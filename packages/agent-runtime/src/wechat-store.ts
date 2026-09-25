import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import type {WeixinMessage} from '@cc-mesh/wechat-transport/types'

/** One downloaded (or definitively failed) attachment slot of an inbound message. */
export interface MediaRecord {
  message:string
  /** Item index in item_list; a quoted item of index i is `${i}r`. */
  slot:string
  status:'ready'|'failed'|'retry'|'expired'
  attempts:number
  retryAt:number
  createdAt:number
  expiresAt?:number
  sha256?:string
  mime?:string
  bytes?:number
  width?:number
  height?:number
  file?:string
  /** Image handed to the model as native image input. */
  native:boolean
  error?:string
}
type MediaRow={message:string;slot:string;status:MediaRecord['status'];attempts:number;retry_at:number;created_at:number;expires_at:number|null;sha256:string|null;mime:string|null;bytes:number|null;width:number|null;height:number|null;file:string|null;native:number;error:string|null}
const fromRow=(r:MediaRow):MediaRecord=>({message:r.message,slot:r.slot,status:r.status,attempts:r.attempts,retryAt:r.retry_at,createdAt:r.created_at,native:!!r.native,
  ...(r.expires_at!==null?{expiresAt:r.expires_at}:{}),...(r.sha256!==null?{sha256:r.sha256}:{}),...(r.mime!==null?{mime:r.mime}:{}),...(r.bytes!==null?{bytes:r.bytes}:{}),
  ...(r.width!==null?{width:r.width}:{}),...(r.height!==null?{height:r.height}:{}),...(r.file!==null?{file:r.file}:{}),...(r.error!==null?{error:r.error}:{})})

export function rawMessageId(message:WeixinMessage):string {
  return createHash('sha256').update(JSON.stringify([message.from_user_id,message.message_id ?? message.client_id ?? [message.create_time_ms,message.item_list]])).digest('hex')
}
export class WeChatStore {
  private db:Database.Database
  constructor(readonly file:string,accountId:string,ownerId:string) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
    this.db=new Database(file)
    const version=this.db.pragma('user_version',{simple:true})
    if(version!==0 && version!==1){this.db.close();throw new Error('unsupported WeChat store version')}
    fs.chmodSync(file,0o600)
    this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = FULL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incoming (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,raw TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS routes (endpoint TEXT PRIMARY KEY,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery (id TEXT PRIMARY KEY,text TEXT NOT NULL,next_part INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media (message TEXT NOT NULL,slot TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,expires_at INTEGER,sha256 TEXT,mime TEXT,bytes INTEGER,width INTEGER,height INTEGER,file TEXT,native INTEGER NOT NULL DEFAULT 0,error TEXT,
        PRIMARY KEY(message,slot));`)
    // The media table is additive: user_version stays 1 so a rollback binary still opens this store.
    this.db.pragma('user_version = 1')
    const identity=JSON.stringify([accountId,ownerId])
    const old=this.get('identity')
    if(old && old!==identity){this.db.close();throw new Error('WeChat account/owner changed; existing inbox and outbox belong to another binding')}
    this.set('identity',identity)
  }
  private get(key:string):string|undefined {return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value}
  private set(key:string,value:string){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  /** One-time offline migration; refuses to overwrite a live or previously used inbox. */
  importLegacy(cursor:string,owner:string,token:string):void {
    this.db.transaction(()=>{
      if(!cursor||!token||this.get('cursor')!==undefined ||
         (this.db.prepare('SELECT count(*) AS n FROM incoming').get() as {n:number}).n ||
         (this.db.prepare('SELECT count(*) AS n FROM delivery').get() as {n:number}).n ||
         (this.db.prepare('SELECT count(*) AS n FROM routes').get() as {n:number}).n)
        throw new Error('legacy import requires an unused WeChat store')
      const identity=JSON.parse(this.get('identity')!) as string[]
      if(identity[1]!==owner)throw new Error('legacy route owner mismatch')
      this.set('cursor',cursor)
      this.db.prepare('INSERT INTO routes VALUES(?,?)').run(owner,token)
    })()
  }
  cursor():string{return this.get('cursor')??''}
  acceptBatch(messages:WeixinMessage[],cursor:string|undefined,owner:string):void {
    this.db.transaction(()=>{
      const pending=(this.db.prepare("SELECT count(*) AS n FROM incoming WHERE status='pending'").get() as {n:number}).n
      if(pending+messages.length>10000)throw new Error('WeChat inbox capacity reached; cursor retained')
      for(const message of messages){
        if(message.message_type!==1 || message.from_user_id!==owner)continue
        const id=rawMessageId(message)
        this.db.prepare('INSERT OR IGNORE INTO incoming(id,raw) VALUES(?,?)').run(id,JSON.stringify(message))
        if(message.context_token)this.db.prepare('INSERT INTO routes VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET token=excluded.token').run(owner,message.context_token)
      }
      if(cursor)this.set('cursor',cursor)
    })()
  }
  pending():Array<{id:string;raw:WeixinMessage}>{
    return (this.db.prepare("SELECT id,raw FROM incoming WHERE status='pending' ORDER BY seq LIMIT 100").all() as Array<{id:string;raw:string}>).map(r=>({id:r.id,raw:JSON.parse(r.raw)}))
  }
  accepted(id:string):void{this.db.prepare("UPDATE incoming SET status='accepted',error=NULL WHERE id=?").run(id)}
  rejected(id:string,reason:string):void{this.db.prepare("UPDATE incoming SET status='rejected',error=? WHERE id=?").run(reason,id)}
  token(endpoint:string):string {
    const token=(this.db.prepare('SELECT token FROM routes WHERE endpoint=?').get(endpoint) as {token:string}|undefined)?.token
    if(!token)throw new Error('no persisted WeChat reply context; wait for owner message')
    return token
  }
  delivery(id:string,text:string):{next_part:number;done:number} {
    this.db.prepare('INSERT OR IGNORE INTO delivery(id,text) VALUES(?,?)').run(id,text)
    const row=this.db.prepare('SELECT text,next_part,done FROM delivery WHERE id=?').get(id) as {text:string;next_part:number;done:number}
    if(row.text!==text)throw new Error('delivery ID reused with different content')
    return row
  }
  partSent(id:string,nextPart:number,done:boolean):void {this.db.prepare('UPDATE delivery SET next_part=?,done=? WHERE id=?').run(nextPart,done?1:0,id)}
  mediaRecords(message:string):MediaRecord[]{return (this.db.prepare('SELECT * FROM media WHERE message=? ORDER BY slot').all(message) as MediaRow[]).map(fromRow)}
  mediaSave(r:MediaRecord):void{
    this.db.prepare(`INSERT INTO media(message,slot,status,attempts,retry_at,created_at,expires_at,sha256,mime,bytes,width,height,file,native,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(message,slot) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,retry_at=excluded.retry_at,created_at=excluded.created_at,expires_at=excluded.expires_at,
      sha256=excluded.sha256,mime=excluded.mime,bytes=excluded.bytes,width=excluded.width,height=excluded.height,file=excluded.file,native=excluded.native,error=excluded.error`)
      .run(r.message,r.slot,r.status,r.attempts,r.retryAt,r.createdAt,r.expiresAt??null,r.sha256??null,r.mime??null,r.bytes??null,r.width??null,r.height??null,r.file??null,r.native?1:0,r.error??null)
  }
  mediaForget(message:string,slot:string):void{this.db.prepare('DELETE FROM media WHERE message=? AND slot=?').run(message,slot)}
  mediaExpiring(now:number):MediaRecord[]{return (this.db.prepare("SELECT * FROM media WHERE status='ready' AND expires_at<=?").all(now) as MediaRow[]).map(fromRow)}
  mediaLiveFiles(now:number):string[]{return (this.db.prepare("SELECT DISTINCT file FROM media WHERE status='ready' AND file IS NOT NULL AND expires_at>?").all(now) as Array<{file:string}>).map(r=>r.file)}
  mediaExpire(message:string,slot:string):void{this.db.prepare("UPDATE media SET status='expired' WHERE message=? AND slot=?").run(message,slot)}
  mediaCounts():{ready:number;failed:number}{
    const rows=this.db.prepare("SELECT status,count(*) AS n FROM media WHERE status IN ('ready','failed') GROUP BY status").all() as Array<{status:string;n:number}>
    return {ready:rows.find(r=>r.status==='ready')?.n??0,failed:rows.find(r=>r.status==='failed')?.n??0}
  }
  close():void{if(this.db.open)this.db.close()}
}
