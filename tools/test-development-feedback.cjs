'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Node{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.hidden=false;}append(...nodes){for(const n of nodes){this.children.push(n);n.parentNode=this;}}setAttribute(){}replaceChildren(){this.children=[];}}
const events={},host=new Node('host'),head=new Node('head');let queries=[],sendCount=0;
const window={piActiveSessionId:'A',addEventListener:(name,fn)=>events[name]=fn,dispatchEvent:e=>events[e.type]?.(e),sendPrompt:()=>sendCount++,piDevelopmentTasks:{open(){}}};
const sandbox={window,document:{head,createElement:tag=>new Node(tag),getElementById:()=>host,hidden:false},AbortSignal,CustomEvent:class{constructor(type,args){this.type=type;this.detail=args.detail;}},fetch:async url=>{queries.push(url);return{ok:true,json:async()=>({tasks:[{id:'a',sourceSessionId:'A',status:'completed',title:'Task A',result:{text:'A result'}},{id:'b',sourceSessionId:'B',status:'completed',title:'Task B',result:{text:'B secret'}}]})}}};
const flatten=n=>[n.textContent,...n.children.map(flatten)].join(' ');
(async()=>{vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../development-feedback.js'),'utf8'),sandbox);await new Promise(setImmediate);
 assert.match(flatten(host),/A result/);assert.doesNotMatch(flatten(host),/B secret/);
 events['pi-runtime-event']({detail:{type:'development_task',payload:{task:{id:'b',sourceSessionId:'B',status:'completed',result:{text:'foreign result'}}}}});assert.doesNotMatch(flatten(host),/foreign result/);
 window.piActiveSessionId='B';events['pi-chat-source-changed']();await new Promise(setImmediate);assert.match(flatten(host),/B secret/);assert.doesNotMatch(flatten(host),/A result/);assert.equal(sendCount,0);assert.ok(queries.every(q=>q.startsWith('/api/development/tasks?sourceSessionId=')));
 console.log('PASS persistent results filtered by source session; switching clears foreign results; no model prompt or speech triggered.');
})().catch(e=>{console.error(e);process.exitCode=1});
