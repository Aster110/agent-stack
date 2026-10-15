"""Private, durable state and narrowly scoped authentication for cloud dispatch."""
import contextlib
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import time
import uuid


class DispatchError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise DispatchError(code, message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save(path, value):
    atomic(path, canonical(value) + b'\n')


def safe_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', value),
            'invalid_id', 'Use a stable ID with 1-96 letters, digits, underscores or hyphens')
    return value


def config(path):
    value = json.loads(Path(path).read_text())
    require(value.get('version') == 1, 'config_version', 'Unsupported configuration version')
    root = Path(value['state_dir'])
    require(root.is_absolute(), 'config_path', 'state_dir must be absolute')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    value.setdefault('max_active', 2)
    value.setdefault('poll_seconds', 15)
    value.setdefault('command_timeout_seconds', 45)
    value.setdefault('task_deadline_seconds', 3600)
    value.setdefault('codex_home', os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    require(isinstance(value['max_active'], int) and 1 <= value['max_active'] <= 16,
            'config_concurrency', 'max_active must be 1-16')
    for key in ('poll_seconds', 'command_timeout_seconds', 'task_deadline_seconds'):
        require(isinstance(value[key], (int, float)) and value[key] > 0, 'config_duration', key + ' must be positive')
    require(value['command_timeout_seconds'] <= 60, 'config_duration', 'CLI timeout must be at most 60 seconds')
    submit_secrets = {read_key(v['key_file']) for v in value.get('submitters', {}).values()}
    verify_secrets = {read_key(v['key_file']) for v in value.get('verifiers', {}).values()}
    require(not submit_secrets.intersection(verify_secrets), 'credential_separation', 'Submitter and verifier keys must be different')
    return value


def read_key(path):
    key = Path(path).read_bytes()
    require(len(key) >= 32, 'credential_invalid', 'Signing key must contain at least 32 bytes')
    return key


def authenticate(cfg, category, body, auth):
    require(isinstance(auth, dict), 'authentication', 'Signed authentication required')
    principal = auth.get('principal')
    spec = cfg.get(category, {}).get(principal)
    require(spec is not None, 'authentication', 'Principal is not authorized for this operation')
    expected = hmac.new(read_key(spec['key_file']), canonical(body), hashlib.sha256).hexdigest()
    actual = auth.get('signature')
    require(isinstance(actual, str) and hmac.compare_digest(expected, actual), 'authentication', 'Invalid signature')
    return principal


def run(argv, *, cwd=None, env=None, data=None, timeout=45, output_dir=None, label='command'):
    """Never use a shell. Large process output goes to private files, not pipe buffers."""
    started = now()
    before = time.monotonic()
    folder = Path(output_dir) if output_dir else None
    if folder:
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        out = open(folder / (label + '.stdout'), 'wb')
        err = open(folder / (label + '.stderr'), 'wb')
    else:
        out, err = tempfile.TemporaryFile(), tempfile.TemporaryFile()
    proc = None
    reason = None
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                stdout=out, stderr=err, start_new_session=True)
        try:
            proc.communicate(input=data, timeout=timeout)
        except subprocess.TimeoutExpired:
            reason = 'timeout'
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        out.flush()
        err.flush()
        if folder:
            stdout = (folder / (label + '.stdout')).read_bytes()
            stderr = (folder / (label + '.stderr')).read_bytes()
        else:
            out.seek(0)
            err.seek(0)
            stdout, stderr = out.read(), err.read()
        receipt = dict(started_at=started, finished_at=now(), pid=proc.pid, exit_code=proc.returncode,
                       reason=reason, elapsed_seconds=round(time.monotonic()-before, 3),
                       stdout_sha256=sha(stdout), stderr_sha256=sha(stderr))
        if folder:
            save(folder / (label + '.receipt.json'), receipt)
        return proc.returncode, stdout, stderr, receipt
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        out.close()
        err.close()


class Store:
    def __init__(self, cfg):
        self.root = Path(cfg['state_dir'])
        self.path = self.root / 'queue.sqlite3'
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS tasks(
                  task_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,request TEXT NOT NULL,
                  status TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events(
                  seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,kind TEXT NOT NULL,
                  created_at TEXT NOT NULL,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS verdicts(
                  task_id TEXT PRIMARY KEY,verifier TEXT NOT NULL,verdict TEXT NOT NULL,
                  evidence_hash TEXT NOT NULL,created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            ''')
            db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)', ('instance_id', str(uuid.uuid4())))

    @contextlib.contextmanager
    def db(self, write=False):
        db = sqlite3.connect(self.path, timeout=3)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA busy_timeout=3000')
        try:
            if write:
                db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def get(self, task_id):
        with self.db() as db:
            row = db.execute('SELECT * FROM tasks WHERE task_id=?', (task_id,)).fetchone()
        require(row is not None, 'not_found', 'Task does not exist')
        return dict(row)

    def public(self, task_id):
        row = self.get(task_id)
        state = json.loads(row['state'])
        return dict(state, ok=True, task_id=task_id, input_hash=row['input_hash'], status=row['status'],
                    created_at=row['created_at'], updated_at=row['updated_at'])

    def event(self, db, task_id, kind, payload):
        db.execute('INSERT INTO events(task_id,kind,created_at,payload) VALUES(?,?,?,?)',
                   (task_id, kind, now(), canonical(payload).decode()))

    def update(self, task_id, status=None, event=None, **fields):
        with self.db(write=True) as db:
            row = db.execute('SELECT * FROM tasks WHERE task_id=?', (task_id,)).fetchone()
            state = json.loads(row['state'])
            state.update(fields)
            new_status = status or row['status']
            db.execute('UPDATE tasks SET status=?,state=?,updated_at=? WHERE task_id=?',
                       (new_status, canonical(state).decode(), now(), task_id))
            if event:
                self.event(db, task_id, event, dict(state, task_id=task_id, status=new_status,
                                                  input_hash=row['input_hash']))
        return self.public(task_id)

    def artifact_dir(self, task_id):
        return self.root / 'tasks' / safe_id(task_id)
