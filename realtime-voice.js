/** Local protocol adapter; only start() opens a billable realtime session. */
export class RealtimeVoiceSession {
  constructor({serverUrl,model,onReady,onAudio,onInterrupt,onTranscript,onStatus,onError,onEnd}) {
    Object.assign(this,{serverUrl,model,onReady,onAudio,onInterrupt,onTranscript,onStatus,onError,onEnd});
    this.closed=false;this.ready=false;this.responseId=null;this.blocked=new Set();this.acceptAudio=false;this.transcriptChannel=null;
  }
  start() {
    const url=new URL('/ws/realtime',this.serverUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const ws=this.ws=new WebSocket(url);
    this.timer=setTimeout(()=>this.fail('实时语音连接超时，请再次点击麦克风重试'),20000);
    ws.onopen=()=>{if(!this.closed)ws.send(JSON.stringify({type:'start',model:this.model}));};
    ws.onmessage=e=>{if(this.closed)return;try{
      if(typeof e.data!=='string')return;
      const m=JSON.parse(e.data);
      if(m.type==='ready'){clearTimeout(this.timer);this.ready=true;this.onReady?.(m);}
      else if(m.type==='speech_started'){this.blockCurrent();this.onInterrupt?.();this.onStatus?.('正在聆听，可随时打断');}
      else if(m.type==='speech_stopped')this.onStatus?.('正在生成实时回复');
      else if(m.type==='response_started'){
        if(typeof m.responseId!=='string'||this.blocked.has(m.responseId))return;
        this.responseId=m.responseId;this.acceptAudio=true;this.transcriptChannel=null;
      } else if(m.type==='audio'){
        if(!this.acceptAudio||m.responseId!==this.responseId||this.blocked.has(m.responseId))return;
        if(m.sampleRate!==24000||typeof m.pcm16Base64!=='string'||m.pcm16Base64.length>2*1024*1024)throw Error('实时音频格式异常');
        const raw=atob(m.pcm16Base64);if(raw.length%2)throw Error('实时PCM数据不完整');
        const pcm=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)pcm[i]=raw.charCodeAt(i);
        this.onAudio?.(pcm.buffer,m.sampleRate);
      } else if(m.type==='transcript'){
        if(m.role==='assistant'&&(this.blocked.has(m.responseId)||!this.acceptAudio))return;
        if(m.role==='assistant'){
          if(this.transcriptChannel==='audio_transcript'&&m.channel==='text')return;
          if(m.channel==='audio_transcript'&&this.transcriptChannel!=='audio_transcript')m.reset=true;
          this.transcriptChannel=m.channel||this.transcriptChannel;
        }
        if(['user','assistant'].includes(m.role)&&typeof m.text==='string')this.onTranscript?.({...m,text:m.text.slice(0,32000)});
      } else if(m.type==='response_done'){
        if(m.responseId===this.responseId)this.onStatus?.('实时连接中，继续说话即可');
      } else if(m.type==='error')this.fail(m.message||'实时语音服务错误');
      else if(m.type==='ended'){this.close();this.onEnd?.(m.reason||'实时语音已结束');}
    }catch(err){this.fail(err.message);}};
    ws.onerror=()=>this.fail('实时语音连接失败，请检查模型配置');
    ws.onclose=()=>{if(!this.closed){this.close();this.onEnd?.('实时语音连接已断开，请点击麦克风重新连接');}};
  }
  sendPCM(pcm){
    if(!this.ready||this.closed||this.ws?.readyState!==WebSocket.OPEN)return;
    if(this.ws.bufferedAmount>128*1024){this.fail('实时语音网络积压，已停止连接以避免延迟和额外用量');return;}
    this.ws.send(pcm);
  }
  blockCurrent(){if(this.responseId)this.blocked.add(this.responseId);while(this.blocked.size>64)this.blocked.delete(this.blocked.values().next().value);this.acceptAudio=false;}
  interrupt(){this.blockCurrent();this.onInterrupt?.();if(this.ready&&this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'interrupt'}));}
  fail(message){if(this.closed)return;this.close();this.onError?.(message);}
  close(){
    if(this.closed)return;this.closed=true;this.ready=false;clearTimeout(this.timer);this.blockCurrent();
    const ws=this.ws;this.ws=null;
    if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'stop'}));ws.close();}
  }
}
