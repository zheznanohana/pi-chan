// Progressive disclosure around existing live DOM. No replacement telemetry or
// duplicate socket: producers retain their original nodes and event listeners.
const panel=document.querySelector('.runtime-panel');
const make=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
if(panel){
 const header=panel.querySelector('header strong');if(header)header.textContent='此刻';
 const presence=make('div',undefined,'status-presence');presence.setAttribute('role','status');presence.setAttribute('aria-live','polite');
 const line=make('p','小派待机中'),subline=make('small','');presence.append(line,subline);panel.querySelector('header')?.after(presence);
 const disclosures=[];
 function fold(title,nodes,read){
  const details=make('details',undefined,'runtime-disclosure'),summary=make('summary'),label=make('span',title),count=make('small','', 'runtime-section-count'),body=make('div',undefined,'runtime-disclosure-content');
  summary.append(label,count);details.append(summary,body);for(const node of nodes)if(node)body.append(node);panel.append(details);
  const entry={details,count,read,userTouched:false};summary.addEventListener('click',()=>{entry.userTouched=true;});disclosures.push(entry);return details;
 }
 const originalRows=[...panel.querySelectorAll(':scope > .runtime-row')];
 const diagnostic=fold('连接与音频',originalRows.concat(panel.querySelector('#runtimeDetail')||[]),()=>({text:'详情',active:false}));
 const activity=panel.querySelector('#agentActivity');panel.querySelector(':scope > .activity-heading')?.remove();
 if(activity)fold('工具与子 Agent',[activity],()=>{
  const items=[...activity.querySelectorAll('.agent-activity')],running=items.filter(node=>/运行中/.test(node.querySelector('small')?.textContent||''));
  return {text:running.length?`${running.length} 项进行中`:items.length?`${items.length} 项已记录`:'暂无活动',active:running.length>0};
 });
 const adopted=new WeakSet();
 function adopt(){
  for(const node of [...panel.children]){
   if(adopted.has(node)||(!node.matches('.runtime-details')&&!node.matches('.workbench-status')))continue;
   adopted.add(node);const heading=node.querySelector('h3'),title=heading?.textContent||'工作台连接';if(heading)heading.hidden=true;
   fold(title,[node],()=>{
    const text=node.textContent.replace(title,'').trim();
    const active=/修改中|运行中|执行中|排队中|正在判断|正在执行|正在取消/.test(text);
    const files=node.querySelectorAll('.runtime-file').length;
    let summary=files?`${files} 项${active?'进行中':''}`:text;
    if(/^(暂无|等待|未引用|工作台尚未|开发工作台尚未)/.test(text))summary='暂无活动';
    if(title==='Jev 判断'&&/^(jev:|active|shadow)/i.test(text))summary='待命';
    return {text:summary.slice(0,52),active};
   });
  }
  // Low-level diagnostics remain last, not the leading visual focus.
  if(panel.lastElementChild!==diagnostic)panel.append(diagnostic);
 }
 const get=id=>document.getElementById(id)?.textContent.trim()||'';
 function set(node,value){if(node.textContent!==value)node.textContent=value;}
 function update(){
  adopt();
  const input=get('runtimeInput'),output=get('runtimeOutput'),task=get('runtimeTask'),connection=get('runtimeConnection');
  const speaking=/播报|播放/.test(output)&&!(/待机|停止|关闭/.test(output));
  const listening=/倾听|聆听|录音|识别中/.test(input);
  const preparing=/生成|加载|预热/.test(output);
  const working=/执行|生成|思考|运行/.test(task)&&!(/完成|待机|结束/.test(task));
  set(line,speaking?'正在和你说话':preparing?'正在准备语音':working?'Pi 正在处理你的请求':listening?'正在听你说':'小派待机中');
  const details=[];if(speaking&&listening)details.push('你可以随时打断');if(connection&&connection!=='已连接')details.push(connection);if(!speaking&&!preparing&&!working&&!listening)details.push('聊一聊，或从一个想法开始');set(subline,details.join(' · '));
  for(const entry of disclosures){const state=entry.read();set(entry.count,state.text);entry.details.dataset.active=String(state.active);if(!entry.userTouched&&entry.details.open!==state.active)entry.details.open=state.active;}
 }
 let queued=false;const observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;update();});});
 update();observer.observe(panel,{subtree:true,childList:true,characterData:true});
 window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
}

// Keep only useful conversation controls visible; move diagnostic controls rather
// than recreating them, so voice/controller cached references keep working.
const composer=document.querySelector('.dialog-box');
if(composer){
 const details=make('details',undefined,'composer-diagnostics'),summary=make('summary','声音与角色详情'),body=make('div',undefined,'composer-diagnostics-content');details.append(summary,body);
 for(const selector of ['.dialog-header','#toolChipsContainer','#voiceLatencyPill','.voice-meter-wrapper','.voice-status-right']){const node=composer.querySelector(selector);if(node)body.append(node);}
 const extras=composer.querySelector('.composer-extras');if(extras)body.append(extras);
 composer.append(details);
 const input=document.getElementById('promptInput');if(input)input.placeholder='说点什么，或一起做点事…';
}
