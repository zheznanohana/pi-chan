const fs=require('fs'),path=require('path'),assert=require('assert/strict'),WebSocket=require('ws');
const root=path.resolve(__dirname,'..'),port=process.env.TEST_PORT||31415;
const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/tts`),results=[];
const texts=['你好，我在这里。','Hello, how are you?','这是打断测试，现在停止播放。'];
let index=0,current,timeout,settled=false,cancelled=false,cancelRequested=false;
function save(extra={}){fs.writeFileSync(path.join(root,'tools/qwen-native-websocket-results.json'),JSON.stringify({results,...extra},null,2));}
function fail(error){if(settled)return;settled=true;clearTimeout(timeout);save({passed:false,error:error.message});ws.close();console.error(error);process.exitCode=1;}
function send(){clearTimeout(timeout);current={text:texts[index],started:performance.now(),chunks:[],bytes:0,peak:0,statuses:[]};timeout=setTimeout(()=>fail(Error('Native WebSocket phase timed out')),180000);ws.send(JSON.stringify({type:'tts_speak',voice:'qwen3-clone',sid:0,text:current.text}));}
ws.on('open',send);ws.on('error',fail);
ws.on('message',(data,binary)=>{try{
 if(cancelled){if(binary)throw Error('PCM arrived after cancellation grace period');return;}
 if(binary){current.bytes+=data.length;assert.equal(data.length%2,0);for(let i=0;i<data.length;i+=2)current.peak=Math.max(current.peak,Math.abs(data.readInt16LE(i)));current.chunks.push({atMs:performance.now()-current.started,bytes:data.length});if(index===2&&!cancelRequested){
   cancelRequested=true;
   ws.send(JSON.stringify({type:'tts_cancel'}));results.push({text:current.text,firstPacketMs:current.chunks[0].atMs,cancelSent:true});clearTimeout(timeout);
   // A frame already queued in the transport can precede cancellation processing.
   setTimeout(()=>{cancelled=true;},150);
   setTimeout(()=>{settled=true;save({passed:true,cancellationQuietMs:1000});ws.close();console.log('PASS actual native WebSocket Chinese, English, ordered PCM, status, mid-generation cancellation');},1150);
  }return;}
 const m=JSON.parse(data);if(m.type==='tts_status')current.statuses.push(m.phase);
 if(m.type==='tts_error')throw Error(m.error);
 if(m.type==='tts_end'){
  assert(current.peak>0&&current.chunks.length>1);assert.equal(m.sampleRate,24000);assert(m.totalMs>current.chunks[0].atMs-50);
  results.push({text:current.text,bytes:current.bytes,peak:current.peak,firstPacketMs:current.chunks[0].atMs,chunkCount:current.chunks.length,statuses:current.statuses,server:m});save();console.log(JSON.stringify(results.at(-1)));index++;send();
 }
}catch(e){fail(e);}});
