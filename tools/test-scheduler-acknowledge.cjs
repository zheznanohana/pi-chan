'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createScheduler}=require('../scheduler-service.cjs');
test('restart cleanup requires explicit acknowledgement, preserves history and same-harness blocks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-scheduler-ack-'));let calls=0;
 const options={dataDir:dir,runTask:async()=>{calls++;return{text:'done'}}};let s=createScheduler(options),server;
 try{
  const make=title=>s.create({title,prompt:'isolated mock task',harness:'development',schedule:{type:'interval',everyMinutes:1}});
  const a=make('a'),b=make('b');s.close();const file=path.join(dir,'tasks.json'),store=JSON.parse(fs.readFileSync(file));
  for(const [i,t]of store.tasks.entries()){t.status=i?'cancelling':'running';t.enabled=true;t.history=[{id:'h'+i,status:'running'}];}fs.writeFileSync(file,JSON.stringify(store));
  s=createScheduler(options);assert(s.list().every(t=>t.workerCleanupRequired&&t.status==='interrupted'&&!t.enabled));
  assert.throws(()=>s.acknowledge(a.id),e=>e.status===400);await assert.rejects(s.run(a.id),e=>e.status===409);
  s.acknowledge(a.id,{executionChecked:true});assert.equal(s.list()[0].history[0].status,'interrupted');assert.equal(s.list()[0].enabled,false);await assert.rejects(s.run(a.id),e=>e.status===409);
  server=http.createServer((req,res)=>s.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/api/tasks/${b.id}/acknowledge`;
  let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,400);
  r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"executionChecked":true}'});assert.equal(r.status,200);assert.equal((await r.json()).task.enabled,false);assert.equal(calls,0);
  await s.run(a.id);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  const saved=JSON.parse(fs.readFileSync(file));assert(saved.tasks.every(t=>!t.workerCleanupRequired));
 }finally{s.close();if(server)await new Promise(r=>server.close(r));assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});
test('active task cannot be acknowledged',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-scheduler-ack-'));let finish;const s=createScheduler({dataDir:dir,runTask:()=>new Promise(r=>finish=r)});
 try{const t=s.create({title:'active',prompt:'mock',harness:'development',schedule:{type:'interval',everyMinutes:1}});await s.run(t.id);assert.throws(()=>s.acknowledge(t.id,{executionChecked:true}),e=>e.status===409);finish({text:'done'});await new Promise(r=>setImmediate(r));}
 finally{s.close();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});
