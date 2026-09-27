const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../session-store.cjs');
test('delete moves exactly one transcript to recovery directory and keeps others',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-test-'));
 const a=path.join(root,'a.jsonl'),b=path.join(root,'b.jsonl');
 fs.writeFileSync(a,JSON.stringify({type:'session',id:'a'}));fs.writeFileSync(b,JSON.stringify({type:'session',id:'b'}));
 const store=new SessionStore(root);assert.equal(store.list().length,2);
 assert.equal(store.remove('a').recoverable,true);assert.equal(store.list().length,1);assert.equal(store.find('b').id,'b');
 assert.equal(fs.readdirSync(path.join(root,'.deleted')).length,1);assert.throws(()=>store.remove('../b'));assert.throws(()=>store.remove('missing'));
 const files=fs.readdirSync(path.join(root,'.deleted'));for(const file of files)fs.unlinkSync(path.join(root,'.deleted',file));fs.rmdirSync(path.join(root,'.deleted'));fs.unlinkSync(b);fs.rmdirSync(root);
});
