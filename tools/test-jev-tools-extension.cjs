const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const handlers={},tools=[{name:'read',description:'Read files'},{name:'edit',description:'Edit files'},{name:'search_web',description:'Search the web'}];let active=tools.map(t=>t.name),session='s1',mode='ready',deferred;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const statuses=[];
vm.runInNewContext(fs.readFileSync('.pi/extensions/jev-tools.ts','utf8').replace("import {createHash} from 'node:crypto';",'').replace("import {Type} from 'typebox';",'').replace('export default function','function')+'\njevTools(pi);',{
 Type:{Object:()=>({}),Optional:()=>({}),String:()=>({})},createHash,process:{env:{PICHAN_HARNESS_KIND:'chat'}},AbortSignal,Date,Set,JSON,Number,
 pi:{registerTool:t=>{tools.push(t);active.push(t.name)},on:(type,fn)=>handlers[type]=fn,getActiveTools:()=>active,getAllTools:()=>tools,setActiveTools:value=>active=[...value]},
 fetch:async(_url,options)=>{const request=JSON.parse(options.body);if(mode==='wait')await new Promise(r=>deferred=r);return {ok:true,json:async()=>({status:mode==='unavailable'?'unavailable':'ready',sessionId:request.sessionId,expiresAt:Date.now()+(mode==='expired'?-1:30000),inputHash:hash(request.text),catalogHash:hash(request.tools),selectedTools:mode==='invented'?['unregistered']:['edit'],route:'chat',routeUsable:true})}}
});
const ctx={sessionManager:{getSessionId:()=>session,getLeafId:()=> 'leaf'},ui:{setStatus:(...a)=>statuses.push(a)}};
(async()=>{
 await handlers.before_agent_start({prompt:'做个简单修改'},ctx);assert.deepEqual(active,['edit','dispatch_development_task']);handlers.agent_end();assert.deepEqual(active,tools.map(t=>t.name));
 for(mode of ['unavailable','expired','invented']){await handlers.before_agent_start({prompt:'test'},ctx);assert.deepEqual(active,tools.map(t=>t.name));}
 mode='wait';const pending=handlers.before_agent_start({prompt:'old'},ctx);await new Promise(r=>setImmediate(r));session='s2';handlers.session_switch();deferred();await pending;assert.deepEqual(active,tools.map(t=>t.name));
 mode='ready';await handlers.before_agent_start({prompt:'new'},ctx);assert.deepEqual(active,['edit','dispatch_development_task']);active=['search_web'];handlers.agent_end();assert.deepEqual(active,['search_web']);
 active=['read','edit','search_web'];await handlers.before_agent_start({prompt:'disabled bridge'},ctx);assert.deepEqual(active,['edit']);handlers.agent_end();assert.deepEqual(active,['read','edit','search_web']);
 assert.ok(statuses.some(s=>String(s[1]).includes('保留现有')));console.log('PASS dispatch bridge retained only when originally enabled; dynamic selection (edit allowed in chat), restore, fallback, expiry, invented tool, stale turn and external settings preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
