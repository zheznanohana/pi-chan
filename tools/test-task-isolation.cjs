 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareWorkspace}=require('../integration/task-isolation.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
test('session mode retains registered root without copying',t=>{const root=fixture(t);assert.equal(prepareWorkspace({source:root}).workspace,root)});
test('copy excludes common credential and generated folders; never overwrites existing work',t=>{
 const root=fixture(t),source=path.join(root,'source'),directory=path.join(root,'copy');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'app.js'),'original');fs.writeFileSync(path.join(source,'.env'),'secret');fs.mkdirSync(path.join(source,'node_modules'));
 const result=prepareWorkspace({source,directory,mode:'copy'});assert.equal(result.workspace,directory);assert(fs.existsSync(path.join(directory,'app.js')));assert(!fs.existsSync(path.join(directory,'.env')));assert(!fs.existsSync(path.join(directory,'node_modules')));assert.throws(()=>prepareWorkspace({source,directory,mode:'copy'}),/already exists/);
});
test('invalid mode and replacing source reject',t=>{const root=fixture(t);assert.throws(()=>prepareWorkspace({source:root,directory:root,mode:'copy'}),/replace source/);assert.throws(()=>prepareWorkspace({source:root,mode:'docker'}),/Invalid/)});
