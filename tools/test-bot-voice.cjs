const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {synthesize,decodeIncoming}=require('../integration/bot-voice.cjs');
const silk=require('silk-wasm');
function pcm(rate=24000){const b=Buffer.alloc(rate*2/2);for(let i=0;i<b.length/2;i++)b.writeInt16LE(Math.round(Math.sin(i/rate*440*Math.PI*2)*5000),i*2);return b;}
const stream=async(_text,{onChunk})=>onChunk({pcmBuffer:pcm(),sampleRate:24000});
test('QQ voice synthesis creates real SILK and incoming SILK decodes to 16k PCM',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-codec-'));
 try{const file=await synthesize('测试',{directory:dir,platform:'qq-official',synthesizeStream:stream});assert.equal(path.extname(file),'.silk');const bytes=fs.readFileSync(file);assert.ok(silk.isSilk(bytes));const decoded=await decodeIncoming(bytes);assert.ok(decoded.length>=16000*2*0.4&&decoded.length<=16000*2*0.6);assert.ok(decoded.some(x=>x!==0));}finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir)}
});
test('Telegram retains OGG Opus; incoming standard audio passes real FFmpeg decoding',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-codec-'));
 try{const file=await synthesize('test',{directory:dir,platform:'telegram',synthesizeStream:stream});assert.equal(path.extname(file),'.ogg');const bytes=fs.readFileSync(file);assert.equal(bytes.subarray(0,4).toString(),'OggS');const decoded=await decodeIncoming(bytes);assert.ok(decoded.length>12000&&decoded.length<20000);}finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir)}
});
test('SILK longer than 120 seconds is rejected before decode',async()=>{
 const bytes=Buffer.from((await silk.encode(Buffer.alloc(24000*2*121),24000)).data);await assert.rejects(decodeIncoming(bytes),/120秒/);
});
test('empty voice and empty TTS response are rejected',async()=>{await assert.rejects(decodeIncoming(Buffer.alloc(0)),/为空/);await assert.rejects(synthesize('hello',{directory:os.tmpdir(),synthesizeStream:async()=>{}}),/没有返回音频/)});
