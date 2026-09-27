const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Node{constructor(){this.children=[];}append(...nodes){this.children.push(...nodes)}replaceChildren(...nodes){this.children=nodes}}
const panel=new Node(),handlers={};let payload={tasks:[]},timer;
vm.runInNewContext(fs.readFileSync(require.resolve('../task-runtime.js'),'utf8'),{
 document:{querySelector:()=>panel,createElement:()=>new Node(),addEventListener(){}},
 window:{addEventListener:(name,fn)=>handlers[name]=fn},fetch:async()=>({ok:true,json:async()=>payload}),
 setInterval:fn=>{timer=fn;return 1},clearInterval(){},Date,Map
});
(async()=>{
 await new Promise(r=>setImmediate(r));const body=panel.children[0].children[1];assert.match(body.textContent,/暂无计划/);
 handlers['pi-runtime-event']({detail:{type:'task_schedule',payload:{task:{id:'one',title:'<script>not html</script>',harness:'development',status:'running'}}}});
 assert.equal(body.children[0].children[0].textContent,'<script>not html</script>');assert.match(body.children[0].children[1].textContent,/开发 · 执行中/);
 timer();await new Promise(r=>setImmediate(r));assert.equal(body.children.length,0);assert.match(body.textContent,/暂无计划/);
 console.log('PASS task status initial/event/plain text/deletion refresh');
})().catch(e=>{console.error(e);process.exitCode=1});
