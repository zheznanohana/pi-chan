'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { McpManager, McpError } = require('./mcp-client.cjs');

/**
 * Helper to safely read JSON request body
 */
function readJsonBody(req, maxSize = 262144) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxSize) {
        tooLarge = true;
        reject(Object.assign(new Error('Request body exceeds size limit'), { status: 413 }));
      }
    });

    req.on('end', () => {
      if (tooLarge) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (err) {
        reject(Object.assign(new Error(`Invalid JSON: ${err.message}`), { status: 400 }));
      }
    });

    req.on('error', err => reject(err));
  });
}

function sendJson(res, statusCode, data) {
  if (res.headersSent) return;
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

/**
 * Validate origin / remote address for local safety
 */
function checkLocalSafety(req) {
  const remoteAddr = req.socket?.remoteAddress || '';
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);
  if (!isLoopback) {
    throw Object.assign(new Error('MCP API only accessible locally'), { status: 403 });
  }

  if (req.headers.origin && req.headers.host) {
    try {
      const originHost = new URL(req.headers.origin).host;
      if (originHost !== req.headers.host) {
        throw Object.assign(new Error('Origin host mismatch'), { status: 403 });
      }
    } catch (e) {
      if (e.status) throw e;
      throw Object.assign(new Error('Invalid Origin header'), { status: 400 });
    }
  }
}

/**
 * MCP Service Factory
 */
function createMcpService(options = {}) {
  const configPath = options.configPath || path.join(__dirname, 'data/mcp-servers.json');
  const cwd = options.cwd || __dirname;
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => {};

  const manager = new McpManager({ configPath, cwd });

  function getSummary() {
    const servers = manager.listServers();
    const tools = manager.getAllTools();
    const resources = manager.getAllResources();
    const readyServers = servers.filter(s => s.status === 'ready');
    
    return {
      status: readyServers.length > 0 ? 'ready' : (servers.length > 0 ? 'degraded' : 'idle'),
      serversCount: servers.length,
      readyServersCount: readyServers.length,
      toolsCount: tools.length,
      resourcesCount: resources.length,
      configPath,
      servers: servers.map(s => ({
        name: s.name,
        type: s.type,
        status: s.status,
        toolsCount: s.toolsCount,
        resourcesCount: s.resourcesCount,
        serverInfo: s.serverInfo,
        lastError: s.lastError
      }))
    };
  }

  async function init() {
    const results = await manager.init({ timeoutMs: options.timeoutMs || 15000 });
    broadcast('mcp_status', getSummary());
    return results;
  }

  async function reload() {
    const summary = await manager.reload({ timeoutMs: options.timeoutMs || 15000 });
    const currentSummary = getSummary();
    broadcast('mcp_status', currentSummary);
    broadcast('mcp_reloaded', { summary, currentSummary });
    return { summary, currentSummary };
  }

  async function handle(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return true;
    }

    checkLocalSafety(req);

    if(pathname==='/api/mcp/presets'&&method==='GET'){sendJson(res,200,{presets:require('./mcp-presets.cjs').getMcpPresets(cwd)});return true;}

    // Import standard client configuration without returning stored credentials.
    if(pathname==='/api/mcp/config'&&method==='POST'){
      const input=await readJsonBody(req);
      if(input.confirmed!==true)throw Object.assign(Error('请确认允许启动所导入的本地服务'),{status:400});
      const servers=input.config?.mcpServers;
      if(!servers||typeof servers!=='object'||Array.isArray(servers)||Object.keys(servers).length>50)throw Object.assign(Error('需要标准 mcpServers 配置（最多 50 项）'),{status:400});
      for(const [name,c] of Object.entries(servers)){
        if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(name)||!c||typeof c!=='object')throw Object.assign(Error('服务名称或配置无效'),{status:400});
        if(c.url){const u=new URL(c.url);if(!['http:','https:'].includes(u.protocol))throw Error('地址协议无效');}
        else if(typeof c.command!=='string'||!c.command.trim())throw Error('本地服务缺少 command');
        if(c.args&&(!Array.isArray(c.args)||c.args.some(a=>typeof a!=='string')))throw Error('args 必须是字符串数组');
        for(const key of ['env','headers'])if(c[key]&&(typeof c[key]!=='object'||Array.isArray(c[key])||Object.values(c[key]).some(v=>typeof v!=='string')))throw Error(key+' 必须为字符串映射');
      }
      if(/YOUR_[A-Z_]+|<your_[^>]+>/i.test(JSON.stringify(servers)))throw Object.assign(Error('请先填写预设中的账号凭据占位项，再保存连接'),{status:400});
      const old=manager.loadConfig();const merged={...old,mcpServers:{...old.mcpServers,...servers}};
      fs.mkdirSync(path.dirname(configPath),{recursive:true});const tmp=configPath+'.tmp';
      fs.writeFileSync(tmp,JSON.stringify(merged,null,2),{mode:0o600});fs.renameSync(tmp,configPath);
      await manager.reload();broadcast('mcp_status',getSummary());sendJson(res,200,{ok:true,...getSummary()});return true;
    }

    // 1. GET /api/mcp/status - Summary status
    if (pathname === '/api/mcp/status' && method === 'GET') {
      sendJson(res, 200, {
        code: 0,
        ...getSummary()
      });
      return true;
    }

    // 2. GET /api/mcp/servers - Server list with full details
    if (pathname === '/api/mcp/servers' && method === 'GET') {
      const servers = manager.listServers();
      sendJson(res, 200, {
        code: 0,
        servers
      });
      return true;
    }

    // 3. GET /api/mcp/tools - Discovered tools (supports ?server=xxx filter)
    if (pathname === '/api/mcp/tools' && method === 'GET') {
      const filterServer = parsedUrl.searchParams.get('server');
      let tools = manager.getAllTools();
      if (filterServer) {
        tools = tools.filter(t => t.server === filterServer);
      }
      sendJson(res, 200, {
        code: 0,
        count: tools.length,
        tools
      });
      return true;
    }

    // 4. GET /api/mcp/resources - Discovered resources (supports ?server=xxx filter)
    if (pathname === '/api/mcp/resources' && method === 'GET') {
      const filterServer = parsedUrl.searchParams.get('server');
      let resources = manager.getAllResources();
      if (filterServer) {
        resources = resources.filter(r => r.server === filterServer);
      }
      sendJson(res, 200, {
        code: 0,
        count: resources.length,
        resources
      });
      return true;
    }

    // 5. GET /api/mcp/resources/read - Read resource content
    if (pathname === '/api/mcp/resources/read' && method === 'GET') {
      const server = parsedUrl.searchParams.get('server');
      const uri = parsedUrl.searchParams.get('uri');
      const target = parsedUrl.searchParams.get('target');

      try {
        let result;
        if (server && uri) {
          result = await manager.readResource(server, uri);
        } else if (target) {
          result = await manager.readPrefixedResource(target);
        } else {
          sendJson(res, 400, { code: 400, error: 'Missing parameters: provide "server" & "uri", or "target"' });
          return true;
        }

        sendJson(res, 200, {
          code: 0,
          result
        });
      } catch (err) {
        sendJson(res, err.code && err.code < 0 ? 400 : 500, {
          code: err.code || -32603,
          error: err.message
        });
      }
      return true;
    }

    // 6. POST /api/mcp/reload - Hot reload configurations
    if (pathname === '/api/mcp/reload' && method === 'POST') {
      try {
        const reloadResult = await reload();
        sendJson(res, 200, {
          code: 0,
          message: 'MCP configuration reloaded successfully',
          ...reloadResult
        });
      } catch (err) {
        sendJson(res, 500, {
          code: -32000,
          error: `Reload failed: ${err.message}`
        });
      }
      return true;
    }

    // 7. POST /api/mcp/tools/call - Tool invocation & test
    if (pathname === '/api/mcp/tools/call' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, e.status || 400, { code: e.status || 400, error: e.message });
        return true;
      }

      const { server, name, fullName, arguments: toolArgs = {} } = body;
      const startTime = Date.now();

      try {
        let callRes;
        let resolvedServer = server;
        let resolvedTool = name;

        if (fullName) {
          const parts = fullName.split('__');
          if (parts.length >= 2) {
            resolvedServer = parts[0];
            resolvedTool = parts.slice(1).join('__');
          }
          callRes = await manager.callPrefixedTool(fullName, toolArgs);
        } else if (server && name) {
          callRes = await manager.callTool(server, name, toolArgs);
        } else {
          sendJson(res, 400, {
            code: 400,
            error: 'Missing tool identifier: provide "server" and "name", or "fullName"'
          });
          return true;
        }

        const durationMs = Date.now() - startTime;
        sendJson(res, 200, {
          code: 0,
          server: resolvedServer,
          tool: resolvedTool,
          durationMs,
          result: callRes
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        sendJson(res, 200, {
          code: err.code || -32603,
          error: err.message,
          server,
          tool: name || fullName,
          durationMs,
          isError: true
        });
      }
      return true;
    }

    // 8. POST /api/mcp/servers/restart - Restart a specific server
    if (pathname === '/api/mcp/servers/restart' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, e.status || 400, { code: e.status || 400, error: e.message });
        return true;
      }

      const serverName = body.server || body.name;
      if (!serverName) {
        sendJson(res, 400, { code: 400, error: 'Missing "server" or "name" in body' });
        return true;
      }

      const client = manager.getServer(serverName);
      if (!client) {
        sendJson(res, 404, { code: 404, error: `MCP server "${serverName}" not found` });
        return true;
      }

      try {
        await client.close();
        await client.connect(15000);
        const currentSummary = getSummary();
        broadcast('mcp_status', currentSummary);
        sendJson(res, 200, {
          code: 0,
          message: `MCP server "${serverName}" restarted successfully`,
          server: {
            name: client.serverName,
            status: client.status,
            toolsCount: client.tools.length,
            resourcesCount: client.resources.length
          }
        });
      } catch (err) {
        sendJson(res, 500, {
          code: -32001,
          error: `Failed to restart server "${serverName}": ${err.message}`
        });
      }
      return true;
    }

    return false;
  }

  return {
    manager,
    init,
    reload,
    getSummary,
    handle,
    close: () => manager.closeAll()
  };
}

module.exports = {
  createMcpService
};
