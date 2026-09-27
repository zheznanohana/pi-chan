'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const API='https://api.bot.qq.com';
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function mediaUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&!['443'].includes(u.port)||!/(^|\.)(qq\.com|qpic\.cn|qq\.com\.cn|myqcloud\.com)$/.test(u.hostname))throw Error('QQ 附件地址不在腾讯 HTTPS 域名范围');return u.href;}
function normalizeEvent(event){
 if(!['C2C_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE'].includes(event.t))return null;
 const d=event.d||{},chatType=event.t==='C2C_MESSAGE_CREATE'?'private':'group',target=chatType==='group'?d.group_openid:d.author?.user_openid;
 if(!validId(target)||typeof d.id!=='string'||!d.id)return null;
 const attachment=(d.attachments||[]).find(a=>{const type=String(a.content_type||'').toLowerCase();return type.startsWith('audio/')||['voice','audio','application/silk','application/x-silk'].includes(type)||/\.(silk|amr|ogg|mp3|wav|m4a)(?:[?#]|$)/i.test(String(a.filename||a.file_name||a.url||''));});
 return {target,chatType,id:d.id,text:String(d.content||'').replace(/<@!?\d+>/g,'').trim(),voice:!!attachment,raw:{attachment},attachmentTypes:(d.attachments||[]).map(a=>String(a.content_type||'unknown')).slice(0,5),replyTo:d.id};
}
function createQQOfficial({env=process.env,fetchImpl=fetch,WebSocketImpl=require('ws')}={}){
 const appId=env.QQ_APP_ID,secret=env.QQ_APP_SECRET;
 if(!validId(appId)||!secret||/YOUR_|REPLACE_/.test(secret))throw Error('请填写 QQ 官方 AppID 和 AppSecret');
 let token='',expires=0,tokenPending;
 async function json(url,options={}){let r,d;try{r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});d=await r.json()}catch{throw Error('QQ 官方接口网络或响应异常')}
 if(!r.ok||(d.code!==undefined&&Number(d.code)!==0))throw Error('QQ 官方接口失败：HTTP '+r.status+' / code '+(Number(d.code)||0));return d;}
 async function access(){if(token&&Date.now()<expires)return token;if(tokenPending)return tokenPending;
 tokenPending=(async()=>{const d=await json(API+'/app/getAppAccessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId,clientSecret:secret})});if(typeof d.access_token!=='string'||Number(d.expires_in)<=0)throw Error('QQ 访问凭证响应异常');token=d.access_token;expires=Date.now()+Math.max(1,Number(d.expires_in)-60)*1000;return token})().finally(()=>tokenPending=null);return tokenPending;}
 async function call(route,body){return json(API+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'QQBot '+await access(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})}
 async function execute(name,args={}){
  if(name==='bot_identity')return call('/users/@me');
  if(name==='bot_receive')throw Error('官方 QQ 使用 WebSocket 事件接收，请在社交与 Bot 中配置自动陪伴');
  if(!['bot_send_text','bot_send_voice'].includes(name))throw Error('未知 Bot 工具');
  if(args.confirmed!==true||!validId(args.target)||!['group','private'].includes(args.chatType))throw Error('需要确认发送，并填写目标 OpenID 与会话类型');
  const route='/v2/'+(args.chatType==='group'?'groups':'users')+'/'+args.target;
  const reply=args.replyTo?{msg_id:String(args.replyTo),msg_seq:Number.isInteger(args.msgSeq)&&args.msgSeq>0&&args.msgSeq<=100?args.msgSeq:1}:{};
  if(name==='bot_send_text'){if(typeof args.text!=='string'||!args.text.trim()||args.text.length>4000)throw Error('文字长度需为 1–4000');return call(route+'/messages',{msg_type:0,content:args.text,...reply})}
  const root=fs.realpathSync(env.BOT_MEDIA_DIR||'audio-debug'),file=fs.realpathSync(path.resolve(root,args.file||'')),rel=path.relative(root,file),stat=fs.statSync(file);
  if(rel.startsWith('..')||path.isAbsolute(rel)||!stat.isFile()||stat.size>20*1024*1024||!['.ogg','.mp3','.wav','.silk'].includes(path.extname(file).toLowerCase()))throw Error('语音需位于媒体目录内，大小不超过 20MB');
  const bytes=fs.readFileSync(file),hash=(type,b)=>crypto.createHash(type).update(b).digest('hex');
  const prep=await call(route+'/upload_prepare',{file_type:3,file_size:String(bytes.length),file_name:path.basename(file),md5:hash('md5',bytes),sha1:hash('sha1',bytes),md5_10m:hash('md5',bytes.subarray(0,10002432))});
  const block=Number(prep.block_size);if(!prep.upload_id||!Number.isSafeInteger(block)||block<1||!Array.isArray(prep.parts)||prep.parts.length!==Math.ceil(bytes.length/block))throw Error('QQ 分片配置异常');
  const parts=[...prep.parts].sort((a,b)=>a.index-b.index);const firstIndex=parts[0]?.index;if(![0,1].includes(firstIndex))throw Error('QQ 分片起始序号异常');
  for(let i=0;i<parts.length;i++){if(parts[i].index!==i+firstIndex)throw Error('QQ 分片序号异常');const chunk=bytes.subarray(i*block,Math.min((i+1)*block,bytes.length));
   const r=await fetchImpl(mediaUrl(parts[i].presigned_url),{method:'PUT',body:chunk,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('QQ 语音分片上传失败');
   await call(route+'/upload_part_finish',{upload_id:prep.upload_id,part_index:parts[i].index,block_size:String(chunk.length),md5:hash('md5',chunk)});
  }
  const upload=await call(route+'/files',{file_type:3,srv_send_msg:false,file_name:path.basename(file),upload_id:prep.upload_id});if(!upload.file_info)throw Error('QQ 未返回语音文件信息');
  return call(route+'/messages',{msg_type:7,media:{file_info:upload.file_info},...reply});
 }
 async function downloadVoice(raw){const r=await fetchImpl(mediaUrl(raw.attachment?.url),{redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('QQ 附件下载失败');const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>20*1024*1024)throw Error('语音超出 20MB');chunks.push(Buffer.from(c))}return Buffer.concat(chunks)}
 function listen(onMessage,onStatus=()=>{}){
  let stopped=false,socket,timer,retry,sessionId='',seq=null,ack=true,attempt=0;
  const notify=s=>{try{onStatus(s)}catch{}};
  async function connect(){if(stopped)return;try{
   const auth=await access(),gateway=await call('/gateway');const u=new URL(gateway.url);if(u.protocol!=='wss:'||!/(^|\.)(qq\.com)$/.test(u.hostname))throw Error('网关地址异常');if(stopped)return;
   socket=new WebSocketImpl(u.href,{handshakeTimeout:10000,maxPayload:2*1024*1024});
   socket.on('message',raw=>{try{const e=JSON.parse(String(raw));
    if(e.op===10){const interval=Number(e.d?.heartbeat_interval);if(!Number.isFinite(interval)||interval<1000||interval>300000){socket.close();return}ack=true;clearInterval(timer);timer=setInterval(()=>{if(!ack){socket.close();return}ack=false;socket.send(JSON.stringify({op:1,d:seq}))},interval);timer.unref?.();socket.send(JSON.stringify(sessionId?{op:6,d:{token:'QQBot '+auth,session_id:sessionId,seq}}:{op:2,d:{token:'QQBot '+auth,intents:1<<25,shard:[0,1]}}));}
    if(e.op===11)ack=true;
    if(e.op===1)socket.send(JSON.stringify({op:1,d:seq}));
    if(e.op===7)socket.close();
    if(e.op===9){sessionId='';seq=null;socket.close();}
    if(e.op===0){if(e.t==='READY'){sessionId=e.d.session_id;attempt=0;notify('QQ 官方网关已连接')}const message=normalizeEvent(e);if(message)onMessage(message);if(Number.isSafeInteger(e.s))seq=e.s;}
   }catch{notify('QQ 事件解析或处理失败')}});
   socket.on('error',()=>notify('QQ 官方网关连接异常'));
   socket.on('close',code=>{clearInterval(timer);if([4001,4002,4010,4011,4012,4013,4014,4914,4915].includes(code)){stopped=true;notify('QQ 网关拒绝连接，请检查权限与机器人状态：'+code);return}if([4006,4007].includes(code)){sessionId='';seq=null}schedule()});
  }catch{notify('QQ 官方连接失败，请检查凭据和网络');schedule()}}
  function schedule(){if(stopped)return;clearTimeout(retry);retry=setTimeout(connect,Math.min(60000,2000*2**Math.min(attempt++,5)));retry.unref?.()}
  connect();return {close(){stopped=true;clearInterval(timer);clearTimeout(retry);socket?.close()}};
 }
 return {platform:'qq-official',execute,downloadVoice,listen};
}
module.exports={createQQOfficial,normalizeEvent,mediaUrl};
