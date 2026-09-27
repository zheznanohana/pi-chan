'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createBotBridge}=require('./bot-bridge.cjs');
function createBotAuto({dataDir,readServers,reply,transcribe,synthesize,broadcast=()=>{},makeBridge=createBotBridge}){
 fs.mkdirSync(dataDir,{recursive:true});const file=path.join(dataDir,'auto-reply.json');
 let state={settings:{enabled:false,channels:[],asr:'local',voice:'qwen-cloud'},seen:{},history:{},offsets:{},events:[]};
 if(fs.existsSync(file))state={...state,...JSON.parse(fs.readFileSync(file,'utf8'))};
 for(const c of Object.values(state.conversations||{}))for(const m of c.messages||[])if(['transcribing','preparing','generating','sending'].includes(m.status)){m.status='interrupted';m.processingStatus='interrupted';}
 for(const channel of state.discovered||[]){const key=channel.server+':'+channel.chatType+':'+channel.target,id=crypto.createHash('sha256').update(key).digest('hex'),c=state.conversations?.[id];if(c&&!c.channel){c.channel=channel;c.historyKey=key;}}
 let busy=false,generation=0,stopped=false;const initialized=new Set(),qqSockets=new Map();
 const save=()=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file)};
 function event(channel,phase){state.events=[{at:new Date().toISOString(),channel,phase},...state.events].slice(0,30);save();broadcast('bot_auto_status',status())}
 const channelKey=c=>c.server+':'+c.chatType+':'+c.target;
 const topicKey=c=>channelKey(c)+(state.activeTopics?.[channelKey(c)]?':topic:'+state.activeTopics[channelKey(c)]:'');
 async function command(channel,message,bridge){const text=String(message.text||'').trim(),base=channelKey(channel);if(!/^\/(会话|新建|切换|当前|帮助)(?:\s|$)/.test(text))return false;const parts=text.split(/\s+/),cmd=parts.shift();state.topics||={};state.activeTopics||={};const topics=state.topics[base]||[{id:'',title:'默认对话'}];state.topics[base]=topics;let reply;
 if(cmd==='/新建'){if(topics.length>=30)reply='最多保留30个对话';else{const t={id:crypto.randomUUID(),title:parts.join(' ').slice(0,60)||'新对话 '+topics.length};topics.push(t);state.activeTopics[base]=t.id;reply='已进入：'+t.title;}}
 else if(cmd==='/切换'){const n=Number(parts[0]);const target=Number.isInteger(n)?topics[n-1]:null;if(!target)reply='请发送 /会话 查看编号，再发送 /切换 编号';else{state.activeTopics[base]=target.id;reply='已进入：'+target.title;}}
 else if(cmd==='/当前')reply='当前：'+(topics.find(t=>t.id===(state.activeTopics[base]||''))?.title||'默认对话');
 else reply=topics.map((t,i)=>(i+1)+'. '+t.title+(t.id===(state.activeTopics[base]||'')?' ← 当前':'')).join('\n')+'\n/新建 名称 · /切换 编号 · /当前\n仅列出本联系人对话，桌面会话需另行绑定。';save();await bridge.execute('bot_send_text',{...channel,text:reply,replyTo:message.replyTo,confirmed:true});return true;}
 function conversations(){return Object.values(state.conversations||{}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 function recordMessage(channel,id,patch){const key=topicKey(channel),conversationId=crypto.createHash('sha256').update(key).digest('hex');state.conversations||={};const c=state.conversations[conversationId]||{id:conversationId,title:(state.topics?.[channelKey(channel)]?.find(t=>t.id===(state.activeTopics?.[channelKey(channel)]||''))?.title||channel.server)+' · '+(channel.chatType==='group'?'群聊':'私聊')+' '+channel.target.slice(-6),platform:readServers()[channel.server]?.env?.BOT_PLATFORM||channel.server,messages:[]};const previous=c.messages.find(m=>m.id===id);if(previous)Object.assign(previous,patch);else c.messages.push({id,at:new Date().toISOString(),...patch});c.channel={...channel};c.historyKey=key;c.messages=c.messages.slice(-200);c.updatedAt=new Date().toISOString();state.conversations[conversationId]=c;const all=conversations();for(const old of all.slice(100))delete state.conversations[old.id];save();broadcast('bot_conversation',{id:conversationId,updatedAt:c.updatedAt});}
 function status(){return{settings:state.settings,busy,events:state.events,discovered:state.discovered||[],available:Object.entries(readServers()).filter(([,c])=>['telegram','qq-onebot','qq-official'].includes(c.env?.BOT_PLATFORM)).map(([name,c])=>({name,platform:c.env.BOT_PLATFORM}))}}
 function configure(input){
  if(typeof input.enabled!=='boolean'||!Array.isArray(input.channels)||input.channels.length>30)throw Error('自动回复配置无效');
  const servers=readServers();const keys=new Set();
  const channels=input.channels.map(c=>{if(!servers[c.server]||!['telegram','qq-onebot','qq-official'].includes(servers[c.server].env?.BOT_PLATFORM)||typeof c.target!=='string'||!(servers[c.server].env.BOT_PLATFORM==='qq-official'?/^(?:[A-Za-z0-9_-]{1,128}|\*)$/:/^-?\d{1,30}$/).test(c.target))throw Error('请先配置 Bot，再填写有效聊天 ID');const kind=c.chatType==='group'?'group':'private';if(c.target==='*'&&kind!=='private')throw Error('自动接收仅允许官方QQ私聊，群聊请指定群OpenID');if(servers[c.server].env.BOT_PLATFORM==='qq-onebot'&&kind!=='group'&&!servers[c.server].env.ONEBOT_WS_URL)throw Error('QQ 私聊自动接收需要在连接配置中填写 ONEBOT_WS_URL');const key=c.server+':'+kind+':'+c.target;if(keys.has(key))throw Error('聊天配置重复');keys.add(key);return{server:c.server,target:c.target,chatType:kind}});
  state.settings={enabled:input.enabled,channels,asr:input.asr==='token-plan'?'token-plan':'local',voice:input.voice==='local'?'vits-aishell3':'qwen-cloud',model:typeof input.model==='string'?input.model.slice(0,200):''};generation++;initialized.clear();for(const entry of qqSockets.values())entry.socket.close();qqSockets.clear();save();return status();
 }
 const conversationQueues=new Map();
 function serial(key,fn){const pending=(conversationQueues.get(key)||Promise.resolve()).catch(()=>{}).then(fn);conversationQueues.set(key,pending);return pending.finally(()=>{if(conversationQueues.get(key)===pending)conversationQueues.delete(key);});}
 async function sendFromDesktop(conversationId,input){const c=state.conversations?.[conversationId];if(!c?.channel||!c.historyKey)throw Error('此历史尚未绑定会话，请先从QQ发送一条新消息');return serial(channelKey(c.channel),async()=>{
  if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId))throw Error('发送凭据无效');const id='desktop:'+input.requestId;
  const old=c.messages.find(m=>m.id===id);if(old)return {message:c.messages.find(m=>m.id===id+':reply')||old};
  const voice=typeof input.audio==='string';let text=input.text;
  if(voice){if(input.audio.length>12*1024*1024||!/^audio\/(webm|ogg|wav|mpeg|mp4)(?:;.*)?$/.test(input.mimeType||''))throw Error('录音格式或大小无效');text=await transcribe(Buffer.from(input.audio,'base64'),state.settings.asr);}
  if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('输入或语音识别结果为空');
  const user={id,role:'user',origin:'desktop',text:text.trim(),voice,status:'received',at:new Date().toISOString()};c.messages.push(user);c.updatedAt=user.at;save();broadcast('bot_conversation',{id:c.id});
  const message={id:id+':reply',role:'assistant',origin:'desktop',text:'',voice:false,status:'generating',at:new Date().toISOString()};c.messages.push(message);save();
  try{const answer=await reply({text:user.text,history:state.history[c.historyKey]||[],model:state.settings.model,sessionKey:c.historyKey,origin:'desktop',channel:c.channel,turnId:id});if(typeof answer!=='string'||!answer.trim())throw Error('空回复');message.text=answer;message.status='completed';state.history[c.historyKey]=[...(state.history[c.historyKey]||[]),{role:'user',text:user.text.slice(0,2000)},{role:'assistant',text:answer.slice(0,2000)}].slice(-12);}
  catch{message.status='failed';message.text='本次回复失败，请检查模型或稍后重新提问';}
  c.messages=c.messages.slice(-200);c.updatedAt=new Date().toISOString();save();broadcast('bot_conversation',{id:c.id});return {message};
 });}
 function processMessage(channel,message,bridge){return serial(channelKey(channel),()=>processIncoming(channel,message,bridge));}
 async function processIncoming(channel,message,bridge){
  if(!state.settings.enabled)return;const gen=generation,key=channelKey(channel),id=String(message.id);
  if(!id||state.seen[key]?.includes(id))return;
  // Persist before any external side effect. Crash/timeout must not send twice.
  state.seen[key]=[...(state.seen[key]||[]),id].slice(-500);save();
  try{if(/^\/(会话|新建|切换|当前|帮助)(?:\s|$)/.test(String(message.text||'').trim())&&await command(channel,message,bridge))return;}catch{event(key,'会话命令回发未确认');return;}
  const historyKey=topicKey(channel);
  async function clarify(){let audio;const text='刚才那条语音我没听清，可以再说一次吗？';recordMessage(channel,id+':reply',{role:'assistant',text,voice:true,status:'preparing'});try{try{audio=await synthesize(text,{voice:state.settings.voice,directory:bridge.mediaDir,platform:bridge.platform});}catch{}if(stopped||!state.settings.enabled||gen!==generation)return;if(audio)await bridge.execute('bot_send_voice',{...channel,file:audio,replyTo:message.replyTo,confirmed:true});else await bridge.execute('bot_send_text',{...channel,text,replyTo:message.replyTo,confirmed:true});recordMessage(channel,id+':reply',{status:'sent',voice:!!audio});event(key,'识别未成功，已回发重说提示');}finally{if(audio&&path.dirname(audio)===bridge.mediaDir)try{fs.unlinkSync(audio)}catch{}}}

  recordMessage(channel,id,{role:'user',text:message.text||'',voice:!!message.voice,status:message.voice?'transcribing':'received'});
  const active=()=>!stopped&&state.settings.enabled&&gen===generation;
  try{
   let text=message.text;
   if(message.voice){event(key,'识别语音');try{text=await transcribe(await bridge.downloadVoice(message.raw),state.settings.asr)}catch{recordMessage(channel,id,{status:'unrecognized',text:'语音识别失败'});await clarify();return;}}
   if(!text?.trim()){recordMessage(channel,id,{status:'unrecognized',text:message.voice?'语音识别结果为空':'附件未识别为语音：'+(message.attachmentTypes||[]).join(',')});event(key,'未识别到内容');await clarify();return;}
   recordMessage(channel,id,{text:text.slice(0,8000),status:'received'});
   if(!active())return;
   event(key,'陪伴回复');const history=state.history[historyKey]||[];
   const answer=await reply({text:text.slice(0,8000),history,model:state.settings.model,sessionKey:historyKey,origin:'social',channel,turnId:id});
   if(!active())return;if(typeof answer!=='string'||!answer.trim())throw Error('空回复');
   recordMessage(channel,id+':reply',{role:'assistant',text:answer.slice(0,8000),voice:!!message.voice,status:'preparing'});
   let audio=null;
   if(message.voice){event(key,'合成语音');try{audio=await synthesize(answer,{voice:state.settings.voice,directory:bridge.mediaDir,platform:bridge.platform})}catch{event(key,'合成失败，改用文字回复')}}
   try{
    if(!active())return;
    event(key,'正在回发');
    if(audio)await bridge.execute('bot_send_voice',{...channel,file:audio,replyTo:message.replyTo,confirmed:true});
    else await bridge.execute('bot_send_text',{...channel,replyTo:message.replyTo,text:answer.length>3900?answer.slice(0,3870)+'\n（回复过长，已截短）':answer,confirmed:true});
    recordMessage(channel,id+':reply',{status:'sent',voice:!!audio});
    state.history[historyKey]=[...history,{role:'user',text:text.slice(0,2000)},{role:'assistant',text:answer.slice(0,2000)}].slice(-12);event(key,'已回发');
   }finally{if(audio&&path.dirname(audio)===bridge.mediaDir)try{fs.unlinkSync(audio)}catch{}}
  }catch{recordMessage(channel,id,{processingStatus:'failed'});if(state.conversations?.[crypto.createHash('sha256').update(historyKey).digest('hex')]?.messages.some(m=>m.id===id+':reply'))recordMessage(channel,id+':reply',{status:'unconfirmed'});event(key,'本条处理失败；未自动重发，请检查 ASR、模型、TTS 或平台连接')}
 }
 function qqInbox(name,env){
  let entry=qqSockets.get(name);if(entry)return entry;
  const url=new URL(env.ONEBOT_WS_URL);
  if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password)throw Error('QQ WebSocket 地址无效');
  if(url.protocol==='ws:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('远程 QQ WebSocket 需要 WSS');
  const socket=new (require('ws'))(url,{headers:{Authorization:'Bearer '+env.ONEBOT_ACCESS_TOKEN},maxPayload:2*1024*1024,handshakeTimeout:10000});
  entry={socket,messages:[]};qqSockets.set(name,entry);
  socket.on('message',raw=>{try{const msg=JSON.parse(String(raw));if(msg.post_type!=='message'||!['private','group'].includes(msg.message_type)||String(msg.user_id)===String(msg.self_id))return;if(entry.messages.length>=100){event(name,'消息队列已满，请减少响应会话');return;}entry.messages.push(msg)}catch{}});
  socket.on('error',()=>event(name,'QQ WebSocket 连接失败，请核对 NapCat 正向 WS 与 Token'));
  socket.on('close',()=>{if(qqSockets.get(name)===entry)qqSockets.delete(name)});
  return entry;
 }
 async function tick(){
  if(busy||stopped||!state.settings.enabled)return;busy=true;
  try{const servers=readServers();const groups=new Map();for(const c of state.settings.channels){if(!groups.has(c.server))groups.set(c.server,[]);groups.get(c.server).push(c)}
   for(const [name,channels]of groups){if(stopped||!state.settings.enabled)break;const config=servers[name];if(!config)continue;
    try{
     const mediaDir=path.join(dataDir,'media');fs.mkdirSync(mediaDir,{recursive:true});
     const bridge=makeBridge({env:{...config.env,BOT_MEDIA_DIR:mediaDir}});bridge.mediaDir=mediaDir;
     if(bridge.platform==='qq-official'){
      let inbox=qqSockets.get(name);
      if(!inbox){inbox={messages:[],bridge};inbox.socket=bridge.listen(message=>{state.discovered=[{server:name,target:message.target,chatType:message.chatType},...(state.discovered||[]).filter(c=>!(c.server===name&&c.target===message.target&&c.chatType===message.chatType))].slice(0,30);save();if(inbox.messages.length>=100){event(name,'官方 QQ 队列已满');return}inbox.messages.push(message)},phase=>event(name,phase));qqSockets.set(name,inbox);}
      while(inbox.messages.length&&state.settings.enabled){const msg=inbox.messages.shift(),c=channels.find(c=>(c.target===msg.target||c.target==='*')&&c.chatType===msg.chatType);if(c)await processMessage({...c,target:msg.target},msg,inbox.bridge);}
     }else if(bridge.platform==='telegram'){
      const info=await bridge.checkWebhook();if(info.url){event(name,'已有 Telegram webhook，未抢占接收；请配置专用 Bot');continue;}
      const messages=await bridge.execute('bot_receive',{offset:state.offsets[name],limit:50});
      if(!Array.isArray(messages))throw Error('更新格式无效');
      for(const item of messages){
       const msg=item.message||item.channel_post,c=channels.find(c=>c.target===String(msg?.chat?.id));
       if(initialized.has(name)&&c&&msg&&!msg.from?.is_bot&&(msg.text||msg.voice))await processMessage(c,{id:item.update_id,text:msg.text,voice:!!msg.voice,raw:msg},bridge);
       state.offsets[name]=item.update_id+1;save();
      }
      // Drain all pre-existing updates before enabling responses on first startup.
      if(messages.length<50)initialized.add(name);
     }else if(config.env.ONEBOT_WS_URL){
      const inbox=qqInbox(name,config.env);
      while(inbox.messages.length&&state.settings.enabled){
       const msg=inbox.messages.shift(),kind=msg.message_type,target=String(kind==='group'?msg.group_id:msg.user_id);
       const c=channels.find(c=>c.target===target&&c.chatType===kind);if(!c)continue;
       const segments=Array.isArray(msg.message)?msg.message:[],text=segments.filter(x=>x.type==='text').map(x=>x.data.text).join(''),voice=segments.some(x=>x.type==='record');
       if(text||voice)await processMessage(c,{id:msg.message_id,text,voice,raw:msg},bridge);
      }
     }else{
      const me=await bridge.execute('bot_identity',{});
      for(const c of channels){const key=name+':'+c.chatType+':'+c.target;const result=await bridge.execute('bot_receive',{groupId:c.target});const messages=result.messages||[];
       for(const msg of messages){const id=String(msg.message_id);if(!initialized.has(key)){state.seen[key]=[...(state.seen[key]||[]),id].slice(-500);continue;}
        if(String(msg.user_id||msg.sender?.user_id)===String(me.user_id))continue;
        const segments=Array.isArray(msg.message)?msg.message:[];const text=segments.filter(x=>x.type==='text').map(x=>x.data.text).join('');
        const voice=segments.some(x=>x.type==='record');if(text||voice)await processMessage(c,{id,text,voice,raw:msg},bridge);
       }initialized.add(key);save();
      }
     }
    }catch{event(name,'连接或接收失败，稍后重试；未自动重发消息')}
   }
  }finally{busy=false}
 }
 const timer=setInterval(()=>tick().catch(()=>{}),5000);timer.unref?.();
 function reportDevelopment(task){
  const c=Object.values(state.conversations||{}).find(c=>'bot-'+crypto.createHash('sha256').update(c.historyKey||'').digest('hex').slice(0,32)===task.sourceSessionId);
  if(!c)return;const id='development:'+task.id+':'+task.status;if(c.messages.some(m=>m.id===id))return;
  const text='开发任务「'+task.title+'」'+(task.status==='completed'?'已完成':'执行失败')+'\n'+String(task.result?.text||task.error||'请在开发工作台查看').slice(0,10000);
  c.messages.push({id,role:'assistant',origin:'development',text,status:'completed',at:new Date().toISOString()});c.updatedAt=new Date().toISOString();
  state.history[c.historyKey]=[...(state.history[c.historyKey]||[]),{role:'assistant',text:text.slice(0,2000)}].slice(-12);save();broadcast('bot_conversation',{id:c.id});
 }
 return{status,conversations,sendFromDesktop,reportDevelopment,configure,processMessage,tick,close(){stopped=true;generation++;clearInterval(timer);for(const entry of qqSockets.values())entry.socket.close();qqSockets.clear()}};
}
module.exports={createBotAuto};
