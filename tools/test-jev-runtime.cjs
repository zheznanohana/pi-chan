const assert=require('assert/strict'),{createHash}=require('crypto'),{createJevRuntime}=require('../jev-runtime.cjs');
const pending=[],events=[];const agent={routeTask:(text,opts)=>new Promise(resolve=>pending.push({text,opts,resolve}))};
const api=createJevRuntime({agent,broadcast:(type,data)=>events.push({type,data})});
const hash=s=>createHash('sha256').update(s.trim()).digest('hex');
const profile=(s,id)=>({usable:true,inputHash:hash(s),sessionId:id,expiresAt:Date.now()+30000});
(async()=>{
 api.analyze('old','s');api.analyze('new','s');await new Promise(r=>setImmediate(r));
 pending[0].resolve({companion:profile('old','s')});pending[1].resolve({companion:profile('new','s')});await new Promise(r=>setImmediate(r));
 assert.equal(await api.profile('s',hash('old')),null);assert.equal((await api.profile('s',hash('new'))).inputHash,hash('new'));assert.equal(events.filter(e=>e.type==='jev_decision').length,1);
 assert.equal(await api.profile('other',hash('new')),null);
 api.analyze('slow','s');await new Promise(r=>setImmediate(r));const at=Date.now();assert.equal(await api.profile('s',hash('slow'),20),null);assert(Date.now()-at<200);
 pending[2].resolve({companion:{...profile('slow','s'),expiresAt:0}});await new Promise(r=>setImmediate(r));assert.equal(await api.profile('s',hash('slow')),null);
 console.log('PASS Jev latest-turn guard, session/hash matching, bounded wait and expired-result rejection');
})().catch(e=>{console.error(e);process.exitCode=1});
