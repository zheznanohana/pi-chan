'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(enqueue=async body=>({id:'job-1',title:'Task',status:'queued',sourceSessionId:body.sourceSessionId})){
 const nodes=[],handlers={},requests=[],events=[];let count=0;
 class El{constructor(tag){this.tag=tag;this.textContent='';this.value='';this.children=[];this.attrs={};this.events={};this.hidden=false;nodes.push(this)}append(...n){this.children.push(...n)}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,f){this.events[k]=f}showModal(){this.open=true}close(){this.open=false;this.events.close?.()}focus(){}click(){if(!this.disabled)return this.onclick?.()}}
 const body=new El('body'),top=new El('div'),prompt=new El('textarea');
 const window={piActiveSessionId:'source-1',piMemoryProjectId:'project-1',getSelection:()=>'',addEventListener:(k,v)=>handlers[k]=v,dispatchEvent:e=>events.push(e),piDevelopmentTasks:{enqueue:b=>{requests.push(b);return enqueue(b)},open:()=>{throw Error('Unexpected automatic navigation')}}};
 const document={body,activeElement:null,createElement:t=>new El(t),querySelector:s=>s==='.top-actions'?top:null,getElementById:()=>prompt};
 const code=fs.readFileSync(require.resolve('../task-handoff.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
 vm.runInNewContext(code,{window,document,crypto:{randomUUID:()=>`id-${++count}`},CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail}}});
 const text=t=>nodes.find(n=>n.textContent===t),label=t=>nodes.find(n=>n.attrs['aria-label']===t);
 function prepare(){text('交给开发').click();label('任务目标').value='Fix synthetic UI';text('预览任务').click()}
 return{window,nodes,handlers,requests,events,text,label,prepare};
}
test('preview has no network, iframe or mode change',()=>{const f=fixture();f.prepare();assert.equal(f.requests.length,0);assert.equal(f.text('确认加入后台队列').hidden,false)});
test('explicit confirm queues without choosing a conversation',async()=>{const f=fixture();f.prepare();await f.text('确认加入后台队列').click();assert.equal(f.requests.length,1);assert.equal(f.requests[0].sourceSessionId,'source-1');assert.equal(f.requests[0].projectId,'project-1');assert.equal(f.requests[0].executionRequested,true);assert.equal('conversationId' in f.requests[0],false);assert.equal(f.events[0].detail.taskId,'job-1')});
test('close before confirmation does not enqueue',()=>{const f=fixture();f.prepare();f.text('关闭').click();f.text('确认加入后台队列').click();assert.equal(f.requests.length,0)});
test('double confirm sends once while pending',async()=>{let done;const f=fixture(()=>new Promise(r=>done=r));f.prepare();const p=f.text('确认加入后台队列').click();f.text('确认加入后台队列').click();assert.equal(f.requests.length,1);done({id:'job',status:'queued'});await p});
test('retry keeps idempotency key after ambiguous network error',async()=>{let fail=true;const f=fixture(async()=>{if(fail)throw Error('Network lost');return{id:'job',status:'queued'}});f.prepare();await f.text('确认加入后台队列').click();fail=false;await f.text('确认加入后台队列').click();assert.equal(f.requests.length,2);assert.equal(f.requests[0].idempotencyKey,f.requests[1].idempotencyKey)});
test('source change invalidates unsent preview',()=>{const f=fixture();f.prepare();f.handlers['pi-session-changed']({detail:{id:'source-2'}});f.text('确认加入后台队列').click();assert.equal(f.requests.length,0);assert.equal(f.label('任务目标').value,'')});
test('late queue response keeps original source and does not reopen dialog',async()=>{let done;const f=fixture(()=>new Promise(r=>done=r));f.prepare();const p=f.text('确认加入后台队列').click();f.text('关闭').click();f.handlers['pi-session-changed']({detail:{id:'source-2'}});done({id:'job',status:'queued'});await p;assert.equal(f.events[0].detail.sourceSessionId,'source-1');assert.equal(f.nodes.find(n=>n.tag==='dialog').open,false)});
test('task preview uses textContent, bounds total length',()=>{const f=fixture();f.prepare();f.label('任务目标').value='<img src=x onerror=alert(1)>';f.text('预览任务').click();assert(f.nodes.find(n=>n.tag==='pre').textContent.includes('<img'));f.label('约束与范围').value='x'.repeat(8000);f.text('预览任务').click();assert(f.nodes.some(n=>n.textContent.includes('8000')))});
