'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function prepareRecording({audio,mimeType,platform,directory}){
 if(typeof audio!=='string'||audio.length>12*1024*1024||!/^audio\/(webm|ogg|wav|mpeg|mp4)(?:;.*)?$/.test(mimeType||'')||!/^[A-Za-z0-9+/]+={0,2}$/.test(audio))throw Error('录音格式或大小无效');
 const bytes=Buffer.from(audio,'base64');if(!bytes.length||bytes.length>8*1024*1024)throw Error('录音需小于8MB');
 const {convertAudio}=require('./bot-voice.cjs');const pcm=await convertAudio(bytes,['-protocol_whitelist','pipe','-i','pipe:0','-t','121','-ar','24000','-ac','1','-f','s16le','pipe:1']);
 if(pcm.length>24000*2*120)throw Error('录音最长120秒');let out,ext;
 if(platform.startsWith('qq-')){out=Buffer.from((await require('silk-wasm').encode(pcm,24000)).data);ext='silk';}else{out=await convertAudio(pcm,['-f','s16le','-ar','24000','-ac','1','-i','pipe:0','-c:a','libopus','-f','ogg','pipe:1']);ext='ogg';}
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'desktop-'+crypto.randomUUID()+'.'+ext);fs.writeFileSync(file,out);return file;
}
module.exports={prepareRecording};
