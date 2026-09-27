const vm=require('vm'),fs=require('fs'),assert=require('assert/strict'),path=require('path');
const root=path.resolve(__dirname,'..'),listeners={},published=[];
class Textarea{constructor(){this._value='现有草稿';this.isConnected=true;this.disabled=false;this.inputs=[]}get value(){return this._value}set value(v){this._value=v}dispatchEvent(e){this.inputs.push(e.type)}}const input=new Textarea();
class Socket{static OPEN=1;constructor(){this.events={};this.readyState=1}addEventListener(n,f){this.events[n]=f}send(data){this.lastSent=data}}
const parent={postMessage:m=>published.push(m)},window={parent,location:{origin:'http://localhost'},WebSocket:Socket,addEventListener:(n,f)=>listeners[n]=f};
const context={window,location:{origin:'http://localhost',href:'http://localhost/workbench/'},document:{readyState:'loading',addEventListener(){},querySelector:()=>input},HTMLTextAreaElement:Textarea,Event:class{constructor(type){this.type=type}},URL,localStorage:{getItem:()=>null}};
vm.runInNewContext(fs.readFileSync(path.join(root,'integration/workbench-bridge.js'),'utf8'),context);
const ws=new window.WebSocket('ws://localhost/workbench/ws');ws.events.open();ws.events.message({data:JSON.stringify({type:'snapshot',state:{sessionId:'s1',conversationId:'c1',rev:1,messages:[]}})});
const send=(command,token='token-1',text='',origin='http://localhost',source=parent)=>listeners.message({origin,source,data:{source:'pichan-dictation',command,token,text}});
ws.events.message({data:JSON.stringify({type:'snapshot_delta',conversationId:'c1',baseRev:1,rev:2,appended:[],state:{rev:2}})});assert.equal(published.at(-1).detail.sessionId,'s1');assert.equal(published.at(-1).detail.conversationId,'c1');
send('begin');assert.equal(published.at(-1).event,'dictation-ready');send('append','token-1','新增语音');assert.equal(input.value,'现有草稿\n新增语音');assert.deepEqual(input.inputs,['input']);
send('append','token-1','外部','https://other');assert.equal(input.inputs.length,1);
send('append','wrong','旧识别');assert.equal(input.inputs.length,1);
ws.send(JSON.stringify({type:'switch_conversation',id:'c2'}));send('append','token-1','晚到结果');assert.equal(input.inputs.length,1);assert.equal(published.at(-1).event,'dictation-invalidated');
ws.events.message({data:JSON.stringify({type:'snapshot',state:{sessionId:'s2',conversationId:'c2',rev:3,messages:[]}})});send('begin','token-2');send('cancel','token-2');send('append','token-2','取消晚到');assert.equal(input.inputs.length,1);
send('begin','token-3');ws.events.message({data:JSON.stringify({type:'snapshot_delta',conversationId:'c2',baseRev:3,rev:4,appended:[],state:{rev:4,sessionId:'s3'}})});send('append','token-3','切会话晚到');assert.equal(input.inputs.length,1);
assert.equal(ws.lastSent,JSON.stringify({type:'switch_conversation',id:'c2'}),'dictation never sent prompt on socket');
console.log('PASS: preserves draft, input state event, no auto-send, source/origin guard, token guard, outbound switch race, incoming session change, cancelled late final');
// UI lifecycle tests with fake capture: no microphone, model prompt or GPU use.
(async()=>{
 const events={},posted=[],created=[];let failMic=false;
 class El{constructor(tag){this.tag=tag;this.hidden=false;this.attrs={};this.contentWindow={postMessage:m=>{posted.push(m);if(m.command==='begin')queueMicrotask(()=>events.message({origin:'http://localhost',source:this.contentWindow,data:{source:'pichan-workbench',event:'dictation-ready',detail:{token:m.token}}}))}}}setAttribute(k,v){this.attrs[k]=v}append(){}after(){}replaceChildren(){}addEventListener(n,f){this[n]=f}}
 class Voice{constructor(){created.push(this);this.currentAsrProvider='local';this.asrProviderSent='local';this.ws=null;this.isRecording=false}setAsrProvider(p){this.currentAsrProvider=p;this.asrProviderSent=p;}async startMicRecording(){this.isRecording=!failMic}stopMicRecording(flush){this.isRecording=false;this.flushed=flush}}
 class WS{constructor(){this.readyState=1;queueMicrotask(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'asr_ready',provider:'local'})})})}close(){this.closed=true;this.onclose?.()}}
 const surface=new El(),win={piDevelopmentTasks:{subscribe(){},getTasks:()=>[]},voiceUI:{stopVoiceMode(){}},piShared:{update(){}},addEventListener:(n,f)=>events[n]=f};
 const ui={VoiceUIController:Voice,document:{createElement:tag=>new El(tag),body:{append(){},classList:{toggle(){}}},querySelector:selector=>selector.includes('nav')?null:surface},window:win,location:{origin:'http://localhost',host:'localhost',protocol:'http:'},localStorage:{getItem:()=>JSON.stringify({inputDeviceId:'chosen-microphone'})},WebSocket:WS,crypto:{randomUUID:()=>String(Math.random())},setTimeout:()=>1,clearTimeout:()=>{},queueMicrotask,fetch:async()=>({ok:true,json:async()=>({ready:true})}),console};
 vm.runInNewContext(fs.readFileSync(path.join(root,'workbench-panel.js'),'utf8').replace(/^\uFEFF/,'').replace(/^import [^\r\n]*[\r\n]+/gm,''),ui);
 vm.runInNewContext('started=true;frame.hidden=false;',ui);
 await vm.runInNewContext('startDictation()',ui);const first=created[0];assert.equal(first.inputDeviceId,'chosen-microphone');assert.equal(first.isRecording,true);
 first.ws.onmessage({data:JSON.stringify({type:'asr_final',text:'听写草稿'})});assert.equal(posted.at(-1).command,'append');assert.equal(posted.at(-1).text,'听写草稿');
 const late=first.ws.onmessage;vm.runInNewContext('setMode(false)',ui);assert.ok(first.ws.closed);const length=posted.length;late({data:JSON.stringify({type:'asr_final',text:'迟到'})});assert.equal(posted.length,length);
 failMic=true;await vm.runInNewContext('startDictation()',ui);assert.ok(created.at(-1).ws.closed);assert.equal(vm.runInNewContext('dictation',ui),null);
 failMic=false;await vm.runInNewContext('startDictation()',ui);assert.equal(created.at(-1).isRecording,true);
 const last=created.at(-1);vm.runInNewContext('stopDictation(true)',ui);
 last.ws.onmessage({data:JSON.stringify({type:'asr_final',text:'第一段'})});last.ws.onmessage({data:JSON.stringify({type:'asr_final',text:'第二段'})});assert.ok(!last.ws.closed);
 last.ws.onmessage({data:JSON.stringify({type:'asr_finished'})});assert.ok(!last.ws.closed,'wait for draft ACKs');
 const ack=()=>events.message({origin:'http://localhost',source:vm.runInNewContext('frame.contentWindow',ui),data:{source:'pichan-workbench',event:'dictation-applied',detail:{token:vm.runInNewContext('dictationToken',ui)}}});ack();assert.ok(!last.ws.closed);ack();assert.ok(last.ws.closed);
 await vm.runInNewContext('startDictation()',ui);events.pagehide();assert.ok(created.at(-1).ws.closed);
 console.log('PASS: independent capture, preferred device, final fills only, mode-switch cancellation, late result rejected, permission failure and retry, pagehide cleanup');
})().catch(e=>{console.error(e);process.exitCode=1});

