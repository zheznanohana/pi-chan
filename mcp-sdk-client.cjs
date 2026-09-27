'use strict';
// Application adapter only: protocol negotiation, framing and transports belong to the official SDK.
const {EventEmitter}=require('node:events');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {SSEClientTransport}=require('@modelcontextprotocol/sdk/client/sse.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
class SdkMcpConnection extends EventEmitter {
 constructor(serverName,config={},options={}){super();Object.assign(this,{serverName,config,options,tools:[],resources:[],prompts:[],status:'disconnected',lastError:null,transportType:config.type||(config.url?'http':'stdio')});}
 async connect(timeout=15000){
  if(this.status==='ready')return this;if(this.connecting)return this.connecting;
  this.connecting=this._connect(timeout).finally(()=>{this.connecting=null});return this.connecting;
 }
 async _connect(timeout){
  this.status='connecting';this.lastError=null;
  const c=this.config;
  try{
   this.client=new Client({name:'pi-chan-studio',version:'1.0.0'},{capabilities:{}});
   const error=e=>{this.lastError=String(e.message||e).slice(0,350);this.emit('connection-error',e)};
   this.client.onerror=error;this.client.onclose=()=>{if(this.status!=='closed')this.status='disconnected'};
   if(this.transportType==='stdio'){
    if(!c.command)throw Error('本地 MCP 缺少启动命令');
    this.transport=new StdioClientTransport({command:c.command,args:c.args||[],env:{...process.env,...c.env},cwd:c.cwd||this.options.cwd,stderr:'pipe'});
    this.transport.stderr?.on('data',()=>{});
   }else{
    const url=new URL(c.url);if(!['http:','https:'].includes(url.protocol))throw Error('MCP 地址必须是 HTTP 或 HTTPS');
    const options={requestInit:{headers:c.headers||{}}};
    if(this.transportType==='sse')this.transport=new SSEClientTransport(url,{...options,eventSourceInit:{fetch:(url,init)=>fetch(url,{...init,headers:{...init?.headers,...c.headers}})}});
    else if(['http','streamable-http','streamableHttp'].includes(this.transportType))this.transport=new StreamableHTTPClientTransport(url,options);
    else throw Error('未知 MCP 传输类型');
   }
   await this.client.connect(this.transport,{timeout});
   this.serverInfo=this.client.getServerVersion();this.capabilities=this.client.getServerCapabilities();
   this.status='ready';
   if(this.capabilities?.tools)await this.listTools();
   if(this.capabilities?.resources)await this.listResources();
   if(this.capabilities?.prompts)this.prompts=await this._pages('listPrompts','prompts');
   return this;
  }catch(e){await this.client?.close().catch(()=>{});this.status='error';this.tools=[];this.resources=[];
   this.lastError=e.code===401||/unauthorized|401/i.test(e.message)?'此服务需要授权，请配置服务提供方要求的凭据；浏览器 OAuth 尚未接入':String(e.message||e).slice(0,350);throw Error(this.lastError);
  }
 }
 async ensureConnected(){if(this.status!=='ready')await this.connect()}
 async _pages(method,key){let cursor;const items=[],seen=new Set();do{const r=await this.client[method](cursor?{cursor}:{});items.push(...(r[key]||[]));cursor=r.nextCursor;if(cursor){if(seen.has(cursor)||seen.size>=100)throw Error('MCP 分页游标异常');seen.add(cursor)}}while(cursor);return items}
 async listTools(){await this.ensureConnected();return this.tools=await this._pages('listTools','tools')}
 async listResources(){await this.ensureConnected();return this.resources=await this._pages('listResources','resources')}
 getTool(name){return this.tools.find(t=>t.name===name)||null}
 getResource(uri){return this.resources.find(r=>r.uri===uri)||null}
 async callTool(name,args={},timeout=30000){await this.ensureConnected();return this.client.callTool({name,arguments:args},undefined,{timeout})}
 async readResource(uri,timeout=30000){await this.ensureConnected();return this.client.readResource({uri},{timeout})}
 async readResourceText(uri,timeout){const r=await this.readResource(uri,timeout);return(r.contents||[]).map(x=>x.text??(x.blob?Buffer.from(x.blob,'base64').toString('utf8'):'')).join('\n')}
 async close(){this.status='closed';await this.client?.close();this.tools=[];this.resources=[]}
}
module.exports={SdkMcpConnection};
