'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
const fs=require('node:fs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jev-retry-test-')),file=path.join(dir,'client.mts');
fs.copyFileSync(path.join(os.homedir(),'.pi/agent/npm/node_modules/@y0usaf/pi-jev/src/client.ts'),file);
require('node:test').after(()=>fs.rmSync(file,{force:true}));
const client=import(pathToFileURL(file).href);

const input={apiKey:'test-only',state:'test',questions:{ok:{type:'noul',instructions:'Is this a test?'}},retries:2};
test('Cloudflare 403 retries then succeeds without exposing HTML',async t=>{
 const {askJev}=await client;let calls=0;
 t.mock.method(global,'fetch',async()=>++calls===1?new Response('<!DOCTYPE html><html>Attention Required! Cloudflare</html>',{status:403}):Response.json({model:'test',answers:{ok:{type:'noul',noul:1}}}));
 const result=await askJev(input);assert.equal(calls,2);assert.equal(result.answers.ok.noul,1);
});
test('permanent auth rejection is not retried',async t=>{
 const {askJev}=await client;let calls=0;t.mock.method(global,'fetch',async()=>{calls++;return new Response('invalid credentials',{status:401})});
 await assert.rejects(askJev(input),e=>e.status===401);assert.equal(calls,1);
});
test('persistent Cloudflare rejection has three-attempt ceiling',async t=>{
 const {askJev}=await client;let calls=0;t.mock.method(global,'fetch',async()=>{calls++;return new Response('<html>Cloudflare</html>',{status:403})});
 await assert.rejects(askJev(input),e=>e.status===403&&!e.message.includes('<html>'));assert.equal(calls,3);
});
