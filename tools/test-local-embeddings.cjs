'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createLocalEmbeddings}=require('../integration/local-embeddings.cjs');
const {createMemoryService}=require('../memory-service.cjs');
test('real CPU E5 q8: Chinese semantic retrieval, persistence, scope and invalidation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-embedding-'));const opts={dataDir:dir,cacheDir:path.resolve(__dirname,'../data/embeddings/models')};let e=createLocalEmbeddings(opts);
 const records=[{id:'car',title:'交通',content:'汽车抛锚，需要修理车辆'},{id:'food',title:'晚餐',content:'晚餐吃西红柿鸡蛋面'}];
 try{
  // Reproduce production: ASR native addon loaded before embedding runtime.
  const sherpa=require('sherpa-onnx-node');assert.ok(sherpa);
  await e.warmup();assert.equal(e.status().runtime,'node-child-process');assert.notEqual(e.status().pid,process.pid);await e.sync(records,'a');const result=await e.search({projectId:'a',query:'车坏了送去维修',records});assert.equal(result[0].id,'car');assert.ok(result[0].score>result[1].score);assert.equal(e.status().dimensions,384);console.log(JSON.stringify({model:e.status().model,scores:result}));
  assert.deepEqual(await e.search({projectId:'b',query:'车坏了',records:[]}),[]);
  await e.close();e=createLocalEmbeddings(opts);await e.warmup();assert.equal(e.status().records,2);
  assert.deepEqual((await e.search({projectId:'a',query:'车坏了',records:[records[1]]})).map(x=>x.id),['food']);
  e.invalidateIds(['car']);assert.equal(e.status().records,1);
  const svc=createMemoryService({dataDir:path.join(dir,'memory'),allowedRoot:dir,semanticProvider:e});try{const n=svc.upsertNote({title:'交通',content:'汽车抛锚，需要修理车辆'});await svc.search({query:'汽车'});while(e.status().indexing)await new Promise(r=>setTimeout(r,20));const semantic=await svc.search({query:'车坏了送去维修'});assert.ok(semantic.results.some(x=>x.noteId===n.id));assert.equal(semantic.mode,'hybrid');svc.deleteNote(n.id);assert.deepEqual((await svc.search({query:'车坏了送去维修'})).results,[]);}finally{svc.close();}
 }finally{await e.close();assert.ok(path.basename(dir).startsWith('pichan-embedding-'));fs.rmSync(dir,{recursive:true,force:true});}
});
