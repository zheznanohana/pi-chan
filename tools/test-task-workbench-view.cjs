'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(status='running',ok=true,mapping=null,plain=false){
 const sent=[],events=[],listeners={};let task={id:'task-1',status,link:{conversationId:'conv',sessionId:'session-target',workbenchClientId:'pichan-task-task-1'}};
 class WS{static OPEN=1;constructor(){this.readyState=1;this.l={}}addEventListener(k,f){this.l[k]=f}send(s){sent.push(JSON.parse(s))}close(){this.closed=true;this.readyState=3}}
 const parent={postMessage:m=>events.push(m)};
 const location={origin:'http://local',href:plain?'http://local/workbench/':'http://local/workbench/?pichanTaskId=task-1'};
 const window={parent,location,WebSocket:WS,addEventListener:(k,f)=>listeners[k]=f};
 const timers=new Map();let id=0;
 const context={window,location,document:{readyState:'loading',addEventListener(){}},URL,Date,Set,console,AbortSignal,fetch:async url=>url.endsWith('/session-link')?{ok:!!mapping,status:mapping?200:404,json:async()=>mapping||{error:'missing'}}:{ok,json:async()=>plain?{tasks:[{...task,link:{...task.link,sessionFile:'C:/sessions/target.jsonl'}}]}:({task})},setTimeout:f=>{timers.set(++id,f);return id},clearTimeout:i=>timers.delete(i)};
 vm.runInNewContext(fs.readFileSync(require.resolve('../integration/workbench-bridge.js'),'utf8'),context);
 const ws=new window.WebSocket('ws://local/workbench/ws');ws.l.open();
 return{ws,sent,events,timers,setStatus:s=>task.status=s,emit(message){let blocked=false;ws.l.message({data:JSON.stringify(message),stopImmediatePropagation(){blocked=true;}});return blocked;}};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('native workbench joins real task owner, running view blocks duplicate prompt',async()=>{
 const f=fixture();f.ws.send(JSON.stringify({type:'hello',clientId:'browser',locale:'zh'}));await settle();
 assert.equal(f.sent[0].clientId,'pichan-task-task-1');
 f.ws.send(JSON.stringify({type:'prompt',text:'duplicate'}));f.ws.send(JSON.stringify({type:'new_chat'}));
 assert.equal(f.sent.length,1);f.ws.send(JSON.stringify({type:'get_state'}));assert.equal(f.sent.length,2);
 assert(f.events.some(x=>x.event==='task-view'&&x.detail.readOnly));
});
test('completed task is editable in same native conversation without takeover',async()=>{
 const f=fixture('completed');f.ws.send(JSON.stringify({type:'hello',clientId:'browser'}));await settle();
 f.ws.send(JSON.stringify({type:'prompt',text:'before verification'}));assert.equal(f.sent.length,1);
 f.emit({type:'snapshot',state:{sessionId:'session-target',conversationId:'conv',isStreaming:false,rev:1,messages:[]}});
 f.ws.send(JSON.stringify({type:'prompt',text:'followup'}));assert.equal(f.sent[1].type,'prompt');
 assert(!f.sent.some(x=>x.type==='take_over_conversation'));
});
test('missing task mapping never connects as unrelated browser owner',async()=>{
 const f=fixture('running',false);f.ws.send(JSON.stringify({type:'hello',clientId:'browser'}));await settle();
 assert.equal(f.sent.length,0);assert.equal(f.ws.closed,true);assert(f.events.some(x=>x.event==='history-error'));
});

test('restart mismatch never exposes unrelated transcript; restores catalog-matched history only',async()=>{
 const f=fixture('completed');f.ws.send(JSON.stringify({type:'hello',clientId:'browser'}));await settle();
 assert.equal(f.emit({type:'snapshot',state:{sessionId:'other',conversationId:'other-conv',isStreaming:false,rev:1,messages:[{text:'PRIVATE'}]}}),true);
 await settle();assert.equal(f.sent.at(-1).type,'list_sessions');
 f.ws.send(JSON.stringify({type:'prompt',text:'blocked'}));assert.ok(!f.sent.some(x=>x.type==='prompt'));
 f.emit({type:'sessions',sessions:[{path:'C:/sessions/time_other.jsonl'},{path:'C:/sessions/time_session-target.jsonl'}]});
 assert.deepEqual(f.sent.at(-1),{type:'switch_session',path:'C:/sessions/time_session-target.jsonl'});
 assert.equal(f.emit({type:'snapshot',state:{sessionId:'session-target',conversationId:'restored',isStreaming:false,rev:2,messages:[]}}),false);
 f.ws.send(JSON.stringify({type:'prompt',text:'explicit followup'}));assert.equal(f.sent.at(-1).type,'prompt');
 assert(f.events.some(e=>e.event==='task-view'&&e.detail.verified&&e.detail.sessionId==='session-target'));
});
test('running target or busy current owner never restores another session',async()=>{
 for(const [status,busy]of [['running',false],['completed',true]]){
  const f=fixture(status);f.ws.send(JSON.stringify({type:'hello',clientId:'browser'}));await settle();
  assert.equal(f.emit({type:'snapshot',state:{sessionId:'other',isStreaming:busy}}),true);
  assert(!f.sent.some(x=>['list_sessions','switch_session','prompt'].includes(x.type)));
  assert(f.events.some(x=>x.event==='history-error'));
 }
});
test('missing or ambiguous persistent session fails closed',async()=>{
 for(const sessions of [[],[{path:'a_session-target.jsonl'},{path:'b_session-target.jsonl'}]]){
  const f=fixture('cancelled');f.ws.send(JSON.stringify({type:'hello'}));await settle();
  f.emit({type:'snapshot',state:{sessionId:'other',isStreaming:false}});await settle();f.emit({type:'sessions',sessions});
  assert(!f.sent.some(x=>x.type==='switch_session'));assert(f.events.some(x=>x.event==='history-error'));
 }
});

test('cross-project stored path is restored through server-validated session mapping',async()=>{
 const mapping={sessionId:'session-target',sessionFile:'D:/different-project/archive/session.jsonl',workbenchClientId:'pichan-task-task-1'};
 const f=fixture('completed',true,mapping);f.ws.send(JSON.stringify({type:'hello'}));await settle();
 f.emit({type:'snapshot',state:{sessionId:'other',conversationId:'old',isStreaming:false,rev:1,messages:[]}});await settle();
 assert.deepEqual(f.sent.at(-1),{type:'switch_session',path:mapping.sessionFile});assert(!f.sent.some(m=>m.type==='list_sessions'));
 f.emit({type:'snapshot',state:{sessionId:'session-target',conversationId:'restored',isStreaming:false,rev:2,messages:[]}});
 const count=f.sent.length;
 assert.equal(f.emit({type:'snapshot_delta',conversationId:'restored',baseRev:2,rev:3,state:{rev:3},appended:[]}),false);
 assert.equal(f.sent.length,count,'missing delta sessionId must not trigger another restore');
 assert.equal(f.emit({type:'snapshot_delta',conversationId:'different',baseRev:3,rev:4,state:{rev:4},appended:[]}),true);
 assert.equal(f.sent.at(-1).type,'get_state');
});
test('bad validated mapping is rejected, repeated catalog rows are deduplicated',async()=>{
 const bad=fixture('completed',true,{sessionId:'wrong',sessionFile:'D:/wrong.jsonl',workbenchClientId:'pichan-task-task-1'});bad.ws.send(JSON.stringify({type:'hello'}));await settle();bad.emit({type:'snapshot',state:{sessionId:'other',isStreaming:false}});await settle();assert(!bad.sent.some(m=>m.type==='switch_session'));
 const f=fixture('completed');f.ws.send(JSON.stringify({type:'hello'}));await settle();f.emit({type:'snapshot',state:{sessionId:'other',isStreaming:false}});await settle();f.emit({type:'sessions',sessions:[{path:'C:/x_session-target.jsonl'},{path:'C:/x_session-target.jsonl'}]});assert.equal(f.sent.at(-1).type,'switch_session');
});

test('history click routes a running dispatched task to its viewer, never a second writer',async()=>{
 const f=fixture('running',true,null,true);
 f.ws.send(JSON.stringify({type:'switch_session',path:'C:\\sessions\\target.jsonl'}));await settle();
 assert.equal(f.sent.length,0);
 assert(f.events.some(e=>e.event==='open-task'&&e.detail.taskId==='task-1'));
 f.ws.send(JSON.stringify({type:'take_over_conversation',owner:'pichan-task-task-1',id:'conv'}));await settle();
 assert.equal(f.sent.length,0);
});
test('unrelated history still opens normally and repeated clicks coalesce',async()=>{
 const f=fixture('running',true,null,true);
 f.ws.send(JSON.stringify({type:'switch_session',path:'C:/sessions/other.jsonl'}));await settle();
 assert.equal(f.sent.length,1);
 f.ws.send(JSON.stringify({type:'switch_session',path:'C:/sessions/target.jsonl'}));
 f.ws.send(JSON.stringify({type:'switch_session',path:'C:/sessions/target.jsonl'}));await settle();
 assert.equal(f.events.filter(e=>e.event==='open-task').length,1);
});
