'use strict';
// Thin adapters for Telegram Bot API and the mature OneBot v11 ecosystem (NapCat).
const fs=require('node:fs'),path=require('node:path');
function createBotBridge({env=process.env,fetchImpl=fetch}={}){
 const platform=env.BOT_PLATFORM||'telegram';
 if(platform==='qq-official')return require('./qq-official.cjs').createQQOfficial({env,fetchImpl});
 if(!['telegram','qq-onebot'].includes(platform))throw Error('未知聊天平台');
 const token=platform==='telegram'?env.TELEGRAM_BOT_TOKEN:env.ONEBOT_ACCESS_TOKEN;
 if(!token||/YOUR_|REPLACE_|<your_/i.test(token))throw Error('请先在外部连接配置中填写 Bot Token');
 const base=platform==='telegram'?`https://api.telegram.org/bot${token}/`:new URL(env.ONEBOT_HTTP_URL||'http://127.0.0.1:3000/').href.replace(/\/?$/,'/');
 if(platform==='qq-onebot'){
  const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('OneBot 地址无效');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('远程 OneBot 请使用 HTTPS');
 }
 const str=(v,n,label)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error(label+'无效');return v};
 async function call(method,payload){
  try{
   const multipart=payload instanceof FormData;
   const response=await fetchImpl(base+method,{method:'POST',redirect:'error',headers:{...(platform==='qq-onebot'?{Authorization:'Bearer '+token}:{}),...(multipart?{}:{'Content-Type':'application/json'})},body:multipart?payload:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const data=await response.json();if(platform==='telegram'?!data.ok:data.status!=='ok'||data.retcode!==0)throw Error('平台拒绝请求，错误码 '+(data.error_code??data.retcode));
   return platform==='telegram'?data.result:data.data;
  }catch(e){const msg=String(e.message||e).split(token).join('[redacted]');throw Error('消息接口失败（发送类操作不会自动重试，避免重复发送）：'+msg);}
 }
 function recipient(a){
  const target=str(a.target,100,'收件人');
  if(platform==='telegram')return{chat_id:target};
  if(!/^\d+$/.test(target))throw Error('QQ 收件人必须为数字 ID');
  if(!['private','group'].includes(a.chatType))throw Error('请选择 private 或 group');
  return a.chatType==='group'?{message_type:'group',group_id:target}:{message_type:'private',user_id:target};
 }
 function voiceFile(file){
  if(!env.BOT_MEDIA_DIR)throw Error('请配置 BOT_MEDIA_DIR 后使用本地语音文件');
  const root=fs.realpathSync(env.BOT_MEDIA_DIR),real=fs.realpathSync(path.resolve(root,file)),rel=path.relative(root,real);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('语音文件超出媒体目录');
  const stat=fs.statSync(real);if(!stat.isFile()||stat.size>20*1024*1024||!['.ogg','.opus','.mp3','.m4a','.wav','.silk'].includes(path.extname(real).toLowerCase()))throw Error('语音文件需为支持的音频格式且不超过 20MB');
  if(platform==='telegram'&&!['.ogg','.opus','.mp3','.m4a'].includes(path.extname(real).toLowerCase()))throw Error('Telegram 语音请先转成 OGG/OPUS、MP3 或 M4A');
  return{bytes:fs.readFileSync(real),name:path.basename(real)};
 }
 async function execute(name,args={}){
  if(name==='bot_identity')return call(platform==='telegram'?'getMe':'get_login_info',{});
  if(name==='bot_receive'){
   if(platform==='telegram'){
    if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))throw Error('offset 无效');
    return call('getUpdates',{...(args.offset!==undefined?{offset:args.offset}:{}),limit:Math.min(50,Math.max(1,Number(args.limit)||20)),timeout:0,allowed_updates:['message','channel_post']});
   }
   if(!/^\d+$/.test(String(args.groupId||'')))throw Error('QQ 读取群消息需要 groupId');
   return call('get_group_msg_history',{group_id:String(args.groupId)});
  }
  if(!['bot_send_text','bot_send_voice'].includes(name))throw Error('未知 Bot 工具');
  if(args.confirmed!==true)throw Error('请确认收件人和发送内容后再发送');
  const target=recipient(args);
  if(name==='bot_send_text'){
   const text=str(args.text,platform==='telegram'?4096:4000,'消息');
   return platform==='telegram'?call('sendMessage',{...target,text}):call('send_msg',{...target,message:[{type:'text',data:{text}}]});
  }
  const audio=voiceFile(str(args.file,2048,'语音路径'));
  if(platform==='telegram'){
   const form=new FormData();form.set('chat_id',target.chat_id);form.set('voice',new Blob([audio.bytes]),audio.name);
   return call('sendVoice',form);
  }
  return call('send_msg',{...target,message:[{type:'record',data:{file:'base64://'+audio.bytes.toString('base64')}}]});
 }
 async function downloadVoice(message){
  let url;
  if(platform==='telegram'){
   const id=message.voice?.file_id;if(!id)throw Error('没有语音附件');
   if(message.voice.file_size>20*1024*1024||message.voice.duration>120)throw Error('语音限 120 秒 / 20MB');
   const file=await call('getFile',{file_id:id});
   if(!/^[a-zA-Z0-9_./-]+$/.test(file.file_path)||file.file_path.includes('..'))throw Error('语音路径无效');
   url=`https://api.telegram.org/file/bot${token}/${file.file_path}`;
  }else{
   const record=(message.message||[]).find(x=>x.type==='record');url=record?.data?.url;
   const parsed=new URL(url);if(parsed.protocol!=='https:'||!/(^|\.)(qq\.com|qpic\.cn|qq\.com\.cn)$/.test(parsed.hostname))throw Error('QQ 语音需要腾讯 HTTPS 附件地址');
  }
  try{
   const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('附件下载失败');
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024){throw Error('附件超过20MB')}chunks.push(Buffer.from(chunk))}
   return Buffer.concat(chunks);
  }catch{throw Error('语音附件下载失败或超出大小限制');}
 }
 return{execute,platform,downloadVoice,checkWebhook:()=>platform==='telegram'?call('getWebhookInfo',{}):Promise.resolve({})};
}
module.exports={createBotBridge};
