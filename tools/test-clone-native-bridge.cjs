const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),{EventEmitter}=require('events'),{PassThrough}=require('stream');
const source=fs.readFileSync('clone-stream.js','utf8');
function fixture(backend){
 const launches=[];let kills=0;
 function spawn(binary,args){
  launches.push(args);const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{kills++;c.emit('exit',0);};
  c.stdin={write(line,cb){cb?.();const m=JSON.parse(line);const emit=v=>c.stdout.write(JSON.stringify({id:m.id,...v})+'\n');
   setTimeout(()=>{if(m.text==='loading-error'){c.stdout.write(JSON.stringify({event:'error',error:'load failed'})+'\n');return;}
    const rate=m.text==='bad-rate'?0:24000;
    emit({event:'chunk',sampleRate:rate,pcm16Base64:Buffer.from([0,64,0,192]).toString('base64')});
    if(m.text==='cancel')return;
    setTimeout(()=>{emit({event:'chunk',sampleRate:24000,pcm16Base64:Buffer.from([0,32]).toString('base64')});emit({event:'end'});},15);
   },3);
  }};return c;
 }
 const scope={require:n=>n==='node:child_process'?{spawn}:require(n),process:{platform:'linux',env:{QWEN_TTS_BACKEND:backend}},__dirname:process.cwd(),module:{exports:{}},Buffer,Float32Array,setTimeout,clearTimeout};vm.createContext(scope);vm.runInContext(source,scope);
 return {api:scope.module.exports,launches,get kills(){return kills}};
}
(async()=>{
 const f=fixture('native-stream');let completed=false,count=0;
 const result=await f.api.synthesize('qwen3-clone','test',{onChunk:c=>{assert.equal(completed,false);assert.ok(c.pcmBuffer.length);if(count++===0)assert.deepEqual(Array.from(c.floatSamples),[0.5,-0.5]);},onDone:()=>completed=true});
 assert.equal(count,2);assert.equal(result.totalSamples,3);assert.match(f.launches[0][1],/qwen3-native-stream-server.py$/);
 await assert.rejects(f.api.synthesize('qwen3-clone','bad-rate'),/采样率/);assert.equal(f.kills,1);
 await assert.rejects(f.api.synthesize('qwen3-clone','loading-error'),/load failed/);assert.equal(f.kills,2);
 const abort=new AbortController();await assert.rejects(f.api.synthesize('qwen3-clone','cancel',{signal:abort.signal,onChunk:()=>abort.abort()}),/取消/);
 await assert.rejects(f.api.synthesize('missing','text'),/未知/);f.api.close();
 const legacy=fixture('sentence');await legacy.api.synthesize('qwen3-clone','test');assert.match(legacy.launches[0][1],/qwen3-server.py$/);legacy.api.close();
 console.log('PASS native streaming selection, incremental delivery, lip-sync PCM, bad rate/load failure cleanup, mid-stream cancellation, explicit legacy rollback');
})().catch(e=>{console.error(e);process.exitCode=1});
