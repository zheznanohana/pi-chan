const assert=require('node:assert/strict');const {createJevToolPlanner}=require('../jev-tool-planner.cjs');
const tools=[{name:'read',description:'Read a file'},{name:'web_search',description:'Retrieve current facts online'},{name:'edit',description:'Edit file'}];let seen;
const response=(values,route='chat')=>({answers:{route:{choice:route,confidence:.9},...Object.fromEntries(values.map((noul,i)=>['tool_'+i,{noul}]))}});
(async()=>{
let p=createJevToolPlanner({query:async q=>{seen=q;return response([.1,.94,.1])}});let r=await p.plan({text:'调查当前信息',tools,sessionId:'session-1'});assert.equal(r.status,'ready');assert.deepEqual(r.selectedTools,['web_search']);assert.equal(r.route,'chat');assert.equal(seen.questions.tool_1.type,'noul');assert.equal(seen.state.catalog.length,3);assert.equal(r.permissionChanged,false);assert.ok(r.catalogHash&&r.inputHash&&r.expiresAt>r.createdAt);
p=createJevToolPlanner({query:async()=>response([.97,.1,.92],'development')});r=await p.plan({text:'修复文件',tools});assert.deepEqual(r.selectedTools,['read','edit']);
p=createJevToolPlanner({query:async()=>response([.97,.1,.92],'chat')});r=await p.plan({text:'same arbitrary fixture',tools});assert.deepEqual(r.selectedTools,['read','edit'],'no mode whitelist');
p=createJevToolPlanner({query:async()=>response([.1,.1,.1])});assert.deepEqual((await p.plan({text:'hi',tools})).selectedTools,[]);
p=createJevToolPlanner({query:async()=>response([.5,.1,.1])});r=await p.plan({text:'x',tools});assert.equal(r.reason,'uncertain_tools');assert.deepEqual(r.selectedTools,tools.map(t=>t.name));
p=createJevToolPlanner({query:async()=>({answers:{...response([.1,.1,.1]).answers,invented:{name:'execute_fake',noul:1}}})});assert.deepEqual((await p.plan({text:'x',tools})).selectedTools,[],'extra invented answer never executes or selects');
p=createJevToolPlanner({query:async()=>response(['.9',.1,.1])});assert.equal((await p.plan({text:'x',tools})).reason,'invalid_response');
p=createJevToolPlanner({timeoutMs:10,query:()=>new Promise(resolve=>setTimeout(()=>resolve(response([1,1,1])),40))});r=await p.plan({text:'x',tools});assert.equal(r.reason,'timeout');assert.deepEqual(r.selectedTools,tools.map(t=>t.name));await new Promise(r=>setTimeout(r,50));assert.equal(r.status,'unavailable');
p=createJevToolPlanner({query:async()=>{throw Error('secret must not leak')}});r=await p.plan({text:'x',tools});assert.equal(r.reason,'jev_unavailable');assert.ok(!JSON.stringify(r).includes('secret'));
assert.equal((await p.plan({text:'x',tools:[tools[0],tools[0]]})).reason,'invalid_catalog');assert.equal((await p.plan({text:'x',tools:[]})).status,'ready');const ac=new AbortController();ac.abort();assert.equal((await p.plan({text:'x',tools,signal:ac.signal})).reason,'cancelled');
console.log('PASS dynamic Noul multi-select, independent route, no mode whitelist, bounded real catalog, uncertainty/unavailable/timeout/late response/cancel fallback');
})().catch(e=>{console.error(e);process.exitCode=1});
