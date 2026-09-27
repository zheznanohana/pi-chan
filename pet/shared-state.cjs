const {EventEmitter}=require('events');
class SharedState extends EventEmitter {
 constructor(settings=null){super();this.value={revision:0,voiceSettings:settings,captureOwner:null,speaking:false,mouth:0,transcript:'',transcriptFinal:false};}
 patch(p={}){
  const next={...this.value};let changed=false;
  if(p.voiceSettings&&typeof p.voiceSettings==='object'){
   const settings={...(next.voiceSettings||{})};
   for(const key of ['inputDeviceId','outputDeviceId','voiceKey','cloneVoiceKey'])if(typeof p.voiceSettings[key]==='string'&&p.voiceSettings[key].length<=1024)settings[key]=p.voiceSettings[key];
   for(const key of ['asrEnabled','ttsEnabled'])if(typeof p.voiceSettings[key]==='boolean')settings[key]=p.voiceSettings[key];
   for(const key of ['speakerId','vadThreshold'])if(Number.isFinite(p.voiceSettings[key]))settings[key]=p.voiceSettings[key];
   if(JSON.stringify(settings)!==JSON.stringify(next.voiceSettings)){next.voiceSettings=settings;changed=true;}
  }
  for(const key of ['captureOwner','speaking','mouth','transcript','transcriptFinal']){
   if(!(key in p))continue;const v=p[key];
   if(key==='captureOwner'&&![null,'dashboard','pet'].includes(v))continue;
   if(['speaking','transcriptFinal'].includes(key)&&typeof v!=='boolean')continue;
   if(key==='mouth'&&(!Number.isFinite(v)||v<0||v>1))continue;
   if(key==='transcript'&&(typeof v!=='string'||v.length>4000))continue;
   if(next[key]!==v){next[key]=v;changed=true;}
  }
  if(changed){next.revision++;this.value=next;this.emit('change',next);}
  return this.value;
 }
}
module.exports={SharedState};
