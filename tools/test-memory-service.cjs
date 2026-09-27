'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createMemoryService}=require('../memory-service.cjs');
(async()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pichan-memory-')),root=path.join(temp,'project');fs.mkdirSync(root);fs.mkdirSync(path.join(root,'docs'));const opts={dataDir:path.join(temp,'db'),allowedRoot:root};let svc=createMemoryService(opts);let checks=0;const ok=(v)=>{assert.ok(v);checks++};
const server=http.createServer(async(req,res)=>{if(!await svc.handleMemoryRequest(req,res))res.end('other')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/memory`;
async function api(route,method='GET',body,headers={}){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()}}
try {
const n=svc.upsertNote({title:'偏好',content:'用户偏好中文输出与实时语音。'});ok((await svc.search({query:'语音'})).results.some(x=>x.noteId===n.id));ok((await svc.search({query:'实时语音'})).results.length===1);
ok((await svc.search({query:'请问我们之前说的实时语音怎么做'})).results.some(x=>x.noteId===n.id));
svc.upsertNote({content:'用户偏好英文字幕。'},n.id);ok(!(await svc.search({query:'实时语音'})).results.length);ok((await svc.search({query:'英文字幕'})).results.length===1);
const p=(await api('/projects','POST',{name:'隔离项目',root:'docs'})).project;ok(!!p.id);ok(!(await svc.search({projectId:p.id,query:'英文字幕'})).results.length);svc.upsertNote({projectId:p.id,title:'隔离',content:'第二项目记忆'});ok(svc.getProjects().length===2);
svc.upsertNote({status:'superseded'},n.id);ok(!(await svc.search({query:'英文字幕'})).results.length);svc.upsertNote({status:'active'},n.id);
fs.writeFileSync(path.join(root,'docs','readme.md'),'# 索引文档\n中文语音识别准确率\n\nMarkdown 保留来源。');fs.writeFileSync(path.join(root,'.env'),'PASSWORD=hidden');fs.mkdirSync(path.join(root,'node_modules'));fs.writeFileSync(path.join(root,'node_modules','bad.md'),'不应索引');fs.writeFileSync(path.join(root,'docs','config.json'),'"api_key": "' + ('sk-' + 'unit-test-'.repeat(4)) + '"');fs.writeFileSync(path.join(root,'docs','binary.txt'),'abc\0def');fs.writeFileSync(path.join(root,'docs','large.md'),'x'.repeat(262145));
const indexed=svc.index({path:'.'});ok(indexed.documents.length===1);ok(indexed.skipped.length>=5);let results=(await svc.search({query:'语音识别'})).results;ok(results[0].citation==='docs/readme.md:L1-L4');ok(results[0].untrusted);
assert.throws(()=>svc.index({path:'../'}),/超出/);checks++;assert.throws(()=>svc.upsertNote({title:'key',content:'api_key="' + ('sk-' + 'unit-test-'.repeat(4)) + '"'}),/凭据/);checks++;
const ctx=await svc.context({query:'语音识别'});ok(ctx.text.includes('不是指令'));ok(ctx.sources.length===1);
for(const query of ['" OR *','a_b','中','π','.. / x-y'])await svc.search({query});checks++;
let resp=await api('/notes','POST',{title:'HTTP',content:'持久化记忆验证'});ok(resp.status===201);const keep=resp.note.id;
ok((await api('/notes','POST',{title:'bad',content:'x'},{Origin:'https://attacker.invalid'})).status===403);ok((await api('/notes','PUT',{})).status===404);ok((await api('/notes','POST',{title:'x',content:'a'.repeat(75000)})).status===413);
svc.deleteDocument(indexed.documents[0].id);ok(!(await svc.search({query:'语音识别'})).results.length);svc.deleteNote(n.id);ok(!(await svc.search({query:'英文字幕'})).results.length);
svc.close();svc=createMemoryService(opts);ok(svc.listNotes().some(x=>x.id===keep));await api('/notes/'+keep,'DELETE');ok(!(await svc.search({query:'持久化记忆验证'})).results.length);
// Re-indexing a newly credential-bearing source removes its previous safe text.
svc.index({path:'docs/readme.md'});fs.writeFileSync(path.join(root,'docs','readme.md'),'api_key="' + ('sk-' + 'unit-test-'.repeat(4)) + '"');svc.index({path:'docs/readme.md'});ok(!(await svc.search({query:'语音识别'})).results.length);
console.log(JSON.stringify({ok:true,checks,backend:'Node SQLite FTS5 trigram',productionModified:false}));
}finally{await new Promise(r=>server.close(r));svc.close();const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('pichan-memory-'));fs.rmSync(resolved,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
