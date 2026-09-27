#!/usr/bin/env node
/**
 * Pi-chan Dashboard Server with REAL Pi Coding Agent Harness & Live2D
 * Integrates:
 *   1. Headless Pi Coding Agent Harness (via pi --mode rpc)
 *   2. Real-time streaming events (SSE) for agent thoughts, tokens, tool calls
 *   3. Jev System One decision & guardrail testing
 *   4. High-performance static serving for Live2D Cubism & WebGL
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { JevCognitiveAgent } = require("./jev-agent");
const ttsEngine = require("./tts-engine");
const workbench = require("./integration/workbench-manager.cjs");
const { createMcpService } = require("./mcp-service.cjs");

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 31415;
const DIR = __dirname;
const skillLevels=new Map();
const skillRoutes=require('./integration/skill-routes.cjs').createSkillRoutes({getLevel:sessionId=>skillLevels.get(sessionId),query:(payload,options)=>jevAgent.query(payload,options),broadcast:broadcastEvent});
const localEmbeddings=require('./integration/local-embeddings.cjs').createLocalEmbeddings({dataDir:path.join(DIR,'data/embeddings')});
localEmbeddings.warmup().catch(()=>console.warn('[Memory] embedding pending; lexical retrieval retained'));
const memoryGraph = require('./integration/long-term-memory.cjs').createLongTermMemory({dataDir:path.join(DIR,'data/memory/graph')});
const memory = require('./memory-service.cjs').createMemoryService({dataDir:path.join(DIR,'data/memory'),allowedRoot:DIR,graphProvider:memoryGraph,semanticProvider:localEmbeddings,reranker:(query,candidates)=>jevAgent.rerankCandidates(query,candidates,{allowRemote:true})});


// Initialize Track 2: Dedicated Jev Cognitive & Decision Agent
const jevAgent = new JevCognitiveAgent();
const memoryGovernance = require('./jev-memory-manager.cjs').createJevMemoryManager({service:memory,agent:jevAgent,dataDir:path.join(DIR,'data/memory'),broadcast:event=>broadcastEvent('memory_governance',event)});
const memoryGovernanceRoutes = require('./integration/memory-governance-routes.cjs').createMemoryGovernanceRoutes({manager:memoryGovernance,checkRequest:require('./cloud-tts.cjs').checkRequest});
const memoryContext = require('./memory-context.cjs').createMemoryContext({service:memory,file:path.join(DIR,'data/memory-sessions.json'),broadcast:broadcastEvent,governance:memoryGovernance});
const memoryMaintenanceTimer=setInterval(()=>memoryGovernance.maintain({limit:10}).catch(()=>{}),60000);memoryMaintenanceTimer.unref();
const jevToolPlanner = require('./jev-tool-planner.cjs').createJevToolPlanner({query:jevAgent.apiKey?(payload,options)=>jevAgent.query(payload,options):undefined,timeoutMs:1200});
const jevRuntime = require('./jev-runtime.cjs').createJevRuntime({agent:jevAgent,broadcast:broadcastEvent});
const utteranceGate = require('./jev-utterance-gate.cjs').createUtteranceGate({
  query: (payload, options) => jevAgent.query(payload, options),
  isConfigured: () => !!jevAgent.apiKey,
  checkRequest: require('./cloud-tts.cjs').checkRequest,
  timeoutMs: 800,
});
jevAgent.init().catch(e => console.warn("[Jev Agent] Background init warning:", e.message));

// Initialize Track 3: High-Performance Streaming TTS Engine
ttsEngine.initTTS("vits-aishell3").catch(e => console.warn("[TTS Engine] Background init warning:", e.message));

// Initialize MCP (Model Context Protocol) Manager & Service
const mcpService = createMcpService({
  configPath: path.join(DIR, "data/mcp-servers.json"),
  cwd: DIR,
  broadcast: broadcastEvent
});
mcpService.init().then(results => {
  console.log("[MCP] Initialized servers:", results.map(r => `${r.name} (${r.status})`).join(", "));
}).catch(e => console.warn("[MCP] Background init warning:", e.message));

// MIME Map
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".moc3": "application/octet-stream",
  ".wasm": "application/wasm",
  ".wav": "audio/wav"
};

// Connected SSE clients
const sseClients = new Set();

function broadcastEvent(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// -----------------------------------------------------------------------------
// Pi Coding Agent Harness Manager (RPC Mode)
// -----------------------------------------------------------------------------
const {SessionStore}=require('./session-store.cjs');
const sessions=new SessionStore(process.env.SESSION_STORE_DIR||path.join(DIR,'data/pi-sessions'));
const pendingRpc=new Map();
let sessionMutation=false;
function rpc(type,fields={}){
 return new Promise((resolve,reject)=>{
  const id=require('crypto').randomUUID();
  const timeout=setTimeout(()=>{pendingRpc.delete(id);reject(new Error('Pi response timed out'));},15000);
  pendingRpc.set(id,{resolve,reject,timeout});
  try{sendToPi({id,type,...fields});}catch(e){clearTimeout(timeout);pendingRpc.delete(id);reject(e);}
 });
}
let piProcess = null;
let currentPromptSource = 'dashboard';
let agentState = {
  status: "ready", // ready | streaming | tool_executing
  model: "default",
  provider: "pi",
  jevStatus: "active"
};

const chatModels = require('./chat-model-service.cjs').createChatModelService({
  rpc, file:path.join(DIR,'data/chat-model.json'),
  acquireMutation:()=>{if(sessionMutation||agentState.status!=='ready')return false;sessionMutation=true;return true;},
  releaseMutation:()=>{sessionMutation=false;},
  onActive:active=>{if(!active)return;agentState.model=active.modelId;agentState.provider=active.provider;broadcastEvent('chat_model_changed',{active});}
});

function startPiHarness() {
  if (piProcess) return;

  console.log("🚀 [Pi Harness] Spawning Pi Coding Agent in RPC mode...");
  piProcess = spawn("pi.cmd", ["--mode", "rpc", "--continue", "--extension", path.join(__dirname,".pi/extensions/jev-tools.ts"), "--extension", path.join(__dirname,".pi/extensions/runtime-model.ts"), "--append-system-prompt", path.join(__dirname,"companion-prompt.md")], {
    shell: true,
    env: {...process.env,PI_CODING_AGENT_SESSION_DIR:sessions.dir,PICHAN_HARNESS_KIND:'chat'},
    cwd: __dirname
  });

  let buffer = "";

  piProcess.stdout.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep last incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        handlePiEvent(ev);
      } catch (err) {
        console.log("[Pi Raw]:", trimmed);
      }
    }
  });

  piProcess.stderr.on("data", chunk => {
    console.error("[Pi Stderr]:", chunk.toString().trim());
  });

  // Wait for process spawn and a real RPC state response before catalog restore.
  piProcess.once('spawn',()=>{
    rpc('get_state').then(state=>{if(agentState.status==='disconnected'&&!state.isStreaming&&!state.isCompacting)agentState.status='ready';return chatModels.restore();}).then(result=>{if(result.error)console.warn('[Chat model restore]',result.error);}).catch(e=>console.warn('[Chat model restore]',e.message));
  });

  piProcess.on("close", code => {
    console.warn(`⚠️ [Pi Harness] Process exited with code ${code}. Restarting in 2s...`);
    piProcess = null;
    for(const pending of pendingRpc.values()){clearTimeout(pending.timeout);pending.reject(new Error('Pi process disconnected'));}
    pendingRpc.clear();
    agentState.status = "disconnected";
    broadcastEvent("agent_status", agentState);
    setTimeout(startPiHarness, 2000);
  });
}

// ---- 失控保护 ----
// pi 在 RPC 模式下没有轮次上限，遇到含糊的指令（比如语音误识别出来的一句话）
// 会反复 read/edit/bash 停不下来，实际见过一轮跑到 47 次调用还在继续。
// 这里按「单轮工具调用次数」兜底，超限就自动 abort 并告诉前端原因。
const MAX_TOOLS_PER_TURN = 40;
let toolCallsThisTurn = 0;
let runawayAborted = false;

function handlePiEvent(ev) {
  if(ev.type==='response'&&pendingRpc.has(ev.id)){
    const item=pendingRpc.get(ev.id);pendingRpc.delete(ev.id);clearTimeout(item.timeout);
    if(ev.success===false)item.reject(new Error(ev.error||'Pi request failed'));else item.resolve(ev.data||{});
    return;
  }
  if(ev.type==='agent_end')broadcastEvent('sessions_changed',{});
  // Pass through all events directly to browser clients
  broadcastEvent("pi_event", { ...ev, source: currentPromptSource });

  if (ev.type === "extension_ui_request" && ev.method === "setStatus" && ev.statusKey === "jev") {
    agentState.jevStatus = ev.statusText || "active";
    broadcastEvent("agent_status", agentState);
  }

  if (ev.type === "agent_start" || ev.type === "turn_start") {
    toolCallsThisTurn = 0;
    runawayAborted = false;
    agentState.status = "streaming";
    broadcastEvent("agent_status", agentState);
  }

  if (ev.type === "tool_call_start" || ev.type === "tool_execution_start") {
    agentState.status = "tool_executing";
    broadcastEvent("agent_status", agentState);

    toolCallsThisTurn++;
    if (toolCallsThisTurn > MAX_TOOLS_PER_TURN && !runawayAborted) {
      runawayAborted = true;
      console.warn(`[Harness] 单轮工具调用已达 ${toolCallsThisTurn} 次，判定失控，自动中止`);
      try { sendToPi({ type: "abort" }); } catch (e) { /* 进程可能已退出 */ }
      broadcastEvent("runaway_abort", {
        toolCalls: toolCallsThisTurn,
        limit: MAX_TOOLS_PER_TURN,
        message: `任务已自动中止：单轮工具调用超过 ${MAX_TOOLS_PER_TURN} 次，判定为失控循环。`
      });
      agentState.status = "ready";
      broadcastEvent("agent_status", agentState);
    }
  }

  if (ev.type === "agent_end" || ev.type === "agent_settled") {
    toolCallsThisTurn = 0;
    agentState.status = "ready";
    broadcastEvent("agent_status", agentState);
  }
}

function sendToPi(obj) {
  if (!piProcess || !piProcess.stdin.writable) {
    throw new Error("Pi harness is not running");
  }
  const str = JSON.stringify(obj) + "\n";
  piProcess.stdin.write(str);
}

// -----------------------------------------------------------------------------
// HTTP Server (Static + SSE + API)
// -----------------------------------------------------------------------------
const workbenchActivity = require('./workbench-activity.cjs').createWorkbenchActivity({status:()=>workbench.status()});
const taskRunner = require('./task-runner.cjs').createTaskRunner({resolveProject:id=>memory.getProjects().find(p=>p.id===(id||'default'))});
const workbenchTaskRunner = require('./integration/workbench-task-runner.cjs').createWorkbenchTaskRunner({resolveProject:id=>memory.getProjects().find(p=>p.id===(id||'default')),ensureReady:()=>workbench.start(),url:`ws://127.0.0.1:${workbench.PORT}/ws`});
const taskOrchestrator=require('./integration/task-orchestrator.cjs').createTaskOrchestrator({runner:workbenchTaskRunner,query:(payload,options)=>jevAgent.query(payload,options),resolveProject:id=>memory.getProjects().find(p=>p.id===(id||'default')),onSession:link=>{const task=link.task;const scope=memoryContext.getScope(task.sourceSessionId);if(link.sessionId){memoryContext.bind(link.sessionId,task.projectId||scope?.projectId||'default',scope?.enabled===true&&scope.projectId===(task.projectId||scope.projectId));skillLevels.set(link.sessionId,{level:'complex',at:Date.now()});}}});
let developmentExecuting=false;
async function runDevelopmentTask(task,options){
  if(developmentExecuting)throw Object.assign(new Error('开发执行器繁忙'),{code:'DEVELOPMENT_BUSY'});
  developmentExecuting=true;
  try{return await taskOrchestrator.runTask(task,{...options,onLinked:link=>{
    if(link.sessionId&&!skillLevels.has(link.sessionId))skillLevels.set(link.sessionId,{level:'development',at:Date.now()});
    const scope=memoryContext.getScope(task.sourceSessionId);
    if(link.sessionId)memoryContext.bind(link.sessionId,task.projectId||scope?.projectId||'default',scope?.enabled===true&&scope.projectId===(task.projectId||scope.projectId));
    options?.onLinked?.(link);
  }});}finally{developmentExecuting=false;}
}
const developmentDispatch=require('./development-dispatch.cjs').createDevelopmentDispatch({
  dataDir:path.join(DIR,'data/development-dispatch'),runTask:runDevelopmentTask,
  resolveProject:id=>memory.getProjects().find(p=>p.id===id),
  resolveSourceProject:sessionId=>{try{const scopes=JSON.parse(fs.readFileSync(path.join(DIR,'data/memory-sessions.json'),'utf8'));return Object.hasOwn(scopes,sessionId)?scopes[sessionId]?.projectId:undefined;}catch(e){if(e.code==='ENOENT')return undefined;throw e;}},
  externalBusy:()=>developmentExecuting||taskScheduler.list().some(t=>t.harness==='development'&&t.workerCleanupRequired),
  checkRequest:require('./cloud-tts.cjs').checkRequest,
  onEvent:event=>{broadcastEvent('development_task',event);const task=event.task;if(['completed','failed'].includes(event.type)&&task?.sourceSessionId?.startsWith('bot-'))botAuto.reportDevelopment(task);if(event.type==='completed'&&task?.result?.text&&task.result.text.length<=4000&&memoryContext.getScope(task.sourceSessionId)?.enabled){memoryGovernance.ingest({projectId:task.projectId,sessionId:task.sourceSessionId,taskId:task.id,role:'subagent',text:task.result.text,source:'development-completed',verifiedResult:true}).catch(()=>{});}},
});
const taskScheduler = require('./scheduler-service.cjs').createScheduler({
  dataDir:path.join(DIR,'data/tasks'),
  runTask:(task,options)=>(task.harness==='development'?runDevelopmentTask:(t,o)=>taskRunner.runTask(t,o))(task,{...options,onEvent:event=>broadcastEvent('task_execution',{taskId:task.id,harness:task.harness,type:event.type,jobId:event.jobId,status:event.status,conversationId:event.conversationId,sessionId:event.sessionId,workbenchClientId:event.workbenchClientId,payload:event.payload})}),
  isBusy:harness=>harness==='chat'?(sessionMutation||agentState.status!=='ready'):(developmentExecuting||developmentDispatch.isBlocked()),
  onEvent:event=>broadcastEvent('task_schedule',event)
});
const botAuto=require('./integration/bot-auto.cjs').createBotAuto({
  dataDir:path.join(DIR,'data/bot-auto'),readServers:()=>mcpService.manager.loadConfig().mcpServers||{},broadcast:broadcastEvent,
  transcribe:require('./integration/bot-voice.cjs').transcribe,synthesize:require('./integration/bot-voice.cjs').synthesize,
  reply:require('./integration/bot-capabilities.cjs').createBotCapabilities({
    query:(payload,options)=>jevAgent.query(payload,options),
    skills:require('./integration/skill-router.cjs').createSkillRouter({catalog:require('./skill-catalog.cjs').createSkillCatalog(),query:(payload,options)=>jevAgent.query(payload,options)}),
    dispatch:input=>developmentDispatch.create(input),listTasks:()=>developmentDispatch.list(),run:task=>taskRunner.runTask(task),
    isTrusted:input=>{if(input.origin==='desktop')return true;try{const config=JSON.parse(fs.readFileSync(path.join(DIR,'data/bot-owner.json'),'utf8'));return config.server===input.channel?.server&&config.target===input.channel?.target&&config.chatType===input.channel?.chatType;}catch{return false;}},
    prepare:async(botId,text)=>{const botRoot=path.join(DIR,'data/bot-workspaces',botId);fs.mkdirSync(botRoot,{recursive:true});memory.ensureProject({id:botId,name:'共享会话项目 '+botId.slice(-8),root:botRoot});memoryContext.bind(botId,botId,true);return (await memoryContext.retrieve({sessionId:botId,query:text,candidateComplete:text.length<=4000})).text;}
  })
});
const server = http.createServer((req, res) => {
  if(workbench.proxy(req,res))return;
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  if(/^\/api\/bot-auto\/conversations\/[a-f0-9]{64}\/send$/.test(pathname)&&req.method==='POST'){(async()=>{try{require('./cloud-tts.cjs').checkRequest(req);let bytes=0,parts=[];for await(const b of req){bytes+=b.length;if(bytes>13*1024*1024)throw Error('录音过大');parts.push(b);}const input=JSON.parse(Buffer.concat(parts).toString('utf8'));const result=await botAuto.sendFromDesktop(pathname.split('/')[4],input);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'发送未完成，请检查会话绑定、输入内容或机器人权限'}));}})();return;}
  if(pathname.startsWith('/api/bot-auto/conversations')&&req.method==='GET'){try{require('./cloud-tts.cjs').checkRequest(req);const id=pathname.slice('/api/bot-auto/conversations'.length).replace(/^\//,'');const all=botAuto.conversations();const conversation=id?all.find(c=>c.id===id):null;res.writeHead(id&&!conversation?404:200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(id?{conversation}:{conversations:all.map(({messages,...c})=>({...c,messageCount:messages.length}))}));}catch{res.writeHead(403);res.end('{}');}return;}
  if(pathname==='/api/bot-auto'){
    (async()=>{try{
      require('./cloud-tts.cjs').checkRequest(req);
      let result;if(req.method==='GET')result=botAuto.status();
      else if(req.method==='POST'){
        let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>20000)throw Error('配置过大')}
        result=botAuto.configure(JSON.parse(data));
      }else{res.writeHead(405);res.end();return;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(error.status||400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}})();return;
  }
  if(pathname.startsWith('/api/skills/')){skillRoutes(req,res,parsedUrl).catch(()=>{if(!res.headersSent){res.writeHead(500);res.end('{}');}});return;}
  if(pathname.startsWith('/api/development/plan/')&&req.method==='GET'){try{require('./cloud-tts.cjs').checkRequest(req);const id=pathname.split('/').at(-1);const plan=taskOrchestrator.get(id);res.writeHead(plan?200:404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({plan}));}catch{res.writeHead(403);res.end('{}');}return;}
  if(pathname==='/api/development/tasks'||pathname.startsWith('/api/development/tasks/')){developmentDispatch.handle(req,res,parsedUrl).catch(()=>{if(!res.headersSent){res.writeHead(500);res.end();}});return;}
  if(pathname==='/api/jev/utterance'){utteranceGate.handle(req,res).catch(()=>{if(!res.headersSent&&!res.destroyed){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Semantic gate unavailable"}');}});return;}
  if(pathname.startsWith('/api/tts/')){try{require('./cloud-tts.cjs').checkRequest(req);}catch(e){res.writeHead(e.status||403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));return;}}
  if(['/api/tts/cloud/voices','/api/tts/cloud/clone','/api/tts/cloud/voices/use'].includes(pathname)){require('./cloud-voice-clone.cjs').handle(req,res,parsedUrl).catch(()=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'云音色操作失败'}));});return;}
  if(pathname==='/api/tts/cloud'){require('./cloud-tts.cjs').handle(req,res,parsedUrl).catch(()=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'云端语音配置操作失败'}));});return;}
  if(pathname==='/api/chat/models'||pathname==='/api/chat/model'){chatModels.handle(req,res,parsedUrl).catch(e=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));});return;}
  if(pathname==='/api/jev/tools'&&req.method==='POST'){
    (async()=>{try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw Error('仅支持本机访问');
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw Error('来源不匹配');
      let body='';for await(const chunk of req){body+=chunk;if(body.length>131072)throw Error('请求过大');}
      const input=JSON.parse(body);if(typeof input.text!=='string'||input.text.length>16000||!Array.isArray(input.tools)||input.tools.length>128||typeof input.sessionId!=='string'||input.sessionId.length>200)throw Error('工具判断请求无效');
      const plan=await jevToolPlanner.plan(input);
      skillLevels.set(input.sessionId,{level:plan.executionLevel||'chat',text:input.text,at:Date.now()});if(skillLevels.size>2000)skillLevels.delete(skillLevels.keys().next().value);
      broadcastEvent('jev_tools',{sessionId:input.sessionId,status:plan.status,selectedTools:plan.selectedTools,route:plan.routeUsable?plan.route:null,reason:plan.reason});
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(plan));
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}})();return;
  }
  if(pathname==='/api/tasks'||pathname.startsWith('/api/tasks/')){taskScheduler.handle(req,res,parsedUrl).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});return;}
  if(pathname==='/api/workbench/activity'&&req.method==='POST'){
    (async()=>{try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw Error('仅支持本机访问');
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw Error('来源不匹配');
      let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('请求过大');}
      workbenchActivity.update(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}})();return;
  }
  if(pathname==='/api/jev/companion'&&req.method==='GET'){
    (async()=>{const companion=await jevRuntime.profile(parsedUrl.searchParams.get('sessionId'),parsedUrl.searchParams.get('inputHash'),400);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({companion}));})();return;
  }
  if(pathname.startsWith('/api/memory/')){
    (async()=>{try{if(await memoryGovernanceRoutes(req,res,parsedUrl))return;if(await memoryContext.handle(req,res,parsedUrl))return;await memory.handleMemoryRequest(req,res,parsedUrl);}catch(error){if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'记忆服务暂时异常'}));}})();return;
  }

  if((pathname==='/api/workbench/status'&&req.method==='GET')||(pathname==='/api/workbench/start'&&req.method==='POST')){
    (async()=>{try{const result=await (req.method==='POST'?workbench.start():workbench.status());res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(error){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}})();return;
  }

  if(pathname.startsWith('/api/mcp/') || pathname === '/api/mcp'){
    (async()=>{
      try {
        const handled = await mcpService.handle(req, res, parsedUrl);
        if (!handled && !res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    })();
    return;
  }

  if (pathname === '/api/client/reload' && req.method === 'POST') {
    broadcastEvent('client_reload', { timestamp: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Client reload signal broadcasted' }));
    return;
  }

  // 1. SSE Stream
  if (pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write("\n");
    sseClients.add(res);

    // Send initial status
    res.write(`data: ${JSON.stringify({ type: "agent_status", payload: agentState })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "mcp_status", payload: mcpService.getSummary() })}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if(pathname==='/api/sessions' && req.method==='GET'){
    (async()=>{try{
      const state=await rpc('get_state');
      const items=sessions.list().map(({messages,file,...item})=>({...item,messageCount:messages.length}));
      if(state.sessionId&&!items.some(i=>i.id===state.sessionId))items.unshift({id:state.sessionId,title:'新对话',messageCount:0,updatedAt:new Date().toISOString()});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({sessions:items,activeId:state.sessionId,isStreaming:state.isStreaming}));
    }catch(e){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}})();return;
  }
  const sessionRoute=pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)(\/switch)?$/);
  if(sessionRoute&&!sessionRoute[2]&&req.method==='DELETE'){
    (async()=>{let locked=false;try{
      require('./cloud-tts.cjs').checkRequest(req);
      if(sessionMutation)throw Error('会话正在切换，请稍后重试');
      sessionMutation=true;locked=true;
      const id=sessionRoute[1],before=await rpc('get_state');
      if(before.isStreaming||before.isCompacting)throw Error('请等待当前回复结束后再删除对话');
      if(!sessions.find(id)&&before.sessionId!==id)throw Error('会话不存在');
      if(developmentDispatch.list().some(t=>t.sourceSessionId===id&&['queued','running','cancelling'].includes(t.status)))throw Error('此对话还有后台开发任务，请等任务结束后删除');
      let next=null;
      if(before.sessionId===id){const result=await rpc('new_session');if(result.cancelled)throw Error('新会话创建已取消');next=await rpc('get_state');if(next.sessionId===id)throw Error('尚未切离待删除会话');}
      const result=sessions.find(id)?sessions.remove(id):{deletedId:id,recoverable:false};
      if(next)broadcastEvent('session_changed',{id:next.sessionId,messages:[]});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...result,activeId:next?.sessionId||before.sessionId,switched:!!next,messages:next?[]:undefined}));
    }catch(e){res.writeHead(e.status||409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}finally{if(locked)sessionMutation=false;}})();return;
  }
  if((pathname==='/api/sessions'&&req.method==='POST') || (sessionRoute&&((req.method==='GET'&&!sessionRoute[2])||(req.method==='POST'&&sessionRoute[2])))){
    (async()=>{let ownsLock=false;try{
      if(req.method==='GET'){
        const item=sessions.find(sessionRoute[1]);
        const state=await rpc('get_state');
        const messages=state.sessionId===sessionRoute[1]?(await rpc('get_messages')).messages:item?.messages;
        if(!messages)throw new Error('Session not found');
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:sessionRoute[1],messages,isStreaming:!!state.isStreaming}));return;
      }
      if(sessionMutation||agentState.status!=='ready'){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'请先停止当前任务，再切换对话。'}));return;}
      sessionMutation=true;ownsLock=true;
      const before=await rpc('get_state');
      if(before.isStreaming||before.isCompacting)throw new Error('请先停止当前任务，再切换对话。');
      let result;
      if(pathname==='/api/sessions')result=await rpc('new_session');
      else{const item=sessions.find(sessionRoute[1]);if(!item)throw new Error('Session not found');result=await rpc('switch_session',{sessionPath:item.file});}
      if(result.cancelled)throw new Error('Session switch cancelled');
      const state=await rpc('get_state');
      const messages=(await rpc('get_messages')).messages;
      broadcastEvent('session_changed',{id:state.sessionId,messages});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:state.sessionId,messages}));
    }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}finally{if(ownsLock)sessionMutation=false;}})();return;
  }

  // 2. API: Send Prompt to Dual-Agent Pipeline (Jev Router -> Pi Harness)
  if (pathname === "/api/prompt" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { message, projectId='default', memoryEnabled=true } = JSON.parse(body);
        if(typeof message!=='string'||!message.trim())throw new Error('Empty message');
        if(typeof message==='string'&&/^\/model(?:\s|$)/i.test(message.trim())){
          const state=await chatModels.current();
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:true,command:'model',...state}));return;
        }
        if(sessionMutation)throw new Error("Session is switching");
        const sessionState=await rpc('get_state');
        if(sessionMutation)throw Object.assign(new Error('聊天会话或模型正在切换，请稍后重试'),{status:409});
        memoryContext.bind(sessionState.sessionId,projectId,memoryEnabled);
        
        // Run narrow typed judgments together; stale results never replace a new turn.
        jevRuntime.analyze(message,sessionState.sessionId);

        // Track 1 (Pi Coding Agent): Deep execution
        currentPromptSource = 'dashboard';
        sendToPi({ type: "prompt", message });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 2b. API: Direct Agent Message (from Pet Wake Engine / IPC)
  if (pathname === "/api/agent/message" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { message, source } = JSON.parse(body || "{}");
        if(typeof message==='string'&&/^\/model(?:\s|$)/i.test(message.trim())){
          const state=await chatModels.current();
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:true,command:'model',...state}));return;
        }
        if(sessionMutation)throw new Error("Session is switching");
        if (!message || typeof message !== 'string') throw new Error('Empty voice command');
        if (agentState.status !== 'ready') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({error:'当前任务尚未完成，请稍后再说。'})); return;
        }
        currentPromptSource = 'pet-wake';
        const sessionState=await rpc('get_state');
        if(sessionMutation)throw Object.assign(new Error('聊天会话或模型正在切换，请稍后重试'),{status:409});
        jevRuntime.analyze(message,sessionState.sessionId);
        sendToPi({type:'prompt', message});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({success:true}));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 3. API: Abort Execution
  if (pathname === "/api/abort" && req.method === "POST") {
    try {
      sendToPi({ type: "abort" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 4. API: Jev Direct Tests (Route / Check / Review) via Native Jev Agent Track
  if (pathname === "/api/jev/test" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { action, text } = JSON.parse(body);
        
        if (action === "route") {
          const route = await jevAgent.routeTask(text);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code: 0,
            output: `【Jev 智能分流】建议层级: ${route.tier} (置信度: ${(route.confidence * 100).toFixed(0)}%)\n编程/技术任务: ${route.isCoding ? '是' : '否'}\n紧急程度: ${route.urgency}`,
            data: route
          }));
          return;
        }

        if (action === "check") {
          const safety = await jevAgent.checkSafety(text, "User Prompt");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code: safety.safe ? 0 : 2,
            output: safety.safe ? `✅ [Jev 安全通过] 操作判定安全，级别: ${safety.severity}` : `🚨 [Jev 门禁拦截] 高风险操作: ${safety.verdict} (破坏性: ${safety.isDestructive ? '高' : '低'}, 泄露风险: ${safety.isExfil ? '高' : '低'})`,
            data: safety
          }));
          return;
        }

        // Fallback to CLI
        const jevProc = spawn("python", ["C:/Users/YOUR_USER/bin/jev.py", action, text], { env: process.env });
        let out = "";
        let errOut = "";
        jevProc.stdout.on("data", d => out += d);
        jevProc.stderr.on("data", d => errOut += d);
        jevProc.on("close", code => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code, output: out.trim(), error: errOut.trim() }));
        });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4b. API: Jev Emotion & Motion Director via Native Jev Agent Track
  if (pathname === "/api/jev/emotion" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { text, context } = JSON.parse(body);
        const result = await jevAgent.directEmotion(text, context);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          code: 0,
          emotion: result.emotion,
          confidence: result.confidence,
          kinematics: result.kinematics,
          rawProbs: result.rawProbs
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4c. API: Jev Agent Track Status
  if (pathname === "/api/jev/agent-status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: jevAgent.status,
      model: jevAgent.model,
      endpoint: jevAgent.endpoint,
      latencyMs: jevAgent.lastLatencyMs,
      lastError: jevAgent.lastError,
      lastSuccessAt: jevAgent.lastSuccessAt,
      reconnecting: !!jevAgent.recoveryTimer
    }));
    return;
  }

  // 4d. API: TTS Model Info
  if (pathname === "/api/tts/info" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      code: 0,
      model: ttsEngine.getModelInfo(),
      voices: ttsEngine.getAvailableVoices()
    }));
    return;
  }

  // 4e. API: TTS Synthesize (Full / Test)
  if (pathname === "/api/tts/synthesize" && req.method === "POST") {
    let body = "";
    let bodyTooLarge=false;
    req.on("data", c => {if(bodyTooLarge)return;body+=c;if(Buffer.byteLength(body)>131072){bodyTooLarge=true;res.writeHead(413,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"语音请求过大"}));}});
    req.on("end", async () => {
      if(bodyTooLarge)return;
      try {
        const { text, speed, voice, sid } = JSON.parse(body || "{}");
        const chunks = [];
        const result = await ttsEngine.synthesizeStream(text || "你好，我是派酱！", {
          speed: speed || 1.0, voice, sid,
          onChunk: chunk => chunks.push(chunk.pcmBuffer)
        });
        const outWav = path.join(audioDebugDir, `tts-${require('crypto').randomUUID()}.wav`);
        const pcm = Buffer.concat(chunks);
        const samples = new Float32Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
        fs.mkdirSync(audioDebugDir, { recursive: true });
        ttsEngine.saveWav(outWav, { samples, sampleRate: result.sampleRate });
        const stat = fs.statSync(outWav);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          code: 0,
          sampleRate: result.sampleRate,
          durationSec: result.durationSec,
          totalMs: result.totalMs,
          fileSize: stat.size,
          wavPath: outWav,
          url: "/audio-debug/" + path.basename(outWav),   // 前端要的是可访问 URL，不是文件系统路径
          voice: result.voice,
          sid: result.sid
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4f. API: TTS Voice Clone (Qwen3-TTS-12Hz-0.6B-Base)
  if (pathname === "/api/tts/clone" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { text, refAudio, refText, maxTokens } = JSON.parse(body || "{}");
        const result = ttsEngine.synthesizeClone(text, { refAudio, refText, maxTokens });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          code: 0,
          ...result
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: -1, error: err.message }));
      }
    });
    return;
  }

  // 4g. API: TTS Voice Selection
  if (pathname === "/api/tts/set-voice" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { voice, sid } = JSON.parse(body);
        const updated = ttsEngine.setActiveVoice(voice, sid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0, model: updated }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. Static Files Serving
  const filePath=require('./static-files.cjs').staticPath(DIR,pathname);
  if(!filePath){res.writeHead(404,{'Content-Type':'text/plain'});res.end('404 Not Found');return;}

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

// -----------------------------------------------------------------------------
// WebSocket Server for Audio Streaming (/ws/audio) & Streaming ASR
// -----------------------------------------------------------------------------
const asrEngine = require("./asr-engine");
const audioDebugDir = path.join(DIR, "audio-debug");
const audioWss = new WebSocketServer({ noServer: true });
const realtimeServer = require('./cloud-realtime.cjs').createRealtimeServer({
  checkRequest: require('./cloud-tts.cjs').checkRequest,
});
server.on('close', () => realtimeServer.close());
server.on('close', () => { developmentDispatch.close().catch(()=>{}); });
server.on('close', () => { mcpService.close().catch(()=>{}); });

// Pre-initialize ASR engine in background
asrEngine.initASR();

server.on("upgrade", (req, socket, head) => {
  try{require('./cloud-tts.cjs').checkRequest(req);}catch{socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  if(workbench.upgrade(req,socket,head))return;
  if(realtimeServer.upgrade(req,socket,head))return;
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (parsedUrl.pathname === "/ws/audio" || parsedUrl.pathname === "/ws/tts") {
    audioWss.handleUpgrade(req, socket, head, (ws) => {
      audioWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Helper: Stream TTS chunks to WebSocket client
async function streamTtsToClient(ws, text, speed = 1.0, voice = null, sid = null, token = ws.ttsToken) {
  if (token !== ws.ttsToken) return;
  if (!text || !text.trim() || ws.readyState !== ws.OPEN) return;
  const cleanText = text.trim();
  console.log(`[TTS] Streaming synthesis requested: "${cleanText.slice(0, 35)}..."`);

  const activeInfo = ttsEngine.getActiveVoiceInfo(voice, sid);

  ws.send(JSON.stringify({
    type: "tts_start",
    text: cleanText,
    sampleRate: activeInfo.sampleRate,
    voice: activeInfo.key,
    sid: activeInfo.sid
  }));

  let errorSent = false;
  const controller = new AbortController();
  ws.ttsAbort = controller;
  try {
    await ttsEngine.synthesizeStream(cleanText, {
      signal: controller.signal,
      speed,
      voice,
      sid,
      onStatus: (status) => {
        if(ws.readyState===ws.OPEN && token===ws.ttsToken) ws.send(JSON.stringify({type:'tts_status',phase:status.phase,voice:status.voice}));
      },
      onChunk: (chunk) => {
        if (ws.readyState !== ws.OPEN || token !== ws.ttsToken) return;
        // 1. Send binary frame with PCM
        ws.send(chunk.pcmBuffer);
        // 2. Also send metadata frame for tracking
        ws.send(JSON.stringify({
          type: "tts_chunk",
          chunkIndex: chunk.chunkIndex,
          latencyMs: chunk.latencyMs,
          firstPacketMs: chunk.firstPacketMs,
          progress: chunk.progress,
          sampleRate: chunk.sampleRate,
          samplesCount: chunk.floatSamples.length,
          voice: chunk.voice,
          sid: chunk.sid
        }));
      },
      onDone: (stat) => {
        if (ws.readyState !== ws.OPEN || token !== ws.ttsToken) return;
        ws.send(JSON.stringify({
          type: "tts_end",
          text: cleanText,
          totalMs: stat.totalMs,
          firstPacketMs: stat.firstPacketMs,
          durationSec: stat.durationSec,
          totalSamples: stat.totalSamples,
          sampleRate: stat.sampleRate,
          voice: stat.voice,
          sid: stat.sid
        }));
        console.log(`[TTS] Stream completed in ${stat.totalMs}ms (first packet: ${stat.firstPacketMs}ms, audio duration: ${stat.durationSec.toFixed(2)}s)`);
      },
      onError: (err) => {
        if (ws.readyState !== ws.OPEN || token !== ws.ttsToken) return;
        errorSent = true;
        ws.send(JSON.stringify({
          type: "tts_error",
          error: err.message
        }));
      }
    });
  } catch (err) {
    console.error("[TTS] Stream synthesis error:", err.message);
    if (!errorSent && ws.readyState === ws.OPEN && token === ws.ttsToken) {
      ws.send(JSON.stringify({ type: 'tts_error', error: err.message }));
    }
  }
}

// Helper: Generate dialogue reply from Agent
async function getAgentReply(userText) {
  const t = userText.trim();
  if (/介绍|是谁|自我介绍|对我做了介绍|做个介绍/i.test(t) ||
      /你好.*(小块|小派|最近|过得怎么样)|(小块|小派).*你好|最近过得怎么样/i.test(t) ||
      /^(你好|哈啰|嗨|早安|hello|hi)[！!，,。~？\s]*$/i.test(t)) {
    return "你好呀！我是皮酱（Pi-chan），你的桌面 AI 智能伴侣与全栈开发助手！我不仅能为你编写代码、排查 Bug、执行自动化测试与系统任务，还拥有实时 Live2D 表情互动、流式语音对话与桌面常驻伴侣能力。今天状态满格，有什么任务随时吩咐我哦！";
  } else if (/代码|编程|测试|任务/i.test(t)) {
    return "收到！相关开发任务已就绪，我随时可以为你执行验证和调优。";
  } else if (/你好|哈啰|嗨|早安/i.test(t)) {
    return "你好呀！我是皮酱（Pi-chan），你的桌面 AI 伴侣与全栈助手，很高兴见到你！";
  } else {
    return `皮酱收到你的消息：“${t}”，正在全速为你处理！`;
  }
}

audioWss.on("connection", (ws, req) => {
  console.log("[audio] client connected to /ws/audio or /ws/tts");
  if (!fs.existsSync(audioDebugDir)) {
    fs.mkdirSync(audioDebugDir, { recursive: true });
  }
  const pcmPath = path.join(audioDebugDir, "last-capture.pcm");
  const fileStream = process.env.AUDIO_DEBUG_CAPTURE === '1'
    ? fs.createWriteStream(path.join(audioDebugDir, `capture-${require('crypto').randomUUID()}.pcm`)) : null;

  let chunkCount = 0;
  let totalBytes = 0;
  let dialogueModeEnabled = false;

  // Create dedicated streaming ASR session for this connection
  let asrSession = null;
  let asrProvider = 'local';
  let asrRevision = 0;
  const createAsrSession = () => asrEngine.createSession({
      onPartial: ({ text, latencyMs }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: "asr_partial",
            text,
            latencyMs,
            totalBytes
          }));
        }
      },
      onFinal: async ({ text, latencyMs, isEndpoint }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: "asr_final",
            text,
            latencyMs,
            isEndpoint: !!isEndpoint,
            totalBytes
          }));

          // If dialogue mode is active and text is non-empty, auto-trigger Agent -> TTS loop
          if (dialogueModeEnabled && text && text.trim()) {
            console.log(`[Dialogue Loop] Triggered by ASR final: "${text}"`);
            const reply = await getAgentReply(text);
            ws.send(JSON.stringify({
              type: "dialogue_reply",
              userText: text,
              replyText: reply
            }));
            await streamTtsToClient(ws, reply);
          }
        }
      },
      onError: (err) => {
        console.error("[audio] ASR session error:", err.message);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({type:"asr_error", error:err.message, provider:asrProvider}));
      }
    }, {provider:asrProvider});
  try {
    asrSession = createAsrSession();
    ws.send(JSON.stringify({
      type: "asr_ready",
      model: asrEngine.getModelInfo(asrProvider), provider:asrProvider
    }));

    ws.send(JSON.stringify({
      type: "tts_ready",
      model: ttsEngine.getModelInfo()
    }));
  } catch (err) {
    console.error("[audio] Failed to create ASR session:", err.message);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({type:"asr_error",error:err.message,provider:asrProvider}));
  }

  let ttsQueue = Promise.resolve();
  ws.ttsToken = 0;
  ws.on("message", async (data, isBinary) => {
    // Frame type, not the first PCM byte, determines whether this is JSON.
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'asr_set_provider') {
          if (!['local','token-plan'].includes(msg.provider)) throw new Error('ASR provider无效');
          ++asrRevision;
          asrSession?.dispose(); asrSession = null;
          asrProvider = msg.provider;
          asrSession = createAsrSession();
          ws.send(JSON.stringify({type:'asr_ready',provider:asrProvider,model:asrEngine.getModelInfo(asrProvider)}));
        } else if (msg.type === "asr_reset" || msg.type === "asr_finish") {
          const revision = ++asrRevision, previous = asrSession;
          if (msg.type === 'asr_finish' && previous) await previous.finish();
          else previous?.dispose();
          // Reset/provider change/close can overtake an awaited cloud final.
          if (revision !== asrRevision || ws.readyState !== ws.OPEN) return;
          previous?.dispose();
          asrSession = null;
          asrSession = createAsrSession();
          ws.send(JSON.stringify({ type: msg.type === 'asr_finish' ? 'asr_finished' : 'asr_reset_done', provider:asrProvider }));
        } else if (msg.type === "tts_speak") {
          // Serialize per socket so different voices never interleave PCM.
          if (!msg.append) ws.ttsAbort?.abort();
          const token = msg.append ? ws.ttsToken : ++ws.ttsToken;
          ttsQueue = ttsQueue.then(() => streamTtsToClient(ws, msg.text, msg.speed, msg.voice, msg.sid, token));
          await ttsQueue;
        } else if (msg.type === "tts_cancel") {
          ++ws.ttsToken;
          ws.ttsAbort?.abort();
          // A cancelled offline clone must not hold the next live utterance hostage.
          ttsQueue = Promise.resolve();
        } else if (msg.type === "tts_set_voice") {
          ttsEngine.setActiveVoice(msg.voice, msg.sid);
          ws.send(JSON.stringify({
            type: "tts_ready",
            model: ttsEngine.getModelInfo()
          }));
        } else if (msg.type === "dialogue_query") {
          const userPrompt = msg.text || "介绍一下你自己";
          const reply = await getAgentReply(userPrompt);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: "dialogue_reply",
              userText: userPrompt,
              replyText: reply
            }));
          }
          await streamTtsToClient(ws, reply, 1.0, msg.voice, msg.sid);
        } else if (msg.type === "set_dialogue_mode") {
          dialogueModeEnabled = !!msg.enabled;
          console.log(`[Dialogue Loop] Automatic mode set to: ${dialogueModeEnabled}`);
        }
        return;
      } catch (e) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "asr_error", error: e.message }));
      }
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0) return;

    chunkCount++;
    totalBytes += buf.length;
    // 16kHz, 16-bit (2 bytes), mono -> 32000 bytes/sec
    const totalMs = Math.round((totalBytes / 32000) * 1000);
    console.log(`[audio] chunk ${chunkCount} bytes=${buf.length} totalMs=${totalMs}`);

    fileStream?.write(buf);

    // Feed to streaming ASR engine
    if (asrSession) {
      try { asrSession.feedPCM(buf); }
      catch (err) { ws.send(JSON.stringify({ type: "asr_error", error: err.message })); }
    }
  });

  ws.on("close", () => {
    ++asrRevision;
    ++ws.ttsToken;
    ws.ttsAbort?.abort();
    fileStream?.end();
    if (asrSession) {
      asrSession.dispose();
      asrSession = null;
    }
    const totalMs = Math.round((totalBytes / 32000) * 1000);
    console.log(`[audio] client disconnected. total chunks: ${chunkCount}, total bytes: ${totalBytes}, total duration: ${(totalMs / 1000).toFixed(2)}s (${totalMs}ms)`);
  });

  ws.on("error", (err) => {
    console.error("[audio] ws error:", err.message);
    fileStream?.end();
    if (asrSession) {
      asrSession.dispose();
      asrSession = null;
    }
  });
});

// Start Server and Pi Harness
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n✨ [Pi-chan Live2D & Harness Dashboard]`);
  console.log(`🌐 Web Interface: http://127.0.0.1:${PORT}`);
  console.log(`🤖 Pi Harness: Active (RPC Mode + Jev Guardrails)\n`);
  if (process.env.PI_DISABLE_HARNESS !== '1') startPiHarness();
});
