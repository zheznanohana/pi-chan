'use strict';
// Dedicated process isolates ONNX DLLs from sherpa-onnx on Windows and keeps inference off the voice loop.
const {fork}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const MODEL='Xenova/multilingual-e5-small',REVISION='761b726dd34fb83930e26aab4e9ac3899aa1fa78';
if(process.argv[2]==='--embedding-child'&&process.send){
 const workerData={cacheDir:process.argv[3]};const parentPort={on:(_event,fn)=>process.on('message',fn),postMessage:value=>{if(process.connected)process.send(value);}};process.on('disconnect',()=>process.exit(0));
 let extractor;
 async function load(){if(!extractor){const {pipeline,env}=await import('@huggingface/transformers');env.cacheDir=workerData.cacheDir;env.backends.onnx.wasm.numThreads=1;const local=path.resolve(workerData.cacheDir,MODEL,REVISION);const cached=['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx'].every(f=>fs.existsSync(path.join(local,f)));extractor=await pipeline('feature-extraction',cached?local:MODEL,{revision:REVISION,dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:2,interOpNumThreads:1}});}return extractor;}
 let queue=Promise.resolve();parentPort.on('message',m=>{queue=queue.then(async()=>{try{const pipe=await load();let result=true;if(m.text!==undefined){const out=await pipe((m.query?'query: ':'passage: ')+String(m.text).slice(0,6000),{pooling:'mean',normalize:true,truncation:true,max_length:512});result=Array.from(out.data);}parentPort.postMessage({id:m.id,result});}catch(e){parentPort.postMessage({id:m.id,error:String(e.message).slice(0,500)});}});});
}else{
 const {DatabaseSync}=require('node:sqlite');
 function createLocalEmbeddings({dataDir,cacheDir=path.join(dataDir,'models')}={}){
  fs.mkdirSync(dataDir,{recursive:true});const db=new DatabaseSync(path.join(dataDir,'embeddings.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,vector TEXT NOT NULL,updatedAt TEXT NOT NULL); CREATE INDEX IF NOT EXISTS vectors_project ON vectors(projectId);');
  const model=MODEL+'@'+REVISION+':q8';let worker,seq=0,state='idle',error='',retryAt=0,closed=false,loading,indexing=false;const invalidated=new Set();const pending=new Map();
  function startWorker(){
   const child=fork(__filename,['--embedding-child',path.resolve(cacheDir)],{windowsHide:true,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});worker=child;
   child.on('message',m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}});
   const failed=e=>{if(worker!==child)return;worker=null;loading=null;if(!closed){state='error';error=String(e.message).slice(0,500);retryAt=Date.now()+60000;}for(const p of pending.values())p.reject(e);pending.clear();};
   child.on('error',failed);child.on('exit',(code,signal)=>failed(new Error('embedding child exited: '+(signal||code))));return child;
  }
  function rpc(text,query=false){if(closed)return Promise.reject(new Error('embedding closed'));const child=worker||startWorker();return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.send({id,text,query},err=>{if(err){pending.delete(id);reject(err);}});});}
  async function stopWorker(){const child=worker;if(!child)return;await new Promise(resolve=>{child.once('exit',resolve);if(child.exitCode!==null||child.signalCode!==null)return resolve();child.kill();});}
  function warmup(){if(closed)return Promise.reject(new Error('embedding closed'));if(!loading&&Date.now()<retryAt)return Promise.reject(new Error('embedding retry pending'));if(!loading){state='loading';loading=rpc().then(()=>{state='ready';error='';return true;}).catch(e=>{state='error';error=String(e.message).slice(0,500);retryAt=Date.now()+60000;loading=null;throw e;});}return loading;}
  const hash=r=>crypto.createHash('sha256').update(r.title+'\n'+r.content).digest('hex');
  async function sync(records,projectId){if(indexing||closed)return;indexing=true;try{for(const r of records){if(closed)break;if(invalidated.has(r.id))continue;const h=hash(r),old=db.prepare('SELECT hash,model FROM vectors WHERE id=?').get(r.id);if(old?.hash===h&&old.model===model)continue;const vector=await rpc(r.title+'\n'+r.content);if(closed)break;if(invalidated.has(r.id))continue;if(vector.length!==384||vector.some(x=>!Number.isFinite(x)))throw new Error('invalid embedding dimensions');db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?,?)').run(r.id,projectId,h,model,vector.length,JSON.stringify(vector),new Date().toISOString());}}catch(e){error=String(e.message).slice(0,500);}finally{indexing=false;}}
  async function search({projectId,query,records=[],limit=8}){if(state!=='ready'){warmup().catch(()=>{});throw new Error('local embedding '+state);}const allowed=new Map(records.map(r=>[r.id,r]));sync(records,projectId);const q=await rpc(query,true);if(closed)throw new Error('embedding closed');return db.prepare('SELECT * FROM vectors WHERE projectId=? AND model=?').all(projectId,model).flatMap(r=>{const live=allowed.get(r.id);if(!live||hash(live)!==r.hash)return [];const v=JSON.parse(r.vector);if(v.length!==q.length)return [];return [{id:r.id,score:v.reduce((sum,n,i)=>sum+n*q[i],0)}];}).sort((a,b)=>b.score-a.score).slice(0,limit);}
  return {search,warmup,invalidateIds:ids=>{if(!closed)for(const id of ids){invalidated.add(id);db.prepare('DELETE FROM vectors WHERE id=?').run(id);}},status:()=>({state,model,runtime:'node-child-process',pid:worker?.pid||null,dimensions:384,indexing,error,retryAt,records:closed?0:db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE model=?').get(model).n}),sync:async(records,projectId)=>{await warmup();await sync(records,projectId);},close:async()=>{if(closed)return;closed=true;await stopWorker();db.close();}};
 }
 module.exports={createLocalEmbeddings,MODEL,REVISION};
}
