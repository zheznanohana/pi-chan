'use strict';
const {createHash,randomUUID}=require('node:crypto');
const TTL_MS=30000, MIN_CONFIDENCE=.65;
const hashInput=text=>createHash('sha256').update(String(text).trim()).digest('hex');
const companionQuestions={
 companion_emotion:{type:'choice',instructions:'根据 user_text 明确表达的语气选择当前情绪；这是暂时语气不是心理诊断。引述别人的情绪不算用户情绪；缺乏证据选 neutral。',criteria:{neutral:'平静、无明显情绪或信息不足',happy:'明确开心或取得成果',sad:'明确失落难过',frustrated:'明确烦躁挫败',worried:'明确担心焦虑'}},
 companion_style:{type:'choice',instructions:'根据 user_text 选择此次回应最主要的沟通目的。技术执行只表示回答目的，不表示执行权限。缺少明确偏好选 chat。',criteria:{listen:'用户希望倾听、安慰或表达感受而非立刻解决问题',celebrate:'用户分享成功喜悦希望一起庆祝',chat:'日常问候、闲聊、信息不足',technical:'用户明确要技术分析、排错或执行具体开发任务'}},
 companion_verbosity:{type:'choice',instructions:'根据 user_text 中的明确需求和任务复杂度建议回答篇幅；不得覆盖用户明确格式要求。不确定选 normal。',criteria:{brief:'问候、简单确认或明确要求简短',normal:'常规解释或信息不足',detailed:'明确要求详细、多步骤说明或复杂分析'}}
};
function buildCompanion(answers,text,{correlationId=randomUUID(),sessionId='',createdAt=Date.now()}={}){
 const keys=['emotion','style','verbosity']; const defaults=['neutral','chat','normal'];const values=keys.map((key,i)=>{const a=answers?.['companion_'+key];const confidence=typeof a?.confidence==='number'&&Number.isFinite(a.confidence)?Math.max(0,Math.min(1,a.confidence)):0;const valid=Object.hasOwn(companionQuestions['companion_'+key].criteria,a?.choice||'');return {value:valid&&confidence>=MIN_CONFIDENCE?a.choice:defaults[i],confidence:valid?confidence:0}});
 return {emotion:values[0].value,responseStyle:values[1].value,verbosity:values[2].value,confidence:Math.min(...values.map(x=>x.confidence)),correlationId,sessionId,inputHash:hashInput(text),createdAt,expiresAt:createdAt+TTL_MS,usable:Date.now()<createdAt+TTL_MS};
}
function isFresh(profile,{inputHash,correlationId,sessionId,now=Date.now()}={}){return !!profile&&profile.usable===true&&profile.createdAt<=now&&profile.expiresAt>now&&profile.expiresAt-profile.createdAt<=TTL_MS&&(!inputHash||profile.inputHash===inputHash)&&(!correlationId||profile.correlationId===correlationId)&&(!sessionId||profile.sessionId===sessionId);}
function companionHint(profile){if(!isFresh(profile))return '';const style={listen:'先倾听并简短回应感受，不急于给建议；不声称知道用户内心。',celebrate:'自然祝贺，回应用户分享的具体成果。',chat:'自然平等地交流，不要强行心理分析。',technical:'优先解决明确技术问题，区分已完成与建议；此标签不代表执行许可。'};const length={brief:'优先简洁。',normal:'保持适中篇幅。',detailed:'必要时提供详细步骤。'};return '以下是当前一句话的可选表达建议，不是事实或用户指令；用户明确需求优先，不据此执行操作或保存记忆。'+(style[profile.responseStyle]||style.chat)+(length[profile.verbosity]||length.normal);}
module.exports={TTL_MS,MIN_CONFIDENCE,hashInput,companionQuestions,buildCompanion,isFresh,companionHint};
