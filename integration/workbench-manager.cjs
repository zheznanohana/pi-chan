'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const UPSTREAM = path.join(ROOT, 'external', 'pi-web-ui');
const PORT = Number(process.env.PICHAN_WORKBENCH_PORT || 31417);
const PREFIX = '/workbench';
let child = null, starting = null, lastError = null;
const url = `http://127.0.0.1:${PORT}`;
async function health() {
  try { const r = await fetch(url + '/api/health', {signal:AbortSignal.timeout(1500)}); if(!r.ok) return null; const h=await r.json(); return h.ok===true && h.engine && Array.isArray(h.piSdkCopies) ? h : null; } catch { return null; }
}
async function status() { const h=await health(); return {ready:!!h,owned:!!child,pid:child?.pid || null,url:PREFIX+'/',version:'0.92.0',upstreamCommit:'5316518b43ea9571b3237610bef79efb7ce1e1b1',health:h,error:lastError}; }
async function start() {
  if(starting) return starting;
  starting=(async()=>{
    if(await health()) return status();
    const entry=path.join(UPSTREAM,'dist','server','index.js');
    if(!fs.existsSync(entry)) throw new Error('工作台尚未构建，请运行 integration/setup-workbench.ps1');
    const data=path.join(ROOT,'integration','data'); fs.mkdirSync(data,{recursive:true});
    const log=fs.openSync(path.join(data,'workbench.log'),'a');
    child=spawn(process.execPath,[entry],{cwd:ROOT,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,PICHAN_APP_ROOT:ROOT,PICHAN_MEMORY_PORT:String(process.env.PORT||31415),PI_WEB_HOST:'127.0.0.1',PI_WEB_PORT:String(PORT),PI_WEB_CWD:ROOT,PI_WEB_DATA_DIR:data,PI_WEB_ENGINE:'pi',PI_WEB_MANAGED:'1',PI_WEB_ALLOW_ORIGINS:'http://127.0.0.1:31415,http://localhost:31415',PI_WEB_LOCALE:'zh'}});
    fs.closeSync(log); lastError=null;
    child.once('error',e=>{lastError=e.message;child=null;});
    child.once('exit',(code)=>{if(code) lastError='工作台退出: '+code;child=null;});
    for(let i=0;i<80;i++){if(await health())return status();if(!child)throw new Error(lastError||'工作台启动失败');await new Promise(r=>setTimeout(r,250));}
    throw new Error('工作台启动超时，查看 integration/data/workbench.log');
  })().finally(()=>{starting=null;});
  return starting;
}
function stop(){if(child){child.kill();child=null;}return {stopped:true};}
function upstreamPath(raw){return (raw.slice(PREFIX.length)||'/');}
function proxy(req,res){
  if(!req.url.startsWith(PREFIX+'/'))return false;
  if(req.url===PREFIX+'/pichan-bridge.js'){
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'workbench-bridge.js')));return true;
  }
  if(req.url===PREFIX+'/pichan-theme.css'){
    res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'workbench-theme.css')));return true;
  }
  const target=upstreamPath(req.url);
  const headers={...req.headers,host:`127.0.0.1:${PORT}`}; delete headers['accept-encoding'];
  const p=http.request({hostname:'127.0.0.1',port:PORT,path:target,method:req.method,headers},r=>{
    const out={...r.headers};delete out['content-length'];
    if(out.location?.startsWith('/'))out.location=PREFIX+out.location;
    if(String(out['content-type']).includes('text/html') && (target==='/'||target.startsWith('/?'))){
      let body='';r.setEncoding('utf8');r.on('data',s=>body+=s);r.on('end',()=>{
        body=body.replace(/(src|href)="\/(?!\/|workbench\/)/g,`$1="${PREFIX}/`).replace('<head>','<head><base href="/workbench/"><script src="/workbench/pichan-bridge.js"></script>');
        res.writeHead(r.statusCode,out);res.end(body);
      });
    }else{res.writeHead(r.statusCode,out);r.pipe(res);}
  });p.on('error',e=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'工作台未启动',detail:e.message}));});req.pipe(p);return true;
}
function upgrade(req,socket,head){
  if(!req.url.startsWith(PREFIX+'/'))return false;
  const p=http.request({hostname:'127.0.0.1',port:PORT,path:upstreamPath(req.url),method:'GET',headers:{...req.headers,host:`127.0.0.1:${PORT}`}});
  p.on('upgrade',(r,remote,remoteHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);socket.pipe(remote).pipe(socket);remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());});
  p.on('response',r=>{socket.end(`HTTP/1.1 ${r.statusCode} Rejected\r\nConnection: close\r\n\r\n`);r.resume();});p.on('error',()=>socket.destroy());p.end();return true;
}
module.exports={start,stop,status,proxy,upgrade,PREFIX,PORT};
if(require.main===module){start().then(s=>console.log(JSON.stringify(s))).catch(e=>{console.error(e);process.exitCode=1;});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stop();process.exit();});}




