/* Keep the single Markdown reader clear of dynamic microphone/composer height.
 * No second renderer, copied messages, synthetic events or voice ownership. */
const composer = document.querySelector('.galgame-dialog-wrapper');
const reader = document.querySelector('.background-reading');
if (composer && reader) {
  const resize = () => document.documentElement.style.setProperty('--composer-height', `${Math.ceil(composer.getBoundingClientRect().height)}px`);
  const observer = new ResizeObserver(resize);
  observer.observe(composer);
  resize();
  window.addEventListener('pagehide', () => observer.disconnect(), { once:true });
}

/** One DOM node + Markdown renderer per message. The outer reader owns scrolling. */
export class ConversationMarkdownRenderer {
  constructor({targetEl, Renderer}) {
    this.targetEl=targetEl; this.Renderer=Renderer; this.messages=[]; this.active=null; this.pendingUser=null;
  }
  _follow(action) {
    const host=this.targetEl, top=host.scrollTop, follow=host.dataset.followOutput!=='false';
    action(); host.scrollTop=follow?host.scrollHeight:top;
  }
  _append(role,text='') {
    const article=document.createElement('article'); article.className='history-message'; article.dataset.role=role;
    const label=document.createElement('small');label.className='history-message-role';label.textContent=role==='user'?'你':'小派';
    const content=document.createElement('div');article.append(label,content);
    const renderer=new this.Renderer({targetEl:content});
    const apply=renderer._applyRender.bind(renderer);
    renderer._applyRender=()=>{if(article.parentNode===this.targetEl)this._follow(apply);};
    const message={role,text,article,content,renderer};this.messages.push(message);
    this._follow(()=>this.targetEl.append(article));
    if(text)renderer.render(content,text,true);
    return message;
  }
  upsertDevelopmentReport(task) {
    if(!task?.id)return;
    const statuses={completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'执行中断'};
    if(!statuses[task.status])return;
    const text=`**开发任务${statuses[task.status]}：${task.title||'开发任务'}**\n\n${task.result?.text||task.error||task.lastError||'任务已结束，详情可在开发工作台查看。'}`;
    let message=this.messages.find(m=>m.taskId===task.id);
    if(!message){message=this._append('assistant');message.taskId=task.id;message.article.dataset.taskId=task.id;
      const open=document.createElement('button');open.type='button';open.textContent='查看开发过程';open.onclick=()=>window.piWorkbench?.inspectTask(task);message.article.append(open);
    }
    if(message.text!==text){message.text=text;message.renderer.render(message.content,text,true);}
  }
  appendUser(text,{echo=false}={}) {
    if(echo && this.pendingUser===text){this.pendingUser=null;return;}
    this.beginTurn(); this._append('user',text); this.pendingUser=echo?null:text;
  }
  beginTurn() { this.active?.renderer.flush(); this.active=null; }
  reset() { this.beginTurn(); }
  render(_target,text,immediate=false) {
    if(!this.active)this.active=this._append('assistant');
    this.active.text=String(text||'');this.active.renderer.render(this.active.content,this.active.text,immediate);
  }
  flush() { this.active?.renderer.flush(); }
  restore(messages) {
    for(const m of this.messages){if(m.renderer.rafId){cancelAnimationFrame(m.renderer.rafId);m.renderer.rafId=null;}}
    this.messages=[];this.active=null;this.pendingUser=null;this.targetEl.replaceChildren();
    this.targetEl.dataset.followOutput='true';
    for(const m of messages||[]){
      if(!['user','assistant'].includes(m.role))continue;
      const text=typeof m.content==='string'?m.content:(m.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('');
      if(text)this._append(m.role,text);
    }
    this.targetEl.scrollTop=this.targetEl.scrollHeight;
  }
}
