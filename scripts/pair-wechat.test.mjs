import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pairWeChat} from './pair-wechat.mjs';

function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'stack-pair-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({role:'brain'}));
  return root;
}
test('QR-confirmed owner is bound and credentials are private; re-pair cannot replace binding',async t=>{
  const root=profile(t);
  await pairWeChat(root,undefined,async()=>({ownerId:'qr-owner',accountId:'fixture',token:'synthetic-test-token'}));
  const c=JSON.parse(fs.readFileSync(path.join(root,'runtime.json')));
  assert.equal(c.wechat.ownerId,'qr-owner');
  assert.equal(fs.statSync(c.wechat.accountFile).mode&0o777,0o600);
  await assert.rejects(pairWeChat(root,undefined,async()=>{throw new Error('must not login again');}),/existing bindings/);
});
test('missing or conflicting owner cannot create credentials or adopt the first message',async t=>{
  const root=profile(t);
  await assert.rejects(pairWeChat(root,undefined,async()=>({accountId:'fixture',token:'synthetic-test-token'})),/omitted owner/);
  await assert.rejects(pairWeChat(root,'different',async()=>({ownerId:'qr-owner',accountId:'fixture',token:'synthetic-test-token'})),/differs/);
  assert.equal(fs.existsSync(path.join(root,'wechat-account.json')),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'runtime.json'))),{role:'brain'});
});
