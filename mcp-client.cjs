'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { URL } = require('node:url');

/**
 * Custom error classes for MCP operations
 */
class McpError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

class McpTimeoutError extends McpError {
  constructor(message) {
    super(message, -32000);
    this.name = 'McpTimeoutError';
  }
}

class McpConnectionError extends McpError {
  constructor(message, code = -32001) {
    super(message, code);
    this.name = 'McpConnectionError';
  }
}

/**
 * Base Transport class for JSON-RPC 2.0 communication
 */
class McpBaseTransport extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
  }

  async connect() {
    throw new Error('Not implemented');
  }

  async send(msg) {
    throw new Error('Not implemented');
  }

  async close() {
    throw new Error('Not implemented');
  }
}

/**
 * Stdio Transport: manages child process stdin/stdout NDJSON framing
 */
class McpStdioTransport extends McpBaseTransport {
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    this.serverName = options.serverName || 'mcp-stdio';
    this.cwd = config.cwd || options.cwd || process.cwd();
    this.child = null;
    this.rl = null;
    this.stderrBuffer = [];
    this.maxStderrLines = 50;
    this.isKilling = false;
  }

  async connect(timeoutMs = 15000) {
    const { command, args = [], env = {} } = this.config;
    if (!command) {
      throw new McpConnectionError(`MCP server "${this.serverName}" has no command specified`);
    }

    const spawnEnv = { ...process.env, ...env };

    return new Promise((resolve, reject) => {
      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          this.close();
          reject(new McpTimeoutError(`Stdio spawn for "${this.serverName}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      try {
        this.child = spawn(command, args, {
          cwd: this.cwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });

        this.child.on('error', (err) => {
          this.emit('error', err);
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            reject(new McpConnectionError(`Spawn error for "${this.serverName}": ${err.message}`));
          }
        });

        this.child.on('exit', (code, signal) => {
          this.isConnected = false;
          const detail = `code=${code}, signal=${signal}`;
          const stderrTail = this.getStderrTail();
          const exitErr = new McpConnectionError(
            `MCP server "${this.serverName}" process exited (${detail})${stderrTail ? `:\n${stderrTail}` : ''}`
          );
          this.emit('close', { code, signal, error: exitErr });

          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            reject(exitErr);
          }
        });

        if (this.child.stderr) {
          this.child.stderr.on('data', (chunk) => {
            const lines = chunk.toString().split(/\r?\n/);
            for (const line of lines) {
              if (line.trim()) {
                this.stderrBuffer.push(line);
                if (this.stderrBuffer.length > this.maxStderrLines) {
                  this.stderrBuffer.shift();
                }
                this.emit('stderr', line);
              }
            }
          });
        }

        this.rl = readline.createInterface({
          input: this.child.stdout,
          terminal: false
        });

        this.rl.on('line', (line) => {
          if (!line.trim()) return;
          try {
            const msg = JSON.parse(line);
            this.emit('message', msg);
          } catch (err) {
            // Malformed line
            this.emit('parseError', { line, error: err });
          }
        });

        // If child spawned successfully, resolve
        this.isConnected = true;
        isSettled = true;
        clearTimeout(timer);
        resolve();
      } catch (err) {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          reject(new McpConnectionError(`Failed to spawn child process: ${err.message}`));
        }
      }
    });
  }

  getStderrTail() {
    return this.stderrBuffer.slice(-10).join('\n');
  }

  async send(msg) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new McpConnectionError(`MCP server "${this.serverName}" stdin is not writable`);
    }

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(msg) + '\n';
      const ok = this.child.stdin.write(payload, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (!ok) {
        this.child.stdin.once('drain', resolve);
      }
    });
  }

  async close() {
    this.isConnected = false;

    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }

    if (this.child && !this.isKilling) {
      this.isKilling = true;
      const pid = this.child.pid;
      try {
        if (process.platform === 'win32') {
          // Robust process tree termination on Windows
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          }).on('error', () => {});
        } else {
          this.child.kill('SIGTERM');
          setTimeout(() => {
            try { this.child?.kill('SIGKILL'); } catch {}
          }, 1000);
        }
      } catch {}
      this.child = null;
    }
  }
}

/**
 * SSE Transport: handles Server-Sent Events stream and HTTP POST message dispatching
 */
class McpSseTransport extends McpBaseTransport {
  constructor(config = {}, options = {}) {
    super();
    this.config = config;
    this.serverName = options.serverName || 'mcp-sse';
    this.cwd = config.cwd || options.cwd || process.cwd();
    this.url = config.url;
    this.postUrl = config.postUrl || null;
    this.headers = config.headers || {};
    this.child = null;
    this.sseReq = null;
    this.sseRes = null;
    this.activeSessionId = null;
    this.stderrBuffer = [];
  }

  async connect(timeoutMs = 15000) {
    // If a command is specified, this is a managed local SSE server
    if (this.config.command) {
      await this.spawnManagedServer(timeoutMs);
    }

    if (!this.url) {
      throw new McpConnectionError(`MCP SSE server "${this.serverName}" requires a url`);
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;
      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          this.close();
          reject(new McpTimeoutError(`SSE connection to "${this.url}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const parsedUrl = new URL(this.url);
      const httpModule = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...this.headers
        }
      };

      this.sseReq = httpModule.request(this.url, reqOptions, (res) => {
        this.sseRes = res;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timer);
            reject(new McpConnectionError(`SSE endpoint returned status ${res.statusCode}`));
          }
          return;
        }

        let buffer = '';
        let currentEvent = 'message';
        let currentData = [];

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop(); // Keep partial line in buffer

          for (const line of lines) {
            if (line === '') {
              // Dispatch event on empty line
              if (currentData.length > 0) {
                const dataStr = currentData.join('\n');
                this.handleSseEvent(currentEvent, dataStr);
              }
              currentEvent = 'message';
              currentData = [];
              continue;
            }

            if (line.startsWith(':')) {
              // Comment / keepalive
              continue;
            }

            const colonIndex = line.indexOf(':');
            let field = line;
            let value = '';
            if (colonIndex !== -1) {
              field = line.slice(0, colonIndex).trim();
              value = line.slice(colonIndex + 1);
              if (value.startsWith(' ')) value = value.slice(1);
            }

            if (field === 'event') {
              currentEvent = value.trim();
            } else if (field === 'data') {
              currentData.push(value);
            }
          }
        });

        res.on('close', () => {
          this.isConnected = false;
          this.emit('close', { reason: 'SSE stream closed by server' });
        });

        res.on('error', (err) => {
          this.emit('error', err);
        });
      });

      this.sseReq.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          reject(new McpConnectionError(`SSE request failed: ${err.message}`));
        } else {
          this.emit('error', err);
        }
      });

      // Once the 'endpoint' event is received (or immediately if postUrl is preset)
      const onEndpointReady = () => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          this.isConnected = true;
          resolve();
        }
      };

      this.once('endpointReady', onEndpointReady);

      // If postUrl is already set in config, we can resolve as soon as res responds
      this.sseReq.once('response', (res) => {
        if (this.postUrl && res.statusCode >= 200 && res.statusCode < 300) {
          onEndpointReady();
        }
      });

      this.sseReq.end();
    });
  }

  async spawnManagedServer(timeoutMs) {
    const { command, args = [], env = {} } = this.config;
    const spawnEnv = { ...process.env, ...env };

    return new Promise((resolve, reject) => {
      let isResolved = false;
      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          reject(new McpTimeoutError(`Managed SSE server spawn timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      try {
        this.child = spawn(command, args, {
          cwd: this.cwd,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        this.child.stderr.on('data', (d) => {
          this.stderrBuffer.push(d.toString());
        });

        this.child.on('error', (err) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            reject(err);
          }
        });

        this.child.on('exit', (code, signal) => {
          this.isConnected = false;
          this.emit('close', { code, signal });
        });

        // Scan stdout for READY_PORT or listen message
        const rl = readline.createInterface({ input: this.child.stdout, terminal: false });
        rl.on('line', (line) => {
          const m = line.match(/READY_PORT=(\d+)/) || line.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (m && !isResolved) {
            const port = m[1];
            if (this.url && this.url.includes(':0/')) {
              this.url = this.url.replace(':0/', `:${port}/`);
            } else if (!this.url) {
              this.url = `http://127.0.0.1:${port}/sse`;
            }
            isResolved = true;
            clearTimeout(timer);
            resolve();
          }
        });

        // Fallback delay if no specific ready output emitted
        setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            resolve();
          }
        }, 800);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  handleSseEvent(event, data) {
    if (event === 'endpoint') {
      // In MCP SSE: event: endpoint, data: /messages?sessionId=... or full URL
      try {
        const resolved = new URL(data, this.url);
        this.postUrl = resolved.toString();
        this.activeSessionId = resolved.searchParams.get('sessionId');
        this.emit('endpointReady', this.postUrl);
      } catch (err) {
        this.emit('error', new Error(`Invalid SSE endpoint URL "${data}": ${err.message}`));
      }
      return;
    }

    if (event === 'message') {
      try {
        const msg = JSON.parse(data);
        this.emit('message', msg);
      } catch (err) {
        this.emit('parseError', { data, error: err });
      }
    }
  }

  async send(msg) {
    if (!this.postUrl) {
      throw new McpConnectionError(`Cannot send MCP message: SSE endpoint URL has not been established yet`);
    }

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(this.postUrl);
      const httpModule = parsedUrl.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(msg);

      const reqOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...this.headers
        }
      };

      const req = httpModule.request(this.postUrl, reqOptions, (res) => {
        let resBody = '';
        res.on('data', chunk => { resBody += chunk; });
        res.on('end', () => {
          // If server directly returns JSON-RPC response in body (some servers do)
          if (resBody && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const bodyMsg = JSON.parse(resBody);
              if (bodyMsg.jsonrpc === '2.0' && bodyMsg.id !== undefined) {
                this.emit('message', bodyMsg);
              }
            } catch {}
          }
          if (res.statusCode >= 400) {
            reject(new McpError(`POST message failed with HTTP ${res.statusCode}: ${resBody}`, -32000));
          } else {
            resolve();
          }
        });
      });

      req.on('error', (err) => {
        reject(new McpConnectionError(`HTTP POST message failed: ${err.message}`));
      });

      req.write(payload);
      req.end();
    });
  }

  async close() {
    this.isConnected = false;

    if (this.sseReq) {
      try { this.sseReq.destroy(); } catch {}
      this.sseReq = null;
    }
    if (this.sseRes) {
      try { this.sseRes.destroy(); } catch {}
      this.sseRes = null;
    }

    if (this.child) {
      const pid = this.child.pid;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          this.child.kill('SIGTERM');
        }
      } catch {}
      this.child = null;
    }
  }
}

/**
 * McpClientConnection: manages a single MCP server connection (stdio or sse),
 * handles JSON-RPC 2.0 handshake (initialize/initialized), dynamic tool discovery,
 * dynamic resource discovery, tool execution, resource reading, and auto-healing lifecycle.
 */
class McpClientConnection extends EventEmitter {
  constructor(serverName, config = {}, options = {}) {
    super();
    this.serverName = serverName;
    this.config = config;
    this.options = options;
    this.cwd = config.cwd || options.cwd || process.cwd();

    this.transportType = this.determineTransportType(config);
    this.transport = null;

    this.reqId = 0;
    this.pending = new Map();
    this.serverInfo = null;
    this.protocolVersion = '2024-11-05';
    this.capabilities = null;
    this.tools = [];
    this.resources = [];
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'ready' | 'error' | 'closed'
    this.lastError = null;

    this.isExplicitlyClosed = false;
    this.reconnectPromise = null;
  }

  determineTransportType(config) {
    if (config.type) return config.type.toLowerCase();
    if (config.url) return 'sse';
    return 'stdio';
  }

  createTransport() {
    if (this.transportType === 'sse') {
      return new McpSseTransport(this.config, {
        serverName: this.serverName,
        cwd: this.cwd
      });
    }
    return new McpStdioTransport(this.config, {
      serverName: this.serverName,
      cwd: this.cwd
    });
  }

  async connect(timeoutMs = 15000) {
    if (this.status === 'ready') return this;
    if (this.status === 'connecting' && this.reconnectPromise) {
      return this.reconnectPromise;
    }

    this.isExplicitlyClosed = false;
    this.status = 'connecting';
    this.lastError = null;

    this.reconnectPromise = (async () => {
      // If previous transport exists, clean it up
      if (this.transport) {
        try { await this.transport.close(); } catch {}
        this.transport = null;
      }

      this.transport = this.createTransport();

      this.transport.on('message', (msg) => this.handleMessage(msg));
      this.transport.on('error', (err) => {
        this.lastError = err.message;
        this.emit('error', err);
      });
      this.transport.on('close', ({ code, signal, error }) => {
        this.status = 'closed';
        const closeErr = error || new McpConnectionError(`MCP server "${this.serverName}" closed`);
        this.rejectAllPending(closeErr);
        this.emit('close', { code, signal });
      });

      // 1. Establish transport connection
      await this.transport.connect(timeoutMs);

      // 2. Perform JSON-RPC 2.0 handshake
      try {
        const initRes = await this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: { listChanged: false },
            sampling: {},
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true }
          },
          clientInfo: {
            name: 'pi-chan-dashboard',
            version: '1.0.0'
          }
        }, timeoutMs);

        this.serverInfo = initRes?.serverInfo || {};
        this.protocolVersion = initRes?.protocolVersion || '2024-11-05';
        this.capabilities = initRes?.capabilities || {};

        // 3. Send notifications/initialized
        await this.notify('notifications/initialized');
        this.status = 'ready';

        // 4. Initial discovery of tools and resources
        if (this.capabilities.tools !== undefined || true) {
          try {
            await this.listTools();
          } catch (err) {
            // Ignore if server does not implement tools
          }
        }

        if (this.capabilities.resources !== undefined) {
          try {
            await this.listResources();
          } catch (err) {
            // Ignore if server does not implement resources
          }
        }

        this.emit('ready', { serverInfo: this.serverInfo, tools: this.tools, resources: this.resources });
        return this;
      } catch (err) {
        this.status = 'error';
        this.lastError = err.message;
        await this.close();
        throw err;
      } finally {
        this.reconnectPromise = null;
      }
    })();

    return this.reconnectPromise;
  }

  /**
   * Auto-heal check: ensures client is connected; restarts if connection dropped
   */
  async ensureConnected(timeoutMs = 15000) {
    if (this.isExplicitlyClosed) {
      throw new McpConnectionError(`MCP server "${this.serverName}" was explicitly closed and will not auto-reconnect`);
    }

    if (this.status === 'ready') return;
    if (this.status === 'connecting' && this.reconnectPromise) {
      await this.reconnectPromise;
      return;
    }

    // Auto-heal / Lazy reconnect
    await this.connect(timeoutMs);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // Handle response
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);

      if (msg.error) {
        const err = new McpError(
          msg.error.message || 'MCP RPC Error',
          msg.error.code,
          msg.error.data
        );
        reject(err);
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Handle notification
    if (msg.method) {
      this.handleNotification(msg.method, msg.params);
    }
  }

  async handleNotification(method, params) {
    this.emit('notification', { method, params });

    if (method === 'notifications/tools/list_changed') {
      try {
        await this.listTools();
        this.emit('toolsChanged', this.tools);
      } catch {}
    } else if (method === 'notifications/resources/list_changed') {
      try {
        await this.listResources();
        this.emit('resourcesChanged', this.resources);
      } catch {}
    } else if (method === 'notifications/message' || method === 'logging/message') {
      this.emit('log', params);
    }
  }

  rejectAllPending(err) {
    for (const [id, { reject, timer }] of this.pending.entries()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.transport || !this.transport.isConnected) {
        return reject(new McpConnectionError(`MCP server "${this.serverName}" is not connected`));
      }

      const id = ++this.reqId;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new McpTimeoutError(`MCP request "${method}" (id: ${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method, createdAt: Date.now() });

      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.transport.send(payload).catch((err) => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async notify(method, params = {}) {
    if (!this.transport || !this.transport.isConnected) return;
    const payload = {
      jsonrpc: '2.0',
      method,
      params
    };
    await this.transport.send(payload).catch(() => {});
  }

  /**
   * Discover and list tools exposed by server
   */
  async listTools(options = {}) {
    await this.ensureConnected();
    const res = await this.request('tools/list', options.cursor ? { cursor: options.cursor } : {});
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    this.tools = tools;
    return this.tools;
  }

  getTool(name) {
    return this.tools.find(t => t.name === name) || null;
  }

  /**
   * Call a tool on the server
   */
  async callTool(name, argumentsObj = {}, timeoutMs = 30000) {
    await this.ensureConnected();
    const res = await this.request('tools/call', {
      name,
      arguments: argumentsObj
    }, timeoutMs);
    return res;
  }

  /**
   * Discover and list resources exposed by server
   */
  async listResources(options = {}) {
    await this.ensureConnected();
    const res = await this.request('resources/list', options.cursor ? { cursor: options.cursor } : {});
    const resources = Array.isArray(res?.resources) ? res.resources : [];
    this.resources = resources;
    return this.resources;
  }

  getResource(uri) {
    return this.resources.find(r => r.uri === uri) || null;
  }

  /**
   * Read resource content by URI
   */
  async readResource(uri, timeoutMs = 30000) {
    await this.ensureConnected();
    const res = await this.request('resources/read', { uri }, timeoutMs);
    return res;
  }

  /**
   * Convenience helper to read resource text directly
   */
  async readResourceText(uri, timeoutMs = 30000) {
    const res = await this.readResource(uri, timeoutMs);
    if (!res || !Array.isArray(res.contents) || res.contents.length === 0) {
      throw new McpError(`Empty resource contents for URI: ${uri}`, -32002);
    }
    const item = res.contents[0];
    if (item.text !== undefined) {
      return item.text;
    }
    if (item.blob !== undefined) {
      return Buffer.from(item.blob, 'base64').toString('utf8');
    }
    return '';
  }

  /**
   * Gracefully close client connection
   */
  async close() {
    this.isExplicitlyClosed = true;
    this.status = 'closed';
    this.rejectAllPending(new McpConnectionError(`MCP server "${this.serverName}" connection closed`));

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {}
      this.transport = null;
    }
  }
}

/**
 * McpManager: manages multiple MCP client connections, loads configuration
 * from data/mcp-servers.json, aggregates tools & resources, routes calls,
 * and provides dynamic reloading and fault isolation.
 */
class McpManager {
  constructor(options = {}) {
    this.configPath = options.configPath || path.join(__dirname, 'data/mcp-servers.json');
    this.cwd = options.cwd || __dirname;
    this.connections = new Map();
    this.serverConfigs = new Map();
  }

  loadConfig(customPath = null) {
    const targetPath = customPath || this.configPath;
    if (!fs.existsSync(targetPath)) {
      return { mcpServers: {} };
    }
    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Support both { mcpServers: ... } and { servers: ... }
      const servers = parsed.mcpServers || parsed.servers || {};
      return { mcpServers: servers };
    } catch (err) {
      throw new McpError(`Failed to load MCP config at ${targetPath}: ${err.message}`, -32000);
    }
  }

  async init(options = {}) {
    const cfg = this.loadConfig();
    const servers = cfg.mcpServers || {};
    const timeoutMs = options.timeoutMs || 15000;
    const results = [];

    const tasks = Object.entries(servers).map(async ([name, serverConfig]) => {
      if (this.connections.has(name)) {
        try { await this.connections.get(name).close(); } catch {}
        this.connections.delete(name);
      }

      this.serverConfigs.set(name, serverConfig);
      const client = new (require('./mcp-sdk-client.cjs').SdkMcpConnection)(name, serverConfig, { cwd: this.cwd });
      this.connections.set(name, client);

      try {
        await client.connect(timeoutMs);
        return {
          name,
          type: client.transportType,
          status: 'connected',
          toolsCount: client.tools.length,
          resourcesCount: client.resources.length
        };
      } catch (err) {
        return {
          name,
          type: client.transportType,
          status: 'error',
          error: err.message
        };
      }
    });

    const settled = await Promise.all(tasks);
    results.push(...settled);
    return results;
  }

  getServer(name) {
    return this.connections.get(name) || null;
  }

  listServers() {
    const list = [];
    for (const [name, client] of this.connections.entries()) {
      list.push({
        name,
        type: client.transportType,
        status: client.status,
        toolsCount: client.tools.length,
        resourcesCount: client.resources.length,
        serverInfo: client.serverInfo,
        lastError: client.lastError
      });
    }
    return list;
  }

  getAllTools() {
    const allTools = [];
    for (const [serverName, client] of this.connections.entries()) {
      if (client.status === 'ready') {
        for (const tool of client.tools) {
          allTools.push({
            server: serverName,
            fullName: `${serverName}__${tool.name}`,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          });
        }
      }
    }
    return allTools;
  }

  getAllResources() {
    const allResources = [];
    for (const [serverName, client] of this.connections.entries()) {
      if (client.status === 'ready') {
        for (const res of client.resources) {
          const cleanUri = res.uri.replace(/^[^:]+:\/\//, '');
          allResources.push({
            server: serverName,
            uri: res.uri,
            fullUri: `${serverName}://${cleanUri}`,
            name: res.name,
            description: res.description,
            mimeType: res.mimeType
          });
        }
      }
    }
    return allResources;
  }

  async callTool(serverName, toolName, args = {}, timeoutMs = 30000) {
    const client = this.connections.get(serverName);
    if (!client) {
      throw new McpError(`MCP server "${serverName}" not found or not connected`, -32601);
    }
    return await client.callTool(toolName, args, timeoutMs);
  }

  async callPrefixedTool(fullName, args = {}, timeoutMs = 30000) {
    const parts = fullName.split('__');
    if (parts.length < 2) {
      throw new McpError(`Invalid prefixed tool name "${fullName}". Expected format "server__toolName"`, -32600);
    }
    const serverName = parts[0];
    const toolName = parts.slice(1).join('__');
    return await this.callTool(serverName, toolName, args, timeoutMs);
  }

  async readResource(serverName, uri, timeoutMs = 30000) {
    const client = this.connections.get(serverName);
    if (!client) {
      throw new McpError(`MCP server "${serverName}" not found or not connected`, -32602);
    }
    return await client.readResource(uri, timeoutMs);
  }

  async readPrefixedResource(target, maybeUri = null, timeoutMs = 30000) {
    let serverName;
    let uri;

    if (maybeUri) {
      serverName = target;
      uri = maybeUri;
    } else if (target.includes('__')) {
      const parts = target.split('__');
      serverName = parts[0];
      uri = parts.slice(1).join('__');
    } else if (target.includes('://')) {
      const match = target.match(/^([^:/]+):\/\/(.*)$/);
      if (match) {
        serverName = match[1];
        uri = target;
      } else {
        throw new McpError(`Unable to parse resource target "${target}"`, -32600);
      }
    } else {
      throw new McpError(`Invalid prefixed resource reference "${target}"`, -32600);
    }

    return await this.readResource(serverName, uri, timeoutMs);
  }

  /**
   * Hot-reload configuration without restarting unaffected running servers
   */
  async reload(options = {}) {
    const cfg = this.loadConfig();
    const newServers = cfg.mcpServers || {};
    const summary = { kept: [], started: [], stopped: [], failed: [] };

    // 1. Identify stopped servers
    for (const [name, client] of Array.from(this.connections.entries())) {
      if (!newServers[name]) {
        try {
          await client.close();
          summary.stopped.push(name);
        } catch {}
        this.connections.delete(name);
        this.serverConfigs.delete(name);
      }
    }

    // 2. Diff and handle new / updated servers
    for (const [name, serverConfig] of Object.entries(newServers)) {
      const oldConfig = this.serverConfigs.get(name);
      const isUnchanged = oldConfig && JSON.stringify(oldConfig) === JSON.stringify(serverConfig);

      if (isUnchanged && this.connections.has(name) && this.connections.get(name).status === 'ready') {
        summary.kept.push(name);
        continue;
      }

      // If configuration changed, close previous instance
      if (this.connections.has(name)) {
        try { await this.connections.get(name).close(); } catch {}
        this.connections.delete(name);
      }

      this.serverConfigs.set(name, serverConfig);
      const client = new (require('./mcp-sdk-client.cjs').SdkMcpConnection)(name, serverConfig, { cwd: this.cwd });
      this.connections.set(name, client);

      try {
        await client.connect(options.timeoutMs || 15000);
        summary.started.push(name);
      } catch (err) {
        summary.failed.push({ name, error: err.message });
      }
    }

    return summary;
  }

  async closeAll() {
    for (const client of this.connections.values()) {
      try {
        await client.close();
      } catch {}
    }
    this.connections.clear();
    this.serverConfigs.clear();
  }
}

module.exports = {
  McpError,
  McpTimeoutError,
  McpConnectionError,
  McpBaseTransport,
  McpStdioTransport,
  McpSseTransport,
  McpClientConnection,
  McpManager
};
