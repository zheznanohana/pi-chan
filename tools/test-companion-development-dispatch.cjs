'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {createJevToolPlanner}=require('../jev-tool-planner.cjs');
const code=fs.readFileSync(require('node:path').join(__dirname,'../.pi/extensions/jev-tools.ts'),'utf8').replace("import {createHash} from 'node:crypto';",'').replace("import {Type} from 'typebox';",'').replace('export default function jevTools','function jevTools')+'\nmodule.exports=jevTools;';
async function scenario(execution,route='development'){
 const hooks={},tools=[],posts=[];let active=['read','dispatch_development_task'];
 const planner=createJevToolPlanner({query:async request=>({answers:Object.fromEntries(Object.keys(request.questions).map(k=>[k,k==='route'?{choice:route,confidence:.99}:k==='execution_requested'?{noul:execution}:{noul:.95}]))})});
 const context={Type:{Object:(properties,options)=>({type:'object',properties,...options}),String:options=>({type:'string',...options}),Optional:x=>x},module:{exports:{}},createHash:crypto.createHash,process:{env:{PICHAN_HARNESS_KIND:'chat'}},AbortSignal,fetch:async(url,options)=>{
  const data=JSON.parse(options.body);
  if(url.endsWith('/api/jev/tools'))return{ok:true,json:()=>planner.plan(data)};
  posts.push(data);return{ok:true,json:async()=>({task:{id:'job-1',status:'queued'}})};
 }};vm.runInNewContext(code,context);
 const pi={registerTool:t=>tools.push(t),on:(name,fn)=>hooks[name]=fn,getActiveTools:()=>active,getAllTools:()=>[{name:'read',description:'read files'},{name:'dispatch_development_task',description:'execute explicitly requested engineering task in background'}],setActiveTools:value=>{active=value;}};
 context.module.exports(pi);
 const ctx={sessionManager:{getSessionId:()=> 'source-A',getLeafId:()=> 'turn-1'},ui:{setStatus(){}}};
 const result=await hooks.before_agent_start({prompt:'Fix the requested bug',systemPrompt:'companion'},ctx);
 return{posts,result,tools,ctx,hooks};
}
(async()=>{
 const auto=await scenario(.99);assert.equal(auto.posts.length,1);assert.equal(auto.posts[0].source,'jev');assert.equal(auto.posts[0].sourceSessionId,'source-A');assert.ok(auto.posts[0].idempotencyKey);assert.match(auto.result.systemPrompt,/job-1/);
 await auto.tools[0].execute('call', {prompt:'Fix the same bug'},undefined,null,auto.ctx);assert.equal(auto.posts.length,1,'automatic dispatch + tool never enqueue twice');
 const discussion=await scenario(.05);assert.equal(discussion.posts.length,0,'development topic without execution request stays discussion');
 const ambiguous=await scenario(.7);assert.equal(ambiguous.posts.length,0);
 const chat=await scenario(.99,'chat');assert.equal(chat.posts.length,0);
 await discussion.tools[0].execute('explicit',{prompt:'Explicit engineering task'},undefined,null,discussion.ctx);assert.equal(discussion.posts.length,1);assert.equal(discussion.posts[0].source,'tool');
 assert.notEqual(auto.posts[0].idempotencyKey,'');
 console.log('PASS: explicit Jev intent, discussion/uncertainty/chat no auto dispatch, source isolation and auto/tool dedup. No network/model calls.');
})().catch(e=>{console.error(e);process.exitCode=1});
