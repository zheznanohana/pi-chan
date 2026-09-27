const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {Server}=require('@modelcontextprotocol/sdk/server/index.js');
const {StreamableHTTPServerTransport}=require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
const {SdkMcpConnection}=require('../mcp-sdk-client.cjs');
test('official Streamable HTTP server: handshake, discovery, real call and close',async t=>{
 const server=new Server({name:'http-fixture',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}));
 server.setRequestHandler(CallToolRequestSchema,r=>({content:[{type:'text',text:r.params.arguments.text}]}));
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>require('node:crypto').randomUUID()});await server.connect(transport);
 const host=http.createServer((req,res)=>transport.handleRequest(req,res));await new Promise(r=>host.listen(0,'127.0.0.1',r));
 const client=new SdkMcpConnection('http',{url:`http://127.0.0.1:${host.address().port}/mcp`});
 try{await client.connect();assert.equal(client.status,'ready');assert.equal(client.tools[0].name,'echo');assert.equal((await client.callTool('echo',{text:'connected'})).content[0].text,'connected');}
 finally{await client.close();await server.close();host.closeAllConnections();await new Promise(r=>host.close(r));}
});
