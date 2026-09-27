'use strict';

const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert');
const { createMcpService } = require('../mcp-service.cjs');

function makeRequest(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, data, json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== Testing McpService and REST Endpoints ===');

  let broadcastEvents = [];
  const broadcast = (type, payload) => {
    broadcastEvents.push({ type, payload });
  };

  const service = createMcpService({
    configPath: path.join(__dirname, '../data/mcp-servers.json'),
    cwd: path.resolve(__dirname, '..'),
    broadcast
  });

  // Start test HTTP server
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    try {
      const handled = await service.handle(req, res, parsedUrl);
      if (!handled) {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch (err) {
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`✓ Test HTTP server listening on port ${port}`);

  try {
    // 1. Initialize service
    console.log('--- Step 1: Initializing McpService ---');
    const initRes = await service.init();
    assert.ok(Array.isArray(initRes), 'Init should return array of server statuses');
    console.log('✓ Init results:', initRes);

    // 2. Test GET /api/mcp/status
    console.log('--- Step 2: Testing GET /api/mcp/status ---');
    const statusRes = await makeRequest(port, 'GET', '/api/mcp/status');
    assert.strictEqual(statusRes.statusCode, 200);
    assert.strictEqual(statusRes.json.code, 0);
    assert.strictEqual(statusRes.json.status, 'ready');
    assert.ok(statusRes.json.serversCount >= 1);
    assert.ok(statusRes.json.toolsCount >= 2);
    console.log('✓ GET /api/mcp/status:', statusRes.json);

    // 3. Test GET /api/mcp/servers
    console.log('--- Step 3: Testing GET /api/mcp/servers ---');
    const serversRes = await makeRequest(port, 'GET', '/api/mcp/servers');
    assert.strictEqual(serversRes.statusCode, 200);
    assert.strictEqual(serversRes.json.code, 0);
    assert.ok(serversRes.json.servers.some(s => s.name === 'system-info' && s.status === 'ready'));
    console.log('✓ GET /api/mcp/servers count:', serversRes.json.servers.length);

    // 4. Test GET /api/mcp/tools and filter
    console.log('--- Step 4: Testing GET /api/mcp/tools ---');
    const toolsRes = await makeRequest(port, 'GET', '/api/mcp/tools');
    assert.strictEqual(toolsRes.statusCode, 200);
    assert.ok(toolsRes.json.tools.length >= 2);
    assert.ok(toolsRes.json.tools.some(t => t.name === 'echo'));
    console.log('✓ GET /api/mcp/tools found:', toolsRes.json.tools.map(t => t.fullName));

    const filterRes = await makeRequest(port, 'GET', '/api/mcp/tools?server=system-info');
    assert.strictEqual(filterRes.statusCode, 200);
    assert.strictEqual(filterRes.json.tools.length, toolsRes.json.tools.length);

    // 5. Test GET /api/mcp/resources
    console.log('--- Step 5: Testing GET /api/mcp/resources ---');
    const resRes = await makeRequest(port, 'GET', '/api/mcp/resources');
    assert.strictEqual(resRes.statusCode, 200);
    assert.ok(resRes.json.resources.length >= 1);
    console.log('✓ Discovered resources:', resRes.json.resources.map(r => r.fullUri));

    // 6. Test GET /api/mcp/resources/read
    console.log('--- Step 6: Testing GET /api/mcp/resources/read ---');
    const readRes = await makeRequest(port, 'GET', '/api/mcp/resources/read?server=system-info&uri=system://info');
    assert.strictEqual(readRes.statusCode, 200);
    assert.strictEqual(readRes.json.code, 0);
    assert.ok(readRes.json.result.contents[0].text);
    console.log('✓ Read resource success:', readRes.json.result.contents[0].text.slice(0, 50));

    // 7. Test POST /api/mcp/tools/call
    console.log('--- Step 7: Testing POST /api/mcp/tools/call ---');
    const callEcho = await makeRequest(port, 'POST', '/api/mcp/tools/call', {
      server: 'system-info',
      name: 'echo',
      arguments: { message: 'Hello McpService REST' }
    });
    assert.strictEqual(callEcho.statusCode, 200);
    assert.strictEqual(callEcho.json.code, 0);
    assert.strictEqual(callEcho.json.result.content[0].text, 'Hello McpService REST');
    console.log('✓ Tool call echo returned:', callEcho.json.result.content[0].text);

    // Test prefixed call
    const callPrefixed = await makeRequest(port, 'POST', '/api/mcp/tools/call', {
      fullName: 'system-info__get_system_time'
    });
    assert.strictEqual(callPrefixed.statusCode, 200);
    assert.strictEqual(callPrefixed.json.code, 0);
    const timeObj = JSON.parse(callPrefixed.json.result.content[0].text);
    assert.ok(timeObj.iso);
    console.log('✓ Prefixed tool call succeeded:', timeObj.iso);

    // Test error handling for non-existent tool
    const callNotFound = await makeRequest(port, 'POST', '/api/mcp/tools/call', {
      server: 'system-info',
      name: 'unknown_function'
    });
    assert.strictEqual(callNotFound.statusCode, 200);
    assert.strictEqual(callNotFound.json.isError, true);
    console.log('✓ Handled tool error properly:', callNotFound.json.error);

    // 8. Test POST /api/mcp/reload
    console.log('--- Step 8: Testing POST /api/mcp/reload ---');
    const reloadRes = await makeRequest(port, 'POST', '/api/mcp/reload');
    assert.strictEqual(reloadRes.statusCode, 200);
    assert.strictEqual(reloadRes.json.code, 0);
    assert.ok(reloadRes.json.summary);
    console.log('✓ Reload summary:', reloadRes.json.summary);

    // Check broadcast events
    assert.ok(broadcastEvents.some(e => e.type === 'mcp_status'));
    assert.ok(broadcastEvents.some(e => e.type === 'mcp_reloaded'));
    console.log('✓ Broadcast events fired properly');

    console.log('\n🎉 ALL MCP SERVICE REST TESTS PASSED!');
  } finally {
    await service.close();
    server.close();
  }
}

runTests().catch(err => {
  console.error('❌ McpService test failed:', err);
  process.exit(1);
});
