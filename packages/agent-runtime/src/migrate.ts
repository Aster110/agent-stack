import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import Database from 'better-sqlite3'
import {initialState,seatPaths,StateStore} from '@cc-mesh/codex-seat'
import {validateRuntimeConfig,type RuntimeConfig} from './index.js'
import {WeChatStore} from './wechat-store.js'

export interface LegacyMigration {
  runtime:RuntimeConfig
  accountId:string
  accountsFile:string
  contextFile:string
  cursorFile:string
  rolloutFile:string
  threadId:string
  cutoverHead:number
  /** Every legacy intake/engine PID captured before the operator stopped it. */
  stoppedPids:number[]
}
/** Import a quiescent tmux brain. Never infer a cursor from an inject seat's absent ACK row. */
export function migrateLegacyBrain(m:LegacyMigration):{threadId:string;cursor:number;accountId:string;createdAt:string} {
  const c=validateRuntimeConfig(m.runtime)
  if(c.role!=='brain'||!c.wechat||!c.relayDatabase)throw new Error('migration requires a brain with WeChat and the existing relay database')
  if(!m.stoppedPids.length)throw new Error('legacy consumer PIDs required')
  for(const pid of m.stoppedPids){
    if(!Number.isSafeInteger(pid)||pid<=1)throw new Error('invalid legacy PID')
    try{process.kill(pid,0)}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')continue;throw e}
    throw new Error('legacy consumer is still alive')
  }
  if(fs.existsSync(c.stateRoot)||fs.existsSync(c.wechat.accountFile))throw new Error('destination already exists; migration never overwrites state or credentials')
  const meta=JSON.parse(fs.readFileSync(m.rolloutFile,'utf8').split('\n',1)[0]!)
  if(meta.type!=='session_meta'||meta.payload?.id!==m.threadId||!Number.isFinite(Date.parse(meta.timestamp)))throw new Error('rollout does not match the verified legacy thread')
  const account=(JSON.parse(fs.readFileSync(m.accountsFile,'utf8')) as Array<{accountId:string;token:string}>).find(a=>a.accountId===m.accountId)
  const context=JSON.parse(fs.readFileSync(m.contextFile,'utf8'))
  const cursor=fs.readFileSync(m.cursorFile,'utf8').trim()
  if(!account?.token||context.userId!==c.wechat.ownerId||!context.contextToken||!cursor||context.accountId&&context.accountId!==account.accountId)throw new Error('account, owner, context or WeChat cursor mismatch')
  const db=new Database(c.relayDatabase,{readonly:true,fileMustExist:true})
  let nodeId:string
  try{
    const head=(db.prepare('SELECT COALESCE(MAX(seq),0) AS head FROM messages').get() as {head:number}).head
    if(!Number.isSafeInteger(m.cutoverHead)||m.cutoverHead<0||m.cutoverHead>head)throw new Error('invalid cutover cursor')
    const nodes=db.prepare('SELECT node_id FROM nodes WHERE short_id=?').all(c.seat) as Array<{node_id:string}>
    if(nodes.length!==1)throw new Error('expected exactly one existing seat')
    nodeId=nodes[0]!.node_id
  }finally{db.close()}
  const staging=c.stateRoot+'.migration-'+randomUUID()
  fs.mkdirSync(staging,{recursive:true,mode:0o700})
  let store:WeChatStore|undefined
  let accountWritten=false
  try{
    const state=initialState({seat:c.seat,nodeId,deviceId:nodeId.split(':')[0]!,instanceId:randomUUID(),now:meta.timestamp})
    state.mainThreadId=m.threadId;state.resumableThreads=[m.threadId]
    state.cursor=m.cutoverHead;state.cursorAnchorSeq=m.cutoverHead;state.cursorAnchoredAt=new Date().toISOString()
    new StateStore(seatPaths(c.seat,staging).state,true).save(state)
    store=new WeChatStore(path.join(staging,'wechat.sqlite'),account.accountId,c.wechat.ownerId)
    store.importLegacy(cursor,c.wechat.ownerId,context.contextToken);store.close();store=undefined
    fs.mkdirSync(path.dirname(c.wechat.accountFile),{recursive:true,mode:0o700})
    fs.writeFileSync(c.wechat.accountFile,JSON.stringify(account)+'\n',{flag:'wx',mode:0o600});accountWritten=true
    fs.renameSync(staging,c.stateRoot)
    return {threadId:m.threadId,cursor:m.cutoverHead,accountId:account.accountId,createdAt:state.createdAt}
  }catch(error){store?.close();fs.rmSync(staging,{recursive:true,force:true});if(accountWritten)fs.unlinkSync(c.wechat.accountFile);throw error}
}
