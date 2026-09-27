'use strict';
// Official MCP memory is a disposable relationship index. SQLite remains the source of truth.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const ENTRY = require.resolve('@modelcontextprotocol/server-memory/dist/index.js');
const BACKEND = '@modelcontextprotocol/server-memory@2026.8.31';
const sensitive = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_.-]{16,}|\bBearer\s+[A-Za-z0-9_.-]{20,}/i;
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw Error('Invalid memory scope/id');
  return value;
}
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function entityName(name) { return 'entity:' + crypto.createHash('sha256').update(name.normalize('NFKC')).digest('hex'); }
function createLongTermMemory({ dataDir } = {}) {
  if (!dataDir) throw Error('dataDir required');
  const root = path.resolve(dataDir), queues = new Map();
  const fileFor = projectId => path.join(root, id(projectId) + '.jsonl');
  function exclusive(projectId, operation) {
    id(projectId);
    const next = (queues.get(projectId) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(projectId, next);
    return next.finally(() => { if (queues.get(projectId) === next) queues.delete(projectId); });
  }
  async function session(file, operation) {
    await fs.mkdir(root, { recursive: true });
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { MEMORY_FILE_PATH: file }, stderr: 'ignore' });
    const client = new Client({ name: 'pichan-memory-derived-index', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: 15000 });
      const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
        if (result.isError) throw Error('Memory graph operation failed: ' + name);
        return JSON.parse((result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n'));
      };
      return await operation(call);
    } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
  function build(records) {
    if (!Array.isArray(records) || records.length > 2000) throw Error('Memory graph record limit exceeded');
    if (Buffer.byteLength(JSON.stringify(records)) > 8 * 1024 * 1024) throw Error('Memory graph exceeds 8 MiB');
    const entities = new Map(), relations = new Map();
    const relate = (from, to, relationType) => { const r = { from, to, relationType }; relations.set(JSON.stringify(r), r); };
    for (const record of records) {
      const note = 'note:' + id(record.id), title = text(record.title, 160), content = text(record.content, 16000), source = text(record.source, 2000);
      if (sensitive.test(title + '\n' + content + '\n' + source)) throw Error('Potential credential in graph record');
      if (entities.has(note)) throw Error('Duplicate memory record');
      entities.set(note, { name: note, entityType: 'sqlite_fact', observations: [JSON.stringify({ title, content, source, citation: 'memory:' + record.id })] });
      const local = new Map();
      for (const value of (Array.isArray(record.entities) ? record.entities : []).slice(0, 32)) {
        const name = text(value.name, 120), type = text(value.type, 60) || 'entity';
        if (!name) continue;
        if (sensitive.test(name + type)) throw Error('Potential credential in graph entity');
        const key = entityName(name); local.set(name, key);
        if (!entities.has(key)) entities.set(key, { name: key, entityType: type, observations: [name] });
        relate(note, key, 'describes');
      }
      for (const value of (Array.isArray(record.relations) ? record.relations : []).slice(0, 64)) {
        const from = local.get(text(value.from, 120)), to = local.get(text(value.to, 120)), type = text(value.type || value.relationType, 80);
        if (from && to && type) { if (sensitive.test(type)) throw Error('Potential credential in graph relation'); relate(from, to, type); }
      }
    }
    return { entities: [...entities.values()], relations: [...relations.values()] };
  }
  function syncProject({ projectId, records }) {
    // Validate before touching the existing derived index; callers supply approved, current SQLite facts only.
    const graph = build(records);
    return exclusive(projectId, async () => {
      const target = fileFor(projectId), temp = target + '.' + crypto.randomUUID() + '.tmp';
      try {
        await session(temp, async call => {
          await call('create_entities', { entities: graph.entities });
          if (graph.relations.length) await call('create_relations', { relations: graph.relations });
        });
        // Empty graphs may not trigger the upstream writer.
        try { await fs.access(temp); } catch { await fs.writeFile(temp, ''); }
        await fs.rename(temp, target);
        return { backend: BACKEND, projectId, records: records.length, entities: graph.entities.length, relations: graph.relations.length };
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    });
  }
  function search({ projectId, query, limit = 8 }) {
    return exclusive(projectId, async () => {
      if (typeof query !== 'string' || !query.trim()) return { backend: BACKEND, noteIds: [], entities: [], relations: [] };
      const file = fileFor(projectId);
      try { await fs.access(file); } catch { return { backend: BACKEND, noteIds: [], entities: [], relations: [] }; }
      return session(file, async call => {
        const found = await call('search_nodes', { query: query.trim().slice(0, 500) });
        const graph = await call('read_graph');
        const matched = new Set(found.entities.map(e => e.name));
        for (const r of graph.relations) if (r.relationType === 'describes' && matched.has(r.to)) matched.add(r.from);
        const noteIds = [...matched].filter(n => n.startsWith('note:')).map(n => n.slice(5)).slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
        return { backend: BACKEND, noteIds, entities: found.entities.slice(0, 32), relations: found.relations.slice(0, 64), untrusted: true };
      });
    });
  }
  function clearProject(projectId) { return exclusive(projectId, async () => { await fs.rm(fileFor(projectId), { force: true }); return { ok: true }; }); }
  return { syncProject, search, clearProject, backend: BACKEND };
}
module.exports = { createLongTermMemory };
