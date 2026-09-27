const {spawn}=require('child_process'),path=require('path');
let worker=null,sequence=0;const pending=new Map();
function fail(err){for(const item of pending.values()){clearTimeout(item.timer);item.reject(err);}pending.clear();worker=null;}
function start(){
 if(worker)return;
 const child=worker=spawn('powershell.exe',['-NoLogo','-NoProfile','-File',path.join(__dirname,'tools/english-tts-worker.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='';child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let result;try{result=JSON.parse(line);}catch{continue;}const item=pending.get(result.id);if(!item)continue;pending.delete(result.id);clearTimeout(item.timer);if(result.error)item.reject(new Error(result.error));else item.resolve(result);}});
 child.stderr.resume();child.on('error',fail);child.on('exit',()=>{if(worker===child)fail(new Error('English speech worker exited'));});
 child.unref();for(const pipe of [child.stdin,child.stdout,child.stderr])pipe.unref?.();
}
async function englishPCM(text,targetRate=8000){
 start();const result=await new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('English synthesis timed out'));},30000);pending.set(id,{resolve,reject,timer});worker.stdin.write(JSON.stringify({id,text})+'\n');});
 const wav=Buffer.from(result.wav,'base64');let pcm=null,rate=16000;
 for(let at=12;at+8<=wav.length;){const id=wav.toString('ascii',at,at+4),size=wav.readUInt32LE(at+4);if(id==='fmt ')rate=wav.readUInt32LE(at+12);if(id==='data')pcm=wav.subarray(at+8,at+8+size);at+=8+size+(size%2);}
 if(!pcm?.length)throw new Error('English engine returned empty WAV');
 const samples=pcm.length/2,n=Math.floor(samples*targetRate/rate),out=Buffer.alloc(n*2);
 for(let i=0;i<n;i++){const pos=i*rate/targetRate,j=Math.floor(pos),f=pos-j;const a=pcm.readInt16LE(Math.min(j,samples-1)*2),b=pcm.readInt16LE(Math.min(j+1,samples-1)*2);out.writeInt16LE(Math.round(a+(b-a)*f),i*2);}
 return {pcmBuffer:out,sampleRate:targetRate,voice:result.voice};
}
function close(){if(worker){const child=worker;worker=null;child.kill();}fail(new Error('English speech closed'));}
process.on('exit',()=>worker?.kill());
module.exports={englishPCM,close};
