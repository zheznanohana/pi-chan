'use strict';
// One private subscription credential, shared by text/ASR/TTS/realtime adapters.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const file=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.config'),'PiChanDashboard','cloud-tts.json');
function getApiKey(){
 let store;try{store=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('Token Plan 私有凭据尚未配置');}
 const key=store.tokenPlan?.apiKey;
 if(typeof key!=='string'||!key.startsWith('sk-sp-')||/[\r\n]/.test(key))throw new Error('Token Plan 订阅密钥尚未配置');
 return key;
}
module.exports={getApiKey};
if(require.main===module&&process.argv[2]==='--print'){
 try{process.stdout.write(getApiKey());}catch{process.stderr.write('Token Plan credential unavailable');process.exitCode=1;}
}
