'use strict';
const {createHash} = require('node:crypto');

const CONTRACT = Object.freeze({
  id: 'vibe-logisim.circuit',
  schema: 'vibe-logisim.circuit-plugin/v1',
  resultSchema: 'vibe-logisim.circuit-plugin.result/v1',
});
const invalid = detail => new Error('电路插件协议不匹配：' + detail);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Consume Studio's executable catalog. No second tool/spec list lives here.
class CircuitToolRegistry {
  constructor(manifest, hostExecutors) {
    if (!object(manifest) || Object.entries(CONTRACT).some(([key, value]) => manifest[key] !== value)
        || !/^1\.\d+\.\d+$/.test(manifest.version || '')) throw invalid('版本或结果 schema 不兼容');
    if (!Array.isArray(manifest.tools) || !manifest.tools.length) throw invalid('缺少工具定义');
    const records = new Map();
    for (const raw of manifest.tools) {
      if (!object(raw) || raw.type !== 'function' || !/^[a-z][a-z0-9_]*$/.test(raw.name || '')
          || typeof raw.description !== 'string' || !raw.description.trim()
          || !object(raw.inputSchema) || raw.inputSchema.type !== 'object'
          || !object(raw.inputSchema.properties) || !['studio','host'].includes(raw.owner)
          || !['direct','hidden'].includes(raw.exposure)) throw invalid('工具定义格式错误');
      if (records.has(raw.name)) throw invalid('重复工具：' + raw.name);
      records.set(raw.name, freeze(structuredClone(raw)));
    }
    const assertNames = (names, expected, label) => {
      if (!Array.isArray(names) || names.length !== new Set(names).size
          || names.length !== expected.length || names.some(name => !expected.includes(name))) throw invalid(label);
    };
    const owned = owner => [...records.values()].filter(tool => tool.owner === owner).map(tool => tool.name);
    assertNames(manifest.registeredToolNames, owned('studio'), 'Studio 工具定义与执行器清单不一致');
    assertNames(manifest.hostTools, owned('host'), '宿主工具归属不一致');
    assertNames(owned('host'), Object.keys(hostExecutors), '宿主工具缺少执行器');
    this.records = records;
    this.identity = freeze({id:manifest.id, version:manifest.version, schema:manifest.schema, resultSchema:manifest.resultSchema});
    this.tools = freeze([...records.values()].filter(tool => tool.exposure === 'direct')
      .map(({type,name,description,inputSchema}) => ({type,name,description,inputSchema})));
    // Availability changes with the canvas; the executable contract must stay
    // fixed for a live thread because Codex received it when that thread opened.
    this.signature = createHash('sha256').update(JSON.stringify(canonical({
      ...this.identity, tools:[...records.values()].sort((a,b) => a.name.localeCompare(b.name)),
    }))).digest('hex');
  }
  get(name) { const tool = this.records.get(name); return tool?.exposure === 'direct' ? tool : null; }
  label(name) { return this.records.get(name)?.label || name; }
}

module.exports = {CircuitToolRegistry, CONTRACT};
