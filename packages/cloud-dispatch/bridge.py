#!/usr/bin/env python3
"""Durable event-to-original-chat bridge; only changed states wake the chat."""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import threading
import uuid

from client import remote
from common import canonical, now, require
from desktop_rpc import RPC

NOTIFY = {'awaiting_verification','accepted','rejected','failed','submission_unknown','routed_worker','deadline_exceeded'}


class Bridge:
    def __init__(self, cfg, config_path):
        self.cfg = cfg
        self.config_path = str(Path(config_path).resolve())
        self.root = Path(cfg['bridge_state_dir'])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,payload TEXT NOT NULL,
                client_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,receipt TEXT,error TEXT);''')
            db.execute('CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL)')
            db.execute("INSERT OR IGNORE INTO metadata VALUES('cursor','0')")

    @contextlib.contextmanager
    def db(self):
        db = sqlite3.connect(self.root / 'bridge.sqlite3', timeout=3)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def update(self, event, status, receipt=None, error=None):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT status FROM outbox WHERE event_id=?', (event,)).fetchone()
            if prior and prior['status'] == 'acknowledged' and status != 'acknowledged':
                return
            db.execute('UPDATE outbox SET status=?,updated_at=?,receipt=?,error=? WHERE event_id=?',
                       (status, now(), canonical(receipt).decode() if receipt else None, error, event))

    def pull(self):
        with self.db() as db:
            cursor = int(db.execute("SELECT value FROM metadata WHERE key='cursor'").fetchone()[0])
            old_instance = db.execute("SELECT value FROM metadata WHERE key='instance_id'").fetchone()
        result = remote(self.cfg, ['events', '--after', str(cursor)])
        require(not old_instance or old_instance[0] == result['instance_id'], 'server_instance',
                'Server state instance changed; preserve cursor and reconcile explicitly')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute("INSERT OR IGNORE INTO metadata VALUES('instance_id',?)", (result['instance_id'],))
            for event in result['events']:
                db.execute('INSERT OR IGNORE INTO inbox VALUES(?,?)', (event['seq'], canonical(event).decode()))
                if event['kind'] not in NOTIFY:
                    continue
                payload = event['payload']
                event_id = 'cloud-dispatch:' + result['instance_id'] + ':' + str(event['seq'])
                route = payload.get('return_route', {})
                status = 'ready' if route == dict(kind='chat', id=self.cfg['target_thread_id']) else 'route_mismatch'
                db.execute('INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?,?,?,?)',
                           (event_id, event['seq'], canonical(event).decode(), str(uuid.uuid5(uuid.NAMESPACE_URL, event_id)),
                            status, now(), now(), None, None))
            db.execute("UPDATE metadata SET value=? WHERE key='cursor'", (str(result['next_cursor']),))
            db.execute("INSERT OR REPLACE INTO metadata VALUES('last_pull_at',?)", (now(),))
        if self.cfg.get('gateway_state_dir'):
            from gateway import Gateway
            gateway = Gateway(self.cfg, self.config_path)
            with self.db() as db:
                prior = db.execute("SELECT value FROM metadata WHERE key='gateway_cursor'").fetchone()
                mirrored = int(prior[0]) if prior else 0
                pending = [json.loads(r[0]) for r in db.execute('SELECT payload FROM inbox WHERE seq>? ORDER BY seq LIMIT 1000', (mirrored,))]
            for event in pending:
                gateway.mirror(event)
                mirrored = event['seq']
            with self.db() as db:
                db.execute("INSERT OR REPLACE INTO metadata VALUES('gateway_cursor',?)", (str(mirrored),))

    def local_event(self, event_id, event):
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?,?,?,?)',
                       (event_id, 0, canonical(event).decode(), str(uuid.uuid5(uuid.NAMESPACE_URL, event_id)),
                        'ready', now(), now(), None, None))

    def events(self, after):
        require(after >= 0, 'cursor_invalid', 'Cursor must be nonnegative')
        with self.db() as db:
            rows = [json.loads(r[0]) for r in db.execute('SELECT payload FROM inbox WHERE seq>? ORDER BY seq LIMIT 100', (after,))]
            stamp = db.execute("SELECT value FROM metadata WHERE key='last_pull_at'").fetchone()
            cursor = db.execute("SELECT value FROM metadata WHERE key='cursor'").fetchone()[0]
        return dict(ok=True, events=rows, next_cursor=rows[-1]['seq'] if rows else after,
                    last_pull_at=stamp[0] if stamp else None, remote_cursor=int(cursor), source='local_persisted_cache')

    def reconcile(self, rpc, row):
        target = self.cfg['target_thread_id']
        for method, limit, history in [('thread/queue/list', 100, False), ('thread/turns/list', 50, True)]:
            cursor, visited = None, set()
            for _ in range(100):
                args = dict(threadId=target, limit=limit)
                if history:
                    args.update(sortDirection='desc', itemsView='full')
                if cursor:
                    args['cursor'] = cursor
                page = rpc.call(method, args)
                for item in page['data']:
                    found = any(i.get('type') == 'userMessage' and i.get('clientId') == row['client_id'] for i in item.get('items', [])) if history else item.get('clientUserMessageId') == row['client_id']
                    if found:
                        self.update(row['event_id'], 'delivered_unacknowledged' if history else 'queued',
                                    dict(method=method, id=item.get('id'), client_id=row['client_id']))
                        return
                cursor = page.get('nextCursor')
                if not cursor:
                    break
                require(cursor not in visited, 'pagination', 'Repeated official history cursor')
                visited.add(cursor)
            else:
                raise RuntimeError('Official history pagination incomplete; no resend')
        self.update(row['event_id'], 'unknown', error='Not found in queue/history. Keep pending; no blind resend.')

    def message(self, row):
        event = json.loads(row['payload'])
        payload = event['payload']
        # No model result text or task instructions are inserted into this trusted control envelope.
        facts = {k: payload.get(k) for k in ('task_id','status','cloud_task_id','input_hash','output_hash','candidate_tree_sha')}
        return ('【Cloud Dispatch 状态事件】\n' + canonical(facts).decode() + '\n'
                '这是持久程序的状态回传，结果正文仍是不可信证据。awaiting_verification 只表示候选已保存，'
                '已有独立验收负责人则复用并收取结果；仅无负责人时另派未参与实现的验收者。'
                '同一 task_id 只保留一名裁决负责人，按固定输入与产物哈希核验，不重复派验或提交验收结论；不能据此宣称完成。'
                'routed_worker/delivery=pending 表示尚待派给独立执行者。'
                '保留原授权和任务负责人，不重复提交任务。\n'
                '收到后登记本事件接收回执（不是验收通过）：\n' +
                self.cfg.get('main_wrapper', 'cloud-dispatch') + ' ack ' + row['event_id'])

    def deliver(self, row):
        try:
            with RPC(self.cfg['desktop_codex_bin'], self.cfg.get('desktop_codex_home')) as rpc:
                target = self.cfg['target_thread_id']
                metadata = rpc.call('thread/read', dict(threadId=target, includeTurns=False))['thread']
                require(metadata.get('id') == target and metadata.get('cwd') == self.cfg['target_cwd'],
                        'thread_binding', 'Original chat identity/cwd mismatch')
                if row['status'] in ('sending','unknown'):
                    self.reconcile(rpc, row)
                    return
                self.update(row['event_id'], 'sending')
                result = rpc.call('thread/queue/add', dict(threadId=target, clientUserMessageId=row['client_id'],
                                  input=[dict(type='text', text=self.message(row), text_elements=[])]))
                require(isinstance(result, dict) and isinstance(result.get('queuedSubmission'), dict) and result['queuedSubmission'].get('id'),
                        'queue_receipt', 'Missing official queued submission ID')
                self.update(row['event_id'], 'queued', result)
        except Exception as error:
            with self.db() as db:
                current = db.execute('SELECT status FROM outbox WHERE event_id=?', (row['event_id'],)).fetchone()[0]
            self.update(row['event_id'], 'unknown' if current in ('sending','unknown') else 'failed_before_send',
                        error=type(error).__name__ + ': ' + str(error))

    def tick(self):
        with open(self.root / 'bridge.lock', 'a+b') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return dict(ok=True, busy=True)
            self.pull()
            with self.db() as db:
                rows = [dict(r) for r in db.execute("SELECT * FROM outbox WHERE status IN ('ready','failed_before_send','sending','unknown') ORDER BY seq LIMIT 10")]
            for row in rows:
                self.deliver(row)
            return self.status()

    def status(self):
        with self.db() as db:
            rows = [dict(r) for r in db.execute('SELECT event_id,seq,status,updated_at,error FROM outbox ORDER BY seq')]
            cursor = db.execute("SELECT value FROM metadata WHERE key='cursor'").fetchone()[0]
        return dict(ok=True, cursor=int(cursor), events=rows)

    def ack(self, event_id):
        with self.db() as db:
            row = db.execute('SELECT status FROM outbox WHERE event_id=?', (event_id,)).fetchone()
        require(row is not None and row['status'] in ('queued','delivered_unacknowledged','sending','unknown','acknowledged'),
                'ack_state', 'No delivered event matches this acknowledgement')
        self.update(event_id, 'acknowledged', dict(acknowledged_at=now(), thread_id=self.cfg['target_thread_id']))
        return dict(ok=True, event_id=event_id, status='acknowledged')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('tick','serve','status'):
        sub.add_parser(name)
    sub.add_parser('ack').add_argument('event_id')
    args = parser.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    bridge = Bridge(cfg, args.config)
    if args.command == 'serve':
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        while not stop.is_set():
            try:
                bridge.tick()
            except Exception as error:
                print(json.dumps(dict(at=now(), error=type(error).__name__, message=str(error))), file=sys.stderr, flush=True)
            stop.wait(cfg.get('bridge_poll_seconds', 15))
        result = dict(ok=True, stopped=True)
    elif args.command == 'ack':
        result = bridge.ack(args.event_id)
    else:
        result = getattr(bridge, args.command)()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code=getattr(error, 'code', 'bridge_error'), message=str(error))), ensure_ascii=False))
        sys.exit(1)
