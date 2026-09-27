'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WebSocketServer}=require('ws');
const {createWorkbenchTaskRunner}=require('../integration/workbench-task-runner.cjs');
async function fixture(t,mode='success'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-runner-'));
 const server=new WebSocketServer({host:'127.0.0.1',port:0});
 await new Promise(resolve=>server.once('listening',resolve));
 const sent=[],events=[];let promptCount=0;
 server.on('connection',ws=>{
  let state={cwd:root,conversationId:'old',sessionId:'old-session',rev:1,messages:mode==='blank'?[]:[{role:'user',content:[{type:'text',text:'Previous task'}]}],isStreaming:false};
  const snapshot=()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'snapshot',state}));};
  ws.on('message',raw=>{
   const msg=JSON.parse(raw);sent.push(msg);
   if(msg.type==='hello'||msg.type==='get_state')snapshot();
   if(msg.type==='set_cwd'){state={...state,cwd:msg.path};snapshot();}
   if(msg.type==='new_chat'){
    snapshot(); // A stale get_state reply may race with the new_chat response.
    state={...state,conversationId:'new-conversation',sessionId:'new-session',rev:2,messages:[]};snapshot();
   }
   if(msg.type==='prompt'){
    promptCount++;state={...state,rev:3,isStreaming:true,messages:[{role:'user',content:[{type:'text',text:msg.text}]}]};snapshot();
    if(mode==='disconnect'){ws.close();return;}
    if(mode==='jev-degraded')ws.send(JSON.stringify({type:'notice',level:'error',text:'pi-jev: HTTP 403: Cloudflare (failing open)'}));
    if(['success','jev-degraded','blank'].includes(mode))setTimeout(()=>{
     state={...state,rev:4,isStreaming:false,messages:[...state.messages,{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Implemented and checked.'}]}]};snapshot();
    },15);
   }
   if(msg.type==='abort'){state={...state,rev:state.rev+1,isStreaming:false};snapshot();}
  });
 });
 t.after(async()=>{for(const ws of server.clients)ws.terminate();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 const runner=createWorkbenchTaskRunner({resolveProject:async()=>root,ensureReady:async()=>{},url:`ws://127.0.0.1:${server.address().port}/ws`,dataDir:path.join(root,'runs')});
 const task={id:'task',harness:'development',title:'Visible development tab',prompt:'Implement the requested feature.'};
 return {runner,task,sent,events,root,get promptCount(){return promptCount;}};
}
test('real local WS: creates and names new conversation; one prompt; persists result and links',async t=>{
 const f=await fixture(t);let linked;
 const result=await f.runner.runTask(f.task,{runId:'one',onLinked:x=>linked=x,onEvent:x=>f.events.push(x)});
 assert.equal(result.conversationId,'new-conversation');assert.equal(linked.conversationId,result.conversationId);
 assert.equal(f.promptCount,1);assert.equal(f.sent.some(x=>x.type==='set_cwd'),false);
 assert.equal(f.sent.find(x=>x.type==='rename_conversation').name,f.task.title);
 assert(f.events.some(x=>x.type==='workbench_snapshot'&&x.payload.isStreaming));
 const again=await f.runner.runTask(f.task,{runId:'one'});assert.equal(again.text,result.text);assert.equal(f.promptCount,1);
});
test('cancellation aborts only the owned conversation and confirms idle',async t=>{
 const f=await fixture(t,'hold'),controller=new AbortController();
 const pending=f.runner.runTask(f.task,{runId:'cancel',signal:controller.signal,onEvent:e=>{if(e.type==='workbench_snapshot'&&e.payload.isStreaming)controller.abort();}});
 await assert.rejects(pending,e=>e.code==='ABORTED');assert.equal(f.sent.filter(x=>x.type==='abort').length,1);
});
test('connection loss after submission is uncertain and must never replay',async t=>{
 const f=await fixture(t,'disconnect');await assert.rejects(f.runner.runTask(f.task,{runId:'lost'}),e=>e.code==='TERMINATION_FAILED');
 await assert.rejects(f.runner.runTask(f.task,{runId:'lost'}),e=>e.code==='DUPLICATE_RUN');assert.equal(f.promptCount,1);
});
test('two-loop integration: durable intake -> real WS conversation -> source result while chat keeps running',async t=>{
 const f=await fixture(t),{createDevelopmentDispatch}=require('../development-dispatch.cjs');
 const notifications=[];let chatTicks=0;const timer=setInterval(()=>chatTicks++,2);t.after(()=>clearInterval(timer));
 const queue=createDevelopmentDispatch({dataDir:path.join(f.root,'queue'),resolveProject:()=>f.root,runTask:(...args)=>f.runner.runTask(...args),onEvent:e=>notifications.push(e),tickMs:10});
 t.after(()=>queue.close());
 const input={prompt:f.task.prompt,title:f.task.title,sourceSessionId:'companion-conversation',source:'jev',idempotencyKey:'same-user-turn',executionRequested:true};
 const first=await queue.create(input),again=await queue.create(input);assert.equal(first.task.id,again.task.id);
 const deadline=Date.now()+3000;while(queue.get(first.task.id).status!=='completed'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 const task=queue.get(first.task.id);assert.equal(task.status,'completed');assert.equal(task.link.conversationId,'new-conversation');
 assert.equal(task.result.text,'Implemented and checked.');assert(chatTicks>0);assert.equal(f.promptCount,1);
 assert(notifications.some(e=>e.type==='completed'&&e.task.sourceSessionId==='companion-conversation'));
 await queue.close();
 const restored=createDevelopmentDispatch({dataDir:path.join(f.root,'queue'),resolveProject:()=>f.root,runTask:()=>{throw Error('must not replay')}});t.after(()=>restored.close());
 assert.equal(restored.get(task.id).result.text,task.result.text);
});

test('Jev fail-open notice does not abort or replay development',async t=>{
 const f=await fixture(t,'jev-degraded');
 const result=await f.runner.runTask(f.task,{runId:'degraded',onEvent:e=>f.events.push(e)});
 assert.equal(result.status,'completed');assert.equal(f.promptCount,1);
 assert(!f.sent.some(x=>x.type==='abort'));
 assert(f.events.some(e=>e.type==='jev_degraded'));
});

test('copy isolation retains visible workbench conversation and does not change source files',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.root,'hello.txt'),'original');
 const result=await f.runner.runTask({...f.task,isolation:'copy'},{runId:'isolated'});
 assert.equal(result.isolation.mode,'copy');assert.notEqual(result.workspace,f.root);
 assert.equal(result.conversationId,'new-conversation');assert.equal(result.sessionId,'new-session');
 assert.equal(f.sent.find(x=>x.type==='set_cwd').path,result.workspace);
 fs.writeFileSync(path.join(result.workspace,'hello.txt'),'changed');
 assert.equal(fs.readFileSync(path.join(f.root,'hello.txt'),'utf8'),'original');
 assert(!fs.existsSync(path.join(result.workspace,'runs')));
});

test('owned blank conversation is reused without waiting for a changed id',async t=>{const f=await fixture(t,'blank');const r=await f.runner.runTask(f.task,{runId:'blank'});assert.equal(r.conversationId,'old');assert.equal(f.promptCount,1);assert.equal(f.sent.some(x=>x.type==='new_chat'),false)});
