"""Reproducible task snapshots without modifying the caller's checkout or index."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile

from common import DispatchError, atomic, canonical, require, run, safe_id, save, sha

PATCH_ARGS = ['diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
              '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', '--no-indent-heuristic',
              '--unified=3', '--inter-hunk-context=0']


def path_ok(value, directory=False):
    require(isinstance(value, str) and value and '\x00' not in value and '\\' not in value,
            'invalid_path', 'Invalid repository path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(p not in ('.', '..', '.git') for p in value.rstrip('/').split('/')),
            'invalid_path', 'Paths must be relative and cannot escape the repository')
    require(str(path) == value.rstrip('/'), 'invalid_path', 'Paths must use canonical relative spelling')
    require(directory or not value.endswith('/'), 'invalid_path', 'Expected a file path')
    return value


def in_scope(path, scope):
    return any(path == s or (s.endswith('/') and path.startswith(s)) for s in scope)


def git(repo, args, *, env=None, data=None, check=True, timeout=45):
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
    if env:
        environment.update(env)
    rc, out, err, _ = run(['git', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-C', str(repo)] + args,
                          env=environment, data=data, timeout=timeout)
    if check and rc:
        raise DispatchError('git_error', 'Git operation failed: ' + args[0] + ': ' + err.decode(errors='replace')[:400])
    return out if check else (rc, out, err)


def names(raw):
    return [p.decode('utf-8') for p in raw.split(b'\x00') if p]


def file_data(root, path):
    file = root / path
    require(file.resolve().is_relative_to(root.resolve()), 'path_escape', 'File escapes checkout')
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode), 'unsupported_file', 'Only regular task input files are supported')
    require(info.st_size <= 16 * 1024 * 1024, 'input_too_large', 'Individual task input exceeds 16 MiB')
    data = file.read_bytes()
    mode = '100755' if info.st_mode & 0o111 else '100644'
    return data, mode


def put(index_env, repo, path, data, mode):
    oid = git(repo, ['hash-object', '-w', '--stdin'], data=data).decode().strip()
    git(repo, ['update-index', '--add', '--cacheinfo', mode, oid, path], env=index_env)


def validate_request(cfg, request):
    require(isinstance(request, dict) and request.get('schema') == 1, 'request_schema', 'Expected request schema 1')
    safe_id(request['task_id'])
    require(request.get('repo_id') in cfg['repos'], 'repo_unknown', 'Repository is not configured')
    require(request.get('branch') == 'codex/cloud/' + request['task_id'], 'branch_invalid', 'Task branch must match task ID')
    for field in ('base_sha', 'snapshot_sha'):
        require(isinstance(request.get(field), str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', request[field]),
                'sha_invalid', 'Expected a full Git object ID')
    require(isinstance(request.get('scope'), list) and request['scope'], 'scope_required', 'Explicit write scope required')
    for path in request['scope']:
        path_ok(path, directory=True)
    require(isinstance(request.get('prompt'), str) and 0 < len(request['prompt'].encode()) <= 128*1024,
            'prompt_invalid', 'Prompt must be 1-131072 bytes')
    require(isinstance(request.get('authorization'), dict) and request['authorization'].get('source') and
            request['authorization'].get('reference'), 'authorization_required', 'Authorization provenance required separately from scope')
    require(isinstance(request.get('return_route'), dict) and request['return_route'].get('kind') == 'chat' and
            isinstance(request['return_route'].get('id'), str), 'route_invalid', 'Original chat return route required')
    require(set(request.get('requirements', [])).issubset({'gui','macos','local_login'}), 'requirements_invalid', 'Unsupported requirement')
    manifest = request.get('manifest')
    require(isinstance(manifest, dict) and sha(canonical(manifest)) == request.get('manifest_hash'),
            'manifest_hash', 'Manifest hash mismatch')
    require(manifest.get('base_sha') == request['base_sha'] and manifest.get('scope') == request['scope'],
            'manifest_binding', 'Manifest base and scope mismatch')
    files = manifest.get('files')
    require(isinstance(files, list), 'manifest_files', 'Manifest files required')
    seen = set()
    for file in files:
        name = path_ok(file['path'])
        require(name not in seen, 'manifest_collision', 'Duplicate manifest path')
        require(file.get('kind') in ('code','context'), 'manifest_kind', 'Invalid manifest file kind')
        if file['kind'] == 'code':
            require(in_scope(name, request['scope']), 'scope_violation', 'Snapshot code lies outside explicit scope')
        seen.add(name)


def prepare(cfg, value):
    task = safe_id(value['task_id'])
    repo_id = value['repo_id']
    require(repo_id in cfg['repos'], 'repo_unknown', 'Repository is not configured')
    repo = Path(value['repo_path'])
    require(repo.is_absolute(), 'repo_path', 'Repository path must be absolute')
    spec = cfg['repos'][repo_id]
    if spec.get('local_path'):
        configured = Path(spec['local_path']).resolve()
        def common_dir(checkout):
            answer = Path(git(checkout, ['rev-parse', '--git-common-dir']).decode().strip())
            return (checkout / answer).resolve() if not answer.is_absolute() else answer.resolve()
        if common_dir(repo) != common_dir(configured):
            allowed = {Path(p).resolve() for p in spec.get('allowed_clone_paths', [])}
            require(repo.resolve() in allowed, 'repo_binding', 'Checkout is neither a linked worktree nor an explicitly configured clone')
            origin = git(repo, ['remote', 'get-url', 'origin']).decode().strip()
            require(origin == spec['remote_url'], 'repo_binding', 'Configured isolated clone remote does not match repository')
    base = git(repo, ['rev-parse', '--verify', value['base_sha'] + '^{commit}']).decode().strip()
    require(base == value['base_sha'], 'sha_invalid', 'Use a full immutable base commit SHA')
    require(not git(repo, ['ls-files', '-u']), 'unmerged_index', 'Resolve unmerged index before preparing task input')
    scope = value['scope']
    require(isinstance(scope, list) and scope, 'scope_required', 'Explicit scope required')
    for path in scope:
        path_ok(path, directory=True)
    include = set(value.get('include_untracked', []))
    exclude = set(value.get('exclude_untracked', []))
    require(not include.intersection(exclude), 'untracked_conflict', 'An untracked path cannot be included and excluded')
    for path in include | exclude:
        path_ok(path)
        require(in_scope(path, scope), 'scope_violation', 'Untracked declaration lies outside scope')
    dirty = names(git(repo, ['diff', '--no-renames', '--name-only', '-z', base]))
    untracked = set(names(git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])))
    relevant_untracked = {p for p in untracked if in_scope(p, scope)}
    require(include.issubset(untracked), 'untracked_missing', 'Included untracked file does not exist or is tracked/ignored')
    require(not relevant_untracked - include - exclude, 'untracked_undeclared', 'Declare every in-scope untracked path in include_untracked or exclude_untracked')
    base_paths = set(names(git(repo, ['ls-tree', '-r', '--name-only', '-z', base])))
    context = value.get('context', [])
    target_paths = set()
    for item in context:
        target = path_ok(item['target'])
        require(Path(item['source']).is_absolute(), 'context_source', 'Context sources must be absolute files')
        occupied = base_paths | include | target_paths | set(dirty)
        require(not any(target == p or target.startswith(p + '/') or p.startswith(target + '/') for p in occupied),
                'context_collision', 'Context target overlaps code or another context file')
        target_paths.add(target)
    with tempfile.TemporaryDirectory(prefix='cloud-index-') as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
        git(repo, ['read-tree', base], env=env)
        files = []
        scoped_dirty = sorted(p for p in dirty if in_scope(p, scope))
        for path in sorted(set(scoped_dirty) | include):
            source = repo / path
            if not source.exists() and not source.is_symlink():
                git(repo, ['update-index', '--force-remove', '--', path], env=env)
                files.append(dict(path=path, kind='code', mode=None, sha256=None, size=0))
            else:
                data, mode = file_data(repo, path)
                put(env, repo, path, data, mode)
                files.append(dict(path=path, kind='code', mode=mode, sha256=sha(data), size=len(data)))
        tracked_patch = git(repo, PATCH_ARGS + ['--cached', base, '--'] + scoped_dirty, env=env) if scoped_dirty else b''
        for item in context:
            source = Path(item['source'])
            data, mode = file_data(source.parent, source.name)
            put(env, repo, item['target'], data, mode)
            files.append(dict(path=item['target'], kind='context', mode=mode, sha256=sha(data), size=len(data)))
        files.sort(key=lambda f: f['path'])
        manifest = dict(version=1, base_sha=base, scope=scope, files=files, tracked_patch_sha256=sha(tracked_patch),
                        tracked_patch_base64=base64.b64encode(tracked_patch).decode(),
                        include_untracked=sorted(include), exclude_untracked=sorted(exclude),
                        excluded=sorted(set(p for p in dirty if not in_scope(p, scope)) | (untracked - include)))
        manifest_hash = sha(canonical(manifest))
        tree = git(repo, ['write-tree'], env=env).decode().strip()
        commit_env = dict(env, GIT_AUTHOR_NAME='Cloud Dispatch', GIT_AUTHOR_EMAIL='cloud-dispatch@localhost',
                          GIT_COMMITTER_NAME='Cloud Dispatch', GIT_COMMITTER_EMAIL='cloud-dispatch@localhost',
                          GIT_AUTHOR_DATE='2000-01-01T00:00:00+0000', GIT_COMMITTER_DATE='2000-01-01T00:00:00+0000')
        snapshot = git(repo, ['commit-tree', tree, '-p', base], env=commit_env,
                       data=('cloud-dispatch ' + task + '\nmanifest ' + manifest_hash + '\n').encode()).decode().strip()
    require(sorted(p for p in names(git(repo, ['diff', '--no-renames', '--name-only', '-z', base])) if in_scope(p, scope)) == scoped_dirty,
            'source_changed', 'In-scope source changed while snapshot was being prepared; retry with a new stable read')
    context_sources = {item['target']: Path(item['source']) for item in context}
    for file in files:
        source = context_sources.get(file['path'], repo / file['path'])
        if file['mode'] is None:
            require(not source.exists() and not source.is_symlink(), 'source_changed', 'Deleted source changed during preparation')
        else:
            data, mode = file_data(source.parent, source.name)
            require(sha(data) == file['sha256'] and mode == file['mode'], 'source_changed', 'Input bytes changed during preparation')
    branch = 'codex/cloud/' + task
    request = dict(schema=1, task_id=task, repo_id=repo_id, base_sha=base, snapshot_sha=snapshot, branch=branch,
                   prompt=value['prompt'], scope=scope, manifest=manifest, manifest_hash=manifest_hash,
                   authorization=value['authorization'], return_route=value['return_route'],
                   task_kind=value.get('task_kind', 'code'), requirements=value.get('requirements', []))
    validate_request(cfg, request)
    result = dict(ok=True, request=request, input_hash=sha(canonical(request)))
    prepared = Path(cfg['state_dir']) / 'prepared' / (task + '.json')
    if prepared.exists():
        prior = json.loads(prepared.read_text())
        require(prior['input_hash'] == result['input_hash'], 'idempotency_conflict', 'Task ID already prepared with different input')
    ref = 'refs/heads/' + branch
    rc, current, _ = git(repo, ['show-ref', '--verify', '--hash', ref], check=False)
    if rc == 0:
        require(current.decode().strip() == snapshot, 'branch_conflict', 'Local task branch already has another snapshot')
    else:
        git(repo, ['update-ref', ref, snapshot, '0' * len(snapshot)])
    remote = cfg['repos'][repo_id]['remote_url']
    observed = git(repo, ['ls-remote', '--refs', remote, ref]).decode().strip()
    if observed:
        require(observed.split()[0] == snapshot, 'branch_conflict', 'Remote task branch already has another snapshot')
    else:
        # Empty expected ref makes this create-only even if another creator races us.
        git(repo, ['push', '--force-with-lease=' + ref + ':', remote, snapshot + ':' + ref], timeout=60)
    readback = git(repo, ['ls-remote', '--refs', remote, ref]).decode().split()
    require(readback and readback[0] == snapshot, 'branch_readback', 'Task branch readback did not match snapshot')
    save(prepared, result)
    atomic(prepared.with_suffix('.tracked.patch'), tracked_patch)
    return result


def cache_snapshot(cfg, request):
    """Fetch objects, not a checkout; blob filtering avoids a full source copy on the scheduler."""
    spec = cfg['repos'][request['repo_id']]
    cache = Path(cfg['state_dir']) / 'git' / (safe_id(request['repo_id']) + '.git')
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        git(cache.parent, ['init', '--bare', str(cache)])
        git(cache, ['remote', 'add', 'origin', spec['remote_url']])
        git(cache, ['config', 'remote.origin.promisor', 'true'])
        git(cache, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
    require(git(cache, ['remote', 'get-url', 'origin']).decode().strip() == spec['remote_url'],
            'repo_binding', 'Object cache remote changed; use a different repo ID')
    ref = 'refs/heads/' + request['branch']
    observed = git(cache, ['ls-remote', '--refs', 'origin', ref]).decode().split()
    require(observed and observed[0] == request['snapshot_sha'], 'snapshot_drift', 'Task branch no longer matches immutable snapshot')
    git(cache, ['fetch', '--filter=blob:none', '--depth=2', 'origin', ref], timeout=60)
    actual = git(cache, ['rev-parse', 'FETCH_HEAD']).decode().strip()
    require(actual == request['snapshot_sha'], 'snapshot_drift', 'Fetched snapshot does not match request')
    parents = git(cache, ['show', '-s', '--format=%P', actual]).decode().split()
    require(parents == [request['base_sha']], 'snapshot_parent', 'Snapshot must directly descend from declared base')
    changed = set(names(git(cache, ['diff', '--no-renames', '--name-only', '-z', request['base_sha'], actual])))
    files = request['manifest']['files']
    # A scope entry can have become clean relative to base; every actual change must be declared.
    require(changed.issubset({f['path'] for f in files}), 'manifest_incomplete', 'Snapshot contains undeclared paths')
    for file in files:
        name = file['path']
        entry = git(cache, ['ls-tree', '-z', actual, '--', name])
        if file['mode'] is None:
            require(not entry, 'manifest_mismatch', 'Deleted input still exists in snapshot')
            continue
        require(entry and entry.split(b' ', 1)[0].decode() == file['mode'], 'manifest_mismatch', 'Snapshot mode differs from manifest')
        data = git(cache, ['cat-file', 'blob', actual + ':' + name])
        require(sha(data) == file['sha256'] and len(data) == file['size'], 'manifest_mismatch', 'Snapshot bytes differ from manifest')
    patch = base64.b64decode(request['manifest']['tracked_patch_base64'], validate=True)
    require(sha(patch) == request['manifest']['tracked_patch_sha256'], 'patch_hash', 'Tracked patch hash mismatch')
    with tempfile.TemporaryDirectory(prefix='input-replay-') as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
        git(cache, ['read-tree', request['base_sha']], env=env)
        if patch:
            git(cache, ['apply', '--cached', '--whitespace=nowarn', '-'], env=env, data=patch)
        extra = set(request['manifest']['include_untracked'])
        for file in files:
            if file['kind'] == 'context' or file['path'] in extra:
                data = git(cache, ['cat-file', 'blob', actual + ':' + file['path']])
                put(env, cache, file['path'], data, file['mode'])
        reconstructed = git(cache, ['write-tree'], env=env).decode().strip()
        snapshot_tree = git(cache, ['rev-parse', actual + '^{tree}']).decode().strip()
        require(reconstructed == snapshot_tree, 'input_replay', 'Patch and explicit additions do not reconstruct the snapshot')
    return cache


def candidate(cfg, request, diff, cache=None):
    cache = cache or cache_snapshot(cfg, request)
    with tempfile.TemporaryDirectory(prefix='candidate-index-') as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / 'index'))
        git(cache, ['read-tree', request['snapshot_sha']], env=env)
        if diff.strip():
            git(cache, ['apply', '--cached', '--whitespace=nowarn', '-'], env=env, data=diff)
        tree = git(cache, ['write-tree'], env=env).decode().strip()
        changed = names(git(cache, ['diff', '--no-renames', '--name-only', '-z', request['snapshot_sha'], tree]))
        protected = {f['path'] for f in request['manifest']['files'] if f['kind'] == 'context'}
        require(all(in_scope(p, request['scope']) and p not in protected for p in changed),
                'output_scope', 'Candidate changes files outside scope or changes protected context')
        for path in changed:
            entry = git(cache, ['ls-tree', '-z', tree, '--', path])
            require(not entry or entry.split(b' ', 1)[0] in (b'100644', b'100755'),
                    'output_mode', 'Candidate cannot introduce symlinks or submodules')
        return tree, changed
