// Manual, opt-in real Codex acceptance. No live WeChat or production relay.
// Usage: node scripts/unified-runtime-real-smoke.mjs /absolute/path/to/codex
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {randomBytes} from 'node:crypto'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {startUnifiedRuntime} from '../packages/agent-runtime/dist/index.js'
import {MeshClient} from '../packages/codex-seat/dist/src/index.js'
const require=createRequire(import.meta.url)
const {createServer}=require('../packages/relay/dist/server.js')
const binary=process.argv[2]
if(!binary||!path.isAbsolute(binary))throw new Error('Pass an explicit absolute Codex binary; this test uses its existing authenticated account.')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'unified-real-smoke-'))
const evidence={startedAt:new Date().toISOString(),node:process.version,platform:process.platform,root,checks:[],real:['Codex app-server','relay HTTP/SQLite','runtime','WeChat HTTP adapter'],simulated:['WeChat platform','peer sender']}
const outputs=[],incoming=[]
let terminalCalls=0,runtime=null,server=null,platform=null
const terminal={inject:async()=>{terminalCalls++;throw new Error('terminal injection must not run')},spawn:async()=>{terminalCalls++;throw new Error('terminal spawn must not run')},isAlive:async()=>true,close:async()=>{},getCurrentSession:async()=>null}
const app=createServer({deviceId:'runtime-lab',dbPath:path.join(root,'relay.sqlite'),profileHome:root,terminal})
async function listen(s){await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}`}
async function until(fn,label){const end=Date.now()+240000;while(!fn()){if(Date.now()>end)throw new Error(`Timed out: ${label}`);await new Promise(r=>setTimeout(r,100))}}
function checkpoint(name,details={}){evidence.checks.push({name,...details});console.log(JSON.stringify({check:name,...details}))}
try{
  server=http.createServer(app);const relayUrl=await listen(server)
  platform=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk
    const body=JSON.parse(text||'{}');res.setHeader('content-type','application/json')
    if(req.url.endsWith('/getupdates'))res.end(JSON.stringify({ret:0,msgs:incoming.splice(0),get_updates_buf:'fixture-cursor'}))
    else if(req.url.endsWith('/sendmessage')){outputs.push(body);res.end('{"ret":0,"message_id":"7498796439671022216"}')}
    else {res.statusCode=404;res.end('{}')}
  })
  const baseUrl=await listen(platform)
  const accountFile=path.join(root,'synthetic-account.json')
  fs.writeFileSync(accountFile,JSON.stringify({accountId:'fixture-bot',token:'synthetic-token',baseUrl}),{mode:0o600})
  const config={version:1,role:'brain',seat:'brain',cwd:path.join(root,'work'),stateRoot:path.join(root,'state'),relayUrl,relayDatabase:path.join(root,'relay.sqlite'),peerNodes:['runtime-lab:probe'],codex:{bin:binary},executionPolicy:'full-access',wechat:{accountFile,ownerId:'fixture-owner'}}
  const peer=new MeshClient(relayUrl);await peer.register({shortId:'probe',role:'worker',description:'isolated synthetic test peer',pid:process.pid})
  runtime=await startUnifiedRuntime(config)
  assert.ok((await runtime.seat.status()).engine.alive,'real engine alive')
  const thread=runtime.seat.state().mainThreadId
  const nonce=randomBytes(10).toString('hex')
  const push=(id,text)=>incoming.push({message_id:String(id),message_type:1,from_user_id:'fixture-owner',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]})
  push(1,`This is an isolated runtime acceptance test. Remember the test code ${nonce} for this conversation. Reply exactly READY ${nonce}. Do not use tools.`)
  await until(()=>JSON.stringify(outputs).includes(`READY ${nonce}`),'first WeChat result')
  checkpoint('real Codex handles WeChat adapter input',{threadId:thread})
  const task=await peer.send({from:'runtime-lab:probe',to:runtime.seat.nodeId,message:'In this isolated test, what was the test code provided in the previous owner message? Reply exactly RECALL followed by that code. Do not use tools.',type:'task'})
  let meshResult=''
  const end=Date.now()+240000
  while(!meshResult){
    if(Date.now()>end)throw new Error('mesh reply timed out')
    const batch=await peer.sync({nodeId:'runtime-lab:probe',since:0,timeoutSec:1,limit:100})
    meshResult=batch.messages.find(m=>m.replyTo===task.msgId && m.type==='result')?.payload??''
  }
  assert.ok(meshResult.includes(`RECALL ${nonce}`),meshResult)
  checkpoint('mesh input recalls WeChat context and replies to original peer')
  await runtime.stop();runtime=null
  runtime=await startUnifiedRuntime(config)
  assert.equal(runtime.seat.state().mainThreadId,thread)
  const artifact=path.join(config.cwd,'verified.txt')
  push(2,`Continue the isolated acceptance test. Write only the test code remembered from earlier in this conversation to ${artifact}. Use a tool to actually create the file. Then reply exactly RECOVERED followed by the code. Do not inspect any other files.`)
  await until(()=>JSON.stringify(outputs).includes(`RECOVERED ${nonce}`),'restarted owner result')
  assert.equal(fs.readFileSync(artifact,'utf8').trim(),nonce)
  assert.equal(runtime.seat.state().mainThreadId,thread)
  checkpoint('restart resumes same thread and real tool creates exact artifact')
  assert.equal(terminalCalls,0)
  checkpoint('zero terminal/tmux operations')
  evidence.status='passed'
}catch(error){evidence.status='failed';evidence.error=String(error);process.exitCode=1;console.error(String(error))}
finally{
  await runtime?.stop().catch(e=>{evidence.shutdownError=String(e);process.exitCode=1})
  for(const s of [server,platform])if(s){s.closeAllConnections();await new Promise(r=>s.close(r))}
  app.store.close();evidence.finishedAt=new Date().toISOString()
  fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify({evidence:path.join(root,'evidence.json'),status:evidence.status}))
}
