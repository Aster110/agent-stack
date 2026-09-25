// 微信入站媒体契约（P0）：图片/文件下载成真实字节，校验 MIME/尺寸/hash，私有落盘 + TTL 清理；
// 同一条消息交给模型时正文与附件按原顺序出现，图片作为原生输入；重复投递幂等；
// 下载失败给可恢复的错误，文字绝不被吞。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import type {AddressInfo} from 'node:net'
import {createRequire} from 'node:module'
import {encryptAesEcb} from '@cc-mesh/wechat-transport/api'
import type {WeixinMessage} from '@cc-mesh/wechat-transport/types'
import type {SeatHandle,ChannelInput} from '@cc-mesh/codex-seat'
import {FakeAppServerClient} from '@cc-mesh/codex-seat'
import {WeChatStore} from './wechat-store.js'
import {DurableWeChatChannel,type WeChatApi} from './wechat.js'
import {mediaKey,sniffImage,type WeChatMediaOptions} from './wechat-media.js'
import {startUnifiedRuntime,validateRuntimeConfig,type RuntimeConfig} from './index.js'
const require=createRequire(import.meta.url)
const {createServer}=require('../../relay/dist/server.js')

const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
async function until(fn:()=>boolean,why='condition',ms=5000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error(`${why} timed out`);await delay(5)}}
const sha=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex')
const md5=(b:Buffer)=>crypto.createHash('md5').update(b).digest('hex')

function png(w:number,h:number):Buffer{
  const ihdr=Buffer.alloc(25);ihdr.writeUInt32BE(13,0);ihdr.write('IHDR',4,'ascii');ihdr.writeUInt32BE(w,8);ihdr.writeUInt32BE(h,12);ihdr[16]=8;ihdr[17]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ihdr,Buffer.from('0000000049454e44ae426082','hex')])
}
function jpeg(w:number,h:number,pad=64):Buffer{
  const app0=Buffer.from('ffe000104a46494600010100000100010000','hex')
  const sof=Buffer.from([0xff,0xc0,0,17,8,h>>8,h&255,w>>8,w&255,3,1,0x22,0,2,0x11,1,3,0x11,1])
  return Buffer.concat([Buffer.from([0xff,0xd8]),app0,sof,crypto.randomBytes(pad),Buffer.from([0xff,0xd9])])
}
function gif(w:number,h:number):Buffer{const b=Buffer.alloc(13);b.write('GIF89a',0,'ascii');b.writeUInt16LE(w,6);b.writeUInt16LE(h,8);return b}
function webpVp8x(w:number,h:number):Buffer{
  const b=Buffer.alloc(30);b.write('RIFF',0,'ascii');b.writeUInt32LE(22,4);b.write('WEBP',8,'ascii');b.write('VP8X',12,'ascii');b.writeUInt32LE(10,16)
  b.writeUIntLE(w-1,24,3);b.writeUIntLE(h-1,27,3);return b
}
function webpVp8l(w:number,h:number):Buffer{
  const b=Buffer.alloc(25);b.write('RIFF',0,'ascii');b.writeUInt32LE(17,4);b.write('WEBP',8,'ascii');b.write('VP8L',12,'ascii');b.writeUInt32LE(5,16);b[20]=0x2f
  const bits=(w-1)|((h-1)<<14);b.writeUInt32LE(bits>>>0,21);return b
}
function webpVp8(w:number,h:number):Buffer{
  const b=Buffer.alloc(30);b.write('RIFF',0,'ascii');b.writeUInt32LE(22,4);b.write('WEBP',8,'ascii');b.write('VP8 ',12,'ascii');b.writeUInt32LE(10,16)
  b[23]=0x9d;b[24]=0x01;b[25]=0x2a;b.writeUInt16LE(w,26);b.writeUInt16LE(h,28);return b
}

interface Blob {status?:number;body?:Buffer;hang?:boolean;delayMs?:number;headers?:Record<string,string>;chunked?:boolean}
async function fakeCdn(t:any){
  const blobs=new Map<string,Blob|Blob[]>()
  const hits:string[]=[]
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url!,'http://cdn')
    const q=url.pathname==='/c2c/download'?url.searchParams.get('encrypted_query_param')??'':`full:${url.pathname}`
    hits.push(q)
    const entry=blobs.get(q)
    const b=Array.isArray(entry)?(entry.length>1?entry.shift()!:entry[0]!):entry
    if(!b){res.writeHead(404,{'x-error-code':'-5103'});res.end();return}
    if(b.hang){res.writeHead(200,{'content-length':'999999'});res.flushHeaders();res.write(Buffer.alloc(16));return}
    if(b.chunked){res.writeHead(200);let i=0;const tick=()=>{if(i>=b.body!.length){res.end();return}res.write(b.body!.subarray(i,i+16));i+=16;setImmediate(tick)};tick();return}
    const send=()=>{res.writeHead(b.status??200,{...(b.body?{'content-length':String(b.body.length)}:{}),...b.headers});res.end(b.body)}
    if(b.delayMs)setTimeout(send,b.delayMs);else send()
  })
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))})
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {cdnBaseUrl:`${base}/c2c`,base,blobs,hits,
    /** Encrypt like WeChat does and register under a fresh query param; returns the item fields. */
    put(plain:Buffer,extra:Partial<Blob>={},keyForm:'hex'|'b64hex'|'b64raw'='hex'){
      const key=crypto.randomBytes(16);const query=`q-${crypto.randomBytes(6).toString('hex')}`
      blobs.set(query,{body:encryptAesEcb(plain,key),...extra})
      const media={encrypt_query_param:query,aes_key:keyForm==='b64raw'?key.toString('base64'):Buffer.from(key.toString('hex')).toString('base64')}
      return {query,key,media,aeskey:keyForm==='hex'?key.toString('hex'):undefined}
    }}
}

function root(t:any){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-media-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
const account={accountId:'test-bot',token:'synthetic-token'}
const noApi:WeChatApi={poll:async()=>{await delay(50);return {ret:0,msgs:[]}},send:async()=>({messageId:'1'})}
let seqNo=0
function message(items:any[],id=`m-${++seqNo}`):WeixinMessage{return {message_id:id,message_type:1,from_user_id:'owner',context_token:'ctx',item_list:items} as WeixinMessage}
const text=(t:string)=>({type:1,text_item:{text:t}})
const image=(put:{media:any;aeskey?:string})=>({type:2,image_item:{...(put.aeskey?{aeskey:put.aeskey}:{}),media:put.media,mid_size:1,hd_size:1}})

function recorder(){
  const inputs:ChannelInput[]=[]
  let mode:'accept'|'crash'|'duplicate'='accept'
  const seat={deliver:(input:ChannelInput)=>{inputs.push(input);if(mode==='crash')throw new Error('crashed after durable acceptance');return mode==='duplicate'?'duplicate':'accepted'}} as unknown as SeatHandle
  return {inputs,seat,set mode(m:typeof mode){mode=m}}
}
async function channelFor(t:any,dir:string,cdn:{cdnBaseUrl:string},opts:Partial<WeChatMediaOptions>={}){
  const store=new WeChatStore(path.join(dir,'wechat.sqlite'),'test-bot','owner')
  const logs:Array<Record<string,unknown>>=[]
  const channel=new DurableWeChatChannel('owner',account,store,noApi,{dir:path.join(dir,'wechat-media'),cdnBaseUrl:cdn.cdnBaseUrl,retryDelaysMs:[20,20],timeoutMs:1500,log:r=>logs.push(r),...opts})
  t.after(async()=>{await channel.stop().catch(()=>{})})
  return {store,channel,logs}
}

test('AES keys in all three WeChat encodings decode to the same 16 bytes; malformed keys yield none',()=>{
  const key=crypto.randomBytes(16)
  const viaHex=mediaKey({type:2,image_item:{aeskey:key.toString('hex'),media:{aes_key:'garbage'}}})
  const viaB64Hex=mediaKey({type:2,image_item:{media:{aes_key:Buffer.from(key.toString('hex')).toString('base64')}}})
  const viaB64Raw=mediaKey({type:4,file_item:{media:{aes_key:key.toString('base64')}}})
  for(const k of [viaHex,viaB64Hex,viaB64Raw])assert.deepEqual(k,key)
  assert.equal(mediaKey({type:2,image_item:{media:{aes_key:Buffer.from('short').toString('base64')}}}),null)
  assert.equal(mediaKey({type:2,image_item:{}}),null)
})

test('image sniffing reports true MIME and dimensions from magic bytes, never from names',()=>{
  assert.deepEqual(sniffImage(png(640,480)),{mime:'image/png',ext:'png',width:640,height:480})
  assert.deepEqual(sniffImage(jpeg(1706,1279)),{mime:'image/jpeg',ext:'jpg',width:1706,height:1279})
  assert.deepEqual(sniffImage(gif(3,2)),{mime:'image/gif',ext:'gif',width:3,height:2})
  assert.deepEqual(sniffImage(webpVp8x(4000,3000)),{mime:'image/webp',ext:'webp',width:4000,height:3000})
  assert.deepEqual(sniffImage(webpVp8l(123,45)),{mime:'image/webp',ext:'webp',width:123,height:45})
  assert.deepEqual(sniffImage(webpVp8(320,200)),{mime:'image/webp',ext:'webp',width:320,height:200})
  assert.equal(sniffImage(Buffer.from('%PDF-1.7 not an image')),null)
  assert.equal(sniffImage(Buffer.from([0xff,0xd8,0xff])),null,'truncated JPEG has no dimensions')
  assert.equal(sniffImage(Buffer.alloc(0)),null)
})

test('an owner photo becomes real private bytes and reaches the model natively with an ordered marker',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const plain=jpeg(1706,1279,4096);const put=cdn.put(plain)
  const {store,channel,logs}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([text('看看这张'),image(put),text('最右边的手P掉')])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===1,'delivery')
  const input=seat.inputs[0]!
  assert.equal(input.images?.length,1)
  const file=input.images![0]!
  assert.equal(path.dirname(file),path.join(dir,'wechat-media'))
  assert.deepEqual(fs.readFileSync(file),plain,'stored bytes are the decrypted original, byte for byte')
  assert.equal(path.basename(file),`${sha(plain)}.jpg`)
  assert.equal(fs.statSync(file).mode&0o777,0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700)
  const lines=input.text.split('\n')
  assert.equal(lines[0],'看看这张');assert.equal(lines[2],'最右边的手P掉')
  assert.match(lines[1]!,/^\[图片1：image\/jpeg，1706×1279，\d+ 字节，sha256=[0-9a-f]{64}，本地文件 .+，.+ 后自动清理\]$/)
  assert.ok(lines[1]!.includes(sha(plain))&&lines[1]!.includes(file))
  assert.equal(store.pending().length,0)
  const serialized=JSON.stringify(logs)
  for(const secret of [put.query,put.key.toString('hex'),put.media.aes_key,cdn.base,'看看这张'])assert.equal(serialized.includes(secret),false,`log leaks ${secret}`)
  assert.ok(logs.some(r=>r.event==='stored'&&r.sha256===sha(plain)&&r.bytes===plain.length&&r.width===1706))
  assert.equal(channel.health().media!.ready,1)
})

test('text and attachments keep their order across messages while an earlier image is still downloading',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const first=cdn.put(png(2,2),{delayMs:300}),third=cdn.put(png(3,3))
  const {store,channel}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([image(first)]),message([text('P掉最右边的手')]),message([image(third)])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===3,'three deliveries')
  assert.match(seat.inputs[0]!.text,/^\[图片1：image\/png，2×2/)
  assert.equal(seat.inputs[1]!.text,'P掉最右边的手')
  assert.match(seat.inputs[2]!.text,/^\[图片1：image\/png，3×3/)
})

test('transient CDN failures are retried; a permanent failure still delivers the words with a recoverable error',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const flaky=cdn.put(png(5,5))
  const good=cdn.blobs.get(flaky.query) as Blob
  cdn.blobs.set(flaky.query,[{status:503},{status:503},good])
  const gone={media:{encrypt_query_param:'q-expired',aes_key:Buffer.from(crypto.randomBytes(16).toString('hex')).toString('base64')}}
  const {store,channel,logs}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([image(flaky)]),message([text('这张也修一下'),image(gone)])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===2,'both deliveries')
  assert.equal(seat.inputs[0]!.images?.length,1)
  assert.equal(cdn.hits.filter(q=>q===flaky.query).length,3)
  assert.equal(cdn.hits.filter(q=>q==='q-expired').length,1,'4xx is permanent: no pointless retries')
  const failed=seat.inputs[1]!
  assert.equal(failed.images,undefined)
  assert.match(failed.text,/^这张也修一下\n\[图片1：下载失败（CDN HTTP 404 x-error-code=-5103）。其余文字照常送达；需要这张图请让发送者重新发送。\]$/)
  assert.ok(logs.some(r=>r.event==='failed'&&r.final===true))
  assert.equal(channel.health().media!.failed,1)
})

test('a CDN body that stalls after headers times out instead of blocking the inbox',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const stuck=cdn.put(png(1,1),{hang:true})
  const {store,channel}=await channelFor(t,dir,cdn,{timeoutMs:150,maxAttempts:1})
  const seat=recorder()
  store.acceptBatch([message([image(stuck)]),message([text('后面的消息')])],'c1','owner')
  const before=Date.now()
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===2,'deliveries after timeout',3000)
  assert.ok(Date.now()-before<2000)
  assert.match(seat.inputs[0]!.text,/下载失败（timeout after 150ms）/)
  assert.equal(seat.inputs[1]!.text,'后面的消息')
  assert.deepEqual(fs.readdirSync(path.join(dir,'wechat-media')),[],'no partial file survives a timeout')
})

test('an oversized body without a declared length is cut off mid-stream; a wrong key is refused; neither leaves a partial file',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const big=cdn.put(jpeg(20,20,4096),{chunked:true})
  const wrong=cdn.put(png(4,4))
  const {store,channel}=await channelFor(t,dir,cdn,{maxImageBytes:1024})
  const seat=recorder()
  store.acceptBatch([message([image(big)]),message([image({...wrong,aeskey:crypto.randomBytes(16).toString('hex')})])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===2,'deliveries')
  assert.match(seat.inputs[0]!.text,/下载失败（too large: more than 1024 bytes）/)
  assert.match(seat.inputs[1]!.text,/下载失败（decrypt failed）/)
  assert.deepEqual(fs.readdirSync(path.join(dir,'wechat-media')),[])
  assert.ok(cdn.hits.filter(q=>q===big.query).length===1,'permanent failures are not retried')
})

test('duplicate platform delivery and a crash before local acknowledgement never download or deliver twice',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const put=cdn.put(png(7,7))
  const msg=message([image(put)],'same-platform-id')
  let {store,channel}=await channelFor(t,dir,cdn)
  store.acceptBatch([msg],'c1','owner');store.acceptBatch([msg],'c1','owner')
  assert.equal(store.pending().length,1)
  const seat=recorder();seat.mode='crash'
  channel.start(seat.seat)
  await until(()=>seat.inputs.length>=1,'first attempt')
  await channel.stop()
  const check=new WeChatStore(path.join(dir,'wechat.sqlite'),'test-bot','owner');assert.equal(check.pending().length,1);check.close()
  ;({store,channel}=await channelFor(t,dir,cdn))
  const again=recorder();again.mode='duplicate'
  channel.start(again.seat)
  await until(()=>store.pending().length===0,'duplicate acknowledged')
  assert.deepEqual(again.inputs[0]!.images,seat.inputs[0]!.images,'same stored file, same delivery content')
  assert.equal(again.inputs[0]!.text,seat.inputs[0]!.text)
  assert.equal(cdn.hits.length,1,'media was downloaded exactly once')
})

test('TTL sweep deletes expired media and stale partials while fresh media and foreign files remain',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  let now=Date.parse('2026-09-25T00:00:00Z')
  const oldImg=png(8,8),newImg=png(9,9)
  const a=cdn.put(oldImg),b=cdn.put(newImg)
  const {store,channel,logs}=await channelFor(t,dir,cdn,{ttlMs:3*3600_000,now:()=>now})
  const seat=recorder()
  store.acceptBatch([message([image(a)])],'c1','owner');channel.start(seat.seat)
  await until(()=>seat.inputs.length===1,'first')
  now+=2*3600_000
  store.acceptBatch([message([image(b)])],'c2','owner')
  await until(()=>seat.inputs.length===2,'second')
  const mediaDir=path.join(dir,'wechat-media')
  const stale=path.join(mediaDir,`.${sha(oldImg)}.123.part`);fs.writeFileSync(stale,'x');fs.utimesSync(stale,new Date(now-2*3600_000),new Date(now-2*3600_000))
  const foreign=path.join(mediaDir,'notes.txt');fs.writeFileSync(foreign,'keep me')
  now+=3600_000+1
  channel.sweepMedia()
  assert.equal(fs.existsSync(seat.inputs[0]!.images![0]!),false,'expired file removed')
  assert.equal(fs.existsSync(seat.inputs[1]!.images![0]!),true,'unexpired file kept')
  assert.equal(fs.existsSync(stale),false);assert.equal(fs.existsSync(foreign),true)
  assert.ok(logs.some(r=>r.event==='swept'&&r.files===2))
  assert.match(seat.inputs[1]!.text,/2026-09-25T05:00:00\.000Z 后自动清理/)
})

test('owner files keep integrity checks; a wrong md5 is refused but the words still arrive',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),crypto.randomBytes(300)])
  const ok=cdn.put(pdf,{},'b64raw'),bad=cdn.put(pdf,{},'b64raw')
  const file=(put:any,name:string,sum:string)=>({type:4,file_item:{media:put.media,file_name:name,md5:sum,len:String(pdf.length)}})
  const {store,channel}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([file(ok,'合同 v2 (终版).pdf',md5(pdf))]),message([text('还有这个'),file(bad,'../../etc/passwd','0'.repeat(32))])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===2,'deliveries')
  const stored=seat.inputs[0]!
  assert.equal(stored.images,undefined,'files are not image input')
  const local=/本地文件 (\S+)，/.exec(stored.text)![1]!
  assert.equal(path.basename(local),`${sha(pdf)}.pdf`)
  assert.deepEqual(fs.readFileSync(local),pdf)
  assert.match(stored.text,/^\[文件1「合同 v2 \(终版\)\.pdf」：application\/pdf，\d+ 字节，sha256=[0-9a-f]{64}，本地文件 /)
  assert.match(seat.inputs[1]!.text,/^还有这个\n\[文件1「passwd」：下载失败（md5 mismatch）。其余文字照常送达；需要这个文件请让发送者重新发送。\]$/)
})

test('oversized media is refused without storing anything',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const put=cdn.put(png(10,10))
  const {store,channel}=await channelFor(t,dir,cdn,{maxImageBytes:32})
  const seat=recorder()
  store.acceptBatch([message([text('大图'),image(put)])],'c1','owner');channel.start(seat.seat)
  await until(()=>seat.inputs.length===1,'delivery')
  assert.match(seat.inputs[0]!.text,/^大图\n\[图片1：下载失败（too large: more than 32 bytes）/)
  assert.deepEqual(fs.existsSync(path.join(dir,'wechat-media'))?fs.readdirSync(path.join(dir,'wechat-media')):[],[])
})

test('video and untranscribed voice are named honestly and never downloaded; transcribed voice stays text',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const {store,channel}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([{type:5,video_item:{media:{encrypt_query_param:'v',aes_key:'x'},video_size:3*1024*1024}},{type:3,voice_item:{media:{encrypt_query_param:'a',aes_key:'x'}}},{type:3,voice_item:{text:'帮我订周五的会议室'}}])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===1,'delivery')
  assert.equal(seat.inputs[0]!.text,['[视频：当前通道不下载视频内容（3.0 MB）；需要处理请让发送者改用文件方式发送。]','[语音：未转写，当前通道不下载语音内容。]','[Voice] 帮我订周五的会议室'].join('\n'))
  assert.equal(cdn.hits.length,0)
})

test('a quoted photo is downloaded and presented as quoted content ahead of the reply text',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const put=cdn.put(jpeg(40,30))
  const {store,channel}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([{type:1,text_item:{text:'把这张的手P掉'},ref_msg:{title:'图片',message_item:image(put)}}])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===1,'delivery')
  const [quoted,reply]=seat.inputs[0]!.text.split('\n')
  assert.match(quoted!,/^\[引用「图片」\] \[图片1：image\/jpeg，40×30，/)
  assert.equal(reply,'把这张的手P掉')
  assert.equal(seat.inputs[0]!.images?.length,1)
})

test('full_url is followed only on the WeChat CDN host allowlist',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const a=cdn.put(png(11,11)),b=cdn.put(png(12,12))
  cdn.blobs.set('full:/allowed',cdn.blobs.get(b.query)!)
  const {store,channel}=await channelFor(t,dir,cdn,{fullUrlAllowed:u=>u.pathname==='/allowed'})
  const seat=recorder()
  store.acceptBatch([message([image({...a,media:{...a.media,full_url:`${cdn.base}/evil`}})]),message([image({...b,media:{...b.media,full_url:`${cdn.base}/allowed`}})])],'c1','owner')
  channel.start(seat.seat)
  await until(()=>seat.inputs.length===2,'deliveries')
  assert.deepEqual(cdn.hits,[a.query,'full:/allowed'],'disallowed full_url falls back to the configured CDN; allowed one is used')
})

test('decrypted bytes that are not an image are kept as a file, never given to the model as an image',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const put=cdn.put(Buffer.from('this is not an image at all'))
  const {store,channel}=await channelFor(t,dir,cdn)
  const seat=recorder()
  store.acceptBatch([message([image(put)])],'c1','owner');channel.start(seat.seat)
  await until(()=>seat.inputs.length===1,'delivery')
  assert.equal(seat.inputs[0]!.images,undefined)
  assert.match(seat.inputs[0]!.text,/^\[图片1：格式无法识别，按文件保存，未作为图片交给模型；application\/octet-stream，27 字节，sha256=[0-9a-f]{64}，本地文件 \S+\.bin，/)
})

test('runtime config accepts only a sane media TTL',()=>{
  const config={version:1,role:'brain',seat:'brain',cwd:'/tmp/w',stateRoot:'/tmp/s',relayUrl:'http://127.0.0.1:19800',relayDatabase:'/tmp/r.db',peerNodes:[],codex:{bin:'/usr/bin/codex'},executionPolicy:'full-access',wechat:{accountFile:'/tmp/a',ownerId:'owner'}}
  assert.equal(validateRuntimeConfig({...config,wechat:{...config.wechat,mediaTtlHours:72}}).wechat?.mediaTtlHours,72)
  for(const bad of [0,-1,1.5,24*31,'72'])assert.throws(()=>validateRuntimeConfig({...config,wechat:{...config.wechat,mediaTtlHours:bad}}),/mediaTtlHours/)
})

test('the unified brain runtime hands a WeChat photo to the model natively, then replies over WeChat',async t=>{
  const dir=root(t);const cdn=await fakeCdn(t)
  const terminal={inject:async()=>{throw new Error('no terminal')},spawn:async()=>{throw new Error('no terminal')},isAlive:async()=>true,close:async()=>{},getCurrentSession:async()=>null}
  const app=createServer({deviceId:'mediart',dbPath:path.join(dir,'relay.sqlite'),profileHome:dir,terminal})
  const relay=http.createServer(app);await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r))
  t.after(async()=>{relay.closeAllConnections();await new Promise<void>(r=>relay.close(()=>r()));app.store.close()})
  const accountFile=path.join(dir,'account.json');fs.writeFileSync(accountFile,JSON.stringify({accountId:'fixture',token:'synthetic-token'}))
  const plain=jpeg(1706,1279,2048);const put=cdn.put(plain)
  let polled=false
  const sent:string[]=[]
  const engine=new FakeAppServerClient({scenario:{defaultTurn:{completeAfterMs:5,outcome:{status:'completed',finalText:'图里有五个人和一只狗'}}}})
  const requests:Array<{text:string;images?:string[]}>=[]
  const startTurn=engine.turnStart.bind(engine)
  engine.turnStart=async req=>{requests.push({text:req.text,...(req.images?{images:req.images}:{})});return startTurn(req)}
  const config:RuntimeConfig={version:1,role:'brain',seat:'brain',cwd:path.join(dir,'work'),stateRoot:path.join(dir,'state'),relayUrl:`http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    relayDatabase:path.join(dir,'relay.sqlite'),peerNodes:['mediart:computer'],codex:{bin:'/synthetic/codex'},executionPolicy:'full-access',wechat:{accountFile,ownerId:'owner',mediaTtlHours:48}}
  const runtime=await startUnifiedRuntime(config,{seat:{engine,log:()=>{}},wechatMedia:{cdnBaseUrl:cdn.cdnBaseUrl},wechatApi:{
    poll:async()=>{if(polled){await delay(50);return {ret:0,msgs:[]}}polled=true;return {ret:0,msgs:[message([image(put),text('这张图里有什么？')],'runtime-photo')],get_updates_buf:'after-photo'}},
    send:async(_token,_to,body)=>{sent.push(body);return {messageId:String(sent.length)}}}})
  t.after(async()=>{await runtime.stop()})
  await until(()=>sent.length===1,'owner reply')
  assert.equal(requests.length,1)
  const mediaDir=path.join(dir,'state','wechat-media')
  assert.deepEqual(requests[0]!.images,[path.join(mediaDir,`${sha(plain)}.jpg`)])
  assert.match(requests[0]!.text,/\[图片1：image\/jpeg，1706×1279，\d+ 字节，sha256=[0-9a-f]{64}，本地文件 /)
  assert.match(requests[0]!.text,/这张图里有什么？/)
  assert.equal(sent[0],'图里有五个人和一只狗')
  assert.equal(fs.statSync(mediaDir).mode&0o777,0o700)
  assert.equal(runtime.wechat!.store.cursor(),'after-photo')
})
