const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class El {constructor(){this.children=[];this.dataset={};this.scrollTop=0;this.scrollHeight=0;}append(...items){for(const x of items){x.parentNode=this;this.children.push(x)}}replaceChildren(){this.children=[]}}
class Renderer {constructor({targetEl}){this.targetEl=targetEl} _applyRender(){} render(el,text){el.textContent=text} flush(){}}
const ctx={document:{querySelector:()=>null,createElement:()=>new El()},window:{},cancelAnimationFrame(){}};
vm.runInNewContext(fs.readFileSync(require.resolve('../background-markdown.js'),'utf8').replace('export class','class')+'\nglobalThis.Reader=ConversationMarkdownRenderer;',ctx);
const view=new ctx.Reader({targetEl:new El(),Renderer});view.render(null,'正在聊天');const active=view.active;
const task={id:'one',title:'任务',status:'completed',result:{text:'已做完'}};
view.upsertDevelopmentReport(task);view.upsertDevelopmentReport(task);
assert.equal(view.messages.length,2);assert.equal(view.active,active);assert.match(view.messages[1].text,/已做完/);
view.render(null,'聊天继续');assert.equal(active.text,'聊天继续');assert.equal(view.messages[1].text.includes('已做完'),true);
view.restore([]);view.upsertDevelopmentReport(task);assert.equal(view.messages.length,1);
console.log('PASS reports deduplicate, survive restore, do not overwrite streaming companion response');
