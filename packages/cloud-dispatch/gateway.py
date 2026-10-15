#!/usr/bin/env python3
"""Fast main-chat commands backed by an independent deterministic prepare worker."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import threading
import time

from client import remote, signed
from common import canonical, config, now, require, safe_id, save, sha
from snapshot import prepare


class Gateway:
    def __init__(self, cfg, config_path):
        self.cfg = cfg
        self.config_path = str(Path(config_path).resolve())
        self.root = Path(cfg['gateway_state_dir'])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,spec_hash TEXT NOT NULL,
              spec TEXT NOT NULL,status TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);''')

    @contextlib.contextmanager
    def db(self):
        db = sqlite3.connect(self.root / 'gateway.sqlite3', timeout=.5)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def enqueue(self, spec):
        require(isinstance(spec, dict), 'spec_invalid', 'Expected a prepare specification object')
        task = safe_id(spec['task_id'])
        repo = self.cfg['repos'].get(spec['repo_id'])
        require(repo is not None and repo.get('local_path'), 'repo_unknown', 'Repository needs an explicit configured local_path')
        expected_repo = str(Path(repo['local_path']).resolve())
        spec = dict(spec)
        spec.setdefault('repo_path', expected_repo)
        checkout = Path(spec['repo_path'])
        require(checkout.is_absolute(), 'repo_binding', 'Explicit checkout path must be absolute')
        roots = [Path(p).resolve() for p in repo.get('allowed_checkout_roots', [str(Path(expected_repo).parent)])]
        clones = [Path(p).resolve() for p in repo.get('allowed_clone_paths', [])]
        require(any(checkout.resolve().is_relative_to(root) for root in roots) or checkout.resolve() in clones,
                'repo_binding', 'Checkout lies outside configured checkout roots')
        # Actual common-dir / explicitly configured clone identity is checked by the background worker.
        # Preserve the caller's worktree instead of silently reading the main checkout.
        target = dict(kind='chat', id=self.cfg['target_thread_id'])
        spec.setdefault('return_route', target)
        require(spec['return_route'] == target, 'route_binding', 'Main wrapper cannot change the original chat')
        require(isinstance(spec.get('authorization'), dict) and spec['authorization'].get('source') and
                spec['authorization'].get('reference'), 'authorization_required', 'Explicit authorization provenance required')
        require(spec.get('scope') and isinstance(spec.get('prompt'), str) and spec.get('base_sha'),
                'spec_incomplete', 'base_sha, prompt and explicit scope are required')
        roots = [Path(p).resolve() for p in self.cfg.get('context_roots', [expected_repo])]
        for item in spec.get('context', []):
            source = Path(item['source']).resolve()
            require(any(source.is_relative_to(root) for root in roots), 'context_source', 'Context source is outside configured task context roots')
        digest = sha(canonical(spec))
        require(len(canonical(spec)) <= 256*1024, 'spec_too_large', 'Prepare specification exceeds 256 KiB')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT spec_hash FROM tasks WHERE task_id=?', (task,)).fetchone()
            if prior:
                require(prior['spec_hash'] == digest, 'idempotency_conflict', 'Task ID already has a different prepare specification')
            else:
                stamp = now()
                db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)',
                           (task, digest, canonical(spec).decode(), 'prepare_queued', '{}', stamp, stamp))
        return dict(self.status(task), duplicate=prior is not None)

    def status(self, task):
        with self.db() as db:
            row = db.execute('SELECT * FROM tasks WHERE task_id=?', (task,)).fetchone()
        require(row is not None, 'not_found', 'No local dispatch receipt exists for this task')
        return dict(json.loads(row['state']), ok=True, task_id=task, status=row['status'], spec_hash=row['spec_hash'],
                    created_at=row['created_at'], updated_at=row['updated_at'], source='local_persisted_cache')

    def update(self, task, status, **values):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT status,state FROM tasks WHERE task_id=?', (task,)).fetchone()
            state = json.loads(row['state'])
            if state.get('remote_seq', 0) and status in ('preparing','submit_pending','prepare_failed','queued','routed_worker'):
                # A delayed submit response cannot roll back a newer mirrored cloud event.
                state = dict(values, **state)
                status = row['status']
            else:
                state.update(values)
            db.execute('UPDATE tasks SET status=?,state=?,updated_at=? WHERE task_id=?',
                       (status, canonical(state).decode(), now(), task))

    def mirror(self, event):
        task = event['task_id']
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT state FROM tasks WHERE task_id=?', (task,)).fetchone()
            if row is None:
                return
            state = json.loads(row['state'])
            payload = event['payload']
            if state.get('input_hash') != payload.get('input_hash') or state.get('remote_seq', 0) >= event['seq']:
                return
            state.update(payload)
            state.update(remote_seq=event['seq'], remote_observed_at=now(), remote_event_at=event['created_at'])
            db.execute('UPDATE tasks SET status=?,state=?,updated_at=? WHERE task_id=?',
                       (payload['status'], canonical(state).decode(), now(), task))

    def failure_event(self, row, error):
        from bridge import Bridge
        bridge = Bridge(self.cfg, self.config_path)
        event = dict(task_id=row['task_id'], kind='prepare_failed', created_at=now(), payload=dict(
            task_id=row['task_id'], status='prepare_failed', return_route=dict(kind='chat', id=self.cfg['target_thread_id']),
            error_code=getattr(error, 'code', 'prepare_failure'), error=str(error)))
        event_id = 'cloud-dispatch-local:' + row['task_id'] + ':' + row['spec_hash']
        bridge.local_event(event_id, event)

    def tick(self):
        with open(self.root / 'worker.lock', 'a+b') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return dict(ok=True, busy=True)
            with self.db() as db:
                rows = [dict(r) for r in db.execute("SELECT * FROM tasks WHERE status IN ('prepare_queued','preparing','submit_pending') ORDER BY created_at")]
            for row in rows:
                state = json.loads(row['state'])
                if state.get('retry_at', 0) > time.time():
                    continue
                task = row['task_id']
                prepared_path = self.root / 'requests' / (task + '.json')
                try:
                    if prepared_path.exists():
                        prepared = json.loads(prepared_path.read_text())
                        require(sha(canonical(prepared['request'])) == prepared['input_hash'], 'prepared_hash', 'Persisted request hash changed')
                    else:
                        self.update(task, 'preparing', prepare_started_at=now())
                        prepared = prepare(self.cfg, json.loads(row['spec']))
                        save(prepared_path, prepared)
                    self.update(task, 'submit_pending', input_hash=prepared['input_hash'], request_path=str(prepared_path),
                                snapshot_sha=prepared['request']['snapshot_sha'], prepared_at=now())
                    request = prepared['request']
                    result = remote(self.cfg, ['submit'], dict(request=request, auth=signed(request, self.cfg['submit_identity'])))
                    clean = {k: v for k, v in result.items() if k not in ('status','task_id','ok')}
                    self.update(task, result['status'], **clean, server_receipt_at=now())
                except Exception as error:
                    if getattr(error, 'code', None) == 'transport_unknown' and prepared_path.exists():
                        # The server's signed request ID is idempotent, unlike upstream cloud exec.
                        self.update(task, 'submit_pending', retry_at=time.time()+30, last_error=str(error))
                    else:
                        self.update(task, 'prepare_failed', error_code=getattr(error, 'code', 'prepare_failure'), last_error=str(error))
                        self.failure_event(row, error)
                return self.status(task)
            return dict(ok=True, idle=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('submit-json').add_argument('spec')
    sub.add_parser('status').add_argument('task_id')
    sub.add_parser('events').add_argument('--after', type=int, default=0)
    sub.add_parser('ack').add_argument('event_id')
    for cmd in ('tick','serve'):
        sub.add_parser(cmd)
    args = parser.parse_args()
    cfg = config(args.config)
    gateway = Gateway(cfg, args.config)
    if args.command == 'submit-json':
        result = gateway.enqueue(json.loads(args.spec))
    elif args.command == 'status':
        result = gateway.status(args.task_id)
    elif args.command in ('events','ack'):
        from bridge import Bridge
        bridge = Bridge(cfg, args.config)
        result = bridge.events(args.after) if args.command == 'events' else bridge.ack(args.event_id)
    elif args.command == 'tick':
        result = gateway.tick()
    else:
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        while not stop.is_set():
            try:
                gateway.tick()
            except Exception as error:
                print(json.dumps(dict(at=now(), error=type(error).__name__, message=str(error))), file=sys.stderr, flush=True)
            stop.wait(2)
        result = dict(ok=True, stopped=True)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code=getattr(error, 'code', 'gateway_error'), message=str(error))), ensure_ascii=False))
        sys.exit(1)
