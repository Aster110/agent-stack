// Opt-in real-model acceptance of the documented deployment runner.
// Uses an isolated Hub, two real relay processes, two identical runtimes and an HTTP WeChat fixture.
// Requires bootstrap plus Codex login in this OS account. Never joins a production mesh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const Database=createRequire(new URL('../packages/agent-runtime/package.json',import.meta.url))('better-sqlite3');
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'stack-deployment-'));
const token=path.join(root,'token');fs.writeFileSync(token,randomBytes(32).toString('hex'),{mode:0o600});
const children=[],logs=[],outputs=[],incoming=[];
let platform;
const evidence={startedAt:new Date().toISOString(),source:JSON.parse(execFileSync('python3',['scripts/source-version.py'],{cwd:source})),checks:[],simulated:['WeChat platform only'],status:'running'};
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const hubPort=await port(),brainPort=await port(),computerPort=await port();
const brain=path.join(root,'brain'),computer=path.join(root,'computer');
function init(profile,role,device,seat,peer,relay){
 execFileSync('python3',['scripts/deploy.py','init','--profile',profile,'--role',role,'--device',device,'--seat',seat,'--workspace',path.join(profile,'work'),'--peer',peer,'--token-file',token,'--hub-url',`ws://127.0.0.1:${hubPort}`,'--hub-port',String(hubPort),'--relay-port',String(relay)],{cwd:source});
}
async function until(fn,label,timeout=240000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out: '+label);}
async function start(profile,service){
 const file=path.join(profile,'logs',service+'.test.log'),fd=fs.openSync(file,'a');logs.push(file);
 const child=spawn('python3',['scripts/deploy.py','run','--profile',profile,'--service',service],{cwd:source,stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(child);return child;
}
async function stop(child){
 if(child.exitCode!==null||child.signalCode!==null)return;
 child.kill('SIGTERM');await until(()=>child.exitCode!==null||child.signalCode!==null,'child stop',20000).catch(()=>{child.kill('SIGKILL');throw new Error('Service failed graceful stop');});
}
async function status(p){try{return (await (await fetch(`http://127.0.0.1:${p}/api/status`)).json()).data;}catch{return null;}}
function push(id,text){incoming.push({message_id:String(id),message_type:1,from_user_id:'fixture-owner',context_token:'fixture-context',item_list:[{type:1,text_item:{text}}]});}
function state(profile,seat){return JSON.parse(fs.readFileSync(path.join(profile,'state/.ccmesh/codex-seat',seat,'state.json')));}
function check(name){evidence.checks.push(name);console.log(name);}
try {
 init(brain,'brain','acceptance-server','brain','acceptance-computer:codex-main',brainPort);
 init(computer,'computer','acceptance-computer','codex-main','acceptance-server:brain',computerPort);
 platform=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  const parsed=JSON.parse(body||'{}');res.setHeader('content-type','application/json');
  if(req.url.endsWith('/getupdates'))res.end(JSON.stringify({ret:0,msgs:incoming.splice(0),get_updates_buf:'fixture-cursor'}));
  else if(req.url.endsWith('/sendmessage')){outputs.push(parsed);res.end('{"ret":0,"message_id":"7498796439671022216"}');}
  else{res.statusCode=404;res.end('{}');}
 });
 await new Promise(r=>platform.listen(0,'127.0.0.1',r));
 const accountFile=path.join(brain,'fixture-account.json');fs.writeFileSync(accountFile,JSON.stringify({accountId:'fixture',token:'synthetic-fixture-token',baseUrl:`http://127.0.0.1:${platform.address().port}`}),{mode:0o600});
 const configFile=path.join(brain,'runtime.json');const config=JSON.parse(fs.readFileSync(configFile));config.wechat={accountFile,ownerId:'fixture-owner'};fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
 let hub=await start(brain,'hub');await start(brain,'relay');await start(computer,'relay');
 await until(async()=> (await status(brainPort))?.uplink?.connected && (await status(computerPort))?.uplink?.connected,'two authenticated relays',30000);
 check('Two real relay processes connected to the same authenticated Hub');
 await start(computer,'runtime');let runtime=await start(brain,'runtime');
 await until(async()=> (await status(brainPort))?.nodes?.some(n=>n.identity.shortId==='brain') && (await status(computerPort))?.nodes?.some(n=>n.identity.shortId==='codex-main'),'two runtime registrations',60000);
 const nonce=randomBytes(10).toString('hex'),artifact=path.join(computer,'work','acceptance.txt');
 push(1,`Isolated deployment acceptance. Remember nonce ${nonce}. Use the mesh CLI to dispatch a task to acceptance-computer:codex-main, asking that peer to write exactly this nonce into ${artifact}, read it back and report it. Do not write the file yourself. Report the returned result to me after the peer completes. This task is explicitly authorized.`);
 await until(()=>fs.existsSync(artifact),'computer file creation');
 assert.equal(fs.readFileSync(artifact,'utf8').trim(),nonce);
 await until(()=>JSON.stringify(outputs).includes(nonce),'WeChat fixture receives result');
 // Require an actual correlated peer result in brain context, not the first acknowledgement.
 await until(()=>Object.keys(state(brain,'brain').taskResultOrigins??{}).length>0,'correlated peer result accepted by brain');
 await until(()=>{
  const ids=Object.values(state(brain,'brain').taskResultOrigins??{});
  const db=new Database(path.join(brain,'state/wechat.sqlite'),{readonly:true,fileMustExist:true});
  try{return ids.some(id=>{
   const row=db.prepare('SELECT text,done FROM delivery WHERE id=?').get(id+':done');
   return row?.done===1 && row.text.includes(nonce);
  });}finally{db.close();}
 },'completed peer-result response acknowledged by WeChat fixture');
 check('Real brain dispatched through Hub; real computer created the exact requested file');
 const before=state(brain,'brain').mainThreadId;
 await stop(runtime);runtime=await start(brain,'runtime');
 await until(()=>{try{return state(brain,'brain').mainThreadId===before&&children.at(-1).exitCode===null;}catch{return false;}},'brain resume');
 const outputOffset=outputs.length;
 push(2,'Recall the nonce from the previous deployment test. Reply exactly RECOVERED followed by the nonce. Do not use tools or send another task.');
 await until(()=>JSON.stringify(outputs.slice(outputOffset)).includes(`RECOVERED ${nonce}`),'same context after process restart');
 assert.equal(state(brain,'brain').mainThreadId,before);
 check('Restarted brain process retained its Codex thread and remembered the nonce');
 await stop(hub);hub=await start(brain,'hub');
 await until(async()=> (await status(brainPort))?.uplink?.connected && (await status(computerPort))?.uplink?.connected,'Hub reconnect',60000);
 check('Both relay processes reconnected after Hub restart');
 evidence.status='passed';
} catch(error){evidence.status='failed';evidence.error=String(error);process.exitCode=1;console.error(String(error));}
finally {
 for(const child of children.reverse())try{await stop(child);}catch(error){evidence.stopError=String(error);process.exitCode=1;}
 if(platform){platform.closeAllConnections();await new Promise(r=>platform.close(r));}
 evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({status:evidence.status,evidence:path.join(root,'evidence.json')}));
}
