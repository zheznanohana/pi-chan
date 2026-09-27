'use strict';
// Exactly one sentence is synthesized. No model download, no second warm-up request.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const python=process.env.QWEN_TEST_PYTHON || 'E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe';
const text=process.env.QWEN_TEST_TEXT || '你好，Hello.';
const output=path.join(__dirname,'qwen3-resident-sample.wav');
const started=performance.now();let ready=null,firstMs=null,sentAt=0,done=null,pcm=[],sr=0,settled=false;
const child=spawn(python,['-X','utf8',path.join(root,'qwen3-server.py'),'--device',process.env.QWEN_TEST_DEVICE||'cuda:0'],{cwd:root,windowsHide:true,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
const stderr=fs.createWriteStream(path.join(__dirname,'qwen3-resident-test.stderr.log'));child.stderr.pipe(stderr);
function fail(error){if(settled)return;settled=true;clearTimeout(timer);if(process.platform==='win32'&&child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();console.error(error);process.exitCode=1;}
const timer=setTimeout(()=>fail(Error('Qwen sentence worker timeout (180s)')),180000);
const lines=readline.createInterface({input:child.stdout});
lines.on('line',line=>{try{
 const m=JSON.parse(line);
 if(m.event==='error')throw Error(m.error);
 if(m.event==='ready'){
  ready=m;sentAt=performance.now();child.stdin.write(JSON.stringify({id:'qwen-test-one',text,language:'Auto',maxTokens:96})+'\n');
 }else if(m.event==='chunk'){
  assert.equal(m.id,'qwen-test-one');assert.equal(m.sampleRate,24000);sr=m.sampleRate;
  if(firstMs===null)firstMs=performance.now()-sentAt;pcm.push(Buffer.from(m.pcm16Base64,'base64'));
 }else if(m.event==='end'){
  assert.equal(m.id,'qwen-test-one');assert.equal(m.promptCached,true);assert.equal(m.streamingMode,'sentence');done=m;
  const data=Buffer.concat(pcm);assert(data.length>4800);assert.equal(data.length%2,0);
  let peak=0;for(let i=0;i<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));assert(peak>0);
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sr,24);header.writeUInt32LE(sr*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);fs.writeFileSync(output,Buffer.concat([header,data]));
  const result={passed:true,text,ready,firstChunkWallMs:firstMs,end:done,wallMs:performance.now()-started,rtf:done.totalMs/1000/done.durationSec,peak,sample:output,synthesisCount:1};
  fs.writeFileSync(path.join(__dirname,'qwen3-resident-test-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  child.stdin.end(JSON.stringify({id:'shutdown',command:'quit'})+'\n');
 }else if(m.event==='bye'){settled=true;clearTimeout(timer);}
}catch(e){fail(e);}});
child.on('error',fail);child.on('exit',code=>{if(!settled||code!==0)fail(Error('Worker exited before successful shutdown: '+code));});

