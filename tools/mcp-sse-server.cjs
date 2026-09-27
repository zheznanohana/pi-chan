'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const url = require('node:url');

const activeSessions = new Map();

function parseArgs() {
  let port = 0;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.slice(7), 10);
    }
  }
  if (!port && process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
  }
  return { port };
}

function handleJsonRpc(reqMsg, sessionId) {
  const { id, method, params } = reqMsg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true }
        },
        serverInfo: {
          name: 'mcp-sse-server',
          version: '1.0.0'
        }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return null; // Notification, no reply
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'sse_echo',
            description: '通过 SSE 协议回显测试内容',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: '待回显的文本' }
              },
              required: ['message']
            }
          },
          {
            name: 'sse_uppercase',
            description: '将输入文本转为大写',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '输入文本' }
              },
              required: ['text']
            }
          }
        ]
      }
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'sse_echo') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `[SSE] ${args.message !== undefined ? args.message : ''}`
            }
          ],
          isError: false
        }
      };
    }

    if (name === 'sse_uppercase') {
      const txt = String(args.text || '');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: txt.toUpperCase()
            }
          ],
          isError: false
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Tool not found: ${name}`
      }
    };
  }

  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          {
            uri: 'sse://welcome',
            name: 'SSE Welcome Doc',
            description: '欢迎使用 MCP SSE 传输协议',
            mimeType: 'text/plain'
          },
          {
            uri: 'sse://metrics',
            name: 'SSE Server Metrics',
            description: 'SSE 服务运行状态及活跃会话计数',
            mimeType: 'application/json'
          }
        ]
      }
    };
  }

  if (method === 'resources/read') {
    const uri = params?.uri;
    if (uri === 'sse://welcome') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'Welcome to MCP SSE Server on Pi-Chan Dashboard!'
            }
          ]
        }
      };
    }

    if (uri === 'sse://metrics') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                activeSessions: activeSessions.size,
                uptimeSec: Math.floor(process.uptime()),
                transport: 'sse'
              })
            }
          ]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32602,
        message: `Resource not found: ${uri}`
      }
    };
  }

  if (id !== undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not supported: ${method}`
      }
    };
  }

  return null;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (pathname === '/health' || pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // SSE stream endpoint
  if (req.method === 'GET' && pathname === '/sse') {
    const sessionId = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });

    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    activeSessions.set(sessionId, res);

    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      activeSessions.delete(sessionId);
    });
    return;
  }

  // POST messages endpoint
  if (req.method === 'POST' && pathname === '/messages') {
    const sessionId = parsed.query?.sessionId;
    const sseRes = sessionId ? activeSessions.get(sessionId) : null;

    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      let rpcReq;
      try {
        rpcReq = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const rpcRes = handleJsonRpc(rpcReq, sessionId);

      if (rpcRes && sseRes && !sseRes.writableEnded) {
        // Send response via SSE message event
        sseRes.write(`event: message\ndata: ${JSON.stringify(rpcRes)}\n\n`);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));
      } else if (rpcRes) {
        // Fallback: direct HTTP response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcRes));
      } else {
        res.writeHead(204);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const { port } = parseArgs();
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`[mcp-sse-server] listening on http://127.0.0.1:${actualPort}`);
  process.stdout.write(`READY_PORT=${actualPort}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
