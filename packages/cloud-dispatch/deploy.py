#!/usr/bin/env python3
"""Render independent systemd or launchd units. Existing brain units are never touched."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import sys


def unit_quote(value):
    return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind',choices=['systemd','launchd-prepare','launchd-bridge','wrapper'])
    parser.add_argument('--source',required=True)
    parser.add_argument('--config',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--python',default=sys.executable)
    args=parser.parse_args()
    source=Path(args.source).resolve()
    config=Path(args.config).resolve()
    output=Path(args.output)
    if args.kind=='systemd':
        argv=[args.python,str(source/'cloud_dispatch.py'),'--config',str(config),'serve']
        value=('''[Unit]
Description=Independent Codex Cloud dispatch queue
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStart=%s
WorkingDirectory=%s
Environment=HOME=/root
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=always
RestartSec=5
TimeoutStopSec=70
KillMode=control-group
UMask=0077
MemoryHigh=192M
MemoryMax=384M
TasksMax=32
[Install]
WantedBy=multi-user.target
''' % (' '.join(unit_quote(a) for a in argv),str(source).replace('%','%%'))).encode()
    elif args.kind=='wrapper':
        value=('#!/bin/sh\nexec '+shlex.join([args.python,str(source/'gateway.py'),'--config',str(config)])+' "$@"\n').encode()
    else:
        mode='prepare' if args.kind=='launchd-prepare' else 'bridge'
        cfg=json.loads(config.read_text())
        logs=Path(cfg['gateway_state_dir']).parent/'logs'
        logs.mkdir(parents=True,exist_ok=True,mode=0o700)
        script='gateway.py' if mode=='prepare' else 'bridge.py'
        value=plistlib.dumps(dict(Label='org.agentstack.cloud-dispatch.'+mode,
            ProgramArguments=[args.python,str(source/script),'--config',str(config),'serve'],
            WorkingDirectory=str(source),RunAtLoad=True,KeepAlive=True,ThrottleInterval=10,ExitTimeOut=70,
            EnvironmentVariables=dict(PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',PYTHONDONTWRITEBYTECODE='1'),
            StandardOutPath=str(logs/(mode+'.log')),StandardErrorPath=str(logs/(mode+'.err.log'))))
    output.parent.mkdir(parents=True,exist_ok=True)
    if output.exists() and output.read_bytes()!=value:
        raise SystemExit('Different existing output preserved: '+str(output))
    output.write_bytes(value)
    output.chmod(0o700 if args.kind=='wrapper' else 0o600)
    print(json.dumps(dict(ok=True,path=str(output))))


if __name__=='__main__':
    main()
