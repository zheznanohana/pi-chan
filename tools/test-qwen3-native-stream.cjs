'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),results=[],texts=['你好，我在这里。','你好。','Hello, how are you?'];
const python='E:/pinokio/api/whisper-webui.git/app/env/Scripts/python.exe';
let ready,current,lastWorkerError,idx=0,timer,finished=false;const start=performance.now();
const child=spawn(python,['-X','utf8',path.join(root,'qwen3-native-stream-server.py')],{cwd:root,windowsHide:true,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
child.stderr.pipe(fs.createWriteStream(path.join(__dirname,'qwen3-native-stream.stderr.log')));
function save(extra={}){fs.writeFileSync(path.join(__dirname,'qwen3-native-stream-eos-results.json'),JSON.stringify({ready,results,workerError:lastWorkerError,wallMs:performance.now()-start,...extra},null,2));}
function fail(e){if(finished)return;finished=true;clearTimeout(timer);save({passed:false,error:e.message});if(child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});console.error(e);process.exitCode=1;}
function deadline(){clearTimeout(timer);timer=setTimeout(()=>fail(Error('Phase timeout 180s')),180000);}
function send(){current={id:'stream-'+(idx+1),text:texts[idx],started:performance.now(),chunks:[],audio:[]};child.stdin.write(JSON.stringify({id:current.id,text:current.text,language:'Auto',maxTokens:256,emitEveryFrames:4})+'\n');deadline();}
function wav(data,sr,file){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(sr*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);fs.writeFileSync(file,Buffer.concat([h,data]));}
readline.createInterface({input:child.stdout}).on('line',line=>{try{
 const m=JSON.parse(line);if(m.event==='loading')console.log('Loading native stream worker...');
 if(m.event==='error'){lastWorkerError=m;throw Error(m.error);}
 if(m.event==='ready'){ready=m;console.log(JSON.stringify(m));send();}
 else if(m.event==='chunk'){assert.equal(m.id,current.id);const pcm=Buffer.from(m.pcm16Base64,'base64');assert(pcm.length>0&&pcm.length%2===0);current.audio.push(pcm);current.chunks.push({atMs:performance.now()-current.started,bytes:pcm.length,generationElapsedMs:m.generationElapsedMs});if(current.chunks.length===1)console.log('FIRST '+current.id+' '+current.chunks[0].atMs.toFixed(1)+'ms');}
 else if(m.event==='end'){
  const wall=performance.now()-current.started;console.log('END '+JSON.stringify(m));save({lastEnd:m});assert(current.chunks.length>1,'must emit multiple genuine generation chunks');assert(wall-current.chunks[0].atMs>100,'first output must precede generation end');
  const data=Buffer.concat(current.audio),sample=path.join(__dirname,'qwen3-native-stream-eos-'+(idx+1)+'.wav');wav(data,m.sampleRate,sample);
  let peak=0;for(let i=0;i<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));assert(peak>0);
  results.push({id:current.id,text:current.text,ttfaMs:current.chunks[0].atMs,wallMs:wall,rtf:m.totalMs/1000/m.durationSec,chunks:current.chunks,end:m,peak,sample});console.log(JSON.stringify({id:current.id,ttfaMs:current.chunks[0].atMs,wallMs:wall,rtf:results.at(-1).rtf,chunks:current.chunks.length}));save();
  idx++;if(idx<texts.length)send();else{child.stdin.end(JSON.stringify({id:'quit',command:'quit'})+'\n');}
 }else if(m.event==='bye'){finished=true;clearTimeout(timer);const passed=results.every(r=>r.end.eosReached&&!r.end.tokenLimitReached&&!r.end.contextLimitReached);save({passed});if(!passed)process.exitCode=1;console.log('FINISHED warmup plus Chinese/English; inspect natural-EOS result');}
}catch(e){fail(e);}});
child.on('error',fail);child.on('exit',code=>{if(!finished)fail(Error('Worker exit '+code));});deadline();
