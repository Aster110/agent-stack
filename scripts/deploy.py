#!/usr/bin/env python3
"""Private profiles plus OS supervisors for one checked-out release. No tmux."""
import argparse
import json
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')


def write_json(file, value):
    with file.open('x', encoding='utf-8') as stream:
        os.chmod(file, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')


def load(profile):
    value = json.loads((profile/'deployment.json').read_text())
    if value['source'] != str(ROOT):
        raise ValueError('Use the deployment script from the profile source checkout.')
    return value


def identity():
    return json.loads(subprocess.check_output([sys.executable, str(ROOT/'scripts/source-version.py')], text=True))


def initialize(a, profile):
    if profile.exists():
        raise ValueError('Profile already exists. Preserve it; use a new directory for installation.')
    if not NAME.fullmatch(a.device) or not NAME.fullmatch(a.seat):
        raise ValueError('device/seat: 1-32 lowercase letters, numbers or hyphens')
    if not a.peer or any(not re.fullmatch(r'[a-z0-9-]+:[a-z0-9-]+', p) for p in a.peer):
        raise ValueError('Supply explicit --peer device:seat entries.')
    endpoint = urlparse(a.hub_url)
    if endpoint.scheme != 'wss' and not (endpoint.scheme == 'ws' and endpoint.hostname in ('localhost','127.0.0.1','::1')):
        raise ValueError('Use wss or a loopback SSH tunnel for the Hub.')
    if endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError('Hub URL must not contain credentials, query or fragment.')
    if a.role == 'brain' and (endpoint.scheme != 'ws' or endpoint.hostname != '127.0.0.1' or endpoint.port != a.hub_port):
        raise ValueError('Brain hosts a local Hub: use ws://127.0.0.1:<hub-port>.')
    if a.ssh and (a.role == 'brain' or not NAME.fullmatch(a.ssh) or endpoint.hostname != '127.0.0.1' or endpoint.scheme != 'ws'):
        raise ValueError('--ssh must name an existing SSH config alias; use a loopback Hub URL on a computer/server node.')
    if not pathlib.Path(a.workspace).is_absolute():
        raise ValueError('--workspace must be absolute')
    token = pathlib.Path(a.token_file).read_text().strip()
    if len(token) < 32 or any(c.isspace() for c in token):
        raise ValueError('Token must be at least 32 non-whitespace characters.')
    node = next(iter(sorted((ROOT/'.tools').glob('node-v24.13.0-*/bin/node'))), None)
    codex = ROOT/'.tools/node_modules/.bin/codex'
    if not node or not codex.exists():
        raise ValueError('Run scripts/bootstrap.sh first.')
    profile.mkdir(parents=True, mode=0o700)
    for name in ('state','logs','relay-home','units'):
        (profile/name).mkdir(mode=0o700)
    (profile/'relay-home/.ccmesh').mkdir(mode=0o700)
    runtime = dict(version=1,role=a.role,seat=a.seat,cwd=a.workspace,stateRoot=str(profile/'state'),
                   relayUrl=f'http://127.0.0.1:{a.relay_port}',peerNodes=a.peer,
                   codex={'bin':str(codex),'home':str(pathlib.Path.home()/'.codex')},executionPolicy='full-access')
    if a.role == 'brain':
        runtime['relayDatabase'] = str(profile/'relay-home/mesh.db')
    common = {'HOME':str(pathlib.Path.home()),'PATH':':'.join([str(node.parent),str(codex.parent),str(ROOT/'.tools/bin'),'/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']),
              'NO_PROXY':'localhost,127.0.0.1,::1','no_proxy':'localhost,127.0.0.1,::1'}
    relay_env = dict(common,HOME=str(profile/'relay-home'),MESH_DEVICE_ID=a.device,MESH_HUB_URL=a.hub_url,
                     MESH_HUB_TOKEN=token,MESH_DB_PATH=str(profile/'relay-home/mesh.db'),
                     RELAY_HTTP_HOST='127.0.0.1',RELAY_HTTP_PORT=str(a.relay_port),MESH_TERMINAL='none',
                     MESH_LEDGER_SYNC='0',MESH_ATTACHMENTS_DISABLED='1')
    services = {}
    if a.role == 'brain':
        services['hub'] = {'argv':[str(node),str(ROOT/'packages/hub/dist/index.js')],
                           'env':dict(common,HOME=str(profile/'relay-home'),HUB_TOKEN=token,MESH_HUB_HOST='127.0.0.1',MESH_HUB_PORT=str(a.hub_port),LEDGER_DISABLED='1')}
    if a.ssh:
        services['tunnel'] = {'argv':['/usr/bin/ssh','-NT','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes',
                            '-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-L',
                            f'127.0.0.1:{endpoint.port}:127.0.0.1:{a.hub_port}',a.ssh], 'env':common}
    services['relay'] = {'argv':[str(node),str(ROOT/'packages/relay/dist/index.js')],'env':relay_env}
    services['runtime'] = {'argv':[str(node),str(ROOT/'packages/agent-runtime/dist/cli.js'),'run',str(profile/'runtime.json')],'env':common}
    write_json(profile/'runtime.json',runtime)
    write_json(profile/'deployment.json',dict(version=1,source=str(ROOT),identity=identity(),device=a.device,services=services))
    print('Prepared private profile: '+str(profile))
    print('Complete Codex login in this OS account. For brain: node scripts/pair-wechat.mjs '+str(profile))
    print('Then: python3 scripts/deploy.py install --profile '+str(profile))


def upgrade(profile, confirmed):
    """Re-record source identity for an existing profile after an intentional in-place source change.

    `execute` refuses to start a service whose checkout drifted from the recorded hash, which is the
    guard against silent drift. A brain that already owns a Codex thread, WAL, mesh and WeChat cursors
    cannot be re-`init`ed into a new profile without abandoning that state, and this repository has no
    lossless profile migration. So an intentional upgrade is an explicit, recorded operation here
    rather than an edit of deployment.json by hand. Paths, services and state are untouched.
    """
    config = load(profile)
    if not confirmed:
        raise ValueError('Re-recording source identity is intentional: pass --confirm-source-change.')
    current, recorded = identity(), config['identity']
    if current['sourceHash'] == recorded['sourceHash']:
        print('Source identity already matches; nothing to re-record.')
        return
    backup = profile/('deployment.json.before-'+recorded['sourceHash'][:12])
    if not backup.exists():
        shutil.copyfile(profile/'deployment.json', backup)
        os.chmod(backup, 0o600)
    config['identity'] = current
    (profile/'deployment.json').write_text(json.dumps(config, indent=2)+'\n', encoding='utf-8')
    os.chmod(profile/'deployment.json', 0o600)
    print(json.dumps({'profile': str(profile), 'backup': str(backup),
                      'from': {k: recorded.get(k) for k in ('release', 'commit', 'sourceHash')},
                      'to': {k: current.get(k) for k in ('release', 'commit', 'sourceHash')},
                      'next': 'restart the affected services when no turn is in flight'}, ensure_ascii=False))


def execute(profile, service):
    config = load(profile)
    if identity()['sourceHash'] != config['identity']['sourceHash']:
        raise ValueError('Source changed since profile creation. Install a new release in a separate checkout.')
    spec = config['services'][service]
    # Only explicit profile values enter the daemon; shell proxies and stale mesh identities do not leak in.
    os.chdir(ROOT)
    os.execve(spec['argv'][0], spec['argv'], spec['env'])


def quote_unit(value):
    return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'


def working_directory_unit(value):
    # This directive takes the entire RHS as its path; ExecStart quoting is not valid here.
    return str(value).replace('%','%%')


def supervisors(profile, action, render_only=False):
    config = load(profile)
    runtime = json.loads((profile/'runtime.json').read_text())
    if action == 'install' and not render_only and runtime['role'] == 'brain' and not runtime.get('wechat'):
        raise ValueError('Pair WeChat before installing the brain services.')
    mac = sys.platform == 'darwin'
    if not mac and (sys.platform != 'linux' or os.geteuid() != 0):
        raise ValueError('Linux service installation requires root (use the same account for login and services).')
    controller = ['launchctl'] if mac else ['systemctl']
    services = list(config['services'])
    failures = []
    if action == 'stop': services.reverse()
    for service in services:
        name = f'org.agentstack.{config["device"]}.{service}'
        argv = [sys.executable,str(ROOT/'scripts/deploy.py'),'run','--profile',str(profile),'--service',service]
        if mac:
            target = pathlib.Path.home()/'Library/LaunchAgents'/(name+'.plist')
            payload = plistlib.dumps(dict(Label=name,ProgramArguments=argv,WorkingDirectory=str(ROOT),RunAtLoad=True,
                KeepAlive=True,ThrottleInterval=10,StandardOutPath=str(profile/'logs'/(service+'.log')),
                StandardErrorPath=str(profile/'logs'/(service+'.err.log'))))
            destination = f'gui/{os.getuid()}'
        else:
            target = pathlib.Path('/etc/systemd/system')/(name+'.service')
            payload = ('[Unit]\nDescription=Agent Stack '+service+'\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n'
                '[Service]\nType=simple\nExecStart='+' '.join(map(quote_unit,argv))+'\nWorkingDirectory='+working_directory_unit(ROOT)+'\n'
                'Restart=always\nRestartSec=10\nTimeoutStopSec=90\nKillMode=control-group\nUMask=0077\n'
                '[Install]\nWantedBy=multi-user.target\n').encode()
        if action == 'install':
            rendered = profile/'units'/target.name
            rendered.write_bytes(payload)
            os.chmod(rendered,0o600)
            if render_only:
                print(str(rendered)); continue
            if not mac:
                subprocess.run(['systemd-analyze','verify',str(rendered)],check=True,stdout=subprocess.DEVNULL)
            if target.exists() and target.read_bytes() != payload:
                raise ValueError('Different existing service definition preserved: '+str(target))
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(rendered,target)
            os.chmod(target,0o600 if mac else 0o644)
            if mac:
                if subprocess.run(['launchctl','print',destination+'/'+name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
                    subprocess.run(controller+['bootstrap',destination,str(target)],check=True)
            else:
                subprocess.run(controller+['daemon-reload'],check=True)
                subprocess.run(controller+['enable',target.name],check=True)
                subprocess.run(controller+['start',target.name],check=True)
                subprocess.run(controller+['is-active','--quiet',target.name],check=True)
            print('Installed '+name)
        elif mac:
            command = ['bootout',destination,str(target)] if action=='stop' else ['print',destination+'/'+name]
            if subprocess.run(controller+command).returncode: failures.append(name)
        else:
            if subprocess.run(controller+[action,'--no-pager',target.name]).returncode: failures.append(name)
    if failures: raise ValueError('Services needing attention: '+', '.join(failures))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['init','run','install','status','stop','upgrade'])
    p.add_argument('--profile',required=True)
    p.add_argument('--role',choices=['brain','computer','server'],default='computer')
    p.add_argument('--device',default='computer')
    p.add_argument('--seat',default='codex-main')
    p.add_argument('--workspace')
    p.add_argument('--peer',action='append')
    p.add_argument('--hub-url',default='ws://127.0.0.1:19900')
    p.add_argument('--hub-port',type=int,default=19900)
    p.add_argument('--relay-port',type=int,default=19800)
    p.add_argument('--token-file')
    p.add_argument('--ssh')
    p.add_argument('--service',choices=['hub','tunnel','relay','runtime'])
    p.add_argument('--render-only',action='store_true')
    p.add_argument('--confirm-source-change',action='store_true')
    a=p.parse_args()
    profile=pathlib.Path(a.profile)
    if not profile.is_absolute() or ROOT == profile or ROOT in profile.parents:
        raise ValueError('Use an absolute private profile path outside the source checkout.')
    if any(c in str(profile)+str(ROOT) for c in '\n\r\x00'):
        raise ValueError('Control characters are not allowed in paths.')
    if a.command=='init':
        if not a.workspace or not a.token_file: p.error('init requires --workspace and --token-file')
        if not 1<=a.hub_port<=65535 or not 1<=a.relay_port<=65535: p.error('invalid port')
        initialize(a,profile)
    elif a.command=='run':
        if not a.service:p.error('run requires --service')
        execute(profile,a.service)
    elif a.command=='upgrade':
        upgrade(profile,a.confirm_source_change)
    else: supervisors(profile,a.command,a.render_only)


if __name__=='__main__':
    os.umask(0o077)
    try: main()
    except (ValueError,KeyError,OSError,subprocess.CalledProcessError) as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
