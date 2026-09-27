'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){const messages=[],listeners={},sent=[];class Textarea{constructor(){this._v='';this.disabled=false;this.isConnected=true;}get value(){return this._v;}set value(v){this._v=v;}dispatchEvent(){}}const input=new Textarea();class WS{static OPEN=1;constructor(){this.readyState=1;this.l={};}addEventListener(k,f){this.l[k]=f;}send(x){sent.push(JSON.parse(x));}emit(x){this.l.message({data:JSON.stringify(x)});}}
 const parent={postMessage:m=>messages.push(m)},window={parent,location:{origin:'http://local'},WebSocket:WS,addEventListener:(k,f)=>(listeners[k]??=[]).push(f)};
 const context={window,location:{origin:'http://local',href:'http://local/workbench/'},document:{readyState:'loading',addEventListener(){},querySelector:()=>input},HTMLTextAreaElement:Textarea,Event:class{},URL,Date,Set,console,setTimeout:()=>1,clearTimeout:()=>{}};vm.runInNewContext(fs.readFileSync(require.resolve('../integration/workbench-bridge.js'),'utf8'),context);
 const ws=new window.WebSocket('http://local/workbench/ws');ws.l.open();ws.emit({type:'snapshot',state:{conversationId:'c1',sessionId:'s1',cwd:'C:/project',isStreaming:false,rev:1,messages:[]}});
 const post=(m,origin='http://local',source=parent)=>listeners.message.forEach(f=>f({source,origin,data:m}));const hand=(command,extra={})=>post({source:'pichan-handoff',command,token:'t1',conversationId:'c1',sessionId:'s1',text:'Build timer',...extra});return{messages,sent,input,ws,post,hand};}
test('retired handoff bridge rejects all submission paths without touching drafts',()=>{
 for(const draft of ['', 'Existing draft'])for(const command of ['prepare','commit']){
  const f=fixture();f.input.value=draft;f.hand(command);assert.equal(f.messages.at(-1).event,'handoff-error');
  assert.equal(f.input.value,draft);assert.equal(f.sent.length,0);
  f.hand(command,{mode:'append'});f.hand(command,{mode:'replace'});assert.equal(f.input.value,draft);assert.equal(f.sent.length,0);
 }
});
test('foreign sources cannot invoke retired handoff or history commands',()=>{
 const f=fixture(),count=f.messages.length;
 f.post({source:'pichan-handoff',command:'commit',token:'x'},'http://evil');
 f.post({source:'pichan-handoff',command:'commit',token:'x'},'http://local',{});
 assert.equal(f.messages.length,count);assert.equal(f.sent.length,0);assert.equal(f.input.value,'');
});
test('legal incremental state is observed and a revision gap requests resync',()=>{
 const f=fixture();f.ws.emit({type:'snapshot_delta',conversationId:'c1',baseRev:1,rev:2,appended:[],state:{rev:2,isStreaming:true}});
 assert.equal(f.messages.at(-1).detail.isStreaming,true);
 f.ws.emit({type:'snapshot_delta',conversationId:'c1',baseRev:0,rev:3,appended:[],state:{rev:3,isStreaming:false}});
 assert.equal(f.sent.at(-1).type,'get_state');assert.equal(f.messages.at(-1).detail.isStreaming,true);
});
test('history uses real switch opcode and waits target snapshot',()=>{const f=fixture();f.ws.emit({type:'conversations',activeId:'c1',conversations:[{id:'c2',cwd:'C:/project'},{id:'bad',cwd:'C:/other'}]});f.post({source:'pichan-history',command:'select',requestId:'r1',conversationId:'bad'});assert.equal(f.sent.length,0);f.post({source:'pichan-history',command:'select',requestId:'r2',conversationId:'c2'});assert.equal(f.sent[0].type,'switch_conversation');assert.equal(f.sent[0].id,'c2');f.ws.emit({type:'snapshot',state:{conversationId:'c2',sessionId:'s2'}});assert.equal(f.messages.at(-1).event,'status');assert(f.messages.some(m=>m.event==='history-selected'&&m.detail.requestId==='r2'));});
