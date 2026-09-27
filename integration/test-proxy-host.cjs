const http=require('node:http'),manager=require('./workbench-manager.cjs');
const s=http.createServer((req,res)=>{if(!manager.proxy(req,res)){res.writeHead(404);res.end();}});s.on('upgrade',(req,socket,head)=>{if(!manager.upgrade(req,socket,head))socket.destroy();});s.listen(31418,'127.0.0.1',()=>console.log('proxy test on 31418'));process.on('SIGINT',()=>s.close());
