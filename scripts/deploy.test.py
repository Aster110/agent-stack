import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch
import json
import plistlib

spec=importlib.util.spec_from_file_location('deploy',pathlib.Path(__file__).with_name('deploy.py'))
deploy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='stack-deploy-')
        self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)/'source with spaces'
        for relative in ['.tools/node-v24.13.0-linux-x64/bin/node','.tools/node_modules/.bin/codex']:
            file=self.root/relative;file.parent.mkdir(parents=True,exist_ok=True);file.touch()
        self.profile=pathlib.Path(self.temp.name)/'private profile'
        self.token=pathlib.Path(self.temp.name)/'token';self.token.write_text('synthetic-test-token-'*4)
        self.args=types.SimpleNamespace(device='computer',seat='codex-main',role='computer',peer=['server:brain'],
          hub_url='ws://127.0.0.1:19900',hub_port=19900,relay_port=19800,ssh='my-server',
          workspace='/tmp/example',token_file=str(self.token))
        self.patches=[patch.object(deploy,'ROOT',self.root),patch.object(deploy,'identity',return_value={'sourceHash':'fixture'})]
        for p in self.patches:p.start();self.addCleanup(p.stop)

    def test_isolated_paths_private_token_and_argument_safe_units(self):
        deploy.initialize(self.args,self.profile)
        config=deploy.load(self.profile)
        self.assertEqual((self.profile/'deployment.json').stat().st_mode&0o777,0o600)
        relay=config['services']['relay']
        self.assertTrue(relay['env']['MESH_DB_PATH'].startswith(str(self.profile)))
        self.assertEqual(config['services']['tunnel']['argv'][-1],'my-server')
        for platform in ['darwin','linux']:
            with patch.object(deploy.sys,'platform',platform),patch.object(deploy.os,'geteuid',return_value=0):
                deploy.supervisors(self.profile,'install',True)
        plist=plistlib.loads(next((self.profile/'units').glob('*relay.plist')).read_bytes())
        self.assertIn(str(self.profile),plist['ProgramArguments'])
        for file in (self.profile/'units').iterdir():
            self.assertNotIn(self.token.read_text().encode(),file.read_bytes())
            if file.suffix == '.service':
                directive=next(line for line in file.read_text().splitlines() if line.startswith('WorkingDirectory='))
                self.assertEqual(directive.partition('=')[2],str(self.root))
        with self.assertRaisesRegex(ValueError,'already exists'):
            deploy.initialize(self.args,self.profile)

    def test_no_public_cleartext_and_no_mutation_before_validation(self):
        self.args.hub_url='ws://example.com:19900'
        with self.assertRaisesRegex(ValueError,'wss'):
            deploy.initialize(self.args,self.profile)
        self.assertFalse(self.profile.exists())

    def test_changed_source_cannot_start_a_service(self):
        deploy.initialize(self.args,self.profile)
        with patch.object(deploy,'identity',return_value={'sourceHash':'changed'}),patch.object(deploy.os,'execve') as run:
            with self.assertRaisesRegex(ValueError,'Source changed'):
                deploy.execute(self.profile,'relay')
            run.assert_not_called()


if __name__=='__main__':unittest.main()
