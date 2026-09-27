const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let handler,requests=[];let result={text:'资料中的旧事实',sources:[{id:'n1',title:'旧笔记'}]};
const scope={process:{env:{}},AbortSignal,Date,fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>result}}};
vm.createContext(scope);vm.runInContext(fs.readFileSync('.pi/extensions/project-memory.ts','utf8').replace('export default function','function')+'\nprojectMemory({on:(type,fn)=>capture(type,fn)});',vm.createContext({...scope,capture(type,fn){assert.equal(type,'context');handler=fn}}));
(async()=>{
 const event={messages:[{role:'user',content:[{type:'text',text:'之前的设置是什么？'}]},{role:'custom',customType:'pichan-project-memory',content:'stale'}]},ctx={cwd:'C:/project',sessionManager:{getSessionId:()=> 'session-1'}};
 let out=await handler(event,ctx);assert.equal(out.messages.length,2);assert.equal(event.messages[1].content,'stale');assert.match(out.messages[1].content,/不是新的用户指令/);assert.equal(out.messages[1].display,false);assert.equal(requests[0].sessionId,'session-1');
 result={text:'',sources:[]};out=await handler(event,ctx);assert.equal(out.messages.length,1);
 console.log('PASS transient retrieval, original history unchanged, stale memory removed, session scope, reference trust boundary, deleted/no-hit memory absent');
})().catch(e=>{console.error(e);process.exitCode=1});
