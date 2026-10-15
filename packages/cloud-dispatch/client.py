#!/usr/bin/env python3
"""Narrow local SSH client; submit credentials never travel with task context."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import shlex
import sys

from common import DispatchError, atomic, canonical, config, read_key, require, run, sha
from snapshot import prepare


def remote(cfg, args, body=None):
    server = cfg['server']
    command = shlex.join([server.get('python', '/usr/bin/python3'), server['script'], '--config', server['config']] + args)
    argv = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', server['ssh_host'], command]
    rc, out, err, _ = run(argv, data=canonical(body) if body is not None else None, timeout=45)
    try:
        result = json.loads(out)
    except ValueError:
        raise DispatchError('transport_unknown', 'SSH outcome is unknown; read status before retrying a write')
    if rc or not result.get('ok'):
        failure = result.get('error', {})
        raise DispatchError(failure.get('code', 'remote_error'), failure.get('message', 'Remote command failed'))
    return result


def signed(body, spec):
    return dict(principal=spec['principal'], signature=hmac.new(read_key(spec['key_file']), canonical(body), hashlib.sha256).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--input', required=True)
    prep.add_argument('--output', required=True)
    submit = sub.add_parser('submit')
    submit.add_argument('--request', required=True)
    status = sub.add_parser('status')
    status.add_argument('task_id')
    event = sub.add_parser('events')
    event.add_argument('--after', type=int, default=0)
    result = sub.add_parser('artifact')
    result.add_argument('task_id')
    result.add_argument('--kind', choices=['diff','request','status','verdict'], default='diff')
    result.add_argument('--output', required=True)
    verifier = sub.add_parser('verify')
    verifier.add_argument('--verdict', required=True)
    args = parser.parse_args()
    cfg = config(args.config)
    if args.command == 'prepare':
        value = prepare(cfg, json.loads(Path(args.input).read_text()))
        atomic(args.output, canonical(value) + b'\n')
        result = dict(ok=True, path=str(Path(args.output).resolve()), task_id=value['request']['task_id'], input_hash=value['input_hash'])
    elif args.command == 'submit':
        value = json.loads(Path(args.request).read_text())
        request = value.get('request', value)
        result = remote(cfg, ['submit'], dict(request=request, auth=signed(request, cfg['submit_identity'])))
    elif args.command == 'verify':
        verdict = json.loads(Path(args.verdict).read_text())
        result = remote(cfg, ['verify'], dict(verdict=verdict, auth=signed(verdict, cfg['verifier_identity'])))
    elif args.command == 'status':
        result = remote(cfg, ['status', args.task_id])
    elif args.command == 'events':
        result = remote(cfg, ['events', '--after', str(args.after)])
    else:
        result = remote(cfg, ['artifact', args.task_id, '--kind', args.kind])
        data = base64.b64decode(result.pop('data'), validate=True)
        require(sha(data) == result['sha256'], 'artifact_hash', 'Artifact transfer hash mismatch')
        atomic(args.output, data)
        result['path'] = str(Path(args.output).resolve())
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(ok=False, error=dict(code=getattr(error, 'code', 'invalid_operation'), message=str(error))), ensure_ascii=False))
        sys.exit(1)
