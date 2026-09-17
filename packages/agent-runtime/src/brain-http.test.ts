import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {BrainHttpChannel,BrainHttpStore,BRAIN_HTTP_CHANNEL,type BrainSeat} from './brain-http.js'
import type {ChannelInput,ChannelOutput} from '@cc-mesh/codex-seat'

const TOKEN='test-token-0123456789abcdef'
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))

/** Fake seat: records deliveries and lets each test decide when (and whether) a reply comes back. */
class FakeSeat implements BrainSeat {
  readonly nodeId='s1:brain'
  readonly delivered:ChannelInput[]=[]
  accept:'accepted'|'duplicate'|'throw'='accepted'
  deliver(input:ChannelInput):'accepted'|'duplicate'{
    if(this.accept==='throw')throw new Error('seat is not accepting messages')
    this.delivered.push(input)
    return this.accept
  }
}

interface Harness {
  channel:BrainHttpChannel
  seat:FakeSeat
  store:BrainHttpStore
  base:string
  stateFile:string
  logs:Array<Record<string,unknown>>
  reply(index:number,text:string,kind?:ChannelOutput['kind']):Promise<void>
}

async function harness(t:any,opts:{token?:string}={}):Promise<Harness>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brain-http-'))
  const stateFile=path.join(dir,'brain-http.json')
  const store=new BrainHttpStore(stateFile)
  const seat=new FakeSeat()
  const logs:Array<Record<string,unknown>>=[]
  const channel=new BrainHttpChannel({token:opts.token??TOKEN,port:0,store,log:r=>logs.push(r)})
  await channel.start(seat)
  t.after(async()=>{await channel.stop();fs.rmSync(dir,{recursive:true,force:true})})
  return {channel,seat,store,stateFile,logs,base:`http://127.0.0.1:${channel.port}`,
    async reply(index:number,text:string,kind:ChannelOutput['kind']='done'){
      const input=seat.delivered[index]
      if(!input)throw new Error('no delivery at index '+index)
      await channel.send(input.endpointId,{id:`${BrainHttpChannel.messageId(input.endpointId,input.id)}:${kind}`,kind,text})
    }}
}

/** Reads an SSE body to completion and returns the parsed `data:` payloads in order. */
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

const ask=(h:Harness,body:unknown,token:string|null=TOKEN)=>fetch(`${h.base}/v1/brain/ask`,{method:'POST',
  headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)})
const get=(h:Harness,pathname:string,token:string|null=TOKEN)=>fetch(h.base+pathname,
  {headers:token?{Authorization:`Bearer ${token}`}:{}})

test('ask streams accepted then final for the reply that comes back on the same session', async t=>{
  const h=await harness(t)
  const response=await ask(h,{sessionId:'s-1',text:'链路测试：请只回 pong',source:'chat',waitSec:30})
  assert.equal(response.status,200)
  assert.equal(response.headers.get('content-type'),'text/event-stream')
  const collected=readSse(response)
  await until(()=>h.seat.delivered.length===1,'delivery')
  assert.equal(h.seat.delivered[0]!.channel,BRAIN_HTTP_CHANNEL)
  assert.equal(h.seat.delivered[0]!.endpointId,'chat:s-1')
  await h.reply(0,'pong')
  const events=await collected
  assert.deepEqual(events.map(e=>e.type),['accepted','final'])
  assert.equal(events[0]!.queued,false)
  assert.equal(typeof events[0]!.turnId,'string')
  assert.equal(events[1]!.text,'pong')
  assert.equal(events[1]!.turnId,events[0]!.turnId)
})

test('voice source carries the voice: endpoint into the seat and tags the text so the brain sees it', async t=>{
  const h=await harness(t)
  const response=await ask(h,{sessionId:'v-1',text:'现在几点',source:'voice',waitSec:1})
  const collected=readSse(response)
  await until(()=>h.seat.delivered.length===1,'delivery')
  assert.equal(h.seat.delivered[0]!.endpointId,'voice:v-1')
  assert.equal(h.seat.delivered[0]!.text,'[voice:v-1] 现在几点')
  await collected
  // The transcript the chat page redraws keeps the owner's own words, not the routing tag.
  const history=await (await get(h,'/v1/brain/history?sessionId=v-1')).json() as any
  assert.deepEqual(history.messages.map((m:any)=>m.text),['现在几点'])
})

test('waitSec expiry closes the stream with pending, and the late reply is drained once by replies', async t=>{
  const h=await harness(t)
  const response=await ask(h,{sessionId:'s-2',text:'慢活',source:'chat',waitSec:1})
  const events=await readSse(response)
  assert.deepEqual(events.map(e=>e.type),['accepted','pending'])
  const turnId=events[0]!.turnId
  assert.equal(events[1]!.turnId,turnId)

  await h.reply(0,'late answer')
  const first=await (await get(h,'/v1/brain/replies?sessionId=s-2')).json() as any
  assert.deepEqual(first.replies.map((r:any)=>[r.turnId,r.text]),[[turnId,'late answer']])
  assert.equal(typeof first.replies[0].at,'string')
  const second=await (await get(h,'/v1/brain/replies?sessionId=s-2')).json() as any
  assert.deepEqual(second.replies,[])
})

test('pending replies survive a channel restart because the store is on disk', async t=>{
  const h=await harness(t)
  const response=await ask(h,{sessionId:'s-3',text:'重启前问的',source:'chat',waitSec:1})
  await readSse(response)
  await h.reply(0,'answer written while nobody listened')
  const reloaded=new BrainHttpStore(h.stateFile)
  assert.deepEqual(reloaded.takeReplies('s-3').map(r=>r.text),['answer written while nobody listened'])
})

test('a second ask while one turn is in flight is accepted as queued, not rejected', async t=>{
  const h=await harness(t)
  const first=await ask(h,{sessionId:'s-4',text:'第一句',source:'chat',waitSec:1})
  const firstEvents=readSse(first)
  await until(()=>h.seat.delivered.length===1,'first delivery')
  const second=await ask(h,{sessionId:'s-4',text:'第二句',source:'chat',waitSec:1})
  const secondEvents=readSse(second)
  await until(()=>h.seat.delivered.length===2,'second delivery')
  const a=await firstEvents, b=await secondEvents
  assert.equal(a[0]!.queued,false)
  assert.equal(b[0]!.queued,true)
  assert.notEqual(a[0]!.turnId,b[0]!.turnId)
})

test('health reports the seat node id and the number of turns still in flight', async t=>{
  const h=await harness(t)
  const idle=await (await get(h,'/v1/brain/health')).json() as any
  assert.deepEqual(idle,{ok:true,seat:'s1:brain',inFlight:0})
  const response=await ask(h,{sessionId:'s-5',text:'在飞',source:'chat',waitSec:1})
  const collected=readSse(response)
  await until(()=>h.seat.delivered.length===1,'delivery')
  const busy=await (await get(h,'/v1/brain/health')).json() as any
  assert.equal(busy.inFlight,1)
  await collected
  await h.reply(0,'done now')
  const after=await (await get(h,'/v1/brain/health')).json() as any
  assert.equal(after.inFlight,0)
})

test('history returns this session in order with user and brain roles', async t=>{
  const h=await harness(t)
  const response=await ask(h,{sessionId:'s-6',text:'问题一',source:'chat',waitSec:30})
  const collected=readSse(response)
  await until(()=>h.seat.delivered.length===1,'delivery')
  await h.reply(0,'答案一')
  await collected
  const history=await (await get(h,'/v1/brain/history?sessionId=s-6')).json() as any
  assert.deepEqual(history.messages.map((m:any)=>[m.role,m.text]),[['user','问题一'],['brain','答案一']])
  assert.equal(history.messages[0].turnId,history.messages[1].turnId)
  const limited=await (await get(h,'/v1/brain/history?sessionId=s-6&limit=1')).json() as any
  assert.deepEqual(limited.messages.map((m:any)=>m.role),['brain'])
})

test('every route refuses a missing or wrong bearer token', async t=>{
  const h=await harness(t)
  for(const token of [null,'wrong-token']){
    const posted=await ask(h,{sessionId:'s-7',text:'x',source:'chat',waitSec:1},token)
    assert.equal(posted.status,401,'ask with '+token)
    assert.deepEqual(await posted.json(),{error:'unauthorized'})
    for(const route of ['/v1/brain/health','/v1/brain/replies?sessionId=s-7','/v1/brain/history?sessionId=s-7']){
      const got=await get(h,route,token)
      assert.equal(got.status,401,route+' with '+token)
    }
  }
  assert.equal(h.seat.delivered.length,0)
})

test('ask rejects bad source, oversized text, bad waitSec and missing session', async t=>{
  const h=await harness(t)
  const cases:Array<[unknown,string]>=[
    [{sessionId:'s-8',text:'x',source:'sms',waitSec:10},'invalid_source'],
    [{sessionId:'s-8',text:'x'.repeat(4001),source:'chat',waitSec:10},'text_too_long'],
    [{sessionId:'s-8',text:'x',source:'chat',waitSec:91},'invalid_waitSec'],
    [{sessionId:'',text:'x',source:'chat',waitSec:10},'invalid_sessionId'],
    [{sessionId:'s 8',text:'x',source:'chat',waitSec:10},'invalid_sessionId'],
    [{sessionId:'s-8',text:'   ',source:'chat',waitSec:10},'empty_text'],
  ]
  for(const [body,error] of cases){
    const response=await ask(h,body)
    assert.equal(response.status,400,error)
    assert.deepEqual(await response.json(),{error})
  }
  assert.equal(h.seat.delivered.length,0)
})

test('the channel only accepts voice/chat endpoints of this installation', async t=>{
  const h=await harness(t)
  for(const ok of ['voice:s-1','chat:abc_DEF-123'])assert.equal(h.channel.accepts(ok),true,ok)
  for(const bad of ['owner','wechat:s-1','chat:','chat:a b','voice:'+'x'.repeat(65),'chat:../etc'])
    assert.equal(h.channel.accepts(bad),false,bad)
})

test('a failed turn reaches the caller as an error event instead of a silent final', async t=>{
  const h=await harness(t)
  const response=await ask(h,{sessionId:'s-9',text:'会失败的',source:'chat',waitSec:30})
  const collected=readSse(response)
  await until(()=>h.seat.delivered.length===1,'delivery')
  await h.reply(0,'[failed] reason=turn-failed','failed')
  const events=await collected
  assert.deepEqual(events.map(e=>e.type),['accepted','error'])
  assert.equal(events[1]!.message,'[failed] reason=turn-failed')
})

test('logs record the turn and size but never the message text', async t=>{
  const h=await harness(t)
  const secret='绝密正文不应出现在日志里'
  const response=await ask(h,{sessionId:'s-10',text:secret,source:'chat',waitSec:30})
  const collected=readSse(response)
  await until(()=>h.seat.delivered.length===1,'delivery')
  await h.reply(0,'回复正文也不该进日志')
  await collected
  assert.ok(h.logs.length>0,'expected log records')
  const dump=JSON.stringify(h.logs)
  assert.ok(!dump.includes(secret),'request text leaked into logs')
  assert.ok(!dump.includes('回复正文也不该进日志'),'reply text leaked into logs')
  assert.ok(h.logs.some(r=>r.event==='brain-http-ask'&&typeof r.chars==='number'),'expected a sized ask record')
})

test('unknown routes and methods are refused after auth', async t=>{
  const h=await harness(t)
  assert.equal((await get(h,'/v1/brain/nope')).status,404)
  assert.equal((await fetch(`${h.base}/v1/brain/ask`,{headers:{Authorization:`Bearer ${TOKEN}`}})).status,404)
})

async function until(fn:()=>boolean,why:string):Promise<void>{
  const end=Date.now()+5000
  while(!fn()){if(Date.now()>end)throw new Error('timeout waiting for '+why);await sleep(5)}
}
