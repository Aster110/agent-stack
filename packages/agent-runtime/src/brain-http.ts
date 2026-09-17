import {createHash,randomUUID,timingSafeEqual} from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import {atomicWriteFileSync,type ChannelInput,type ChannelOutput,type SeatChannel} from '@cc-mesh/codex-seat'

/** Channel name. The seat namespaces message IDs and reply routes with it, so it is part of the on-disk contract. */
export const BRAIN_HTTP_CHANNEL='brain-http'
export const MAX_TEXT_CHARS=4000
export const MAX_WAIT_SEC=90
export const DEFAULT_WAIT_SEC=45
export const DEFAULT_PORT=18090
const SESSION=/^[A-Za-z0-9_-]{1,64}$/
const ENDPOINT=/^(voice|chat):[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES=64*1024
const IN_FLIGHT_MAX_AGE_MS=60*60*1000
const TURN_RETENTION_MS=24*60*60*1000
const MAX_REPLIES=1000
const MAX_HISTORY_PER_SESSION=200
const MAX_SESSIONS=200
const MAX_TURNS=2000

/** Only what this channel needs from the seat, so the contract is testable without an engine. */
export interface BrainSeat {readonly nodeId:string;deliver(input:ChannelInput):'accepted'|'duplicate'}
export interface BrainReply {turnId:string;text:string;at:string}
export interface BrainMessage {turnId:string;role:'user'|'brain';text:string;at:string}
interface StoredTurn {turnId:string;endpointId:string;at:string;settledAt?:string}
interface StoredReply extends BrainReply {endpointId:string}
interface StoreData {version:1;turns:Record<string,StoredTurn>;replies:StoredReply[];history:Record<string,BrainMessage[]>}

const now=():string=>new Date().toISOString()
const sessionOf=(endpointId:string):string=>endpointId.slice(endpointId.indexOf(':')+1)

/**
 * Durable side of the channel: which turns are open, which finals nobody collected yet, and the
 * per-session transcript the chat page redraws from. Plain JSON written atomically — a restart must
 * not lose an answer the model already produced.
 */
export class BrainHttpStore {
  private data:StoreData
  constructor(readonly file:string){
    let loaded:StoreData|null=null
    try{
      const parsed=JSON.parse(fs.readFileSync(file,'utf8')) as StoreData
      if(parsed&&parsed.version===1)loaded={version:1,turns:parsed.turns??{},replies:parsed.replies??[],history:parsed.history??{}}
    }catch{loaded=null}
    this.data=loaded??{version:1,turns:{},replies:[],history:{}}
  }
  flush():void{this.prune();atomicWriteFileSync(this.file,JSON.stringify(this.data))}
  private prune():void{
    const cutoff=Date.now()-TURN_RETENTION_MS
    for(const [msgId,turn] of Object.entries(this.data.turns))
      if(turn.settledAt&&Date.parse(turn.settledAt)<cutoff)delete this.data.turns[msgId]
    const ids=Object.keys(this.data.turns)
    if(ids.length>MAX_TURNS)for(const msgId of ids.sort((a,b)=>Date.parse(this.data.turns[a]!.at)-Date.parse(this.data.turns[b]!.at)).slice(0,ids.length-MAX_TURNS))delete this.data.turns[msgId]
    if(this.data.replies.length>MAX_REPLIES)this.data.replies=this.data.replies.slice(-MAX_REPLIES)
    const sessions=Object.keys(this.data.history)
    if(sessions.length>MAX_SESSIONS)for(const key of sessions.slice(0,sessions.length-MAX_SESSIONS))delete this.data.history[key]
  }
  openTurn(msgId:string,turnId:string,endpointId:string,text:string):void{
    this.data.turns[msgId]={turnId,endpointId,at:now()}
    this.record(endpointId,{turnId,role:'user',text,at:now()})
  }
  dropTurn(msgId:string):void{
    const turn=this.data.turns[msgId]
    if(!turn)return
    const log=this.data.history[turn.endpointId]
    if(log)this.data.history[turn.endpointId]=log.filter(m=>m.turnId!==turn.turnId)
    delete this.data.turns[msgId]
  }
  /** Marks the turn finished and returns it, so a reply can be routed back to the asking session. */
  settleTurn(msgId:string):StoredTurn|undefined{
    const turn=this.data.turns[msgId]
    if(turn&&!turn.settledAt)turn.settledAt=now()
    return turn
  }
  inFlight():number{
    const cutoff=Date.now()-IN_FLIGHT_MAX_AGE_MS
    return Object.values(this.data.turns).filter(t=>!t.settledAt&&Date.parse(t.at)>=cutoff).length
  }
  pendingReplies():number{return this.data.replies.length}
  private record(endpointId:string,message:BrainMessage):void{
    const log=this.data.history[endpointId]??(this.data.history[endpointId]=[])
    log.push(message)
    if(log.length>MAX_HISTORY_PER_SESSION)this.data.history[endpointId]=log.slice(-MAX_HISTORY_PER_SESSION)
  }
  recordBrainMessage(endpointId:string,turnId:string,text:string):void{this.record(endpointId,{turnId,role:'brain',text,at:now()})}
  queueReply(endpointId:string,turnId:string,text:string):void{this.data.replies.push({endpointId,turnId,text,at:now()})}
  dequeueReply(turnId:string):void{this.data.replies=this.data.replies.filter(r=>r.turnId!==turnId)}
  /** Take-and-destroy: a collected final is gone, so the caller must not poll the same answer twice. */
  takeReplies(sessionId?:string,after?:string):BrainReply[]{
    const match=(r:StoredReply):boolean=>(!sessionId||sessionOf(r.endpointId)===sessionId)&&(!after||r.at>after)
    const taken=this.data.replies.filter(match)
    if(taken.length){this.data.replies=this.data.replies.filter(r=>!match(r));this.flush()}
    return taken.map(({turnId,text,at})=>({turnId,text,at}))
  }
  history(sessionId:string,limit:number):BrainMessage[]{
    const merged=Object.entries(this.data.history)
      .filter(([endpointId])=>sessionOf(endpointId)===sessionId)
      .flatMap(([,messages])=>messages)
      .sort((a,b)=>a.at.localeCompare(b.at))
    return merged.slice(Math.max(0,merged.length-limit))
  }
}

export interface BrainHttpOptions {
  token:string
  port?:number
  host?:string
  store:BrainHttpStore
  log?:(record:Record<string,unknown>)=>void
}
interface OpenStream {res:http.ServerResponse;turnId:string;timer:NodeJS.Timeout}

/**
 * Third brain channel: HTTP in, the same Codex thread as WeChat and mesh, answer back to the asking
 * HTTP session. Transport only — no model process, no thread selection, no new authority: the token
 * buys the right to talk to the brain as its owner, nothing more.
 */
export class BrainHttpChannel implements SeatChannel {
  private readonly tokenHash:Buffer
  private readonly streams=new Map<string,OpenStream>()
  private server:http.Server|null=null
  private seat:BrainSeat|null=null
  private stopped=false
  private failure:string|null=null
  constructor(private readonly opts:BrainHttpOptions){
    if(!opts.token||opts.token.length<16)throw new Error('brain channel token must be at least 16 characters')
    this.tokenHash=createHash('sha256').update(opts.token).digest()
  }
  /** Mirrors the seat's channel message ID so a reply receipt can be mapped back to its turn. */
  static messageId(endpointId:string,id:string):string{
    return `channel:${BRAIN_HTTP_CHANNEL}:${createHash('sha256').update(JSON.stringify([endpointId,id])).digest('hex')}`
  }
  get port():number{
    const address=this.server?.address()
    return address&&typeof address==='object'?address.port:(this.opts.port??DEFAULT_PORT)
  }
  accepts(endpointId:string):boolean{return ENDPOINT.test(endpointId)}

  async send(endpointId:string,output:ChannelOutput):Promise<void>{
    if(!this.accepts(endpointId))throw new Error('brain channel endpoint not allowed')
    const msgId=output.id.slice(0,output.id.lastIndexOf(':'))
    if(output.kind==='seen'){this.streams.get(msgId)?.res.write(': working\n\n');return}
    const turn=this.opts.store.settleTurn(msgId)
    const turnId=turn?.turnId??msgId.slice(-32)
    // Persist first: an answer the model already produced must survive a socket that dies mid-write.
    this.opts.store.recordBrainMessage(endpointId,turnId,output.text)
    this.opts.store.queueReply(endpointId,turnId,output.text)
    this.opts.store.flush()
    const event=output.kind==='done'?{type:'final',turnId,text:output.text}:{type:'error',turnId,message:output.text}
    if(this.emit(msgId,event)){
      this.opts.store.dequeueReply(turnId)
      try{this.opts.store.flush()}catch(error){this.log({event:'brain-http-dequeue-failed',turnId,error:String(error)})}
    }
    this.log({event:'brain-http-reply',turnId,kind:output.kind,chars:[...output.text].length,streamed:!this.opts.store.pendingReplies()})
  }

  async start(seat:BrainSeat):Promise<void>{
    this.seat=seat
    const server=http.createServer((req,res)=>{this.handle(req,res).catch(error=>{
      this.failure=String(error);this.log({event:'brain-http-error',error:String(error)})
      if(!res.headersSent)this.json(res,500,{error:'internal'});else res.end()
    })})
    server.keepAliveTimeout=120_000
    server.headersTimeout=125_000
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject)
      server.listen(this.opts.port??DEFAULT_PORT,this.opts.host??'127.0.0.1',()=>{server.off('error',reject);resolve()})
    })
    this.server=server
    this.log({event:'brain-http-listening',port:this.port})
  }

  async stop():Promise<void>{
    this.stopped=true
    for(const [msgId,stream] of this.streams){clearTimeout(stream.timer);this.write(stream.res,{type:'pending',turnId:stream.turnId});stream.res.end();this.streams.delete(msgId)}
    const server=this.server
    this.server=null
    if(server)await new Promise<void>(resolve=>{server.closeAllConnections?.();server.close(()=>resolve())})
  }

  health():{ok:boolean;port:number;inFlight:number;pendingReplies:number;error:string|null}{
    return {ok:!this.stopped&&!!this.server&&!this.failure,port:this.port,
      inFlight:this.opts.store.inFlight(),pendingReplies:this.opts.store.pendingReplies(),error:this.failure}
  }

  // ---------------------------------------------------------------- internals

  private log(record:Record<string,unknown>):void{this.opts.log?.(record)}
  private write(res:http.ServerResponse,event:Record<string,unknown>):boolean{
    return res.write(`data: ${JSON.stringify(event)}\n\n`)!==false||true
  }
  private emit(msgId:string,event:Record<string,unknown>):boolean{
    const stream=this.streams.get(msgId)
    if(!stream)return false
    this.streams.delete(msgId)
    clearTimeout(stream.timer)
    try{stream.res.write(`data: ${JSON.stringify(event)}\n\n`);stream.res.end();return true}
    catch{return false}
  }
  private json(res:http.ServerResponse,status:number,body:unknown):void{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
    res.end(JSON.stringify(body))
  }
  private authorized(req:http.IncomingMessage):boolean{
    const header=req.headers.authorization
    if(typeof header!=='string'||!header.startsWith('Bearer '))return false
    return timingSafeEqual(createHash('sha256').update(header.slice(7)).digest(),this.tokenHash)
  }
  private async body(req:http.IncomingMessage):Promise<string>{
    const chunks:Buffer[]=[]
    let size=0
    for await(const chunk of req){
      size+=(chunk as Buffer).length
      if(size>MAX_BODY_BYTES)throw new Error('request body too large')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async handle(req:http.IncomingMessage,res:http.ServerResponse):Promise<void>{
    const url=new URL(req.url??'/','http://127.0.0.1')
    if(!this.authorized(req)){this.json(res,401,{error:'unauthorized'});return}
    if(req.method==='POST'&&url.pathname==='/v1/brain/ask')return this.ask(req,res)
    if(req.method==='GET'&&url.pathname==='/v1/brain/health'){
      this.json(res,200,{ok:!this.stopped&&!this.failure,seat:this.seat?.nodeId??null,inFlight:this.opts.store.inFlight()});return
    }
    if(req.method==='GET'&&url.pathname==='/v1/brain/replies'){
      const sessionId=url.searchParams.get('sessionId')??undefined
      if(sessionId&&!SESSION.test(sessionId)){this.json(res,400,{error:'invalid_sessionId'});return}
      this.json(res,200,{replies:this.opts.store.takeReplies(sessionId,url.searchParams.get('after')??undefined)});return
    }
    if(req.method==='GET'&&url.pathname==='/v1/brain/history'){
      const sessionId=url.searchParams.get('sessionId')??''
      if(!SESSION.test(sessionId)){this.json(res,400,{error:'invalid_sessionId'});return}
      const raw=Number(url.searchParams.get('limit')??50)
      const limit=Number.isFinite(raw)?Math.min(Math.max(Math.trunc(raw),1),MAX_HISTORY_PER_SESSION):50
      this.json(res,200,{messages:this.opts.store.history(sessionId,limit)});return
    }
    this.json(res,404,{error:'not_found'})
  }

  private async ask(req:http.IncomingMessage,res:http.ServerResponse):Promise<void>{
    let payload:any
    try{payload=JSON.parse(await this.body(req))}catch{this.json(res,400,{error:'invalid_json'});return}
    const sessionId=payload?.sessionId
    if(typeof sessionId!=='string'||!SESSION.test(sessionId)){this.json(res,400,{error:'invalid_sessionId'});return}
    const source=payload?.source
    if(source!=='voice'&&source!=='chat'){this.json(res,400,{error:'invalid_source'});return}
    const text=payload?.text
    if(typeof text!=='string'){this.json(res,400,{error:'invalid_text'});return}
    if([...text].length>MAX_TEXT_CHARS){this.json(res,400,{error:'text_too_long'});return}
    if(!text.trim()){this.json(res,400,{error:'empty_text'});return}
    const waitRaw=payload?.waitSec??DEFAULT_WAIT_SEC
    if(typeof waitRaw!=='number'||!Number.isFinite(waitRaw)||waitRaw<1||waitRaw>MAX_WAIT_SEC){this.json(res,400,{error:'invalid_waitSec'});return}
    const seat=this.seat
    if(!seat||this.stopped){this.json(res,503,{error:'seat_unavailable'});return}

    const endpointId=`${source}:${sessionId}`
    const turnId=randomUUID()
    const msgId=BrainHttpChannel.messageId(endpointId,turnId)
    const queued=this.opts.store.inFlight()>0
    this.opts.store.openTurn(msgId,turnId,endpointId,text)
    this.opts.store.flush()
    // The seat hashes the endpoint into `from`, so the brain only learns which session is talking
    // if the source travels in the text. History keeps the user's own words, without the tag.
    try{seat.deliver({channel:BRAIN_HTTP_CHANNEL,endpointId,id:turnId,text:`[${endpointId}] ${text}`})}
    catch(error){
      this.opts.store.dropTurn(msgId);this.opts.store.flush()
      this.log({event:'brain-http-deliver-failed',turnId,error:String(error)})
      this.json(res,503,{error:'seat_unavailable'});return
    }
    this.log({event:'brain-http-ask',turnId,source,queued,chars:[...text].length})

    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-store',
      Connection:'keep-alive','X-Accel-Buffering':'no'})
    res.write(`data: ${JSON.stringify({type:'accepted',turnId,queued})}\n\n`)
    const timer=setTimeout(()=>{
      this.streams.delete(msgId)
      res.write(`data: ${JSON.stringify({type:'pending',turnId})}\n\n`)
      res.end()
      this.log({event:'brain-http-pending',turnId})
    },waitRaw*1000)
    this.streams.set(msgId,{res,turnId,timer})
    res.on('close',()=>{if(this.streams.get(msgId)?.res===res){clearTimeout(timer);this.streams.delete(msgId)}})
  }
}
