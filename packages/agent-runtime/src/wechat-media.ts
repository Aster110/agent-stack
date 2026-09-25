import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {CDNMedia,MessageItem,WeixinMessage} from '@cc-mesh/wechat-transport/types'
import type {MediaRecord,WeChatStore} from './wechat-store.js'

/**
 * Inbound WeChat media for the owner channel.
 *
 * Every photo/file item of an owner message is downloaded from the WeChat CDN, decrypted
 * (AES-128-ECB), checked (size, magic-byte MIME, image dimensions, file md5/length) and written
 * content-addressed into one private directory (0700, files 0600) with an explicit TTL. The
 * message is then rendered for the model in its original item order: the text parts, and for
 * each attachment a marker with MIME, size, SHA-256 and local path; photos are also returned as
 * native image input for the same turn. A download failure never swallows the words: the message
 * is delivered with a marker naming the error once the retry budget is spent.
 *
 * Logs carry kind, slot, MIME, dimensions, byte count, SHA-256 and error codes only: never the
 * CDN URL/query, keys, file names or content.
 */
export const WECHAT_CDN_BASE_URL='https://novac2c.cdn.weixin.qq.com/c2c'
export const DEFAULT_MEDIA_TTL_MS=72*3600_000
const HOUR=3600_000
const MiB=1024*1024

export interface WeChatMediaOptions {
  /** Private media directory; created 0700 on first download. */
  dir:string
  /** How long stored media stays on disk; default 72 h. */
  ttlMs?:number
  maxImageBytes?:number
  maxFileBytes?:number
  /** Images above this pixel count are kept as files and not handed to the model as images. */
  maxImagePixels?:number
  /** Idle deadline per attempt (no headers / no body bytes for this long); the whole transfer is capped at 20x. */
  timeoutMs?:number
  maxAttempts?:number
  /** Delay before attempt n+1 after a retryable failure of attempt n. */
  retryDelaysMs?:number[]
  cdnBaseUrl?:string
  /** Whether a platform-supplied full_url may be fetched; default: https on *.weixin.qq.com only. */
  fullUrlAllowed?:(url:URL)=>boolean
  fetch?:typeof fetch
  now?:()=>number
  log?:(record:Record<string,unknown>)=>void
}

export type MediaKind='image'|'file'
interface Slot {slot:string;kind:MediaKind;item:MessageItem}
export interface Rendered {text:string;images:string[]}

class MediaError extends Error {constructor(message:string,readonly retryable:boolean){super(message)}}

export function mediaKindOf(item:MessageItem|undefined):MediaKind|null {
  if(item?.type===2)return 'image'
  if(item?.type===4)return 'file'
  return null
}
function cdnMediaOf(item:MessageItem):(CDNMedia&{full_url?:string})|undefined {
  return (item.image_item?.media??item.file_item?.media??item.video_item?.media??item.voice_item?.media) as (CDNMedia&{full_url?:string})|undefined
}

/** The item's AES-128 key: image_item.aeskey (hex) first, then media.aes_key as base64 of raw 16 bytes or of 32 hex chars. */
export function mediaKey(item:MessageItem):Buffer|null {
  const hex=item.image_item?.aeskey
  if(typeof hex==='string'&&/^[0-9a-f]{32}$/i.test(hex))return Buffer.from(hex,'hex')
  const b64=cdnMediaOf(item)?.aes_key
  if(typeof b64!=='string'||!b64)return null
  const raw=Buffer.from(b64,'base64')
  if(raw.length===16)return raw
  const text=raw.toString('latin1')
  if(raw.length===32&&/^[0-9a-f]{32}$/i.test(text))return Buffer.from(text,'hex')
  return null
}

export interface Sniffed {mime:string;ext:string;width:number;height:number}
/** MIME and dimensions from magic bytes only (PNG, JPEG, GIF, WebP). */
export function sniffImage(b:Buffer):Sniffed|null {
  const dims=(mime:string,ext:string,width:number,height:number):Sniffed|null=>width>0&&height>0?{mime,ext,width,height}:null
  if(b.length>=24&&b.readUInt32BE(0)===0x89504e47&&b.readUInt32BE(4)===0x0d0a1a0a&&b.toString('latin1',12,16)==='IHDR')
    return dims('image/png','png',b.readUInt32BE(16),b.readUInt32BE(20))
  if(b.length>=10&&(b.toString('latin1',0,6)==='GIF87a'||b.toString('latin1',0,6)==='GIF89a'))
    return dims('image/gif','gif',b.readUInt16LE(6),b.readUInt16LE(8))
  if(b.length>=16&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'){
    const chunk=b.toString('latin1',12,16)
    if(chunk==='VP8X'&&b.length>=30)return dims('image/webp','webp',b.readUIntLE(24,3)+1,b.readUIntLE(27,3)+1)
    if(chunk==='VP8 '&&b.length>=30&&b[23]===0x9d&&b[24]===0x01&&b[25]===0x2a)return dims('image/webp','webp',b.readUInt16LE(26)&0x3fff,b.readUInt16LE(28)&0x3fff)
    if(chunk==='VP8L'&&b.length>=25&&b[20]===0x2f){const bits=b.readUInt32LE(21);return dims('image/webp','webp',(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1)}
    return null
  }
  if(b.length>=4&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff){
    let i=2
    while(i+3<b.length){
      if(b[i]!==0xff){i++;continue}
      const marker=b[i+1]!
      if(marker===0xff){i++;continue}
      if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){i+=2;continue}
      if(marker===0xd9||marker===0xda)return null
      const len=b.readUInt16BE(i+2)
      if(len<2)return null
      const sof=marker>=0xc0&&marker<=0xcf&&marker!==0xc4&&marker!==0xc8&&marker!==0xcc
      if(sof){if(i+9>b.length)return null;return dims('image/jpeg','jpg',b.readUInt16BE(i+7),b.readUInt16BE(i+5))}
      i+=2+len
    }
  }
  return null
}

const FILE_TYPES:Record<string,string>={pdf:'application/pdf',zip:'application/zip',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',
  doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',mp3:'audio/mpeg',mp4:'video/mp4',mov:'video/quicktime',
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',heic:'image/heic',gz:'application/gzip',rar:'application/vnd.rar','7z':'application/x-7z-compressed'}
/** File MIME: magic bytes where they are decisive, otherwise the (sanitized) extension, otherwise octet-stream. */
export function sniffFile(b:Buffer,name:string):{mime:string;ext:string} {
  const image=sniffImage(b)
  if(image)return {mime:image.mime,ext:image.ext}
  const fromName=/\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase()
  if(b.toString('latin1',0,5)==='%PDF-')return {mime:'application/pdf',ext:'pdf'}
  if(b.length>=4&&b.readUInt32BE(0)===0x504b0304)return fromName&&['docx','xlsx','pptx','zip'].includes(fromName)?{mime:FILE_TYPES[fromName]!,ext:fromName}:{mime:'application/zip',ext:'zip'}
  if(b.length>=2&&b[0]===0x1f&&b[1]===0x8b)return {mime:'application/gzip',ext:'gz'}
  if(fromName&&FILE_TYPES[fromName])return {mime:FILE_TYPES[fromName]!,ext:fromName}
  return {mime:'application/octet-stream',ext:fromName??'bin'}
}

/** Display name only: last path component, no control characters, bounded length. Never used as a path. */
export function safeFileName(name:unknown):string {
  const base=String(name??'').replace(/\\/g,'/').split('/').filter(Boolean).pop()??''
  const clean=Array.from(base.replace(/[\u0000-\u001f\u007f「」\[\]]/g,'')).slice(0,120).join('').trim()
  return clean||'未命名文件'
}

/** Downloadable attachments of a message in render order: a quoted item precedes the item that quotes it. */
export function mediaSlots(message:WeixinMessage):Slot[] {
  const out:Slot[]=[]
  ;(message.item_list??[]).forEach((item,i)=>{
    const quoted=item.ref_msg?.message_item
    const qk=mediaKindOf(quoted)
    if(quoted&&qk)out.push({slot:`${i}r`,kind:qk,item:quoted})
    const k=mediaKindOf(item)
    if(k)out.push({slot:String(i),kind:k,item})
  })
  return out
}

/** The model-facing text of one message, in original item order, plus the native images it names. */
export function renderInbound(message:WeixinMessage,records:Map<string,MediaRecord>):Rendered {
  const parts:string[]=[]
  const images:string[]=[]
  let imageNo=0,fileNo=0
  const media=(slot:string,item:MessageItem,kind:MediaKind):string=>{
    const label=kind==='image'?`图片${++imageNo}`:`文件${++fileNo}「${safeFileName(item.file_item?.file_name)}」`
    const r=records.get(slot)
    if(!r||r.status!=='ready'){
      const reason=r?.status==='expired'?'已按保留期清理':(r?.error??'未能下载')
      return `[${label}：下载失败（${reason}）。其余文字照常送达；需要这${kind==='image'?'张图':'个文件'}请让发送者重新发送。]`
    }
    const facts=`${r.mime}，${r.bytes} 字节，sha256=${r.sha256}，本地文件 ${r.file}，${new Date(r.expiresAt!).toISOString()} 后自动清理`
    if(kind==='file')return `[${label}：${facts}]`
    if(r.native){images.push(r.file!);return `[${label}：${r.mime}，${r.width}×${r.height}，${r.bytes} 字节，sha256=${r.sha256}，本地文件 ${r.file}，${new Date(r.expiresAt!).toISOString()} 后自动清理]`}
    const why=r.mime!.startsWith('image/')?`像素过多（${r.width}×${r.height}）`:'格式无法识别'
    return `[${label}：${why}，按文件保存，未作为图片交给模型；${facts}]`
  }
  const one=(item:MessageItem,slot:string):string|null=>{
    const kind=mediaKindOf(item)
    if(kind)return media(slot,item,kind)
    switch(item.type){
      case 1:return item.text_item?.text||null
      case 3:return item.voice_item?.text?`[Voice] ${item.voice_item.text}`:'[语音：未转写，当前通道不下载语音内容。]'
      case 5:{
        const size=Number(item.video_item?.video_size)
        return `[视频：当前通道不下载视频内容${size>0?`（${(size/MiB).toFixed(1)} MB）`:''}；需要处理请让发送者改用文件方式发送。]`
      }
      default:return item.type?`[不支持的消息类型 ${item.type}]`:null
    }
  }
  ;(message.item_list??[]).forEach((item,i)=>{
    const ref=item.ref_msg
    if(ref&&(ref.message_item||ref.title)){
      const quoted=ref.message_item?one(ref.message_item,`${i}r`):null
      parts.push(`[引用${ref.title?`「${ref.title}」`:''}]${quoted?` ${quoted}`:''}`)
    }
    const own=one(item,String(i))
    if(own)parts.push(own)
  })
  return {text:parts.join('\n')||'[Empty message]',images}
}

function defaultFullUrlAllowed(url:URL):boolean {return url.protocol==='https:'&&(url.hostname==='weixin.qq.com'||url.hostname.endsWith('.weixin.qq.com'))}
function retryableStatus(status:number):boolean {return status===408||status===425||status===429||status>=500}

export class WeChatMedia {
  private readonly o:Required<Omit<WeChatMediaOptions,'fetch'|'log'>>&Pick<WeChatMediaOptions,'fetch'|'log'>
  private inflight:Promise<void>|null=null
  private timer:NodeJS.Timeout|null=null
  private readonly abort=new AbortController()
  private stopped=false
  private lastError:string|null=null
  constructor(private readonly store:WeChatStore,options:WeChatMediaOptions){
    this.o={ttlMs:DEFAULT_MEDIA_TTL_MS,maxImageBytes:25*MiB,maxFileBytes:100*MiB,maxImagePixels:100_000_000,timeoutMs:60_000,maxAttempts:3,
      retryDelaysMs:[2_000,10_000],cdnBaseUrl:WECHAT_CDN_BASE_URL,fullUrlAllowed:defaultFullUrlAllowed,now:Date.now,...options}
  }

  /**
   * Delivery input once every attachment of the message is settled (stored, or failed for good).
   * Otherwise starts or schedules the downloads, calls `wake` when there is progress, and returns
   * null so the caller keeps later messages behind this one: order is part of the message.
   */
  prepare(id:string,raw:WeixinMessage,wake:()=>void):Rendered|null {
    const slots=mediaSlots(raw)
    if(!slots.length)return renderInbound(raw,new Map())
    const records=new Map(this.store.mediaRecords(id).map(r=>[r.slot,r]))
    const now=this.o.now()
    const due:Slot[]=[]
    let later=Infinity
    for(const s of slots){
      const r=records.get(s.slot)
      if(r?.status==='ready'){
        if(r.file&&fs.existsSync(r.file))continue
        this.store.mediaForget(id,s.slot)
        due.push(s);continue
      }
      if(r?.status==='failed'||r?.status==='expired')continue
      if(r?.status==='retry'&&r.retryAt>now){later=Math.min(later,r.retryAt);continue}
      due.push(s)
    }
    if(!due.length&&later===Infinity)return renderInbound(raw,records)
    if(this.inflight||this.stopped)return null
    if(due.length){
      this.inflight=this.resolve(id,due).catch(error=>{this.lastError=String(error)}).finally(()=>{this.inflight=null;if(!this.stopped)wake()})
    }else if(!this.timer){
      this.timer=setTimeout(()=>{this.timer=null;if(!this.stopped)wake()},Math.max(0,later-now))
      this.timer.unref?.()
    }
    return null
  }

  private async resolve(id:string,slots:Slot[]):Promise<void> {
    for(const s of slots){
      if(this.stopped)return
      const attempt=(this.store.mediaRecords(id).find(r=>r.slot===s.slot)?.attempts??0)+1
      const started=Date.now()
      try{
        const got=await this.download(s)
        if(this.stopped)return
        const now=this.o.now()
        this.store.mediaSave({message:id,slot:s.slot,status:'ready',attempts:attempt,retryAt:0,createdAt:now,expiresAt:now+this.o.ttlMs,...got})
        this.log({event:'stored',kind:s.kind,slot:s.slot,mime:got.mime,bytes:got.bytes,width:got.width,height:got.height,sha256:got.sha256,native:got.native,attempt,ms:Date.now()-started})
      }catch(error){
        if(this.stopped)return
        const e=error instanceof MediaError?error:new MediaError(`internal: ${String(error).slice(0,120)}`,false)
        const final=!e.retryable||attempt>=this.o.maxAttempts
        const now=this.o.now()
        const wait=this.o.retryDelaysMs[Math.min(attempt-1,this.o.retryDelaysMs.length-1)]??0
        this.store.mediaSave({message:id,slot:s.slot,status:final?'failed':'retry',attempts:attempt,retryAt:final?0:now+wait,error:e.message,createdAt:now,native:false})
        this.lastError=e.message
        this.log({event:'failed',kind:s.kind,slot:s.slot,attempt,final,error:e.message})
      }
    }
  }

  /**
   * Stream download -> AES-128-ECB decrypt -> hash -> private temp file, so a large file never sits
   * in memory. The temp file is renamed to its content address only after every check passed.
   */
  private async download(s:Slot):Promise<Omit<MediaRecord,'message'|'slot'|'status'|'attempts'|'retryAt'|'createdAt'|'expiresAt'>> {
    const key=mediaKey(s.item)
    const media=cdnMediaOf(s.item)
    if(!key||!media||(!media.encrypt_query_param&&!media.full_url))throw new MediaError('missing download parameters',false)
    const url=this.urlFor(media)
    const max=s.kind==='image'?this.o.maxImageBytes:this.o.maxFileBytes
    const tooLarge=()=>new MediaError(`too large: more than ${max} bytes`,false)
    fs.mkdirSync(this.o.dir,{recursive:true,mode:0o700})
    fs.chmodSync(this.o.dir,0o700)
    const tmp=path.join(this.o.dir,`.${crypto.randomBytes(32).toString('hex')}.${process.pid}.part`)
    const fd=fs.openSync(tmp,'wx',0o600)
    let open=true,kept=false
    try{
      const decipher=crypto.createDecipheriv('aes-128-ecb',key,null)
      const sha=crypto.createHash('sha256'),md5=crypto.createHash('md5')
      const head:Buffer[]=[]
      let bytes=0,headBytes=0
      const sink=(plain:Buffer)=>{
        if(!plain.length)return
        bytes+=plain.length
        if(bytes>max)throw tooLarge()
        sha.update(plain);md5.update(plain)
        // Images are sniffed whole (bounded by maxImageBytes); files only need their first bytes.
        if(s.kind==='image'||headBytes<65536){head.push(plain);headBytes+=plain.length}
        fs.writeSync(fd,plain)
      }
      await this.fetchStream(url,Math.floor(max/16)*16+16,tooLarge,chunk=>sink(decipher.update(chunk)))
      let tail:Buffer
      try{tail=decipher.final()}catch{throw new MediaError('decrypt failed',false)}
      sink(tail)
      if(!bytes)throw new MediaError('empty media',false)
      fs.fsyncSync(fd);fs.closeSync(fd);open=false
      const sha256=sha.digest('hex')
      const sample=Buffer.concat(head)
      let info:{mime:string;ext:string;width?:number;height?:number;native:boolean}
      if(s.kind==='file'){
        const f=s.item.file_item!
        if(typeof f.md5==='string'&&/^[0-9a-f]{32}$/i.test(f.md5)&&md5.digest('hex')!==f.md5.toLowerCase())throw new MediaError('md5 mismatch',false)
        if(f.len!==undefined&&/^\d+$/.test(String(f.len))&&Number(f.len)!==bytes)throw new MediaError('length mismatch',false)
        info={...sniffFile(sample,safeFileName(f.file_name)),native:false}
      }else{
        const image=sniffImage(sample)
        info=image?{...image,native:image.width*image.height<=this.o.maxImagePixels}:{mime:'application/octet-stream',ext:'bin',native:false}
      }
      const final=path.join(this.o.dir,`${sha256}.${info.ext}`)
      let reuse=false
      try{const st=fs.lstatSync(final);reuse=st.isFile()&&st.size===bytes}catch{/* absent */}
      if(reuse)fs.unlinkSync(tmp)
      else fs.renameSync(tmp,final)
      kept=true
      fs.chmodSync(final,0o600)
      const {ext:_ext,...rest}=info
      return {sha256,bytes,file:final,...rest}
    }finally{
      if(open)fs.closeSync(fd)
      if(!kept)try{fs.unlinkSync(tmp)}catch{/* never created or already moved */}
    }
  }

  private urlFor(media:CDNMedia&{full_url?:string}):string {
    if(media.full_url){
      try{const u=new URL(media.full_url);if(this.o.fullUrlAllowed(u))return u.toString()}catch{/* fall back */}
    }
    if(!media.encrypt_query_param)throw new MediaError('missing download parameters',false)
    return `${this.o.cdnBaseUrl.replace(/\/+$/,'')}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
  }

  /**
   * One attempt. `timeoutMs` is an idle deadline (no headers or no body bytes for that long) and the
   * whole transfer is capped at twenty times it, so a stalled body can never hold the inbox.
   */
  private async fetchStream(url:string,limit:number,tooLarge:()=>MediaError,onChunk:(chunk:Buffer)=>void):Promise<void> {
    const ac=new AbortController()
    let timedOut:string|null=null
    let idle:NodeJS.Timeout|null=null
    const arm=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>{timedOut=`timeout after ${this.o.timeoutMs}ms`;ac.abort()},this.o.timeoutMs)}
    const cap=setTimeout(()=>{timedOut=`timeout: transfer exceeded ${this.o.timeoutMs*20}ms`;ac.abort()},this.o.timeoutMs*20)
    const onStop=()=>ac.abort()
    this.abort.signal.addEventListener('abort',onStop,{once:true})
    arm()
    try{
      const res=await (this.o.fetch??fetch)(url,{signal:ac.signal})
      const code=res.headers.get('x-error-code')
      if(res.status!==200||(code&&code!=='0')){
        await res.body?.cancel().catch(()=>{})
        throw new MediaError(`CDN HTTP ${res.status}${code?` x-error-code=${code}`:''}`,retryableStatus(res.status))
      }
      const declared=Number(res.headers.get('content-length'))
      if(Number.isFinite(declared)&&declared>limit){await res.body?.cancel().catch(()=>{});throw tooLarge()}
      if(!res.body)throw new MediaError('CDN returned no body',true)
      const reader=res.body.getReader()
      let total=0
      for(;;){
        arm()
        const {done,value}=await reader.read()
        if(done)break
        total+=value.byteLength
        if(total>limit){await reader.cancel().catch(()=>{});throw tooLarge()}
        try{onChunk(Buffer.from(value.buffer,value.byteOffset,value.byteLength))}
        catch(error){await reader.cancel().catch(()=>{});throw error}
      }
    }catch(error){
      if(error instanceof MediaError)throw error
      if(timedOut)throw new MediaError(timedOut,true)
      if(this.stopped)throw new MediaError('stopped',true)
      const code=(error as {cause?:{code?:string}})?.cause?.code
      throw new MediaError(`network${code?` ${code}`:' error'}`,true)
    }finally{
      if(idle)clearTimeout(idle)
      clearTimeout(cap)
      this.abort.signal.removeEventListener('abort',onStop)
    }
  }

  /** TTL: delete files whose every reference expired, plus stale partials and unreferenced leftovers older than an hour. */
  sweep():{files:number;bytes:number} {
    const now=this.o.now()
    const live=new Set(this.store.mediaLiveFiles(now))
    let files=0,bytes=0
    const remove=(file:string)=>{try{const st=fs.lstatSync(file);if(!st.isFile())return;fs.unlinkSync(file);files++;bytes+=st.size}catch{/* already gone */}}
    for(const r of this.store.mediaExpiring(now)){
      if(r.file&&!live.has(r.file))remove(r.file)
      this.store.mediaExpire(r.message,r.slot)
    }
    let names:string[]=[]
    try{names=fs.readdirSync(this.o.dir)}catch{/* no media yet */}
    for(const name of names){
      const full=path.join(this.o.dir,name)
      const partial=/^\.[0-9a-f]{64}(\.[0-9a-z]+)+\.part$/.test(name)
      const stored=/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(name)
      if(!partial&&!(stored&&!live.has(full)))continue
      try{if(fs.lstatSync(full).mtimeMs>now-HOUR)continue}catch{continue}
      remove(full)
    }
    if(files)this.log({event:'swept',files,bytes})
    return {files,bytes}
  }

  health(){const c=this.store.mediaCounts();return {inflight:!!this.inflight,ready:c.ready,failed:c.failed,lastError:this.lastError}}

  stop():void {
    this.stopped=true
    this.abort.abort()
    if(this.timer)clearTimeout(this.timer)
    this.timer=null
  }

  private log(record:Record<string,unknown>):void {try{this.o.log?.({component:'wechat-media',...record})}catch{/* logging never breaks intake */}}
}
