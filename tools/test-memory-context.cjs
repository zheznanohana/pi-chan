const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {createMemoryContext}=require('../memory-context.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-memory-scope-')),file=path.join(dir,'scopes.json');let calls=[];
 const service={context:async input=>{calls.push(input);return {text:input.projectId,sources:[{id:'one'}]}}};
 let api=createMemoryContext({service,file});assert.deepEqual(await api.retrieve({sessionId:'s1',query:'test'}),{text:'',sources:[]});assert.equal(calls.length,0);
 api.bind('s1','p1');await api.retrieve({sessionId:'s1',query:'test'});assert.equal(calls.length,0);
 api.bind('s1','p1',true);api.bind('s2','p2',true);assert.equal((await api.retrieve({sessionId:'s1',query:'test'})).text,'p1');assert.equal((await api.retrieve({sessionId:'s2',query:'test'})).text,'p2');
 api=createMemoryContext({service,file});assert.equal((await api.retrieve({sessionId:'s2',query:'test'})).text,'p2');api.bind('s2','p2',false);assert.equal((await api.retrieve({sessionId:'s2',query:'test'})).sources.length,0);
 await api.retrieve({sessionId:'s1',query:'长消息'*400});assert.ok(calls.at(-1).query.length<=500);
 assert.throws(()=>api.bind('../path','default',true));
 console.log('PASS retrieval opt-in, per-session project isolation, restart persistence, disable clears retrieval, invalid identifiers');
})().catch(e=>{console.error(e);process.exitCode=1});
