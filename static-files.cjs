const path=require('path'),fs=require('fs');
const PRIVATE_DIRS=new Set(['memory','data','backups','external','integration','tools','audio-debug','tts-env','node_modules','__pycache__','speaker-eval','aishell3-sweep']);
const PUBLIC_EXTS=new Set(['.html','.css','.js','.mjs','.json','.png','.jpg','.jpeg','.webp','.gif','.ico','.svg','.moc3','.wasm','.wav','.mp3','.mp4','.webm','.woff','.woff2','.ttf']);
const PRIVATE_JS=new Set(['harness-server.js','asr-engine.js','tts-engine.js','english-tts.js','jev-agent.js','main.js','preload.js','dashboard-preload.js','wake-engine.js']);
function staticPath(root,urlPath){
 let decoded;try{decoded=decodeURIComponent(urlPath);}catch{return null;}
 if(decoded.includes('\\')||decoded.includes('\0'))return null;
 const segments=decoded.split('/').filter(Boolean);
 const publicAudio=segments.length===2&&segments[0]==='audio-debug'&&(/^(test-zh2?\.wav|tts-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav)$/i.test(segments[1]));
 if(segments.some(s=>s.startsWith('.')||PRIVATE_DIRS.has(s.toLowerCase()))&&!publicAudio)return null;
 const file=path.resolve(root,...(segments.length?segments:['index.html']));
 const relative=path.relative(path.resolve(root),file);
 if(relative.startsWith('..')||path.isAbsolute(relative))return null;
 const ext=path.extname(file).toLowerCase();
 if(!PUBLIC_EXTS.has(ext)||PRIVATE_JS.has(path.basename(file).toLowerCase()))return null;
 // JSON is only public when it is an asset manifest (model/pose/motion).
 if(ext==='.json'&&decoded!=='/soullink.profile.json'&&!['assets','live2d','character','models','vendor'].includes(segments[0]?.toLowerCase()))return null;
 try{const real=fs.realpathSync(file),rel=path.relative(fs.realpathSync(root),real);if(rel.startsWith('..')||path.isAbsolute(rel))return null;}catch{}
 return file;
}
module.exports={staticPath};
