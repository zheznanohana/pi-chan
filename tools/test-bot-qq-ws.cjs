const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WebSocketServer}=require('ws'),{createBotAuto}=require('../integration/bot-auto.cjs');
test('QQ real local WS receives private text and routes reply to the same peer',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-qq-ws-'));const host=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>host.once('listening',r));
 const connected=new Promise(r=>host.once('connection',r));const sent=[];
 const auto=createBotAuto({dataDir:dir,readServers:()=>({qq:{env:{BOT_PLATFORM:'qq-onebot',ONEBOT_WS_URL:`ws://127.0.0.1:${host.address().port}`,ONEBOT_ACCESS_TOKEN:'test'}}}),reply:async()=> 'reply',transcribe:async()=>'',synthesize:async()=>'',makeBridge:()=>({platform:'qq-onebot',execute:async(name,args)=>{sent.push({name,args});return{}}})});
 try{auto.configure({enabled:true,channels:[{server:'qq',target:'42',chatType:'private'}]});await auto.tick();const socket=await connected;
 socket.send(JSON.stringify({post_type:'message',message_type:'private',message_id:1,user_id:42,self_id:99,message:[{type:'text',data:{text:'hello'}}]}));
 await new Promise(r=>setTimeout(r,40));await auto.tick();assert.equal(sent.length,1);assert.equal(sent[0].name,'bot_send_text');assert.equal(sent[0].args.target,'42');
 socket.send(JSON.stringify({post_type:'message',message_type:'private',message_id:2,user_id:7,self_id:99,message:[{type:'text',data:{text:'not selected'}}]}));await new Promise(r=>setTimeout(r,40));await auto.tick();assert.equal(sent.length,1);
 }finally{auto.close();for(const socket of host.clients)socket.terminate();await new Promise(r=>host.close(r));for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())fs.rmdirSync(file);else fs.unlinkSync(file)}fs.rmdirSync(dir)}
});
