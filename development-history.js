// Companion history is chat-only. Workbench conversations stay in their native view.
const sidebar=document.querySelector('.history-sidebar');
const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='/conversation-history.css';document.head.append(stylesheet);
const chat=document.createElement('section');chat.id='chatHistoryPanel';chat.className='history-section';chat.setAttribute('aria-label','聊天历史');
for(const id of ['newConversationBtn','historyList','historyNotice']){const node=document.getElementById(id);if(node)chat.append(node)}
sidebar.querySelector('.history-project')?.remove();sidebar.querySelector('.history-title strong').textContent='聊天历史';sidebar.append(chat);
let current='chat',connected=false,conversations=[],activeId=null,pending=null;
const frame=()=>document.querySelector('.workbench-home iframe');
function send(command,conversationId){const target=frame();if(!target?.contentWindow)return false;target.contentWindow.postMessage({source:'pichan-history',command,conversationId,requestId:crypto.randomUUID()},location.origin);return true}
async function navigate(id){if(!conversations.some(c=>c.id===id))throw Error('开发会话已不在当前列表');await window.piWorkbench?.open();if(!connected)return false;pending=id;send('select',id);return true}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame()?.contentWindow||event.data?.source!=='pichan-workbench')return;const{event:kind,detail={}}=event.data;
 if(kind==='connection'){connected=!!detail.connected;if(connected)send('refresh')}
 if(kind==='conversations'&&Array.isArray(detail.conversations)){if(!detail.cached)connected=true;conversations=detail.conversations;activeId=detail.activeId??activeId}
 if(kind==='status'&&detail.conversationId)activeId=detail.conversationId;
 if(kind==='history-selected'&&detail.conversationId===pending){activeId=detail.conversationId;pending=null}
 if(kind==='history-error')pending=null;
});
window.piHistory={getMode:()=>current,show:kind=>{current=kind==='development'?'development':'chat';},refreshDevelopment:()=>send('refresh'),navigateDevelopment:navigate,getDevelopmentConversations:()=>conversations.filter(c=>!c.isSubagent).map(c=>({...c})),getSelectedDevelopment:()=>conversations.find(c=>c.id===activeId)||null};
