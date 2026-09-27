'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createDevelopmentDispatch}=require('../development-dispatch.cjs');
test('session-link validates persisted identity, canonical approved root, and HTTP response',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-session-link-')),approved=path.join(dir,'sessions'),outside=path.join(dir,'sessions-other'),dataDir=path.join(dir,'queue');
 fs.mkdirSync(approved);fs.mkdirSync(outside);fs.mkdirSync(dataDir);const tasks=[];
 const add=(name,folder,header,changes={})=>{const id=crypto.randomUUID(),sessionId=crypto.randomUUID(),file=path.join(folder,name);fs.writeFileSync(file,JSON.stringify(header===undefined?{type:'session',id:sessionId}:header)+'\n');const link={sessionId,sessionFile:file,workbenchClientId:'pichan-task-'+id,...changes};tasks.push({id,status:'completed',link,result:{...link,text:'ok'}});return{id,sessionId,file};};
 const good=add('ok.jsonl',approved),bad=add('bad.jsonl',approved,{type:'session',id:'wrong'}),out=add('out.jsonl',outside),wrong=add('data.txt',approved),gone=add('gone.jsonl',approved);fs.unlinkSync(gone.file);
 const conflict=add('conflict.jsonl',approved);tasks.at(-1).result.sessionId='other';
 const pending={id:crypto.randomUUID(),status:'completed'};tasks.push(pending);
 const idOnly={id:crypto.randomUUID(),status:'completed',link:{sessionId:crypto.randomUUID(),workbenchClientId:'owned-id-only'},result:{text:'done'}};tasks.push(idOnly);
 const idOnlyFile=path.join(approved,'2026-09-23_'+idOnly.link.sessionId+'.jsonl');fs.writeFileSync(idOnlyFile,JSON.stringify({type:'session',id:idOnly.link.sessionId})+'\n');
 const alias=path.join(approved,'alias');fs.symlinkSync(outside,alias,'junction');const escaped=add('escape.jsonl',alias);
 fs.writeFileSync(path.join(dataDir,'queue.json'),JSON.stringify({version:1,tasks}));
 const s=createDevelopmentDispatch({dataDir,sessionRoots:[approved],resolveProject:()=>({root:dir}),runTask:async()=>{throw Error('should not run')},checkRequest:()=>{}});let server;
 try{
  assert.deepEqual(s.sessionLink(good.id),{sessionId:good.sessionId,sessionFile:fs.realpathSync(good.file),workbenchClientId:'pichan-task-'+good.id});
  for(const [item,status]of [[bad,409],[out,403],[wrong,403],[gone,410],[conflict,409],[pending,409],[escaped,403]])assert.throws(()=>s.sessionLink(item.id),e=>e.status===status);
  assert.equal(s.sessionLink(idOnly.id).sessionFile,fs.realpathSync(idOnlyFile));const stored=JSON.parse(fs.readFileSync(path.join(dataDir,'queue.json'))).tasks.find(t=>t.id===idOnly.id);assert.equal(stored.link.sessionFile,fs.realpathSync(idOnlyFile));assert.equal(stored.result.sessionFile,fs.realpathSync(idOnlyFile));
  server=http.createServer((req,res)=>s.handle(req,res,new URL(req.url,'http://localhost')));await new Promise(r=>server.listen(0,'127.0.0.1',r));const r=await fetch(`http://127.0.0.1:${server.address().port}/api/development/tasks/${good.id}/session-link?path=ignored`);assert.equal(r.status,200);assert.deepEqual(Object.keys(await r.json()).sort(),['sessionFile','sessionId','workbenchClientId']);
 }finally{await s.close();if(server)await new Promise(r=>server.close(r));assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});
