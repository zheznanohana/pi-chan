'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { McpClientConnection, McpManager } = require('../mcp-client.cjs');

async function runTests() {
  console.log('--- 1. Testing Single McpClientConnection with tools/mcp-system-server.cjs ---');

  const client = new McpClientConnection('test-sys', {
    command: process.execPath,
    args: [path.join(__dirname, 'mcp-system-server.cjs')]
  }, { cwd: path.resolve(__dirname, '..') });

  // 1. Connect and initialize
  await client.connect(5000);
  assert.strictEqual(client.status, 'ready', 'Client status should be ready');
  assert.ok(client.serverInfo, 'serverInfo should be received');
  assert.strictEqual(client.serverInfo.name, 'mcp-system-server');
  console.log('✓ Handshake & initialize OK:', client.serverInfo);

  // 2. Discover tools
  const tools = await client.listTools();
  assert.ok(Array.isArray(tools), 'Tools should be an array');
  assert.ok(tools.length >= 2, 'Should discover at least 2 tools');
  assert.ok(tools.some(t => t.name === 'get_system_time'));
  assert.ok(tools.some(t => t.name === 'echo'));
  console.log('✓ Discovered tools:', tools.map(t => t.name));

  // 3. Call tool: get_system_time
  const timeRes = await client.callTool('get_system_time');
  assert.ok(timeRes && timeRes.content && timeRes.content[0], 'Tool response structure valid');
  const timeData = JSON.parse(timeRes.content[0].text);
  assert.ok(timeData.iso && timeData.timestamp, 'Valid ISO time and timestamp');
  console.log('✓ tools/call get_system_time succeeded:', timeData.iso);

  // 4. Call tool: echo
  const echoRes = await client.callTool('echo', { message: 'Hello MCP Client!' });
  assert.strictEqual(echoRes.content[0].text, 'Hello MCP Client!');
  console.log('✓ tools/call echo succeeded:', echoRes.content[0].text);

  // 5. Error handling on non-existent tool
  try {
    await client.callTool('non_existent_tool');
    assert.fail('Should have thrown error for non-existent tool');
  } catch (err) {
    assert.ok(err.message.includes('Tool not found'), 'Expected tool not found error');
    console.log('✓ Handled non-existent tool error correctly:', err.message);
  }

  // 6. Close client
  client.close();
  assert.strictEqual(client.status, 'closed');
  console.log('✓ Client closed cleanly');

  console.log('\n--- 2. Testing McpManager with data/mcp-servers.json ---');

  const manager = new McpManager({
    configPath: path.join(__dirname, '../data/mcp-servers.json'),
    cwd: path.resolve(__dirname, '..')
  });

  const initResults = await manager.init();
  console.log('✓ McpManager init results:', initResults);
  assert.ok(initResults.length > 0);
  assert.strictEqual(initResults[0].status, 'connected');

  const allTools = manager.getAllTools();
  console.log('✓ Aggregated tools from McpManager:', allTools.map(t => t.fullName));
  assert.ok(allTools.some(t => t.fullName === 'system-info__echo'));

  // Test prefixed tool call
  const callRes = await manager.callPrefixedTool('system-info__echo', { message: 'Prefix routing works!' });
  assert.strictEqual(callRes.content[0].text, 'Prefix routing works!');
  console.log('✓ Prefixed tool execution succeeded:', callRes.content[0].text);

  manager.closeAll();
  console.log('✓ McpManager closeAll cleanly closed all servers');

  console.log('\n🎉 ALL MCP CLIENT TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ MCP Client test failed:', err);
  process.exit(1);
});
