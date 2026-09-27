'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { createMcpService } = require('../mcp-service.cjs');
const { McpClientConnection, McpManager } = require('../mcp-client.cjs');

function requestJson(port, method, reqPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runComprehensiveMcpTestSuite() {
  console.log('====================================================');
  console.log('      MCP CONNECTOR COMPREHENSIVE TEST SUITE        ');
  console.log('====================================================\n');

  const rootDir = path.resolve(__dirname, '..');

  // Test 1: Code and File Structure Integrity
  console.log('TEST 1: Verifying File & Assets Integrity');
  const requiredFiles = [
    'mcp-client.cjs',
    'mcp-service.cjs',
    'mcp-panel.js',
    'mcp-panel.css',
    'data/mcp-servers.json',
    'tools/mcp-system-server.cjs'
  ];
  for (const rel of requiredFiles) {
    const fullPath = path.join(rootDir, rel);
    assert.ok(fs.existsSync(fullPath), `Required file missing: ${rel}`);
    assert.ok(fs.statSync(fullPath).size > 0, `File is empty: ${rel}`);
    console.log(`  ✓ ${rel} exists and is valid`);
  }

  // Test 2: Frontend Integration Presence in index.html, settings-panel.js, workbench-panel.js
  console.log('\nTEST 2: Verifying Frontend Integration Points');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('mcp-panel.css'), 'index.html should link mcp-panel.css');
  assert.ok(indexHtml.includes('mcp-panel.js'), 'index.html should load mcp-panel.js');
  assert.ok(indexHtml.includes('mcpTopBadge'), 'index.html should contain top MCP badge');
  assert.ok(indexHtml.includes('mcp_status'), 'index.html should handle mcp_status event');
  console.log('  ✓ index.html integration verified');

  const settingsJs = fs.readFileSync(path.join(rootDir, 'settings-panel.js'), 'utf8');
  assert.ok(settingsJs.includes('initMcpSettings'), 'settings-panel.js should call initMcpSettings');
  assert.ok(settingsJs.includes('settingMcpBadge'), 'settings-panel.js should render MCP status badge');
  console.log('  ✓ settings-panel.js integration verified');

  const workbenchJs = fs.readFileSync(path.join(rootDir, 'workbench-panel.js'), 'utf8');
  assert.ok(workbenchJs.includes('workbench-mcp'), 'workbench-panel.js should render MCP button');
  assert.ok(workbenchJs.includes('openMcp'), 'workbench-panel.js should expose openMcp');
  console.log('  ✓ workbench-panel.js integration verified');

  // Test 3: Backend REST API and JSON-RPC Execution
  console.log('\nTEST 3: Initializing McpService on Live HTTP Server');
  const broadcastLog = [];
  const service = createMcpService({
    configPath: path.join(rootDir, 'data/mcp-servers.json'),
    cwd: rootDir,
    broadcast: (type, payload) => broadcastLog.push({ type, payload })
  });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    try {
      const handled = await service.handle(req, res, parsedUrl);
      if (!handled) {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`  ✓ Test harness server bound to 127.0.0.1:${port}`);

  try {
    // 3.1: Service Init
    const initRes = await service.init();
    assert.strictEqual(initRes[0].status, 'connected', 'Server should connect successfully');
    console.log('  ✓ MCP Server initialized:', initRes[0].name);

    // 3.2: Status Query
    const status = await requestJson(port, 'GET', '/api/mcp/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.status, 'ready');
    assert.strictEqual(status.json.serversCount, 1);
    assert.ok(status.json.toolsCount >= 4, 'Should expose at least 4 tools');
    console.log(`  ✓ GET /api/mcp/status: ${status.json.serversCount} server(s), ${status.json.toolsCount} tools`);

    // 3.3: Servers List
    const servers = await requestJson(port, 'GET', '/api/mcp/servers');
    assert.strictEqual(servers.status, 200);
    const sys = servers.json.servers.find(s => s.name === 'system-info');
    assert.ok(sys, 'system-info server found');
    assert.strictEqual(sys.type, 'stdio');
    assert.strictEqual(sys.serverInfo.name, 'mcp-system-server');
    console.log('  ✓ GET /api/mcp/servers: serverInfo matches specification');

    // 3.4: Tools Discovery & Schema
    const tools = await requestJson(port, 'GET', '/api/mcp/tools');
    assert.strictEqual(tools.status, 200);
    const calcTool = tools.json.tools.find(t => t.name === 'calculate');
    assert.ok(calcTool, 'calculate tool should exist');
    assert.ok(calcTool.inputSchema.properties.operation, 'inputSchema contains expected operation field');
    console.log('  ✓ GET /api/mcp/tools: Schema discovery confirmed for "calculate"');

    // 3.5: Resources Discovery & Reading
    const resources = await requestJson(port, 'GET', '/api/mcp/resources');
    assert.strictEqual(resources.status, 200);
    assert.ok(resources.json.resources.some(r => r.uri === 'system://info'));

    const readRes = await requestJson(port, 'GET', '/api/mcp/resources/read?server=system-info&uri=system://info');
    assert.strictEqual(readRes.status, 200);
    assert.ok(readRes.json.result.contents[0].text.includes('nodeVersion'));
    console.log('  ✓ GET /api/mcp/resources/read: URI system://info read successfully');

    // 3.6: Tool Invocation: get_system_time
    const timeCall = await requestJson(port, 'POST', '/api/mcp/tools/call', {
      server: 'system-info',
      name: 'get_system_time'
    });
    assert.strictEqual(timeCall.status, 200);
    assert.strictEqual(timeCall.json.code, 0);
    const timeData = JSON.parse(timeCall.json.result.content[0].text);
    assert.ok(timeData.iso && timeData.timestamp);
    console.log('  ✓ POST /api/mcp/tools/call get_system_time ->', timeData.iso);

    // 3.7: Tool Invocation: echo with arguments
    const echoCall = await requestJson(port, 'POST', '/api/mcp/tools/call', {
      fullName: 'system-info__echo',
      arguments: { message: 'Verification Test 2026' }
    });
    assert.strictEqual(echoCall.status, 200);
    assert.strictEqual(echoCall.json.result.content[0].text, 'Verification Test 2026');
    console.log('  ✓ POST /api/mcp/tools/call (prefixed) echo ->', echoCall.json.result.content[0].text);

    // 3.8: Tool Invocation: calculate with arguments
    const calcCall = await requestJson(port, 'POST', '/api/mcp/tools/call', {
      server: 'system-info',
      name: 'calculate',
      arguments: { operation: 'multiply', a: 6, b: 7 }
    });
    assert.strictEqual(calcCall.status, 200);
    assert.strictEqual(calcCall.json.result.content[0].text, '42');
    console.log('  ✓ POST /api/mcp/tools/call calculate(multiply, 6, 7) ->', calcCall.json.result.content[0].text);

    // 3.9: Error Handling: Tool not found
    const errCall = await requestJson(port, 'POST', '/api/mcp/tools/call', {
      server: 'system-info',
      name: 'invalid_tool_test'
    });
    assert.strictEqual(errCall.status, 200);
    assert.strictEqual(errCall.json.isError, true);
    assert.ok(errCall.json.error.includes('Tool not found'));
    console.log('  ✓ POST /api/mcp/tools/call error handling ->', errCall.json.error);

    // 3.10: Hot Reload
    const reload = await requestJson(port, 'POST', '/api/mcp/reload');
    assert.strictEqual(reload.status, 200);
    assert.strictEqual(reload.json.code, 0);
    assert.ok(reload.json.summary.kept.includes('system-info'));
    console.log('  ✓ POST /api/mcp/reload hot reload succeeded without server interruption');

    // 3.11: Restart Single Server
    const restart = await requestJson(port, 'POST', '/api/mcp/servers/restart', {
      server: 'system-info'
    });
    assert.strictEqual(restart.status, 200);
    assert.strictEqual(restart.json.code, 0);
    console.log('  ✓ POST /api/mcp/servers/restart succeeded');

    // 3.12: SSE Broadcast Verification
    assert.ok(broadcastLog.some(b => b.type === 'mcp_status'), 'mcp_status event was broadcast');
    assert.ok(broadcastLog.some(b => b.type === 'mcp_reloaded'), 'mcp_reloaded event was broadcast');
    console.log(`  ✓ Event broadcasting verified (${broadcastLog.length} events logged)`);

  } finally {
    await service.close();
    server.close();
  }

  console.log('\n====================================================');
  console.log('  🎉 ALL AUTOMATED TEST CASES PASSED SUCCESSFULLY!  ');
  console.log('====================================================');
}

runComprehensiveMcpTestSuite().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
