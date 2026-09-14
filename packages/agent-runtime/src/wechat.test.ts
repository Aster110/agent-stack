import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {WeChatStore} from './wechat-store.js'
import {DurableWeChatChannel,type WeChatApi} from './wechat.js'
import {validateRuntimeConfig} from './index.js'
import type {SeatHandle} from '@cc-mesh/codex-seat'
import {getUpdates,sendMessage} from '@cc-mesh/wechat-transport/api'
import {RuntimeLease} from './runtime-lease.js'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {rawMessageId} from './wechat-store.js'

function file(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unified-wechat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'store.sqlite')}
const raw=(id:number)=>({message_id:id,message_type:1,from_user_id:'owner',context_token:'private-test-context',item_list:[{type:1,text_item:{text:`task ${id}`}}]})
const account={accountId:'test-bot',token:'synthetic-token'}
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
async function until(fn:()=>boolean){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('condition timed out');await delay(5)}}

test('raw messages and cursor survive restart atomically before model handoff',t=>{
  const db=file(t);let store=new WeChatStore(db,'test-bot','owner')
  store.acceptBatch([raw(1),raw(2)],'cursor-2','owner');store.close()
  store=new WeChatStore(db,'test-bot','owner')
  assert.equal(store.cursor(),'cursor-2');assert.equal(store.pending().length,2)
  store.acceptBatch([raw(1),raw(2)],'cursor-2','owner')
  assert.equal(store.pending().length,2)
  store.accepted(store.pending()[0]!.id);store.close()
  store=new WeChatStore(db,'test-bot','owner');assert.equal(store.pending().length,1);store.close()
})

test('wrong sender never enters the inbox and cannot replace owner reply context',t=>{
  const store=new WeChatStore(file(t),'test-bot','owner')
  store.acceptBatch([raw(1),{...raw(2),from_user_id:'stranger',context_token:'wrong-context'}],'next','owner')
  assert.equal(store.pending().length,1);assert.equal(store.token('owner'),'private-test-context');assert.throws(()=>store.token('stranger'))
  store.close()
})

test('account/owner change fails visibly instead of delivering old results to new binding',t=>{
  const db=file(t);const store=new WeChatStore(db,'test-bot','owner');store.close()
  assert.throws(()=>new WeChatStore(db,'different-bot','owner'),/binding/)
  assert.throws(()=>new WeChatStore(db,'test-bot','different-owner'),/binding/)
})

test('multipart reply resumes after last confirmed part with stable IDs and persisted context',async t=>{
  const db=file(t);let store=new WeChatStore(db,'test-bot','owner');store.acceptBatch([raw(1)],'cursor','owner')
  const sent:Array<{text:string;token:string;id:string|undefined}>=[]
  let fail=true
  const api:WeChatApi={poll:async()=>({ret:0,msgs:[]}),send:async(_token,_to,text,context,_base,id)=>{
    if(fail&&sent.length===1)throw new Error('connection lost before second part')
    sent.push({text,token:context,id});return {messageId:String(sent.length)}
  }}
  let channel=new DurableWeChatChannel('owner',account,store,api)
  const output={id:'logical-delivery',kind:'done' as const,text:'甲'.repeat(6500)}
  await assert.rejects(channel.send('owner',output),/connection lost/)
  const first=sent[0]!.id;await channel.stop()
  fail=false;store=new WeChatStore(db,'test-bot','owner');channel=new DurableWeChatChannel('owner',account,store,api)
  await channel.send('owner',output);await channel.send('owner',output)
  assert.equal(sent.length,3);assert.equal(sent[0]!.id,first);assert.equal(new Set(sent.map(s=>s.id)).size,3)
  assert.ok(sent.every(s=>s.token==='private-test-context'));assert.equal(sent.map(s=>s.text).join(''),output.text)
  await channel.stop()
})

test('failed durable handoff keeps raw input and retries without polling-model coupling',async t=>{
  const store=new WeChatStore(file(t),'test-bot','owner');store.acceptBatch([raw(3)],'cursor','owner')
  let attempts=0,allow=false
  const seat={deliver:()=>{attempts++;if(!allow)throw new Error('WAL unavailable');return 'accepted'}} as unknown as SeatHandle
  const channel=new DurableWeChatChannel('owner',account,store,{poll:async()=>({ret:0,msgs:[]}),send:async()=>({messageId:'1'})})
  channel.start(seat);await until(()=>attempts>0);assert.equal(store.pending().length,1)
  allow=true;await until(()=>store.pending().length===0);assert.ok(attempts>=2);await channel.stop()
})

test('stop aborts a real HTTP long poll and causes no late intake',async t=>{
  let requested=false,delivered=0
  const server=http.createServer((_req,_res)=>{requested=true})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))})
  const store=new WeChatStore(file(t),'test-bot','owner')
  const channel=new DurableWeChatChannel('owner',{...account,baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`},store)
  channel.start({deliver:()=>{delivered++;return 'accepted'}} as unknown as SeatHandle)
  await until(()=>requested)
  const before=Date.now();await channel.stop();await delay(30)
  assert.ok(Date.now()-before<1000);assert.equal(delivered,0)
})

test('role configuration uses explicit peers, local relay and explicit execution policy',()=>{
  const config={version:1,role:'computer',seat:'computer',cwd:'/tmp/work',stateRoot:'/tmp/state',relayUrl:'http://127.0.0.1:19800',peerNodes:['cloud:brain'],codex:{bin:'/usr/bin/codex'},executionPolicy:'full-access'}
  assert.equal(validateRuntimeConfig(config).role,'computer')
  assert.throws(()=>validateRuntimeConfig({...config,peerNodes:['*:brain']}),/explicit/)
  assert.throws(()=>validateRuntimeConfig({...config,executionPolicy:undefined}),/explicit/)
  assert.throws(()=>validateRuntimeConfig({...config,wechat:{accountFile:'/tmp/account',ownerId:'owner'}}),/brain/)
})

test('incoming int64 message IDs remain distinct through real HTTP JSON parsing',async t=>{
  const server=http.createServer((_req,res)=>res.end('{"ret":0,"msgs":[{"message_id":7498796439671022216,"from_user_id":"owner"},{"message_id":7498796439671022217,"from_user_id":"owner"}]}'))
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const response=await getUpdates('synthetic-token','',`http://127.0.0.1:${(server.address() as AddressInfo).port}`,1000)
  assert.deepEqual(response.msgs?.map(m=>m.message_id),['7498796439671022216','7498796439671022217'])
  assert.notEqual(rawMessageId(response.msgs![0]!),rawMessageId(response.msgs![1]!))
})

test('HTTP timeout covers a body that hangs after headers arrive',async t=>{
  const server=http.createServer((_req,res)=>{res.writeHead(200);res.flushHeaders();res.write('{')})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const before=Date.now()
  const response=await getUpdates('synthetic-token','cursor',`http://127.0.0.1:${(server.address() as AddressInfo).port}`,50)
  assert.ok(Date.now()-before<1000);assert.equal(response.get_updates_buf,'cursor')
})

test('exclusive state lease rejects duplicate processes and is released by SIGKILL',async t=>{
  const db=file(t)
  const lease=new RuntimeLease(db)
  assert.throws(()=>new RuntimeLease(db),/another process/)
  lease.close()
  const child=spawn(process.execPath,['--input-type=module','-e',`import {RuntimeLease} from ${JSON.stringify(new URL('./runtime-lease.js',import.meta.url).href)};new RuntimeLease(${JSON.stringify(db)});process.stdout.write('locked');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore']})
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')})
  await once(child.stdout!,'data');assert.throws(()=>new RuntimeLease(db),/another process/)
  const exited=once(child,'exit');child.kill('SIGKILL');await exited
  const recovered=new RuntimeLease(db);recovered.close()
})

test('HTTP 200 without a valid send acknowledgement never advances delivery checkpoint',async t=>{
  let response=''
  const server=http.createServer((_req,res)=>res.end(response))
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  t.after(()=>{server.closeAllConnections();server.close()})
  const store=new WeChatStore(file(t),'test-bot','owner');store.acceptBatch([raw(1)],'cursor','owner')
  const channel=new DurableWeChatChannel('owner',{...account,baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`},store,{poll:async()=>({ret:0,msgs:[]}),send:sendMessage})
  const output={id:'ack-check',kind:'done' as const,text:'finished'}
  for(const malformed of ['', '<html>proxy error</html>', '{}', '{"ret":0}', '{"ret":"5","message_id":123}', '{"ret":0,"message_id":1.5}', '{"ret":0,"message_id":1e9}']){
    response=malformed
    await assert.rejects(channel.send('owner',output),/acknowledgement/)
    assert.equal(store.delivery(output.id,output.text).next_part,0)
    assert.equal(store.delivery(output.id,output.text).done,0)
  }
  response='{"ret":0,"message_id":7498796439671022216}'
  await channel.send('owner',output)
  assert.equal(store.delivery(output.id,output.text).done,1)
  await channel.stop()
})
