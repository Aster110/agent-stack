#!/usr/bin/env node
import fs from 'node:fs'
import {startUnifiedRuntime,validateRuntimeConfig} from './index.js'

const [command,file]=process.argv.slice(2)
if(!file||!['check','run'].includes(command??'')){
  console.error('Usage: agent-stack check|run /absolute/path/runtime.json');process.exitCode=2
}else{
  try{
    const config=validateRuntimeConfig(JSON.parse(fs.readFileSync(file,'utf8')))
    if(command==='check')console.log(JSON.stringify({valid:true,role:config.role,seat:config.seat,channels:['mesh',...(config.wechat?['wechat']:[]),...(config.brainChannel?['brain-http']:[])],brainChannelPort:config.brainChannel?(config.brainChannel.port??18090):null}))
    else{
      const runtime=await startUnifiedRuntime(config)
      const status=await runtime.seat.status()
      console.log(JSON.stringify({role:config.role,nodeId:runtime.seat.nodeId,threadId:runtime.seat.state().mainThreadId,engineAlive:status.engine.alive}))
      let stopping=false
      for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
        if(stopping)return;stopping=true
        void runtime.stop().then(()=>{process.exitCode=0},error=>{console.error(String(error));process.exitCode=1})
      })
    }
  }catch(error){console.error(String(error));process.exitCode=1}
}
