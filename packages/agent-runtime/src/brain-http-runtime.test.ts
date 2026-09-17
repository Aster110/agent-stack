import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {createRequire} from 'node:module'
import {FakeAppServerClient} from '@cc-mesh/codex-seat'
import {startUnifiedRuntime,validateRuntimeConfig,type RuntimeConfig} from './index.js'
const require=createRequire(import.meta.url)
const {createServer}=require('../../relay/dist/server.js')

const TOKEN='runtime-e2e-token-0123456789'
const freePort=async():Promise<number>=>new Promise(resolve=>{
  const probe=net.createServer()
  probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address() as AddressInfo;probe.close(()=>resolve(port))})
})
async function readSse(response:Response):Promise<Array<Record<string,any>>>{
  const events:Array<Record<string,any>>=[]
  const reader=response.body!.getReader()
  const decoder=new TextDecoder()
  let buffer=''
  for(;;){
    const {done,value}=await reader.read()
    if(done)break
    buffer+=decoder.decode(value,{stream:true})
    let cut
    while((cut=buffer.indexOf('\n\n'))>=0){
      const frame=buffer.slice(0,cut);buffer=buffer.slice(cut+2)
      for(const line of frame.split('\n'))if(line.startsWith('data:'))events.push(JSON.parse(line.slice(5).trim()))
    }
  }
  return events
}

test('the real brain runtime answers an HTTP ask on the same thread that serves WeChat',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-http-runtime-'))
  const terminal={inject:async()=>{throw new Error('no terminal')},spawn:async()=>{throw new Error('no terminal')},isAlive:async()=>true,close:async()=>{},getCurrentSession:async()=>null}
  const app=createServer({deviceId:'brainhttp',dbPath:path.join(root,'relay.sqlite'),profileHome:root,terminal})
  const relay=http.createServer(app);await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r))
  const relayUrl=`http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const accountFile=path.join(root,'account.json')
  fs.writeFileSync(accountFile,JSON.stringify({accountId:'fixture',token:'synthetic-token'}))
  const tokenFile=path.join(root,'brain-channel-token')
  fs.writeFileSync(tokenFile,TOKEN+'\n',{mode:0o600})
  fs.chmodSync(tokenFile,0o600)
  const channelPort=await freePort()
  const healthPort=await freePort()
  const config:RuntimeConfig={version:1,role:'brain',seat:'brain',cwd:path.join(root,'work'),
    stateRoot:path.join(root,'state'),relayUrl,relayDatabase:path.join(root,'relay.sqlite'),healthPort,
    peerNodes:['brainhttp:computer'],codex:{bin:'/synthetic/codex'},executionPolicy:'full-access',
    wechat:{accountFile,ownerId:'owner'},brainChannel:{tokenFile,port:channelPort}}

  const wechatSent:string[]=[]
  const engine=new FakeAppServerClient({scenario:{defaultTurn:{completeAfterMs:10,outcome:{status:'completed',finalText:'pong'}}}})
  const threads:string[]=[]
  const startTurn=engine.turnStart.bind(engine)
  engine.turnStart=async request=>{threads.push(request.threadId);return startTurn(request)}
  const runtime=await startUnifiedRuntime(config,{seat:{engine,receiptRetryMs:25,log:()=>{}},
    wechatApi:{poll:async()=>({ret:0,msgs:[]}),send:async(_t,_to,text)=>{wechatSent.push(text);return {messageId:String(wechatSent.length+1)}}}})
  t.after(async()=>{await runtime.stop();relay.closeAllConnections();await new Promise<void>(r=>relay.close(()=>r()));app.store.close();fs.rmSync(root,{recursive:true,force:true})})

  const base=`http://127.0.0.1:${channelPort}`
  const auth={Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'}
  const health=await (await fetch(`${base}/v1/brain/health`,{headers:auth})).json() as any
  assert.equal(health.ok,true)
  assert.equal(health.seat,runtime.seat.nodeId)

  const response=await fetch(`${base}/v1/brain/ask`,{method:'POST',headers:auth,
    body:JSON.stringify({sessionId:'w7-e2e',text:'链路测试：请只回 pong',source:'chat',waitSec:30})})
  const events=await readSse(response)
  assert.deepEqual(events.map(e=>e.type),['accepted','final'])
  assert.equal(events[1]!.text,'pong')
  assert.equal(wechatSent.length,0,'an HTTP ask must not be answered into WeChat')

  // Same owner, same brain, same Codex thread: WeChat and HTTP are two doors into one conversation.
  runtime.wechat!.store.acceptBatch([{message_id:'owner-1',message_type:1,from_user_id:'owner',
    context_token:'fixture-context',item_list:[{type:1,text_item:{text:'微信这边问一句'}}]}],'cursor','owner')
  const end=Date.now()+5000
  while(wechatSent.length===0){if(Date.now()>end)throw new Error('WeChat reply timed out');await new Promise(r=>setTimeout(r,10))}
  await runtime.seat.drain()
  assert.equal(wechatSent[0],'pong')
  const state=runtime.seat.state()
  assert.equal(state.resumableThreads.length,1,'two channels must not open two threads')
  assert.equal(state.resumableThreads[0],state.mainThreadId)
  assert.equal(threads.length,2,'both the HTTP ask and the WeChat message ran a turn')
  assert.equal(new Set(threads).size,1,'two channels must share one Codex thread')

  const runtimeHealth=await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json() as any
  assert.equal(runtimeHealth.brainHttp.ok,true)
  assert.equal(runtimeHealth.brainHttp.port,channelPort)
  assert.equal(runtimeHealth.wechat.ok,true)
})

test('a world-readable token file is refused instead of silently serving the brain',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-http-perm-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const tokenFile=path.join(root,'token')
  fs.writeFileSync(tokenFile,TOKEN)
  fs.chmodSync(tokenFile,0o644)
  const config:RuntimeConfig={version:1,role:'brain',seat:'brain',cwd:path.join(root,'work'),
    stateRoot:path.join(root,'state'),relayUrl:'http://127.0.0.1:19800',peerNodes:['x:y'],
    codex:{bin:'/synthetic/codex'},executionPolicy:'full-access',brainChannel:{tokenFile}}
  await assert.rejects(startUnifiedRuntime(config),/group\/world accessible/)
})

test('config validation pins the brain channel to the brain role and absolute private paths',async()=>{
  const base={version:1,seat:'brain',cwd:'/tmp/w',stateRoot:'/tmp/s',relayUrl:'http://127.0.0.1:19800',
    peerNodes:['x:y'],codex:{bin:'/usr/bin/codex'},executionPolicy:'full-access'} as const
  assert.throws(()=>validateRuntimeConfig({...base,role:'computer',brainChannel:{tokenFile:'/tmp/t'}}),/brain role/)
  assert.throws(()=>validateRuntimeConfig({...base,role:'brain',brainChannel:{tokenFile:'relative'}}),/tokenFile must be absolute/)
  assert.throws(()=>validateRuntimeConfig({...base,role:'brain',brainChannel:{tokenFile:'/tmp/t',port:0}}),/invalid brainChannel.port/)
  assert.throws(()=>validateRuntimeConfig({...base,role:'brain',brainChannel:{tokenFile:'/tmp/t',stateFile:'x.json'}}),/stateFile must be absolute/)
  const ok=validateRuntimeConfig({...base,role:'brain',brainChannel:{tokenFile:'/tmp/t',port:18090}})
  assert.equal(ok.brainChannel!.port,18090)
})
