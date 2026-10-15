#!/usr/bin/env python3
"""A bounded durable Codex Cloud queue. Cloud readiness is never acceptance."""
import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time

from common import DispatchError, Store, atomic, authenticate, canonical, config, now, require, run, save, sha
from snapshot import cache_snapshot, candidate, prepare, validate_request

ACTIVE = ('submitting', 'running', 'submission_unknown')


def submit(cfg, store, envelope):
    request = envelope['request']
    principal = authenticate(cfg, 'submitters', request, envelope.get('auth'))
    validate_request(cfg, request)
    digest = sha(canonical(request))
    task = request['task_id']
    route = None
    if request.get('task_kind', 'code') != 'code':
        route = 'task_kind'
    elif request.get('requirements'):
        route = 'requirements:' + ','.join(sorted(request['requirements']))
    elif not cfg['repos'][request['repo_id']].get('env_id'):
        route = 'cloud_environment_unavailable'
    status = 'routed_worker' if route else 'queued'
    state = dict(cloud_task_id=None, submitter=principal, return_route=request['return_route'],
                 snapshot_sha=request['snapshot_sha'], base_sha=request['base_sha'], branch=request['branch'],
                 manifest_hash=request['manifest_hash'], acceptance_status='not_verified')
    if route:
        state['route'] = dict(kind='independent_worker', reason=route, delivery='pending')
    with store.db(write=True) as db:
        old = db.execute('SELECT input_hash FROM tasks WHERE task_id=?', (task,)).fetchone()
        if old:
            require(old['input_hash'] == digest, 'idempotency_conflict', 'Task ID already has different input')
            duplicate = True
        else:
            stamp = now()
            db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)',
                       (task, digest, canonical(request).decode(), status, canonical(state).decode(), stamp, stamp))
            store.event(db, task, status, dict(state, task_id=task, status=status, input_hash=digest))
            duplicate = False
    return dict(store.public(task), duplicate=duplicate)


def cli(cfg, store, task, label, args):
    env = dict(os.environ, CODEX_HOME=cfg['codex_home'])
    # API-key variables cannot silently replace the verified subscription account.
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY'):
        env.pop(key, None)
    return run([cfg['codex_bin']] + args, env=env, timeout=cfg['command_timeout_seconds'],
               output_dir=store.artifact_dir(task), label=label)


def preflight(cfg, store, task):
    try:
        rc, out, err, _ = cli(cfg, store, task, 'preflight-login', ['login', 'status'])
        require(rc == 0 and b'Logged in using ChatGPT' in out + err,
                'login_unavailable', 'Codex ChatGPT subscription login is not ready')
        account = json.loads((Path(cfg['codex_home']) / 'auth.json').read_text())
        account_id = (account.get('tokens') or {}).get('account_id') or account.get('account_id')
        require(isinstance(account_id, str) and account_id, 'account_unavailable', 'Account identifier is unavailable')
        digest = sha(account_id.encode())[:16]
        require(digest == cfg.get('expected_account_sha256_16'), 'account_mismatch', 'Codex subscription account does not match configuration')
        rc, version, _, _ = cli(cfg, store, task, 'preflight-version', ['--version'])
        require(rc == 0, 'cli_unavailable', 'Codex CLI version check failed')
        return dict(checked_at=now(), login_status='Logged in using ChatGPT', account_sha256_16=digest,
                    cli_version=version.decode(errors='replace').strip())
    except DispatchError:
        raise
    except (OSError, ValueError, KeyError):
        raise DispatchError('login_unavailable', 'Codex subscription login could not be verified')


def cloud_prompt(request):
    metadata = dict(task_id=request['task_id'], base_sha=request['base_sha'], snapshot_sha=request['snapshot_sha'],
                    manifest_hash=request['manifest_hash'], scope=request['scope'],
                    files=request['manifest']['files'], tracked_patch_sha256=request['manifest']['tracked_patch_sha256'])
    return ('Implement the following authorized code task. Work only in the declared write scope. '
            'Context files are read-only evidence; do not change them. Do not merge, publish or alter remote refs. '
            'Do not claim independent acceptance: your changes will be evaluated separately. '
            'First verify git HEAD matches snapshot_sha and verify each supplied file byte hash. '
            'If input differs, stop and report the mismatch.\n'
            'Canonical input manifest (SHA256 of the complete manifest is manifest_hash):\n' + canonical(metadata).decode() +
            '\nTask:\n' + request['prompt'])


def route_unavailable(store, task, error):
    return store.update(task, 'routed_worker', event='routed_worker',
                        route=dict(kind='independent_worker', reason=error.code, delivery='pending'),
                        last_error=str(error))


def start_task(cfg, store, row):
    task = row['task_id']
    request = json.loads(row['request'])
    try:
        identity = preflight(cfg, store, task)
    except DispatchError as error:
        return route_unavailable(store, task, error)
    try:
        cache_snapshot(cfg, request)
    except DispatchError as error:
        return store.update(task, 'failed', event='failed', last_error=str(error), error_code=error.code)
    # This intent is committed before the only operation that creates an upstream task.
    # A crash from here through task-ID persistence is uncertain, never safe to retry.
    store.update(task, 'submitting', event='submitting', preflight=identity, submission_started_at=now(),
                 deadline_at=(dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=cfg['task_deadline_seconds'])).isoformat())
    try:
        rc, out, err, receipt = cli(cfg, store, task, 'submit', [
            'cloud', 'exec', '--env', cfg['repos'][request['repo_id']]['env_id'],
            '--branch', request['branch'], '--attempts', '1', cloud_prompt(request)])
        ids = set(re.findall(r'^https://chatgpt\.com/codex/tasks/(task_[A-Za-z0-9_]+)[ \t]*$',
                             out.decode(errors='replace'), re.MULTILINE))
        if len(ids) != 1:
            return store.update(task, 'submission_unknown', event='submission_unknown', submit_receipt=receipt,
                                last_error='Submission outcome is unknown; no automatic resubmission', slot_reserved=True)
        upstream = next(iter(ids))
        return store.update(task, 'running', event='running', cloud_task_id=upstream,
                            cloud_url='https://chatgpt.com/codex/tasks/' + upstream,
                            submitted_at=now(), submit_receipt=receipt, poll_count=0, next_poll_at=0)
    except Exception as error:
        return store.update(task, 'submission_unknown', event='submission_unknown',
                            last_error=type(error).__name__ + ': submission outcome unknown', slot_reserved=True)


def poll_task(cfg, store, row):
    task = row['task_id']
    state = json.loads(row['state'])
    request = json.loads(row['request'])
    if state.get('next_poll_at', 0) > time.time():
        return None
    count = state.get('poll_count', 0) + 1
    store.update(task, poll_count=count, next_poll_at=time.time()+cfg['poll_seconds'])
    if not state.get('deadline_exceeded') and dt.datetime.now(dt.timezone.utc) > dt.datetime.fromisoformat(state['deadline_at']):
        store.update(task, event='deadline_exceeded', deadline_exceeded=True,
                     deadline_note='Upstream not cancelled; slot remains reserved and read-only reconciliation continues')
    try:
        rc, out, err, receipt = cli(cfg, store, task, 'status-%06d' % count, ['cloud', 'status', state['cloud_task_id']])
        match = re.search(r'^\[([A-Z_]+)\]', out.decode(errors='replace'), re.MULTILINE)
        upstream_status = match.group(1) if match else 'UNKNOWN'
        store.update(task, remote_status=upstream_status, last_polled_at=now(), last_status_receipt=receipt)
        if upstream_status in ('FAILED', 'CANCELLED', 'CANCELED', 'ERROR'):
            return store.update(task, 'failed', event='failed', finished_at=now(), error_code='cloud_' + upstream_status.lower())
        if upstream_status != 'READY':
            return None
        rc, diff, err, receipt = cli(cfg, store, task, 'diff-%06d' % count, ['cloud', 'diff', state['cloud_task_id']])
        require(rc == 0 and len(diff) <= 32*1024*1024, 'diff_unavailable', 'Cloud diff is unavailable or larger than 32 MiB')
        destination = store.artifact_dir(task) / 'result.diff'
        atomic(destination, diff)
        store.update(task, output_path=str(destination), diff_path=str(destination), output_hash=sha(diff), diff_receipt=receipt)
        tree, changed = candidate(cfg, request, diff)
        return store.update(task, 'awaiting_verification', event='awaiting_verification', finished_at=now(),
                            output_path=str(destination), diff_path=str(destination), output_hash=sha(diff),
                            candidate_tree_sha=tree, changed_paths=changed, diff_receipt=receipt,
                            acceptance_status='not_verified')
    except DispatchError as error:
        return store.update(task, 'failed', event='failed', last_error=str(error), error_code=error.code)
    except Exception as error:
        # Status transport failures cannot prove upstream termination or release its slot.
        return store.update(task, last_error=type(error).__name__ + ': polling failed; upstream slot retained')


def tick(cfg, store):
    lock = open(store.root / 'scheduler.lock', 'a+b')
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return dict(ok=True, busy=True, processed=[])
        with store.db() as db:
            interrupted = [r['task_id'] for r in db.execute("SELECT task_id FROM tasks WHERE status='submitting'")]
        for task in interrupted:
            store.update(task, 'submission_unknown', event='submission_unknown', slot_reserved=True,
                         last_error='Scheduler restarted during submission; no automatic resubmission')
        with store.db() as db:
            running = [dict(r) for r in db.execute("SELECT * FROM tasks WHERE status='running' ORDER BY created_at")]
        processed = []
        for row in running:
            result = poll_task(cfg, store, row)
            if result:
                processed.append(result)
        while True:
            with store.db() as db:
                active = db.execute("SELECT count(*) FROM tasks WHERE status IN ('submitting','running','submission_unknown')").fetchone()[0]
                row = db.execute("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone()
            if active >= cfg['max_active'] or row is None:
                break
            processed.append(start_task(cfg, store, dict(row)))
        return dict(ok=True, busy=False, processed=processed)
    finally:
        lock.close()


def verify(cfg, store, envelope):
    verdict = envelope['verdict']
    principal = authenticate(cfg, 'verifiers', verdict, envelope.get('auth'))
    require(verdict.get('decision') in ('accepted','rejected'), 'verdict_invalid', 'Decision must be accepted or rejected')
    require(isinstance(verdict.get('evidence'), dict) and verdict['evidence'], 'evidence_required', 'Independent evidence is required')
    task = verdict['task_id']
    row = store.get(task)
    state = json.loads(row['state'])
    require(row['status'] in ('awaiting_verification','accepted','rejected'), 'verification_state', 'Task is not ready for independent verification')
    require(verdict.get('input_hash') == row['input_hash'], 'input_hash', 'Verdict input hash does not match')
    request = json.loads(row['request'])
    diff = Path(state['output_path']).read_bytes()
    require(sha(diff) == state['output_hash'] == verdict.get('output_hash'), 'output_hash', 'Saved output or verdict output hash changed')
    cache = Path(cfg['state_dir']) / 'git' / (request['repo_id'] + '.git')
    tree, changed = candidate(cfg, request, diff, cache=cache)
    require(tree == state['candidate_tree_sha'] == verdict.get('candidate_tree_sha'), 'candidate_hash', 'Candidate tree does not match verdict')
    with store.db(write=True) as db:
        current = db.execute('SELECT status,state FROM tasks WHERE task_id=?', (task,)).fetchone()
        prior = db.execute('SELECT * FROM verdicts WHERE task_id=?', (task,)).fetchone()
        if prior:
            require(prior['verifier'] == principal and prior['verdict'] == canonical(verdict).decode(),
                    'verdict_conflict', 'A different final verdict already exists')
        else:
            require(current['status'] == 'awaiting_verification', 'verification_state', 'Task state changed during verification')
            evidence_hash = sha(canonical(verdict['evidence']))
            db.execute('INSERT INTO verdicts VALUES(?,?,?,?,?)', (task, principal, canonical(verdict).decode(), evidence_hash, now()))
            state.update(acceptance_status=verdict['decision'], verifier=principal, evidence_hash=evidence_hash, verified_at=now())
            db.execute('UPDATE tasks SET status=?,state=?,updated_at=? WHERE task_id=?',
                       (verdict['decision'], canonical(state).decode(), now(), task))
            store.event(db, task, verdict['decision'], dict(state, task_id=task, status=verdict['decision'], input_hash=row['input_hash']))
    return store.public(task)


def events(store, after, limit=100):
    with store.db() as db:
        rows = db.execute('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?', (after, limit)).fetchall()
        instance = db.execute("SELECT value FROM metadata WHERE key='instance_id'").fetchone()[0]
    records = [dict(r, payload=json.loads(r['payload'])) for r in rows]
    return dict(ok=True, instance_id=instance, events=records, next_cursor=records[-1]['seq'] if records else after)


def artifact(store, task, kind):
    row = store.get(task)
    if kind == 'diff':
        state = json.loads(row['state'])
        require(state.get('output_path'), 'artifact_unavailable', 'No candidate artifact is available')
        data = Path(state['output_path']).read_bytes()
    elif kind == 'request':
        data = row['request'].encode()
    elif kind == 'verdict':
        with store.db() as db:
            receipt = db.execute('SELECT verdict FROM verdicts WHERE task_id=?', (task,)).fetchone()
        require(receipt is not None, 'artifact_unavailable', 'No independent verdict is available')
        data = receipt['verdict'].encode()
    else:
        data = canonical(store.public(task))
    return dict(ok=True, task_id=task, kind=kind, encoding='base64', sha256=sha(data), data=base64.b64encode(data).decode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    for cmd in ('prepare','submit','tick','serve','verify'):
        sub.add_parser(cmd)
    status = sub.add_parser('status')
    status.add_argument('task_id')
    event = sub.add_parser('events')
    event.add_argument('--after', type=int, default=0)
    event.add_argument('--limit', type=int, default=100)
    result = sub.add_parser('artifact')
    result.add_argument('task_id')
    result.add_argument('--kind', choices=['diff','request','status','verdict'], default='diff')
    args = parser.parse_args()
    cfg = config(args.config)
    if args.command == 'prepare':
        result = prepare(cfg, json.load(sys.stdin))
    else:
        store = Store(cfg)
        if args.command == 'submit':
            result = submit(cfg, store, json.load(sys.stdin))
        elif args.command == 'status':
            result = store.public(args.task_id)
        elif args.command == 'verify':
            result = verify(cfg, store, json.load(sys.stdin))
        elif args.command == 'events':
            require(0 < args.limit <= 1000 and args.after >= 0, 'cursor_invalid', 'Invalid event cursor or limit')
            result = events(store, args.after, args.limit)
        elif args.command == 'artifact':
            result = artifact(store, args.task_id, args.kind)
        elif args.command == 'tick':
            result = tick(cfg, store)
        else:
            stopped = threading.Event()
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda *_: stopped.set())
            while not stopped.is_set():
                try:
                    tick(cfg, store)
                except Exception as error:
                    print(json.dumps(dict(at=now(), error=type(error).__name__, message=str(error))), file=sys.stderr, flush=True)
                stopped.wait(min(2, cfg['poll_seconds']))
            result = dict(ok=True, stopped=True)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code=getattr(error, 'code', 'invalid_operation'), message=str(error))), ensure_ascii=False))
        sys.exit(1)
