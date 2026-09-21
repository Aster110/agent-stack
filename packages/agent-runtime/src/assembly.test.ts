import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {createRequire} from 'node:module'
import {FakeAppServerClient,MeshClient} from '@cc-mesh/codex-seat'
import {startUnifiedRuntime,type RuntimeConfig,type UnifiedRuntime} from './index.js'
const require=createRequire(import.meta.url)
const {createServer}=require('../../relay/dist/server.js')

test('same runtime assembles brain and computer with real relay, correlated result and original owner',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unified-assembly-'))
  let terminalCalls=0
  const terminal={inject:async()=>{terminalCalls++;throw new Error('no terminal')},spawn:async()=>{terminalCalls++;throw new Error('no terminal')},isAlive:async()=>true,close:async()=>{},getCurrentSession:async()=>null}
  const app=createServer({deviceId:'assembly',dbPath:path.join(root,'relay.sqlite'),profileHome:root,terminal})
  const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const relayUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const runtimes:UnifiedRuntime[]=[]
  t.after(async()=>{for(const runtime of runtimes)await runtime.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));app.store.close();fs.rmSync(root,{recursive:true,force:true})})
  const base={version:1,cwd:path.join(root,'work'),relayUrl,codex:{bin:'/synthetic/codex'},executionPolicy:'full-access'} as const
  const accountFile=path.join(root,'account.json');fs.writeFileSync(accountFile,JSON.stringify({accountId:'fixture',token:'synthetic-token'}))
  const brainConfig:RuntimeConfig={...base,role:'brain',seat:'brain',stateRoot:path.join(root,'brain'),peerNodes:['assembly:computer'],relayDatabase:path.join(root,'relay.sqlite'),wechat:{accountFile,ownerId:'owner'}}
  const outputs:string[]=[]
  let acknowledge=false,modelStarts=0
  const brainEngine=new FakeAppServerClient({scenario:{defaultTurn:{completeAfterMs:5,outcome:{status:'completed',finalText:'owner-result'}}}})
  const startTurn=brainEngine.turnStart.bind(brainEngine)
  brainEngine.turnStart=async request=>{modelStarts++;return startTurn(request)}
  const brain=await startUnifiedRuntime(brainConfig,{seat:{engine:brainEngine,receiptRetryMs:25,log:()=>{}},wechatApi:{poll:async()=>({ret:0,msgs:[]}),send:async(_token,to,text)=>{assert.equal(to,'owner');if(!acknowledge)return {};outputs.push(text);return {messageId:String(outputs.length)}}}})
  runtimes.push(brain)
  const computerEngine=new FakeAppServerClient({scenario:{defaultTurn:{completeAfterMs:250,outcome:{status:'completed',finalText:'computer-evidence'}}}})
  const originalComputerStart=computerEngine.turnStart.bind(computerEngine)
  let unresponsive:(request:{threadId:string;msgId:string})=>void=()=>{}
  const originalEvents=computerEngine.onEvent.bind(computerEngine)
  computerEngine.onEvent=handler=>{
    unresponsive=request=>handler({type:'request.unresponsive',...request})
    return originalEvents(handler)
  }
  computerEngine.turnStart=async request=>{
    assert.equal(request.timeoutMs,0,'unified runtime must disable the destructive engine deadline')
    assert.ok(request.text.includes(`[mesh-task-id:${request.msgId}]`))
    const handle=await originalComputerStart(request)
    setTimeout(()=>unresponsive(request),20)
    return handle
  }
  const computer=await startUnifiedRuntime({...base,role:'computer',seat:'computer',stateRoot:path.join(root,'computer'),peerNodes:['assembly:brain']},{seat:{engine:computerEngine,log:()=>{}}})
  runtimes.push(computer)
  // Fake engines use the same deterministic ID counter; identities/state must still be separate.
  assert.notEqual(brain.seat.state(),computer.seat.state())
  assert.notEqual(brain.seat.nodeId,computer.seat.nodeId)
  brain.wechat!.store.acceptBatch([{message_id:'owner-request',message_type:1,from_user_id:'owner',context_token:'fixture-context',item_list:[{type:1,text_item:{text:'coordinate a task'}}]}],'cursor','owner')
  const until=async(fn:()=>boolean)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw new Error('assembly timed out');await new Promise(r=>setTimeout(r,10))}}
  await until(()=>brain.seat.state().lastDoneAt!==null)
  assert.equal((await brain.seat.status()).wal.completed,1)
  assert.equal(outputs.length,0)
  acknowledge=true
  await until(()=>outputs.length===1)
  assert.equal(modelStarts,1,'delivery retry must not reexecute model')
  const mesh=new MeshClient(relayUrl)
  const task=await mesh.send({from:brain.seat.nodeId,to:computer.seat.nodeId,message:'complete assigned test work',type:'task'})
  await mesh.send({from:computer.seat.nodeId,to:brain.seat.nodeId,message:`[failed] nonce=legacy node=${computer.seat.nodeId} reason=timeout detail=old runtime threshold`,type:'system',replyTo:task.msgId})
  await until(()=>outputs.length===2)
  await brain.seat.drain();await computer.seat.drain()
  assert.equal(modelStarts,2)
  assert.equal(Object.keys(brain.seat.state().taskResultOrigins??{}).length,1)
  assert.equal(brain.seat.state().resumableThreads.length,1)
  assert.equal(computer.seat.state().resumableThreads.length,1)
  assert.equal(terminalCalls,0)
  assert.equal((await computer.seat.status()).wal.completed,0)
  await assert.rejects(startUnifiedRuntime(brainConfig),/another process/)
  const realStop=brain.seat.stop.bind(brain.seat)
  brain.seat.stop=async reason=>{await realStop(reason);throw new Error('drain failure fixture')}
  await assert.rejects(brain.stop(),/drain failure/)
  assert.equal(brain.wechat!.health().pending,null,'failed drain still closes the intake store')
  const replacement=await startUnifiedRuntime(brainConfig,{seat:{engine:new FakeAppServerClient(),log:()=>{}},wechatApi:{poll:async()=>({ret:0,msgs:[]}),send:async()=>({messageId:'1'})}})
  runtimes.push(replacement)
})
