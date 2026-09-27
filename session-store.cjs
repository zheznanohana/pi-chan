const fs = require('fs');
const path = require('path');
// Read only Pi's active parent chain, not abandoned branches in append-only JSONL.
function activeMessages(entries) {
 const nodes=entries.filter(e=>e.type!=='session'&&e.id);
 if(!nodes.length)return entries.filter(e=>e.type==='message'&&e.message).map(e=>e.message);
 const byId=new Map(nodes.map(e=>[e.id,e])), chain=[],seen=new Set();
 let node=nodes.at(-1);
 while(node&&!seen.has(node.id)){seen.add(node.id);chain.push(node);node=byId.get(node.parentId);}
 return chain.reverse().filter(e=>e.type==='message'&&e.message).map(e=>e.message);
}
class SessionStore {
 constructor(dir){this.dir=path.resolve(dir);fs.mkdirSync(this.dir,{recursive:true});}
 list(){return fs.readdirSync(this.dir).filter(n=>n.endsWith('.jsonl')).map(name=>{
  const file=path.join(this.dir,name);try{
   // Do not follow linked session files outside this application's store.
   if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())return null;
   const entries=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
   const header=entries.find(e=>e.type==='session');if(!header?.id)return null;
   const messages=activeMessages(entries);
   const user=messages.find(m=>m.role==='user');const text=typeof user?.content==='string'?user.content:(Array.isArray(user?.content)?user.content:[]).filter(c=>c.type==='text').map(c=>c.text).join('');
   const named=entries.filter(e=>e.type==='session_info'&&e.name).at(-1)?.name;
   return {id:header.id,title:named||text.trim().split('\n')[0].slice(0,45)||'新对话',updatedAt:fs.statSync(file).mtime.toISOString(),messages,file};
  }catch{return null;}
 }).filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 find(id){return this.list().find(item=>item.id===id);}
 remove(id){
  const matches=this.list().filter(item=>item.id===id);
  if(matches.length!==1)throw Error('会话不存在或标识不唯一');
  const file=matches[0].file;
  if(path.dirname(file)!==this.dir||fs.lstatSync(file).isSymbolicLink())throw Error('会话路径无效');
  const trash=path.join(this.dir,'.deleted');fs.mkdirSync(trash,{recursive:true});
  if(fs.lstatSync(trash).isSymbolicLink()||fs.realpathSync(trash)!==path.join(fs.realpathSync(this.dir),'.deleted'))throw Error('回收目录无效');
  fs.renameSync(file,path.join(trash,require('node:crypto').randomUUID()+'-'+path.basename(file)));
  return {deletedId:id,recoverable:true};
 }
}
module.exports={SessionStore,activeMessages};
