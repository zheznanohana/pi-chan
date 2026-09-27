const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createSkillCatalog,hash}=require('../skill-catalog.cjs');
const {createSkillRouter,applySelection,TYPE}=require('../integration/skill-router.cjs');
const fakeQuery=async({questions})=>({answers:Object.fromEntries(Object.keys(questions).map(k=>[k,{noul:.95}]))});
test('real installed catalog is pinned, full files verified; oversized skills not auto loaded',()=>{
 const catalog=createSkillCatalog(),items=catalog.list();assert.equal(items.length,8);assert(items.every(x=>x.revision.length===40&&path.isAbsolute(x.file)));assert.equal(items.find(x=>x.id==='skill-creator').autoEligible,false);
});
test('Jev selects by level with hard context budget and removes old skills',async()=>{
 const router=createSkillRouter({catalog:createSkillCatalog(),query:fakeQuery});
 for(const [level,limit] of [['simple',1],['development',2],['complex',3]]){
  const result=await router.select({text:'测试 浏览器 主题 汇报',sessionId:'a',level});assert.equal(result.status,'ready');assert(result.selected.length>0&&result.selected.length<=limit);assert(result.context.length<=12000);
  const once=applySelection([{role:'user',content:'test'}],result),twice=applySelection(once,result);assert.equal(twice.filter(x=>x.customType===TYPE).length,1);assert.equal(applySelection(twice,null).length,1);
 }
 const chat=await router.select({text:'hello',level:'chat'});assert.equal(chat.context,'');assert.equal(chat.selected.length,0);
});
test('failure/malformed Jev response loads nothing; query deduplicates per session not cross session',async()=>{
 const catalog=createSkillCatalog();for(const query of [undefined,async()=>{throw Error('offline')},async()=>({answers:{}})]){const r=await createSkillRouter({catalog,query}).select({text:'test',level:'simple'});assert.equal(r.context,'');assert.equal(r.status,'unavailable');}
 let calls=0;const router=createSkillRouter({catalog,query:async x=>{calls++;return fakeQuery(x)}});
 await Promise.all([router.select({text:'test',level:'simple',sessionId:'a'}),router.select({text:'test',level:'simple',sessionId:'a'})]);assert.equal(calls,1);await router.select({text:'test',level:'simple',sessionId:'b'});assert.equal(calls,2);
});
test('tampered content invalidates source; previous selection never reused after mutation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-skills-'));
 try{fs.mkdirSync(path.join(root,'example'));fs.writeFileSync(path.join(root,'example','SKILL.md'),'test');fs.writeFileSync(path.join(root,'catalog-lock.json'),JSON.stringify({skills:[{id:'example',sha256:hash('test')}]}));const catalog=createSkillCatalog({root});assert.equal(catalog.list().length,1);fs.writeFileSync(path.join(root,'example','SKILL.md'),'changed');assert.equal(catalog.list().length,0);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
