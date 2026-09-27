// Main-chat Pi model selection. The development runtime keeps its own selector.
const host=document.getElementById('chatHistoryPanel')||document.querySelector('.history-sidebar');
const make=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
const panel=make('section');panel.className='chat-model-picker';
const label=make('label','文字聊天模型');label.htmlFor='chatModelSelect';
const select=make('select');select.id='chatModelSelect';select.disabled=true;
const refresh=make('button','↻');refresh.type='button';refresh.title='刷新可用模型';refresh.setAttribute('aria-label','刷新可用模型');
const hint=make('small','正在读取 Pi 模型…');hint.setAttribute('role','status');
const row=make('div');row.append(select,refresh);panel.append(label,row,hint);host?.prepend(panel);
// Realtime is a separate audio endpoint, never a Pi setModel candidate.
const REALTIME_MODEL='qwen-audio-3.0-realtime-plus';
const VOICE_MODE_KEY='pichan_conversation_voice_mode';
const voiceSection=make('div');voiceSection.className='chat-voice-mode';
const voiceLabel=make('label','语音对话');voiceLabel.htmlFor='chatVoiceMode';
const voiceSelect=make('select');voiceSelect.id='chatVoiceMode';
const standard=make('option','跟随文字模型 · 识别后回复');standard.value='standard';
const realtime=make('option','千问 3.0 Realtime Plus · 实时音频');realtime.value=REALTIME_MODEL;
voiceSelect.append(standard,realtime);
const voiceHint=make('small');voiceHint.id='chatVoiceModeHint';voiceHint.setAttribute('role','status');voiceSelect.setAttribute('aria-describedby',voiceHint.id);
voiceSection.append(voiceLabel,voiceSelect,voiceHint);panel.append(voiceSection);
let models=[],active=null,busy=false,streaming=false,revision=0;
let voiceMode='standard';try{if(localStorage.getItem(VOICE_MODE_KEY)===REALTIME_MODEL)voiceMode=REALTIME_MODEL;}catch{}
function applyVoiceMode(mode,persist=true){
 voiceMode=mode===REALTIME_MODEL?REALTIME_MODEL:'standard';voiceSelect.value=voiceMode;
 if(persist)try{localStorage.setItem(VOICE_MODE_KEY,voiceMode);}catch{}
 const model=voiceMode===REALTIME_MODEL?{id:REALTIME_MODEL,realtime:true}:{id:active?.modelId||active?.id||'pi-current',realtime:false};
 window.piConversationModel=model;
 window.dispatchEvent(new CustomEvent('pi-conversation-model',{detail:model}));
 voiceHint.textContent=model.realtime?'已选实时音频对话。点击麦克风才连接云端并计费；语音直接由千问回复，不交给 Pi。文字聊天及历史保持不变。':'使用上面的文字模型回复，再合成语音。切换文字模型会恢复此模式。';
}
voiceSelect.onchange=()=>applyVoiceMode(voiceSelect.value);
window.addEventListener('storage',event=>{if(event.key===VOICE_MODE_KEY)applyVoiceMode(event.newValue,false);});
applyVoiceMode(voiceMode,false);

const key=model=>JSON.stringify([model.provider,model.modelId||model.id]);
function lock(){select.disabled=busy||streaming||!models.length;refresh.disabled=busy;}
async function request(url,options){
 const response=await fetch(url,{...options,headers:{Accept:'application/json',...options?.headers},signal:AbortSignal.timeout(20000)});
 if(response.status===404)throw Error('后台版本尚未更新，请重启小派服务');
 const text=await response.text();let data;
 try{data=JSON.parse(text);}catch{throw Error(response.ok?'模型服务返回格式异常，请刷新':'模型服务暂未就绪，请稍后重试');}
 if(!response.ok)throw Error(data.error||`模型请求失败（${response.status}）`);return data;
}
function render(){
 select.replaceChildren();
 if(!models.length){const option=make('option','暂无可用模型');select.append(option);lock();return;}
 const groups=new Map();for(const model of models){if(!groups.has(model.provider)){const group=make('optgroup');group.label=model.provider;groups.set(model.provider,group);select.append(group);}const option=make('option',model.name||model.id);option.value=key(model);groups.get(model.provider).append(option);}
 if(active&&models.some(model=>key(model)===key(active)))select.value=key(active);
 else{const option=make('option',active?'当前模型不在可选目录中':'请选择聊天模型');option.value='';option.disabled=true;select.prepend(option);select.value='';}
 lock();
}
async function load(){
 const version=++revision;busy=true;lock();hint.textContent='正在读取 Pi 模型…';panel.dataset.error='false';if(!models.length){select.replaceChildren(make('option','正在读取模型…'));}
 try{const data=await request('/api/chat/models');if(version!==revision)return;models=Array.isArray(data.models)?data.models:[];active=data.active;streaming=!!data.busy;render();if(voiceMode==='standard')applyVoiceMode('standard',false);hint.textContent=active?`Pi · ${active.provider} / ${active.modelId}${streaming?' · 正在回复':''}`:'Pi 尚未返回当前模型';}
 catch(error){if(version===revision){panel.dataset.error='true';hint.textContent=error.name==='TimeoutError'?'连接超时，请刷新重试':error.message;if(!models.length){select.replaceChildren(make('option','模型服务未连接'));}}}
 finally{if(version===revision){busy=false;lock();}}
}
select.onchange=async()=>{
 const selected=models.find(model=>key(model)===select.value);if(!selected||busy||streaming)return;
 busy=true;lock();hint.textContent='正在切换聊天模型…';
 try{const data=await request('/api/chat/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:selected.provider,modelId:selected.id})});active=data.active;applyVoiceMode('standard');hint.textContent=data.warning||'已切换 · '+(data.model?.name||selected.name||selected.id);}
 catch(error){hint.textContent=error.message;}
 finally{busy=false;render();}
};
window.piChatModels={open:async()=>{
 const data=await request('/api/chat/model');
 for(let el=panel.parentElement;el;el=el.parentElement)if(el.tagName==='DETAILS')el.open=true;
 panel.scrollIntoView({block:'nearest'});
 await load();
 hint.textContent=data.active?`当前文字聊天：Pi · ${data.active.provider} / ${data.active.modelId}`:'Pi 尚未返回当前模型';
 select.focus();
 return data;
}};
refresh.onclick=load;
window.addEventListener('pi-live-event',({detail})=>{if(detail?.type==='agent_start'){streaming=true;lock();hint.textContent='正在回复，结束后可切换';}if(detail?.type==='agent_end'){streaming=false;lock();hint.textContent='仅切换聊天 Pi，保留当前历史';}});
window.addEventListener('pi-runtime-event',({detail})=>{if(detail?.type==='agent_status'){streaming=detail.payload?.status!=='ready';lock();}if(detail?.type==='chat_model_changed')load();});
window.addEventListener('pi-session-changed',load);
load();
