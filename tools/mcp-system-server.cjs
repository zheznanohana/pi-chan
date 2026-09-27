'use strict';
const readline = require('node:readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const { id, method, params } = req;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true }
          },
          serverInfo: {
            name: 'mcp-system-server',
            version: '1.1.0'
          }
        }
      });
      return;
    }

    if (method === 'notifications/initialized') {
      // Notification, no reply expected
      return;
    }

    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'get_system_time',
              description: '获取当前系统的 ISO 时间和时间戳',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'echo',
              description: '回显输入的测试文本',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: '待回显的内容' }
                },
                required: ['message']
              }
            },
            {
              name: 'calculate',
              description: '执行基础数值运算',
              inputSchema: {
                type: 'object',
                properties: {
                  operation: { type: 'string', enum: ['add', 'multiply'] },
                  a: { type: 'number' },
                  b: { type: 'number' }
                },
                required: ['operation', 'a', 'b']
              }
            },
            {
              name: 'crash',
              description: '故意触发进程异常退出以验证自愈机制',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            }
          ]
        }
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === 'get_system_time') {
        const now = new Date();
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ iso: now.toISOString(), timestamp: now.getTime() })
              }
            ],
            isError: false
          }
        });
        return;
      }

      if (toolName === 'echo') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: String(args.message !== undefined ? args.message : '')
              }
            ],
            isError: false
          }
        });
        return;
      }

      if (toolName === 'calculate') {
        const { operation, a = 0, b = 0 } = args;
        let val = 0;
        if (operation === 'add') val = Number(a) + Number(b);
        else if (operation === 'multiply') val = Number(a) * Number(b);
        else {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Unsupported operation: ${operation}` }],
              isError: true
            }
          });
          return;
        }

        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(val) }],
            isError: false
          }
        });
        return;
      }

      if (toolName === 'crash') {
        // Deliberate crash for testing self-healing
        process.exit(1);
      }

      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Tool not found: ${toolName}`
        }
      });
      return;
    }

    if (method === 'resources/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'system://info',
              name: 'System Information',
              description: '当前系统及 Node 运行环境信息',
              mimeType: 'application/json'
            },
            {
              uri: 'system://status',
              name: 'System Status',
              description: '系统健康度与运行时间',
              mimeType: 'application/json'
            },
            {
              uri: 'system://notice.txt',
              name: 'System Notice',
              description: '纯文本系统通知文档',
              mimeType: 'text/plain'
            },
            {
              uri: 'system://binary.dat',
              name: 'Binary Sample Data',
              description: '二进制 Base64 数据样例',
              mimeType: 'application/octet-stream'
            }
          ]
        }
      });
      return;
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri === 'system://info') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  platform: process.platform,
                  arch: process.arch,
                  nodeVersion: process.version,
                  pid: process.pid
                })
              }
            ]
          }
        });
        return;
      }

      if (uri === 'system://status') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                  status: 'healthy',
                  uptimeSec: Math.floor(process.uptime())
                })
              }
            ]
          }
        });
        return;
      }

      if (uri === 'system://notice.txt') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: 'Pi-Chan MCP Client Connector System Ready.'
              }
            ]
          }
        });
        return;
      }

      if (uri === 'system://binary.dat') {
        const buf = Buffer.from('MCP Binary Protocol Sample Data: 0x12345678');
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: 'application/octet-stream',
                blob: buf.toString('base64')
              }
            ]
          }
        });
        return;
      }

      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: `Resource not found: ${uri}`
        }
      });
      return;
    }

    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not supported: ${method}`
        }
      });
    }
  } catch (err) {
    process.stderr.write(`Parse error: ${err.message}\n`);
  }
});
