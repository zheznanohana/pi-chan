const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createQQOfficial,normalizeEvent,mediaUrl}=require('../integration/qq-official.cjs');
const env={QQ_APP_ID:'123',QQ_APP_SECRET:'secret-example'};
const response=d=>({ok:true,status:200,json:async()=>d});
test('official token uses current endpoint, cached and not exposed; passive reply carries message id',async()=>{
 const calls=[];const b=createQQOfficial({env,fetchImpl:async(url,o)=>{calls.push({url,o});return response(url.endsWith('getAppAccessToken')?{access_token:'test-token',expires_in:7200}:{id:'sent'})}});
 await b.execute('bot_identity');await b.execute('bot_send_text',{target:'OPEN_ID',chatType:'private',text:'hello',confirmed:true,replyTo:'msg1'});
 assert.equal(calls.filter(c=>c.url.endsWith('getAppAccessToken')).length,1);assert.equal(calls[0].url,'https://api.bot.qq.com/app/getAppAccessToken');
 assert.deepEqual(JSON.parse(calls[2].o.body),{content:'hello',msg_type:0,msg_id:'msg1',msg_seq:1});assert.equal(calls[2].o.headers.Authorization,'QQBot test-token');
});
test('official errors never echo secret; HTTP 200 business failure rejected',async()=>{
 const b=createQQOfficial({env,fetchImpl:async()=>response({code:100016,message:env.QQ_APP_SECRET})});await assert.rejects(b.execute('bot_identity'),e=>e.message.includes('100016')&&!e.message.includes(env.QQ_APP_SECRET));
});
test('normalization accepts only official private and mentioned group events; SSRF blocked',()=>{
 assert.equal(normalizeEvent({t:'GROUP_MESSAGE_CREATE',d:{}}),null);
 const m=normalizeEvent({t:'C2C_MESSAGE_CREATE',d:{id:'m',author:{user_openid:'abc'},content:'hi'}});assert.equal(m.target,'abc');assert.equal(m.replyTo,'m');
 for(const u of ['http://127.0.0.1/x','https://qq.com.evil.test/x','https://127.0.0.1/x'])assert.throws(()=>mediaUrl(u));
});
test('official voice uploads chunks before a single passive media reply, no credential to upload host',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-voice-'));fs.writeFileSync(path.join(dir,'voice.ogg'),'audio');const calls=[];
 const b=createQQOfficial({env:{...env,BOT_MEDIA_DIR:dir},fetchImpl:async(url,o)=>{calls.push({url,o});return response(url.endsWith('getAppAccessToken')?{access_token:'t',expires_in:7200}:url.endsWith('upload_prepare')?{upload_id:'up',block_size:'10',parts:[{index:1,presigned_url:'https://bucket.cos.ap-guangzhou.myqcloud.com/upload'}]}:url.endsWith('/files')?{file_info:'info'}:{id:'sent'})}});
 await b.execute('bot_send_voice',{target:'GROUP',chatType:'group',file:'voice.ogg',confirmed:true,replyTo:'origin'});
 assert.equal(calls.filter(c=>c.url.endsWith('/messages')).length,1);const upload=calls.find(c=>c.o.method==='PUT');assert.equal(upload.o.headers,undefined);assert.equal(JSON.parse(calls.at(-1).o.body).msg_id,'origin');
 fs.unlinkSync(path.join(dir,'voice.ogg'));fs.rmdirSync(dir);
});
const{EventEmitter}=require('node:events');
test('official gateway handshake, message normalization and permanent error stop',async()=>{
 let socket;class FakeWS extends EventEmitter{constructor(){super();socket=this;this.sent=[]}send(s){this.sent.push(JSON.parse(s))}close(){this.emit('close',1000)}}
 const received=[],statuses=[];const b=createQQOfficial({env,WebSocketImpl:FakeWS,fetchImpl:async url=>response(url.endsWith('getAppAccessToken')?{access_token:'t',expires_in:7200}:{url:'wss://api.bot.qq.com/websocket'})});
 const listener=b.listen(m=>received.push(m),s=>statuses.push(s));await new Promise(r=>setImmediate(r));
 socket.emit('message',JSON.stringify({op:10,d:{heartbeat_interval:45000}}));assert.equal(socket.sent[0].op,2);assert.equal(socket.sent[0].d.intents,1<<25);
 socket.emit('message',JSON.stringify({op:0,s:1,t:'C2C_MESSAGE_CREATE',d:{id:'msg',author:{user_openid:'user'},content:'hello'}}));assert.equal(received[0].target,'user');
 socket.emit('close',4014);assert.ok(statuses.at(-1).includes('4014'));listener.close();
});
