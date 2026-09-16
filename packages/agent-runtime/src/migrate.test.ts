import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {seatPaths,StateStore} from '@cc-mesh/codex-seat'
import {migrateLegacyBrain,type LegacyMigration} from './migrate.js'
import {WeChatStore} from './wechat-store.js'
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brain-migrate-'))
 const write=(name:string,value:unknown)=>{const file=path.join(root,name);fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file}
 const dbFile=path.join(root,'mesh.db'),db=new Database(dbFile)
 db.exec("CREATE TABLE messages(seq INTEGER);INSERT INTO messages VALUES(100);CREATE TABLE nodes(node_id TEXT,short_id TEXT);INSERT INTO nodes VALUES('test:brain','brain')");db.close()
 const migration:LegacyMigration={runtime:{version:1,role:'brain',seat:'brain',cwd:root,stateRoot:path.join(root,'state'),relayUrl:'http://127.0.0.1:19800',relayDatabase:dbFile,peerNodes:['peer:main'],codex:{bin:'/bin/codex'},executionPolicy:'full-access',wechat:{accountFile:path.join(root,'account.json'),ownerId:'owner'}},accountId:'account',accountsFile:write('accounts.json',[{accountId:'account',token:'secret'}]),contextFile:write('context.json',{userId:'owner',contextToken:'latest'}),cursorFile:write('cursor','platform-cursor'),rolloutFile:write('rollout',{type:'session_meta',timestamp:'2026-08-28T01:46:34Z',payload:{id:'original-thread'}}),threadId:'original-thread',cutoverHead:99,stoppedPids:[2147483647]}
 return {root,migration,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})}
}
test('legacy migration keeps original resumable thread, age, explicit boundary and private reply route',()=>{
 const f=fixture();try{
  migrateLegacyBrain(f.migration)
  const s=new StateStore(seatPaths('brain',f.migration.runtime.stateRoot).state,true).load()!
  assert.equal(s.mainThreadId,'original-thread');assert.deepEqual(s.resumableThreads,['original-thread']);assert.equal(s.cursor,99);assert.equal(s.createdAt,'2026-08-28T01:46:34Z')
  const store=new WeChatStore(path.join(f.migration.runtime.stateRoot,'wechat.sqlite'),'account','owner')
  assert.equal(store.cursor(),'platform-cursor');assert.equal(store.token('owner'),'latest');assert.deepEqual(store.pending(),[])
  assert.throws(()=>store.importLegacy('other','owner','other'),/unused/);store.close()
  assert.equal(fs.statSync(f.migration.runtime.wechat!.accountFile).mode&0o777,0o600)
  assert.throws(()=>migrateLegacyBrain(f.migration),/already exists/)
 }finally{f.cleanup()}
})
test('legacy migration refuses a live writer, wrong thread, owner or future cursor without partial output',()=>{
 for(const change of [(m:LegacyMigration)=>m.stoppedPids=[process.pid],(m:LegacyMigration)=>m.threadId='wrong',(m:LegacyMigration)=>m.runtime.wechat!.ownerId='wrong',(m:LegacyMigration)=>m.cutoverHead=101]){
  const f=fixture();try{change(f.migration);assert.throws(()=>migrateLegacyBrain(f.migration));assert.equal(fs.existsSync(f.migration.runtime.stateRoot),false);assert.equal(fs.existsSync(f.migration.runtime.wechat!.accountFile),false)}finally{f.cleanup()}
 }
})
