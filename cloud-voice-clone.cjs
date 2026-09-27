'use strict';
// Official voice-enrollment URL protocol. No paid request is made on import/list/use.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const tts=require('./cloud-tts.cjs');
const MAX_BYTES=10*1024*1024;
const file=path.join(path.dirname(tts.configFile),'cloud-voices.json');
const models=new Set(['qwen-audio-3.0-tts-plus','qwen-audio-3.0-tts-flash','qwen-audio-3.1-tts-flash']);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
let creating=false;
function profile(model){if(!models.has(model))throw fail('请选择已接入的语音模型');return tts.getProfile(model);}
function capability(c){
 if(c.apiKey?.startsWith('sk-sp-')||c.endpoint?.includes('token-plan.'))return 'Token Plan 的声音克隆接口及额度尚未得到官方确认；本次不会上传音频，也不会切换到按量计费通道。';
 if(!c.apiKey||!c.endpoint)return '请先保存该模型的百炼北京端点和 API Key。';
 let u;try{u=new URL(c.endpoint);}catch{return '百炼端点格式无效。';}
 if(u.protocol!=='wss:'||u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/api-ws/v1/inference'||!(u.hostname==='dashscope.aliyuncs.com'||/^[a-z0-9][a-z0-9-]*\.cn-beijing\.maas\.aliyuncs\.com$/.test(u.hostname)))return '声音克隆仅接入已配置的百炼北京官方端点。';
 return '';
}
function scope(c){return crypto.createHash('sha256').update(c.endpoint+'\0'+(c.apiKey||'')).digest('hex');}
function read(){try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(data))throw Error();return data;}catch(e){if(e.code==='ENOENT')return [];throw fail('本机云音色记录读取失败',503);}}
function write(rows){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(rows,null,2),{mode:0o600});fs.renameSync(temp,file);}catch{try{fs.unlinkSync(temp);}catch{}throw fail('云音色已创建，但本机记录保存失败，请勿重复点击创建',500);}}
function publicVoice(v){return {id:v.id,voiceId:v.voiceId,name:v.name,model:v.model,createdAt:v.createdAt,status:v.status||'created'};}
function list(model){const c=profile(model),reason=capability(c);return {voices:read().filter(v=>v.model===model&&v.scope===scope(c)).map(publicVoice),maxBytes:MAX_BYTES,cloneAvailable:!reason,cloneUnavailableReason:reason};}
function decode(input){
 const b64=input.audioBase64;
 if(typeof b64!=='string'||!b64.length||b64.length>Math.ceil(MAX_BYTES/3)*4||b64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64))throw fail('音频需为有效Base64，大小不超过10MiB');
 const b=Buffer.from(b64,'base64');if(!b.length||b.length>MAX_BYTES||b.toString('base64')!==b64)throw fail('音频编码无效或超过10MiB',413);
 let ext,mime;
 if(b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'){ext='wav';mime='audio/wav';}
 else if(b.length>=10&&(b.toString('ascii',0,3)==='ID3'||(b[0]===255&&(b[1]&0xe0)===0xe0&&(b[1]&6)!==0))){ext='mp3';mime='audio/mpeg';}
 else if(b.length>=24&&b.toString('ascii',4,8)==='ftyp'&&['M4A ','isom','mp42','mp41'].includes(b.toString('ascii',8,12))){ext='m4a';mime='audio/mp4';}
 else throw fail('仅接受具有有效文件头的WAV、MP3或M4A音频');
 const aliases={'audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/mp3':'audio/mpeg','audio/x-m4a':'audio/mp4','audio/m4a':'audio/mp4'};
 if((aliases[input.mimeType]||input.mimeType)!==mime)throw fail('音频MIME与实际文件头不一致');
 return {bytes:b,ext,mime};
}
async function request(url,options,stage,json=true){
 let response;try{response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(90000)});}catch{throw fail(stage+'请求超时或网络错误；创建阶段若超时，请先在百炼确认是否已生成，避免重复计费',502);}
 let value;try{value=json?await response.json():await response.text();}catch{throw fail(stage+'响应格式异常',502);}
 if(!response.ok||value?.code){const code=typeof value?.code==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(value.code)?value.code:'';throw fail(stage+'失败（HTTP '+response.status+(code?' / '+code:'')+'）。请检查该模型权限、音频要求与额度；未切换其他Key或计费通道。',502);}
 return value;
}
async function clone(input){
 const c=profile(input.model),reason=capability(c);if(reason)throw fail(reason,409);
 if(input.consent!==true)throw fail('请确认参考音频属于本人或已获得声音权利人的许可');
 if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw fail('音色名称需要1至80个字符');
 const audio=decode(input);if(creating)throw fail('另一个云音色正在创建，请等待完成',409);
 creating=true;
 try{
  // Read local metadata before incurring a paid operation.
  read();
  const auth={Authorization:'Bearer '+c.apiKey,'Content-Type':'application/json'};
  // Upload model is the actual outer inference model, not target_model.
  const data=(await request('https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=voice-enrollment',{headers:auth},'临时上传凭证')).data;
  let host;try{host=new URL(data.upload_host);}catch{throw fail('临时上传凭证缺少有效OSS地址',502);}
  if(host.protocol!=='https:'||host.username||host.password||host.port||host.search||host.hash||!/^dashscope-file-[a-z0-9-]+\.oss-cn-beijing\.aliyuncs\.com$/.test(host.hostname))throw fail('临时上传地址未通过官方OSS域名校验',502);
  const fields={OSSAccessKeyId:'oss_access_key_id',Signature:'signature',policy:'policy','x-oss-object-acl':'x_oss_object_acl','x-oss-forbid-overwrite':'x_oss_forbid_overwrite'};
  const form=new FormData();for(const [key,source]of Object.entries(fields)){if(typeof data[source]!=='string'||!data[source])throw fail('临时上传凭证字段缺失',502);form.append(key,data[source]);}
  if(typeof data.upload_dir!=='string'||!/^[-A-Za-z0-9_/]+$/.test(data.upload_dir))throw fail('临时上传目录无效',502);
  const filename=crypto.randomUUID()+'.'+audio.ext,key=data.upload_dir.replace(/\/$/,'')+'/'+filename;
  form.append('key',key);form.append('success_action_status','200');form.append('file',new Blob([audio.bytes],{type:audio.mime}),filename);
  await request(host.href,{method:'POST',body:form},'音频临时上传',false);
  const origin=new URL(c.endpoint);origin.protocol='https:';origin.pathname='/api/v1/services/audio/tts/customization';
  const result=await request(origin.href,{method:'POST',headers:{...auth,'X-DashScope-OssResourceResolve':'enable'},body:JSON.stringify({model:'voice-enrollment',input:{action:'create_voice',target_model:c.model,prefix:'pi'+crypto.randomBytes(4).toString('hex'),url:'oss://'+key}})},'云音色创建');
  const voiceId=result?.output?.voice_id;if(typeof voiceId!=='string'||!/^[-A-Za-z0-9_.]{1,200}$/.test(voiceId))throw fail('云端响应未返回有效音色ID；请先在百炼确认创建结果',502);
  const voice={id:crypto.randomUUID(),voiceId,name:input.name.trim(),model:c.model,createdAt:new Date().toISOString(),status:'created',scope:scope(c)};
  write([...read(),voice]);return {voice:publicVoice(voice)};
 }finally{creating=false;}
}
function use(input){const c=profile(input.model);if(!read().some(v=>v.model===c.model&&v.scope===scope(c)&&v.voiceId===input.voiceId))throw fail('该音色不属于当前模型和已保存凭据的本机创建记录',404);const config=tts.saveConfig({model:c.model,voice:input.voiceId,activate:true});return{model:c.model,voiceId:input.voiceId,config};}
async function handle(req,res,url){
 const respond=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 try{
  tts.checkRequest(req);
  if(url.pathname==='/api/tts/cloud/voices'&&req.method==='GET'){respond(200,list(url.searchParams.get('model')));return;}
  if(req.method!=='POST')throw fail('该操作需要POST',405);
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw fail('需要application/json',415);
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>Math.ceil(MAX_BYTES/3)*4+4096)throw fail('上传请求超过10MiB音频限制',413);chunks.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('JSON格式无效');}
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('请求需要JSON对象');
  if(url.pathname==='/api/tts/cloud/clone')respond(201,await clone(input));
  else if(url.pathname==='/api/tts/cloud/voices/use')respond(200,use(input));
  else throw fail('接口不存在',404);
 }catch(e){respond(e.status||500,{error:e.status?e.message:'云音色操作失败，请检查本机配置'});}
}
module.exports={handle,MAX_BYTES};
