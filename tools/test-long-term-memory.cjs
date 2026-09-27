'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLongTermMemory } = require('../integration/long-term-memory.cjs');
test('real official MCP: persistence, project isolation, graph references, replacement and deletion', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pichan-graph-'));
  try {
    let service = createLongTermMemory({ dataDir });
    const record = { id: 'fact-one', title: '偏好', content: '喜欢清淡茶饮', source: 'session:verified-message-1', entities: [{ name: '小明', type: 'person' }, { name: '茶饮', type: 'preference' }], relations: [{ from: '小明', to: '茶饮', type: '喜欢' }] };
    await Promise.all([service.syncProject({ projectId: 'project-a', records: [record] }), service.syncProject({ projectId: 'project-b', records: [{ ...record, id: 'other-fact', content: '喜欢咖啡', entities: [], relations: [] }] })]);
    assert.deepEqual((await service.search({ projectId: 'project-a', query: '小明' })).noteIds, ['fact-one']);
    assert.deepEqual((await service.search({ projectId: 'project-b', query: '小明' })).noteIds, []);
    service = createLongTermMemory({ dataDir });
    assert.deepEqual((await service.search({ projectId: 'project-a', query: '清淡' })).noteIds, ['fact-one']);
    const stored = await fs.readFile(path.join(dataDir, 'project-a.jsonl'), 'utf8');
    assert.match(stored, /session:verified-message-1/);
    assert.match(stored, /喜欢/);
    assert.throws(() => service.syncProject({ projectId: 'project-a', records: [{ ...record, content: 'sk-' + 'a'.repeat(30) }] }), /credential/);
    assert.deepEqual((await service.search({ projectId: 'project-a', query: '清淡' })).noteIds, ['fact-one']);
    await service.syncProject({ projectId: 'project-a', records: [] });
    assert.deepEqual((await service.search({ projectId: 'project-a', query: '清淡' })).noteIds, []);
    assert.deepEqual((await service.search({ projectId: 'project-b', query: '咖啡' })).noteIds, ['other-fact']);
    await service.clearProject('project-b');
    assert.deepEqual((await service.search({ projectId: 'project-b', query: '咖啡' })).noteIds, []);
    assert.throws(() => service.search({ projectId: '../escape', query: 'x' }), /scope/);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
test('same-project mutations serialize and final replacement wins', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pichan-graph-'));
  try {
    const service = createLongTermMemory({ dataDir });
    await Promise.all([service.syncProject({ projectId: 'p', records: [{ id: 'old', content: '旧事实' }] }), service.syncProject({ projectId: 'p', records: [{ id: 'new', content: '新事实' }] })]);
    assert.deepEqual((await service.search({ projectId: 'p', query: '旧事实' })).noteIds, []);
    assert.deepEqual((await service.search({ projectId: 'p', query: '新事实' })).noteIds, ['new']);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
