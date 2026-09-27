'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDevelopmentDispatch}=require('../development-dispatch.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await wait(5);}throw Error('condition timeout');}
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-dispatch-'));const s=createDevelopmentDispatch({dataDir:dir,resolveProject:()=>({root:dir}),tickMs:20,...options});t.after(async()=>{await s.close();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert(path.basename(dir).startsWith('pichan-dispatch-'));fs.rmSync(dir,{recursive:true,force:true});});return{s,dir};}
const input=(key='one')=>({prompt:'Implement the specified isolated fixture.',sourceSessionId:'source-chat',idempotencyKey:key,source:'jev',executionRequested:true});
test('persists acceptance, deduplicates concurrent requests, serial execution and completion events',async t=>{
 let running=0,max=0,calls=0;const events=[];
 const {s,dir}=fixture(t,{onEvent:e=>events.push(e),runTask:async(task,o)=>{running++;max=Math.max(max,running);calls++;o.onLinked({conversationId:'conv-'+task.id,workbenchClientId:'client-'+task.id});await wait(20);running--;return{text:'finished',conversationId:'conv-'+task.id};}});
 const [a,b]=await Promise.all([s.create(input()),s.create(input())]);assert.equal(a.task.id,b.task.id);assert.equal(b.deduplicated,true);
 await s.create(input('two'));await until(()=>s.list().every(x=>x.status==='completed'));assert.equal(calls,2);assert.equal(max,1);assert(events.some(e=>e.type==='completed'&&e.task.result.text==='finished'));
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'queue.json')));assert.equal(saved.tasks.length,2);assert(saved.tasks[0].link.conversationId);
 await assert.rejects(s.create({...input(),prompt:'different'}),e=>e.status===409);
});
test('queue does not depend on a UI observer; external busy is respected',async t=>{
 let busy=true,calls=0;const {s}=fixture(t,{externalBusy:()=>busy,runTask:async()=>{calls++;return{text:'ok'}}});const a=await s.create(input());await wait(30);assert.equal(calls,0);busy=false;await until(()=>s.get(a.task.id).status==='completed');assert.equal(calls,1);
});
test('abort is scoped to current job; failed jobs are not retried',async t=>{
 let calls=0;const {s}=fixture(t,{runTask:(_task,{signal})=>{calls++;return new Promise((r,j)=>{signal.addEventListener('abort',()=>j(Object.assign(Error('cancelled'),{code:'ABORTED'})),{once:true});});}});const a=await s.create(input());await until(()=>s.get(a.task.id).status==='running');s.cancel(a.task.id);await until(()=>s.get(a.task.id).status==='cancelled');await wait(30);assert.equal(calls,1);
 const f=fixture(t,{runTask:async()=>{throw Error('mock model failure')}});const b=await f.s.create(input());await until(()=>f.s.get(b.task.id).status==='failed');await wait(30);assert.equal(f.s.list().length,1);
});
test('restart marks running interrupted; queued waits for explicit acknowledgement',async t=>{
 const {s,dir}=fixture(t,{externalBusy:()=>true,runTask:async()=>({text:'no'})});const a=await s.create(input());await s.create(input('next'));await s.close();const state=JSON.parse(fs.readFileSync(path.join(dir,'queue.json')));state.tasks[0].status='running';fs.writeFileSync(path.join(dir,'queue.json'),JSON.stringify(state));let calls=0;
 const reopened=createDevelopmentDispatch({dataDir:dir,resolveProject:()=>({root:dir}),runTask:async()=>{calls++;return{text:'ok'}},tickMs:20});t.after(()=>reopened.close());assert.equal(reopened.get(a.task.id).status,'interrupted');await wait(40);assert.equal(calls,0);reopened.acknowledge(a.task.id);await until(()=>calls===1);assert.equal(reopened.get(a.task.id).status,'interrupted');
});
test('unconfirmed cancellation blocks subsequent work; source project is selected',async t=>{
 let seen;const {s}=fixture(t,{resolveSourceProject:()=> 'bound-project',resolveProject:id=>{seen=id;return{root:os.tmpdir()}},runTask:async()=>{throw Object.assign(Error('unknown execution'),{code:'TERMINATION_FAILED'})}});const a=await s.create(input());await until(()=>s.get(a.task.id).status==='failed');assert.equal(seen,'bound-project');assert.equal(s.isBlocked(),true);assert.equal(s.get(a.task.id).executionUncertain,true);await assert.rejects(s.create({...input('bad'),executionRequested:false}));
});
