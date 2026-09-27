// Cross-harness schedule status lives beside file/Jev telemetry, not in chat history.
const panel=document.querySelector('.runtime-panel');
const section=document.createElement('section');section.className='runtime-details';
const heading=document.createElement('h3');heading.textContent='定时与循环任务';
const body=document.createElement('div');section.append(heading,body);panel?.append(section);
const tasks=new Map();let revision=0;
const labels={running:'执行中',cancelling:'正在取消',paused:'已暂停',idle:'等待计划',error:'执行失败',interrupted:'意外中断'};
function render(){
 body.replaceChildren();
 if(!tasks.size){body.textContent='暂无计划 · 顶部任务板可添加';return;}
 for(const task of [...tasks.values()].sort((a,b)=>(b.status==='running')-(a.status==='running')).slice(0,6)){
  const row=document.createElement('div');row.className='runtime-file';
  const title=document.createElement('span');title.textContent=task.title;
  const status=document.createElement('small');status.textContent=`${task.harness==='development'?'开发':'陪伴'} · ${labels[task.status]||task.status}`;
  row.title=task.nextRunAt?'下次：'+new Date(task.nextRunAt).toLocaleString():task.lastError||'';
  row.append(title,status);body.append(row);
 }
}
async function refresh(){const version=revision;try{const response=await fetch('/api/tasks');if(!response.ok)throw Error();const data=await response.json();if(version!==revision)return;tasks.clear();for(const task of data.tasks||[])tasks.set(task.id,task);render();}catch{if(!tasks.size)body.textContent='任务服务暂未连接';}}
window.addEventListener('pi-runtime-event',({detail})=>{
 if(detail?.type!=='task_schedule')return;
 revision++;const event=detail.payload;
 if(event?.task)tasks.set(event.task.id,event.task);
 render();
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
const timer=setInterval(()=>{if(!document.hidden)refresh();},15000);
window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
refresh();
