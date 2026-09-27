 'use strict';
const fs=require('node:fs'),path=require('node:path');
// Convenience isolation, not an OS security boundary. Tools retain user permissions.
function prepareWorkspace({source,directory,mode='session'}){
 const root=fs.realpathSync(source);
 if(mode==='session')return{mode,workspace:root,sourceRoot:root};
 if(mode!=='copy')throw Error('Invalid task isolation mode');
 const dest=path.resolve(directory),inside=(a,b)=>{const rel=path.relative(a,b);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
 if(inside(dest,root))throw Error('Workspace must not replace source');
 if(fs.existsSync(dest))throw Error('Task workspace already exists; inspect it instead of overwriting');
 fs.mkdirSync(dest,{recursive:true});let files=0,bytes=0;
 const skip=/^(\.git|\.pi|\.env(?:\..*)?|node_modules|\.venv|venv|tts-env|data|logs|backups|audio-debug|models|\.ssh|\.aws|\.azure|\.npmrc)$/i;
 function walk(from,to){for(const e of fs.readdirSync(from,{withFileTypes:true})){
  if(skip.test(e.name)||/\.(pem|key|pfx|p12)$/i.test(e.name)||/(?:credentials|secrets|auth)\.json$/i.test(e.name))continue;
  const src=path.join(from,e.name),dst=path.join(to,e.name),st=fs.lstatSync(src);
  if(st.isSymbolicLink()||inside(src,dest))continue;
  if(++files>30000)throw Error('Project copy exceeds 30000 entries');
  if(st.isDirectory()){fs.mkdirSync(dst);walk(src,dst)}else if(st.isFile()){bytes+=st.size;if(bytes>256*1024*1024)throw Error('Project copy exceeds 256 MB');fs.copyFileSync(src,dst)}
 }}
 walk(root,dest);return{mode,workspace:dest,sourceRoot:root,files,bytes};
}
module.exports={prepareWorkspace};
