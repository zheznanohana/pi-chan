'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this._text='';this.attrs={};}
 set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
 append(...items){this.children.push(...items);}replaceChildren(){this._text='';this.children=[];}setAttribute(k,v){this.attrs[k]=v;}
}
const panel=new Element('aside'),head=new Element('head'),events={},opened=[];let subscriber,disposed=false;
const api={getTasks:()=>[{id:'old',title:'已完成的工作',status:'completed',createdAt:'2026-01-01'}],subscribe:fn=>{subscriber=fn;return()=>disposed=true},open:id=>opened.push(id)};
const context={window:{piDevelopmentTasks:api,addEventListener:(name,fn)=>{events[name]=fn}},document:{head,querySelector:()=>panel,createElement:tag=>new Element(tag)},console};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../runtime-details.js'),'utf8').replace(/^import[^\n]*\n/,''),context);
const section=panel.children.find(s=>s.children[0].textContent==='开发近况'),body=section.children[1];
assert.match(body.textContent,/已完成的工作已完成查看/);
subscriber([{id:'old',title:'已完成的工作',status:'completed'},{id:'new',title:'<img onerror=bad>',status:'running'}]);
assert.equal(body.children[0].children[0].textContent,'<img onerror=bad>');assert.equal(body.children[0].children[1].textContent,'执行中');
body.children[0].children[2].onclick();assert.deepEqual(opened,['new']);
subscriber([{id:'new',title:'新任务',status:'completed'}]);assert.match(body.textContent,/已完成/);assert.doesNotMatch(body.textContent,/执行中/);
subscriber([]);assert.equal(body.textContent,'暂无后台开发任务');events.pagehide();assert.equal(disposed,true);
assert.equal(body.children.length,0);console.log('PASS runtime queue initial snapshot, subscription updates, running-first ordering, plain text titles, view-only action and cleanup');
