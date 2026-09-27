'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function createSkillCatalog({root=path.join(__dirname,'data','skills-library'),manifest=path.join(root,'catalog-lock.json')}={}){
 root=path.resolve(root);
 function list(){
  let lock;try{lock=JSON.parse(fs.readFileSync(manifest,'utf8'));}catch{return [];}
  return (lock.skills||[]).flatMap(entry=>{
   try{
    if(!/^[a-z0-9-]+$/.test(entry.id))return [];
    const file=path.join(root,entry.id,'SKILL.md'),real=fs.realpathSync(file);
    if(!real.startsWith(fs.realpathSync(root)+path.sep))return [];
    const content=fs.readFileSync(real,'utf8');
    if(hash(content)!==entry.sha256)return [];
    // Lock every support file as well: references/scripts are not silently updated.
    for(const [relative,digest] of Object.entries(entry.files||{})){
     const target=path.resolve(root,entry.id,relative);
     if(!target.startsWith(path.join(root,entry.id)+path.sep)||!fs.realpathSync(target).startsWith(fs.realpathSync(root)+path.sep)||hash(fs.readFileSync(target))!==digest)return [];
    }
    return [{id:entry.id,name:entry.name||entry.id,description:String(entry.description||'').slice(0,700),tags:entry.tags||[],source:entry.source,revision:lock.revision,sha256:entry.sha256,file:real,baseDir:path.dirname(real),characters:content.length,autoEligible:content.length<=11000}];
   }catch{return [];}
  });
 }
 function read(id){const entry=list().find(x=>x.id===id);return entry?{...entry,content:fs.readFileSync(entry.file,'utf8')}:null;}
 return {list,read,root};
}
module.exports={createSkillCatalog,hash};
