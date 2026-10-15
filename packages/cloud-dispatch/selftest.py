#!/usr/bin/env python3
"""Offline integration test of the local queue, fake SSH, and lost desktop RPC reply."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from bridge import Bridge
from common import Store, canonical, sha
from cloud_dispatch import tick
from gateway import Gateway


class DeliveryTest(unittest.TestCase):
    def test_async_prepare_cache_and_unknown_desktop_receipt(self):
        with tempfile.TemporaryDirectory(prefix='cloud-dispatch-selftest-') as directory:
            root = Path(directory)
            repo = root/'repo'
            repo.mkdir()
            def git(*args):
                return subprocess.check_output(['git','-C',str(repo),*args], stderr=subprocess.DEVNULL).decode().strip()
            git('init')
            git('config','user.name','Test')
            git('config','user.email','test@example.invalid')
            (repo/'src').mkdir()
            (repo/'src/value.py').write_text('value = 1\n')
            git('add','src/value.py')
            git('commit','-m','base')
            base=git('rev-parse','HEAD')
            (repo/'src/value.py').write_text('value = 2\n')
            upstream=root/'remote.git'
            subprocess.run(['git','init','--bare',str(upstream)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            submitkey=root/'submit.key'; submitkey.write_bytes(b's'*32)
            verifierkey=root/'verify.key'; verifierkey.write_bytes(b'v'*32)
            home=root/'codex'; home.mkdir()
            (home/'auth.json').write_text(json.dumps({'tokens':{'account_id':'fictional-account'}}))
            fake=root/'fake-codex'
            fake.write_text('''#!/usr/bin/env python3
import sys
a=sys.argv[1:]
if a==['--version']: print('fake-codex 1')
elif a==['login','status']: print('Logged in using ChatGPT')
elif a[:2]==['cloud','exec']: print('https://chatgpt.com/codex/tasks/task_fake_delivery')
elif a[:2]==['cloud','status']: print('[READY]')
elif a[:2]==['cloud','diff']: print('diff --git a/src/value.py b/src/value.py\\n--- a/src/value.py\\n+++ b/src/value.py\\n@@ -1 +1 @@\\n-value = 2\\n+value = 3')
else: raise SystemExit(2)
''')
            fake.chmod(0o700)
            server=dict(version=1,state_dir=str(root/'server'),codex_bin=str(fake),codex_home=str(home),
                        expected_account_sha256_16=sha(b'fictional-account')[:16],max_active=2,poll_seconds=.01,
                        command_timeout_seconds=5,task_deadline_seconds=20,
                        repos={'test':dict(remote_url=str(upstream),env_id='fake-env')},
                        submitters={'brain':dict(key_file=str(submitkey))},verifiers={'review':dict(key_file=str(verifierkey))})
            serverpath=root/'server.json'; serverpath.write_text(json.dumps(server))
            bindir=root/'bin'; bindir.mkdir()
            ssh=bindir/'ssh'
            ssh.write_text('#!/usr/bin/env python3\nimport os,sys,shlex\na=shlex.split(sys.argv[-1]);os.execvp(a[0],a)\n')
            ssh.chmod(0o700)
            rpc=root/'rpc'
            queuestate=root/'official-queue.json'
            rpc.write_text('''#!/usr/bin/env python3
import json,sys,os
from pathlib import Path
p=Path(%r)
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m: continue
 method=m['method']; args=m.get('params',{})
 rows=json.loads(p.read_text()) if p.exists() else []
 if method=='initialize': result={}
 elif method=='thread/read': result={'thread':{'id':'original-chat','cwd':%r}}
 elif method=='thread/queue/add':
  rows.append({'id':'queued-1','clientUserMessageId':args['clientUserMessageId']});p.write_text(json.dumps(rows));os._exit(0)
 elif method=='thread/queue/list': result={'data':rows,'nextCursor':None}
 elif method=='thread/turns/list': result={'data':[],'nextCursor':None}
 else: raise SystemExit(3)
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
''' % (str(queuestate),str(repo)))
            rpc.chmod(0o700)
            local=dict(server)
            local.update(state_dir=str(root/'prepare'),gateway_state_dir=str(root/'gateway'),bridge_state_dir=str(root/'bridge'),
                         server=dict(ssh_host='fixture',python=os.sys.executable,script=str(Path(__file__).with_name('cloud_dispatch.py')),config=str(serverpath)),
                         submit_identity=dict(principal='brain',key_file=str(submitkey)),verifiers={},
                         target_thread_id='original-chat',target_cwd=str(repo),desktop_codex_bin=str(rpc))
            local['repos']={'test':dict(server['repos']['test'],local_path=str(repo))}
            localpath=root/'local.json'; localpath.write_text(json.dumps(local))
            previous=os.environ['PATH']; os.environ['PATH']=str(bindir)+os.pathsep+previous
            try:
                gateway=Gateway(local,localpath)
                spec=dict(task_id='async-delivery',repo_id='test',base_sha=base,prompt='Set value to 3',scope=['src/'],
                          include_untracked=[],exclude_untracked=[],context=[],authorization=dict(source='test',reference='offline'))
                started=time.monotonic(); receipt=gateway.enqueue(spec)
                self.assertLess(time.monotonic()-started, .5)
                self.assertEqual(receipt['status'],'prepare_queued')
                self.assertTrue(gateway.enqueue(spec)['duplicate'])
                self.assertEqual(gateway.tick()['status'],'queued')
                store=Store(server); tick(server,store); tick(server,store)
                self.assertEqual(store.public('async-delivery')['status'],'awaiting_verification')
                bridge=Bridge(local,localpath)
                first=bridge.tick()
                self.assertEqual(first['events'][0]['status'],'unknown')
                self.assertEqual(gateway.status('async-delivery')['status'],'awaiting_verification')
                gateway.update('async-delivery','queued',server_receipt_at='late',cloud_task_id=None)
                self.assertEqual(gateway.status('async-delivery')['status'],'awaiting_verification')
                self.assertEqual(gateway.status('async-delivery')['cloud_task_id'],'task_fake_delivery')
                gateway.update('async-delivery','submit_pending',retry_at=time.time()+30,last_error='late transport_unknown')
                self.assertEqual(gateway.status('async-delivery')['status'],'awaiting_verification')
                self.assertEqual(gateway.status('async-delivery')['cloud_task_id'],'task_fake_delivery')
                second=bridge.tick()
                self.assertEqual(second['events'][0]['status'],'queued')
                self.assertEqual(len(json.loads(queuestate.read_text())),1)
                bridge.tick()
                self.assertEqual(len(json.loads(queuestate.read_text())),1)
                event=second['events'][0]['event_id']
                self.assertEqual(bridge.ack(event)['status'],'acknowledged')
                bridge.update(event,'unknown',error='late RPC failure')
                self.assertEqual(bridge.status()['events'][0]['status'],'acknowledged')
                # Cached main commands still work after transport removal.
                disabled_ssh=ssh.with_name('ssh.disabled')
                ssh.rename(disabled_ssh)
                self.assertEqual(gateway.status('async-delivery')['source'],'local_persisted_cache')
                self.assertGreater(len(bridge.events(0)['events']),0)
                disabled_ssh.rename(ssh)
                self.assertEqual(git('rev-parse','HEAD'),base)
                self.assertEqual((repo/'src/value.py').read_text(),'value = 2\n')
                # A linked worktree keeps its own dirty content, branch, and index.
                linked=root/'linked-worktree'
                git('worktree','add','-b','task-source',str(linked),base)
                (linked/'src/value.py').write_text('value = 41\n')
                worktree_spec=dict(spec,task_id='linked-source',repo_path=str(linked))
                self.assertEqual(gateway.enqueue(worktree_spec)['status'],'prepare_queued')
                self.assertEqual(gateway.tick()['status'],'queued')
                request=json.loads((root/'gateway/requests/linked-source.json').read_text())['request']
                self.assertEqual(git('show',request['snapshot_sha']+':src/value.py'),'value = 41')
                self.assertEqual((repo/'src/value.py').read_text(),'value = 2\n')
                self.assertEqual((linked/'src/value.py').read_text(),'value = 41\n')
            finally:
                os.environ['PATH']=previous


if __name__ == '__main__':
    unittest.main()
