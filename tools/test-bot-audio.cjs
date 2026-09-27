const {test}=require('node:test'),assert=require('node:assert/strict');
const {convertAudio}=require('../integration/bot-voice.cjs');
test('real FFmpeg encodes a voice note as OGG/Opus and decodes to ASR PCM',async()=>{
 const raw=Buffer.alloc(16000*2);for(let i=0;i<16000;i++)raw.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*3000),i*2);
 const ogg=await convertAudio(raw,['-f','s16le','-ar','16000','-ac','1','-i','pipe:0','-c:a','libopus','-f','ogg','pipe:1']);assert.equal(ogg.subarray(0,4).toString(),'OggS');
 const pcm=await convertAudio(ogg,['-protocol_whitelist','pipe','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1']);assert(Math.abs(pcm.length-raw.length)<1000);
});
