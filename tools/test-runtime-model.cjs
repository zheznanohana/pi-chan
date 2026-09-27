const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createChatModelService}=require('../chat-model-service.cjs');
test('current identity uses fresh Pi state, including busy model changes',async()=>{
 let model={provider:'one',id:'first'};
 const calls=[];
 const service=createChatModelService({rpc:async type=>{calls.push(type);return{model,isStreaming:true};}});
 assert.deepEqual((await service.current()).active,{provider:'one',modelId:'first'});
 model={provider:'two',id:'second'};
 assert.deepEqual((await service.current()).active,{provider:'two',modelId:'second'});
 assert.deepEqual(calls,['get_state','get_state']);
});
test('runtime extension supplies current identity and preserves prior prompt',async()=>{
 const source=fs.readFileSync('.pi/extensions/runtime-model.ts','utf8').replace('export default function','return function');
 const install=new Function(source)();const old=process.env.PICHAN_HARNESS_KIND;
 try {
 process.env.PICHAN_HARNESS_KIND='chat';let hook;install({on:(event,fn)=>{assert.equal(event,'before_agent_start');hook=fn;}});
 for(const id of ['model-a','model-b']){const result=await hook({systemPrompt:'BASE'},{model:{provider:'test',id}});assert.ok(result.systemPrompt.startsWith('BASE'));assert.ok(result.systemPrompt.includes('"id":"'+id+'"'));}
 process.env.PICHAN_HARNESS_KIND='development';install({on:()=>assert.fail('must not misidentify development')});
 } finally {if(old===undefined)delete process.env.PICHAN_HARNESS_KIND;else process.env.PICHAN_HARNESS_KIND=old;}
});
test('/model frontend returns before adding messages; backend intercepts both inputs',()=>{
 const html=fs.readFileSync('index.html','utf8');const part=html.slice(html.indexOf('window.sendPrompt ='));
 assert.ok(part.indexOf('await window.piChatModels.open()')<part.indexOf('markdownRenderer.appendUser(text)'));
 const server=fs.readFileSync('harness-server.js','utf8');
 assert.equal((server.match(/command:'model'/g)||[]).length,2);
});
