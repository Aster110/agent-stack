import {createHash} from 'node:crypto'
import {getUpdates,sendMessage} from '@cc-mesh/wechat-transport/api'
import {extractText} from '@cc-mesh/wechat-transport/utils'
import type {SeatChannel,SeatHandle,ChannelOutput} from '@cc-mesh/codex-seat'
import {WeChatStore} from './wechat-store.js'

export interface WeChatAccount {accountId:string;token:string;baseUrl?:string}
export interface WeChatApi {poll:typeof getUpdates;send:typeof sendMessage}
/** Transport only: no Agent, session store, model child or model queue here. */
export class DurableWeChatChannel implements SeatChannel {
  private stopped=false
  private abort=new AbortController()
  private wake: (()=>void)|null=null
  private loop:Promise<void>|null=null
  private intake:NodeJS.Timeout|null=null
  private failure:string|null=null
  private failures=0
  private seat:SeatHandle|null=null
  constructor(readonly ownerId:string,private account:WeChatAccount,readonly store:WeChatStore,
    private api:WeChatApi={poll:getUpdates,send:sendMessage}){}
  accepts(endpoint:string):boolean{return endpoint===this.ownerId}
  async send(endpoint:string,output:ChannelOutput):Promise<void>{
    if(!this.accepts(endpoint))throw new Error('WeChat endpoint not allowed')
    if(output.kind==='seen')return
    const chunks=Array.from(output.text).reduce<string[]>((parts,c,i)=>{const n=Math.floor(i/3000);parts[n]=(parts[n]??'')+c;return parts},[])
    if(!chunks.length)chunks.push('(empty result)')
    const state=this.store.delivery(output.id,output.text)
    if(state.done)return
    for(let i=state.next_part;i<chunks.length;i++){
      const stableId='agent-stack-'+createHash('sha256').update(`${this.account.accountId}:${output.id}:${i}`).digest('hex').slice(0,40)
      const confirmation=await this.api.send(this.account.token,endpoint,chunks[i]!,this.store.token(endpoint),this.account.baseUrl,stableId)
      if(typeof confirmation.messageId!=='string'||! /^-?\d+$/.test(confirmation.messageId))throw new Error('WeChat send has no valid message acknowledgement; checkpoint retained')
      this.store.partSent(output.id,i+1,i+1===chunks.length)
    }
  }
  start(seat:SeatHandle):void {
    this.seat=seat;this.pump()
    this.intake=setInterval(()=>this.pump(),250)
    this.loop=this.poll()
  }
  private pump():void {
    if(this.stopped||!this.seat)return
    for(const message of this.store.pending()){
      // Candidate text path: do not silently fabricate attachment contents.
      const unsupported=message.raw.item_list?.some(i=>i.type!==1 && !(i.type===3 && i.voice_item?.text))
      const text=unsupported?'The owner sent an attachment that this candidate transport cannot download. Tell the owner this limitation; do not pretend to have read it.':extractText(message.raw)
      try{
        this.seat.deliver({channel:'wechat',endpointId:this.ownerId,id:message.id,text})
        this.store.accepted(message.id)
      }catch(error){this.failure=String(error);break}
    }
  }
  private async pause(ms:number):Promise<void>{
    if(this.stopped)return
    await new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.wake=null;resolve()},ms);this.wake=()=>{clearTimeout(timer);this.wake=null;resolve()}})
  }
  private async poll():Promise<void>{
    let timeout=35000
    while(!this.stopped){
      try{
        const response=await this.api.poll(this.account.token,this.store.cursor(),this.account.baseUrl,timeout,this.abort.signal)
        if(this.stopped)return
        if(response.errcode===-14 || response.ret===-14){this.failure='WeChat session expired';await this.pause(300000);continue}
        if(response.ret || response.errcode)throw new Error(`WeChat poll rejected: ${response.ret}/${response.errcode}`)
        this.store.acceptBatch(response.msgs??[],response.get_updates_buf,this.ownerId)
        this.failures=0;this.failure=null;this.pump()
        if(response.longpolling_timeout_ms && response.longpolling_timeout_ms>0)timeout=Math.min(response.longpolling_timeout_ms,35000)
        if(!response.msgs?.length)await this.pause(100)
      }catch(error){
        if(this.stopped)return
        this.failure=String(error);this.failures++
        await this.pause(this.failures>=3?30000:2000)
      }
    }
  }
  health(){return {ok:!this.stopped&&!this.failure,error:this.failure,failures:this.failures,pending:this.stopped?null:this.store.pending().length}}
  async stop():Promise<void>{
    this.stopped=true;this.abort.abort();this.wake?.();if(this.intake)clearInterval(this.intake)
    // In-flight platform request may finish later; it checks stopped before touching the store.
    this.store.close()
  }
}
