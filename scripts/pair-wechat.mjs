#!/usr/bin/env node
// Run only while this account has no active receiver. Credentials never go to stdout.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loginWithQR} from '../packages/wechat-transport/dist/auth.js';

export async function pairWeChat(profile, explicitOwner, login = loginWithQR) {
if (!profile || !path.isAbsolute(profile)) throw new Error('Usage: node scripts/pair-wechat.mjs /absolute/profile [verified-owner-id]');
const runtimeFile = path.join(profile, 'runtime.json');
const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
if (runtime.role !== 'brain' || runtime.wechat) throw new Error('Pair a new brain profile only; stop and preserve existing bindings before migration.');
const accountFile = path.join(profile, 'wechat-account.json');
if (fs.existsSync(accountFile)) throw new Error('Account file already exists; preserving it.');
const result = await login();
if (explicitOwner && result.ownerId && explicitOwner !== result.ownerId) throw new Error('Explicit owner differs from confirmed QR identity.');
const ownerId = result.ownerId || explicitOwner;
if (!ownerId) throw new Error('Platform omitted owner identity. Obtain the verified owner ID and rerun with it; no sender was automatically trusted.');
fs.writeFileSync(accountFile, JSON.stringify({accountId:result.accountId, token:result.token, baseUrl:result.baseUrl})+'\n', {mode:0o600, flag:'wx'});
runtime.wechat = {accountFile, ownerId};
const temp = runtimeFile+'.pairing';
fs.writeFileSync(temp, JSON.stringify(runtime,null,2)+'\n', {mode:0o600, flag:'wx'});
fs.renameSync(temp, runtimeFile);
console.log('WeChat account saved privately and QR owner bound. Start the brain runtime, then send it a message from WeChat.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await pairWeChat(...process.argv.slice(2));
}
