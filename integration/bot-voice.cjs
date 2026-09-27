'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
function ffmpeg(input,args){return new Promise((resolve,reject)=>{const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error',...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});const chunks=[];let size=0,done=false;const finish=(e)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(Buffer.concat(chunks))};const timer=setTimeout(()=>{child.kill();finish(Error('语音转换超时'))},30000);child.on('error',()=>finish(Error('请安装 FFmpeg 或设置 FFMPEG_PATH')));child.stdout.on('data',b=>{size+=b.length;if(size>24*1024*1024){child.kill();finish(Error('语音过长'))}else chunks.push(b)});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('close',code=>finish(code?Error('语音解码失败'):null));child.stdin.end(input)})}
async function decodeIncoming(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw Error('语音文件为空或超过20MB');
 const silk=require('silk-wasm');
 if(silk.isSilk(bytes)){
  if(silk.getDuration(bytes)>120000)throw Error('语音超过120秒，请分条发送');
  const decoded=await silk.decode(bytes,16000);return Buffer.from(decoded.data);
 }
 return ffmpeg(bytes,['-protocol_whitelist','pipe','-i','pipe:0','-t','121','-ar','16000','-ac','1','-f','s16le','pipe:1']);
}
async function transcribe(bytes,provider='local'){
 if(!['local','token-plan'].includes(provider))throw Error('语音识别服务无效');
 const pcm=await decodeIncoming(bytes);
 if(pcm.length>16000*2*120)throw Error('语音超过120秒，请分条发送');
 if(provider==='token-plan')return require('../cloud-asr.cjs').transcribe(pcm);
 const texts=[];let error;const session=require('../asr-engine.js').createSession({onFinal:r=>{if(r.text)texts.push(r.text)},onError:e=>{error=e}});
 try{for(let i=0;i<pcm.length;i+=3200){session.feedPCM(pcm.subarray(i,i+3200));await session.pendingFinals;}await session.finish();if(error)throw error;return texts.join(' ')}finally{session.dispose()}
}
async function synthesize(text,{voice='qwen-cloud',directory,platform='telegram',synthesizeStream}){
 if(typeof text!=='string'||!text.trim())throw Error('语音回复内容为空');
 if(text.length>4000)throw Error('回复过长，语音生成已停止');
 const chunks=[];let rate=null,totalBytes=0;
 await (synthesizeStream||require('../tts-engine.js').synthesizeStream)(text,{voice,onChunk:chunk=>{
  if(!Number.isInteger(chunk.sampleRate)||chunk.sampleRate<8000||chunk.sampleRate>96000)throw Error('合成采样率无效');
  if(rate&&rate!==chunk.sampleRate)throw Error('合成采样率发生变化');rate=chunk.sampleRate;
  if(chunk.pcmBuffer){totalBytes+=chunk.pcmBuffer.length;if(totalBytes>24*1024*1024)throw Error('合成语音超过大小限制');chunks.push(Buffer.from(chunk.pcmBuffer));}
 }});
 if(!rate||!chunks.length)throw Error('TTS 没有返回音频');
 const pcm=Buffer.concat(chunks);let encoded,extension;
 if(platform==='qq-official'||platform==='qq-onebot'){
  const normalized=rate===24000?pcm:await ffmpeg(pcm,['-f','s16le','-ar',String(rate),'-ac','1','-i','pipe:0','-ar','24000','-f','s16le','pipe:1']);
  encoded=Buffer.from((await require('silk-wasm').encode(normalized,24000)).data);extension='silk';
 }else{encoded=await ffmpeg(pcm,['-f','s16le','-ar',String(rate),'-ac','1','-i','pipe:0','-c:a','libopus','-f','ogg','pipe:1']);extension='ogg'}
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'bot-reply-'+crypto.randomUUID()+'.'+extension);fs.writeFileSync(file,encoded);return file;
}
module.exports={transcribe,synthesize,decodeIncoming,convertAudio:ffmpeg};
