const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn,spawnSync}=require('child_process');
const {SessionStore,activeMessages}=require('../session-store.cjs');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-history-')),port=31416;
const id='12345678-1234-4234-8234-123456789abc';
const now=new Date().toISOString();
const entries=[{type:'session',version:3,id,timestamp:now,cwd:root},{type:'message',id:'u1',parentId:null,timestamp:now,message:{role:'user',content:[{type:'text',text:'History fixture: Markdown'}],timestamp:Date.now()}},{type:'message',id:'old',parentId:'u1',timestamp:now,message:{role:'assistant',content:[{type:'text',text:'Abandoned reply'}],api:'openai-responses',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}},{type:'message',id:'a1',parentId:'u1',timestamp:now,message:{role:'assistant',content:[{type:'text',text:'**Restored**\n\n- one\n- two'}],api:'openai-responses',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}}];
fs.writeFileSync(path.join(dir,`${id}.jsonl`),entries.map(JSON.stringify).join('\n')+'\n');
assert.equal(activeMessages(entries).length,2);assert.equal(new SessionStore(dir).list()[0].messages.length,2);
let child,logs='';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function call(url,method='GET'){let r=await fetch(`http://127.0.0.1:${port}${url}`,{method,signal:AbortSignal.timeout(20000)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
async function start(){child=spawn(process.execPath,['harness-server.js'],{cwd:root,windowsHide:true,env:{...process.env,PORT:String(port),SESSION_STORE_DIR:dir,PI_OFFLINE:'1'}});child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);for(let i=0;i<40;i++){await delay(500);try{return await call('/api/sessions')}catch{}}throw Error('Test server start failed: '+logs.slice(-3000));}
function stop(){if(child){spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});child=null;}}
(async()=>{const checks=[];try{
 let listed=await start();assert.equal(listed.activeId,id);assert.equal(listed.sessions[0].messageCount,2);checks.push('real Pi --continue loads isolated persisted session');
 const restored=await call(`/api/sessions/${id}`);assert.equal(restored.messages.length,2);assert.ok(restored.messages[1].content[0].text.includes('**Restored**'));checks.push('active get_messages restores Markdown and excludes abandoned branch');
 const fresh=await call('/api/sessions','POST');assert.notEqual(fresh.id,id);assert.deepEqual(fresh.messages,[]);checks.push('new_session creates empty real session');
 const old=await call(`/api/sessions/${id}`);assert.equal(old.messages.length,2);checks.push('inactive history retains selected branch');
 const switched=await call(`/api/sessions/${id}/switch`,'POST');assert.equal(switched.id,id);assert.equal(switched.messages.length,2);checks.push('switch_session restores original conversation');
 const unknown=await fetch(`http://127.0.0.1:${port}/api/sessions/not-found/switch`,{method:'POST'});assert.equal(unknown.status,400);checks.push('unknown session rejected');
 stop();await delay(500);listed=await start();assert.equal(listed.activeId,id);assert.equal((await call(`/api/sessions/${id}`)).messages.length,2);checks.push('server restart retains history');
 const result={passed:true,isolatedStore:dir,checks};fs.writeFileSync(path.join(root,'history-test-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{stop();fs.writeFileSync(path.join(dir,'server-test.log'),logs);}})().catch(e=>{console.error(e);process.exitCode=1});
