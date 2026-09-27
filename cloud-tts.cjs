'use strict';
// Alibaba Cloud Qwen-Audio-TTS/CosyVoice WebSocket protocol (not Qwen3 realtime).
// https://help.aliyun.com/zh/model-studio/cosyvoice-client-events
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const WebSocket=require('ws');
const configFile=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.config'),'PiChanDashboard','cloud-tts.json');
const DEFAULTS={endpoint:'',model:'qwen-audio-3.1-tts-flash',voice:'longanhuan_v3.1',instructions:'明亮、偏高音、俏皮而自然的原创动漫风女声，吐字清楚，中英文发音自然，情绪灵动但不夸张，不模仿任何名人或现有角色。'};
const TOKEN_PLAN_ENDPOINT='https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const MODEL_VOICES=Object.freeze({'qwen-audio-3.1-tts-flash':'longanhuan_v3.1','qwen-audio-3.0-tts-flash':'longanfengyue','qwen-audio-3.0-tts-plus':'longanhuan_v3.6'});
function validateModel(model){if(typeof model!=='string'||!Object.hasOwn(MODEL_VOICES,model))throw error('请选择已接入的 Qwen Audio TTS 模型');return model;}
function defaultsFor(model){return{...DEFAULTS,model:validateModel(model),voice:MODEL_VOICES[model]};}
function readStore(){
 let value;try{value=JSON.parse(fs.readFileSync(configFile,'utf8'));}catch(e){if(e.code==='ENOENT')return{version:2,activeModel:DEFAULTS.model,profiles:{}};throw error('云端语音配置读取失败，请重新保存设置',503);}
 if(!value||typeof value!=='object'||Array.isArray(value))throw error('云端语音配置格式无效',503);
 if(value.version===2){
  validateModel(value.activeModel);
  if(!value.profiles||typeof value.profiles!=='object'||Array.isArray(value.profiles))throw error('云端语音profiles配置无效',503);
  return value;
 }
 // Legacy single-model config is migrated in memory; disk changes only on save.
 // Its credential stays with its own model; never share it with a new profile.
 const model=validateModel(value.model||DEFAULTS.model);
 return{version:2,activeModel:model,profiles:{[model]:{...value,model}}};
}
function profileFrom(store,model){const selected=validateModel(model===undefined?store.activeModel:model);const c={...defaultsFor(selected),...(store.profiles[selected]||{}),model:selected};if(c.endpoint===TOKEN_PLAN_ENDPOINT)c.apiKey=store.tokenPlan?.apiKey;return c;}
function getProfile(model){return profileFrom(readStore(),model);}
function publicFrom(store,model){const c=profileFrom(store,model);return{endpoint:c.endpoint,model:c.model,voice:c.voice,instructions:c.instructions,hasApiKey:!!c.apiKey,configured:!!(c.endpoint&&c.apiKey&&c.voice),activeModel:store.activeModel,isActive:c.model===store.activeModel};}
function publicConfig(model){return publicFrom(readStore(),model);}
function validateEndpoint(value){
 if(value==='')return '';
 if(value===TOKEN_PLAN_ENDPOINT)return value;
 let u;try{u=new URL(value);}catch{throw error('请输入官方WebSocket端点');}
 const official=u.hostname==='dashscope.aliyuncs.com'||/^[a-z0-9][a-z0-9-]*\.cn-beijing\.maas\.aliyuncs\.com$/.test(u.hostname);
 if(u.protocol!=='wss:'||!official||u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/api-ws/v1/inference')throw error('只接受百炼北京官方WebSocket或Token Plan专用HTTPS端点');
 return u.href;
}
function validateCredentialRoute(c){
 if(!c.apiKey||!c.endpoint)return;
 const subscription=c.apiKey.startsWith('sk-sp-'),tokenPlan=c.endpoint===TOKEN_PLAN_ENDPOINT;
 if(subscription!==tokenPlan)throw error('订阅Key仅用于Token Plan专用端点；按量Key仅用于官方WebSocket，不自动切换计费通道');
 if(tokenPlan&&c.model!=='qwen-audio-3.0-tts-plus')throw error('Token Plan 官方语音目录为 qwen-audio-3.0-tts-plus，请选择 3.0 Plus 套餐配置');
}
function saveConfig(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw error('配置必须为JSON对象');
 const store=readStore();
 const model=validateModel(Object.hasOwn(input,'model')?input.model:store.activeModel);
 const c=profileFrom(store,model);
 if(Object.hasOwn(input,'activate')&&typeof input.activate!=='boolean')throw error('activate必须为布尔值');
 for(const k of ['endpoint','model','voice','instructions'])if(Object.hasOwn(input,k)){
  if(typeof input[k]!=='string'||input[k].length>(k==='instructions'?2000:500))throw error('配置字段格式无效');c[k]=input[k].trim();
 }
 c.endpoint=validateEndpoint(c.endpoint);
 validateModel(c.model);
 if(!/^[A-Za-z0-9_.-]{1,200}$/.test(c.voice))throw error('请填写有效音色ID');
 if(Object.hasOwn(input,'apiKey')){if(typeof input.apiKey!=='string'||input.apiKey.length>4096||/[\r\n]/.test(input.apiKey))throw error('API Key格式无效');if(input.apiKey.trim())c.apiKey=input.apiKey.trim();}
 if(input.deleteApiKey===true)delete c.apiKey;
 validateCredentialRoute(c);
 if(c.endpoint===TOKEN_PLAN_ENDPOINT){store.tokenPlan={...store.tokenPlan};if(input.deleteApiKey===true)delete store.tokenPlan.apiKey;else if(c.apiKey)store.tokenPlan.apiKey=c.apiKey;delete c.apiKey;}
 store.profiles[model]=c;
 if(input.activate!==false)store.activeModel=model;
 const directory=path.dirname(configFile);fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const tmp=configFile+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(store,null,2),{mode:0o600});fs.renameSync(tmp,configFile);}catch{try{fs.unlinkSync(tmp);}catch{}throw error('云端语音配置保存失败',500);}
 return publicFrom(store,model);
}
function checkRequest(req){
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw error('仅支持本机访问',403);
 let host;try{host=new URL('http://'+req.headers.host);}catch{throw error('Host无效',403);}
 if(!['localhost','127.0.0.1','[::1]'].includes(host.hostname))throw error('仅接受本机Host',403);
 if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{throw error('来源无效',403);}if(origin.origin!==host.origin)throw error('跨来源请求已拦截',403);}
 if(req.headers['sec-fetch-site']==='cross-site')throw error('跨站请求已拦截',403);
}
async function handle(req,res,url){
 if(url.pathname!=='/api/tts/cloud')return false;
 const respond=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 try{checkRequest(req);
  if(req.method==='GET'){respond(200,publicConfig(url.searchParams.has('model')?url.searchParams.get('model'):undefined));return true;}
  if(req.method!=='POST')throw error('仅支持GET或POST',405);
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw error('需要application/json',415);
  const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>16384)throw error('配置请求过大',413);chunks.push(Buffer.from(chunk));}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('JSON格式无效');}
  respond(200,saveConfig(input));
 }catch(e){respond(e.status||500,{error:e.status?e.message:'云端语音配置操作失败'});}
 return true;
}
async function synthesize(text,options={}){
 const config=getProfile();validateEndpoint(config.endpoint);
 if(!config.endpoint||!config.apiKey||!config.voice)throw error('云端语音尚未配置：请填写百炼北京端点、API Key和音色ID',503);
 validateModel(config.model);validateCredentialRoute(config);
 if(typeof text!=='string'||!text.trim()||text.length>20000)throw error('云端语音文本需要1至20000字符');
 if(options.signal?.aborted)throw Object.assign(new Error('云端语音已取消'),{name:'AbortError'});
 if(config.endpoint===TOKEN_PLAN_ENDPOINT)return synthesizeTokenPlan(config,text,options);
 return new Promise((resolve,reject)=>{
  const taskId=crypto.randomUUID(),startedAt=Date.now(),sampleRate=24000;
  let ws,done=false,started=false,samples=0,chunkIndex=0,firstPacketMs=null,carry=Buffer.alloc(0),timer;
  const send=(action,payload)=>ws.send(JSON.stringify({header:{action,task_id:taskId,streaming:'duplex'},payload}));
  function finish(err){if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
   if(ws){if(err)ws.terminate();else{ws.close();const force=setTimeout(()=>ws.terminate(),1000);force.unref?.();}}
   if(err){reject(err);return;}
   const result={sampleRate,totalMs:Date.now()-startedAt,firstPacketMs,totalSamples:samples,durationSec:samples/sampleRate,voice:'qwen-cloud',sid:0};
   try{options.onDone?.(result);resolve(result);}catch(e){reject(e);}
  }
  function abort(){if(ws?.readyState===WebSocket.OPEN&&started)try{send('finish-task',{input:{directive:'cancel'}});}catch{}finish(Object.assign(new Error('云端语音已取消'),{name:'AbortError'}));}
  try{ws=new WebSocket(config.endpoint,{headers:{Authorization:'Bearer '+config.apiKey},handshakeTimeout:15000,maxPayload:8*1024*1024,followRedirects:false});}
  catch{reject(error('云端语音连接初始化失败',502));return;}
  timer=setTimeout(()=>finish(error('云端语音任务超时',504)),120000);
  ws.on('error',()=>finish(error('百炼语音连接失败，请检查端点、密钥权限与网络',502)));
  ws.on('close',()=>{if(!done)finish(error('百炼语音连接提前关闭，音频可能未完整生成',502));});
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted){abort();return;}
  ws.on('open',()=>{
   if(done)return;
   try{options.onStatus?.({phase:'connected',voice:'qwen-cloud'});}catch{finish(error('语音状态回调失败',500));return;}
   const rate=Number.isFinite(options.speed)?Math.min(2,Math.max(.5,options.speed)):1;
   try{send('run-task',{task_group:'audio',task:'tts',function:'SpeechSynthesizer',model:config.model,parameters:{text_type:'PlainText',voice:config.voice,format:'pcm',sample_rate:sampleRate,rate,instruction:config.instructions},input:{}});}catch{finish(error('云端语音任务启动失败',502));}
  });
  ws.on('message',(data,isBinary)=>{
   if(done)return;
   try{
    if(isBinary){
     if(!started)throw error('语音数据早于任务就绪',502);
     const joined=carry.length?Buffer.concat([carry,data]):Buffer.from(data);carry=joined.length%2?Buffer.from(joined.subarray(-1)):Buffer.alloc(0);const pcm=joined.subarray(0,joined.length-carry.length);if(!pcm.length)return;
     samples+=pcm.length/2;if(samples>sampleRate*120)throw error('云端语音超出时长上限',502);
     if(firstPacketMs===null)firstPacketMs=Date.now()-startedAt;
     const floats=new Float32Array(pcm.length/2);for(let i=0;i<floats.length;i++)floats[i]=pcm.readInt16LE(i*2)/32768;
     options.onChunk?.({pcmBuffer:pcm,floatSamples:floats,sampleRate,chunkIndex:++chunkIndex,firstPacketMs,latencyMs:Date.now()-startedAt,progress:0,voice:'qwen-cloud',sid:0});return;
    }
    const event=JSON.parse(data.toString());if(event.header?.task_id!==taskId)return;
    switch(event.header.event){
     case 'task-started':if(started)return;started=true;send('continue-task',{input:{text}});send('finish-task',{input:{}});break;
     case 'task-finished':if(!started||!samples||carry.length)throw error('云端语音未返回完整PCM',502);finish();break;
     case 'task-failed':throw error('百炼语音合成失败，请检查模型、音色、额度与权限',502);
    }
   }catch(e){finish(e.status?e:error('百炼语音返回的数据格式无效',502));}
  });
 });
}
// Token Plan uses HTTP SSE, not workspace WebSocket. No retries or fallback billing.
async function synthesizeTokenPlan(config,text,options){
 const sampleRate=24000,startedAt=Date.now(),controller=new AbortController();
 let reader,buffer='',carry=Buffer.alloc(0),samples=0,index=0,firstPacketMs=null,finished=false,totalBytes=0,stage='连接云端';
 const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted)abort();
 const timeout=setTimeout(abort,120000);
 try{
  const rate=Number.isFinite(options.speed)?Math.min(2,Math.max(.5,options.speed)):1;
  const response=await fetch(config.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json','X-DashScope-SSE':'enable'},body:JSON.stringify({model:config.model,input:{text,voice:config.voice,format:'pcm',sample_rate:sampleRate,rate,instruction:config.instructions}})});
  if(!response.ok)throw error('Token Plan语音请求失败（HTTP '+response.status+'），请检查套餐模型权限和额度',502);
  if(!response.body||!String(response.headers.get('content-type')||'').toLowerCase().includes('text/event-stream'))throw error('Token Plan未返回预期SSE音频流',502);
  stage='接收音频流';
  options.onStatus?.({phase:'connected',voice:'qwen-cloud'});
  reader=response.body.getReader();const decoder=new TextDecoder();
  function frame(raw){
   const data=raw.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
   if(!data||data==='[DONE]')return;
   let event;try{event=JSON.parse(data);}catch{throw error('Token Plan SSE数据格式无效',502);}
   if(event.code||event.error)throw error('Token Plan语音服务返回错误，请检查套餐权限',502);
   const output=event.output;if(!output)return;
   // Final complete-file URL may include duplicated audio: never play/download it.
   if(output.audio?.data){
    const encoded=output.audio.data;
    if(typeof encoded!=='string'||encoded.length>8*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw error('Token Plan PCM编码无效',502);
    const data=Buffer.from(encoded,'base64'),joined=carry.length?Buffer.concat([carry,data]):data;
    carry=joined.length%2?Buffer.from(joined.subarray(-1)):Buffer.alloc(0);
    const pcm=joined.subarray(0,joined.length-carry.length);
    if(pcm.length){samples+=pcm.length/2;if(samples>sampleRate*120)throw error('云端语音超出时长上限',502);if(firstPacketMs===null)firstPacketMs=Date.now()-startedAt;
     const floats=new Float32Array(pcm.length/2);for(let i=0;i<floats.length;i++)floats[i]=pcm.readInt16LE(i*2)/32768;
     options.onChunk?.({pcmBuffer:pcm,floatSamples:floats,sampleRate,chunkIndex:++index,firstPacketMs,latencyMs:Date.now()-startedAt,progress:0,voice:'qwen-cloud',sid:0});
    }
   }
   if(output.finish_reason==='stop')finished=true;
   else if(output.finish_reason&&output.finish_reason!=='null')throw error('Token Plan语音非正常结束',502);
  }
  while(!finished){
   const {value,done}=await reader.read();
   if(done){buffer+=decoder.decode();if(buffer.trim())frame(buffer);break;}
   totalBytes+=value.length;if(totalBytes>24*1024*1024)throw error('Token Plan输出超出限制',502);
   buffer+=decoder.decode(value,{stream:true});if(buffer.length>8*1024*1024)throw error('Token Plan事件过大',502);
   let match;while(!finished&&(match=/\r?\n\r?\n/.exec(buffer))){const raw=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);frame(raw);}
  }
  if(!finished||!samples||carry.length)throw error('Token Plan音频流未完整结束',502);
  const result={sampleRate,totalMs:Date.now()-startedAt,firstPacketMs,totalSamples:samples,durationSec:samples/sampleRate,voice:'qwen-cloud',sid:0};
  options.onDone?.(result);return result;
 }catch(e){
  if(controller.signal.aborted)throw Object.assign(new Error(options.signal?.aborted?'云端语音已取消':'Token Plan语音请求超时'),{name:options.signal?.aborted?'AbortError':'TimeoutError'});
  if(e.status)throw e;
  const code=String(e.cause?.code||e.code||'');
  const known=new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  throw error('Token Plan'+stage+'失败'+(known.has(code)?'（'+code+'）':'')+(samples?'；已收到部分音频':'；尚未收到音频'),502);
 }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);if(reader)try{await reader.cancel();reader.releaseLock();}catch{}controller.abort();}
}
module.exports={handle,getProfile,publicConfig,saveConfig,synthesize,configFile,checkRequest};
