#!/usr/bin/env python3
"""Compare source identity across role/OS installs; this is not a process-health probe."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--record', action='store_true')
parser.add_argument('--verify', action='store_true')
args = parser.parse_args()
excluded = {'node_modules', 'dist', '.git', '.tools', '__pycache__', 'evidence', 'private'}
roots = {'packages', 'scripts', 'skills', 'docs', '.github'}
files = {}
for p in sorted(root.rglob('*')):
    rel = p.relative_to(root)
    if any(part in excluded for part in rel.parts) or not p.is_file():
        continue
    if len(rel.parts) == 1:
        if p.name not in {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.gitignore', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', '一键准备.command'}:
            continue
    elif rel.parts[0] not in roots:
        continue
    if p.is_symlink():
        raise SystemExit('Unexpected symlink in source: ' + str(rel))
    files[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
encoded = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
commit = ''
if (root/'.git').exists():
    result = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    if result.returncode == 0:
        commit = result.stdout.strip()
data = {'release': json.loads((root/'package.json').read_text())['version'], 'commit': commit or None,
        'sourceHash': hashlib.sha256(encoded).hexdigest(), 'sourceFiles': len(files),
        'scope': 'source only; verify running service entrypoint separately'}
record = root/'.release-info.json'
if args.record:
    record.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
if args.verify:
    if not record.exists():
        raise SystemExit('No recorded source identity; run --record after installation.')
    expected = json.loads(record.read_text())
    data['matchesRecordedSource'] = expected.get('sourceHash') == data['sourceHash']
    if not data['matchesRecordedSource']:
        print(json.dumps(data, ensure_ascii=False))
        sys.exit(1)
print(json.dumps(data, ensure_ascii=False))
