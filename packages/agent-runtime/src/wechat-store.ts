import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import type {WeixinMessage} from '@cc-mesh/wechat-transport/types'

export function rawMessageId(message:WeixinMessage):string {
  return createHash('sha256').update(JSON.stringify([message.from_user_id,message.message_id ?? message.client_id ?? [message.create_time_ms,message.item_list]])).digest('hex')
}
export class WeChatStore {
  private db:Database.Database
  constructor(file:string,accountId:string,ownerId:string) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
    this.db=new Database(file)
    const version=this.db.pragma('user_version',{simple:true})
    if(version!==0 && version!==1){this.db.close();throw new Error('unsupported WeChat store version')}
    fs.chmodSync(file,0o600)
    this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = FULL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incoming (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,raw TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS routes (endpoint TEXT PRIMARY KEY,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery (id TEXT PRIMARY KEY,text TEXT NOT NULL,next_part INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0);`)
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
  close():void{this.db.close()}
}
