'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTaskOrchestrator,validatePlan}=require('../integration/task-orchestrator.cjs');
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pichan-orch-'));
const task={id:'t',harness:'development',title:'example',projectId:'default',sourceSessionId:'source',prompt:'Implement the specified multi-module change'};
const plan={tasks:[{id:'a',title:'A',prompt:'do A',dependsOn:[]},{id:'b',title:'B',prompt:'do B',dependsOn:['a']}],acceptance:'A and B implemented'};
const query=async()=>({answers:{strategy:{choice:'planned',confidence:.95}}});
test('DAG rejects cycles, unknown dependencies, duplicate and reserved ids',()=>{
 for(const tasks of [[{id:'a',dependsOn:['a']}],[{id:'a',dependsOn:['missing']}],[{id:'plan',dependsOn:[]}],[{id:'a',dependsOn:[]},{id:'a',dependsOn:[]}]])assert.throws(()=>validatePlan({...plan,tasks:tasks.map(t=>({...t,title:'x',prompt:'x'}))}));
 assert.equal(validatePlan(plan).tasks.length,2);
});
test('planned run persists source, ordered sessions, one parent link and model verification',async()=>{
 const calls=[],links=[],children=[];let active=0;
 const runner={runTask:async(t,o)=>{assert.equal(active++,0);calls.push(t.title);o.onLinked?.({sessionId:o.runId,conversationId:o.runId});active--;return{text:calls.length===1?JSON.stringify(plan):calls.length===4?JSON.stringify({passed:true,summary:'verified by review',issues:[]}):'done',conversationId:o.runId};}};
 const instance=createTaskOrchestrator({runner,query,dataDir:dir(),onSession:s=>children.push(s)});
 const result=await instance.runTask(task,{runId:'parent',onLinked:x=>links.push(x)});
 assert.equal(calls.length,4);assert.equal(links.length,1);assert.equal(children.length,4);assert.equal(result.orchestration.verification.method,'model_review');
 assert.equal(instance.get('parent').sourceSessionId,'source');assert.equal(instance.list()[0].status,'completed');
 await instance.runTask(task,{runId:'parent'});assert.equal(calls.length,4);
});
test('Jev uncertainty chooses single and never generates speculative tree',async()=>{
 let calls=0;const instance=createTaskOrchestrator({runner:{runTask:async()=>{calls++;return{text:'done'}}},query:async()=>({answers:{strategy:{choice:'planned',confidence:.4}}}),dataDir:dir()});
 await instance.runTask(task,{runId:'single'});assert.equal(calls,1);assert.equal(instance.get('single').decision.mode,'single');
});
test('invalid plan halts without execution and failed run is not replayed',async()=>{
 let calls=0;const instance=createTaskOrchestrator({runner:{runTask:async()=>{calls++;return{text:'bad JSON'}}},query,dataDir:dir()});
 await assert.rejects(instance.runTask(task,{runId:'bad'}));assert.equal(calls,1);assert.equal(instance.get('bad').status,'failed');
 await assert.rejects(instance.runTask(task,{runId:'bad'}),{code:'DUPLICATE_RUN'});
});
test('negative acceptance is failed not completed',async()=>{
 let calls=0;const instance=createTaskOrchestrator({runner:{runTask:async()=>({text:++calls===1?JSON.stringify(plan):calls===4?JSON.stringify({passed:false,summary:'missing test evidence',issues:['test']}):'done'})},query,dataDir:dir()});
 await assert.rejects(instance.runTask(task,{runId:'rejected'}),{code:'ACCEPTANCE_FAILED'});assert.equal(instance.get('rejected').status,'failed');
});
test('pre-cancellation dispatches nothing',async()=>{
 let calls=0;const instance=createTaskOrchestrator({runner:{runTask:async()=>{calls++}},query,dataDir:dir()});const controller=new AbortController();controller.abort();
 await assert.rejects(instance.runTask(task,{runId:'cancelled',signal:controller.signal}),{code:'ABORTED'});assert.equal(calls,0);
});
