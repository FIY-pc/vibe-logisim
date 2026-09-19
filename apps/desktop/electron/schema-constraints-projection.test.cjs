'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const catalog = require('../circuit-lens/studio/domain/circuit-plugin.json');
const projection = require('./schema-constraints-projection.cjs');
const {CircuitToolRegistry} = require('./circuit-tools.cjs');
const executors = Object.fromEntries(catalog.hostTools.map(name => [name, () => {}]));

test('projection preserves executable catalog, optionality, descriptions and hidden exposure', () => {
  const original = structuredClone(catalog);
  const registry = new CircuitToolRegistry(catalog, executors);
  assert.deepEqual(catalog, original);
  for (const raw of catalog.tools) {
    assert.deepEqual(registry.records.get(raw.name), raw);
    const visible = registry.tools.find(t => t.name === raw.name);
    if (raw.exposure === 'hidden') { assert.equal(visible, undefined); continue; }
    assert.deepEqual(visible.inputSchema, raw.inputSchema);
    assert.ok(visible.description.startsWith(raw.description));
    assert.equal(registry.get(raw.name).description, raw.description, 'executor sees the original spec');
  }
  assert.match(registry.tools.find(t => t.name === 'inspect_circuit').description, /wireLimit: integer 1\.\.512/);
  assert.match(registry.tools.find(t => t.name === 'evaluate_circuit').description, /buttonEvents, inputEvents: <=1000 items/);
  assert.match(registry.tools.find(t => t.name === 'evaluate_circuit').description, /expectedRows\[\]\.values: >=1 properties/);
});

test('generic bounds cover zero, negative, decimal, nested arrays and map values without schema duplication', () => {
  const inputSchema = {type:'object', properties:{
    choices:{type:'string', enum:['on','off']},
    steps:{type:'array', minItems:0, maxItems:2, items:{type:'object', properties:{
      offset:{type:'integer', minimum:-4, maximum:0, multipleOf:2},
      gain:{type:'number', minimum:0.05, maximum:32},
      data:{type:'object', minProperties:1, additionalProperties:{type:'array', maxItems:3,
        items:{type:'string', minLength:1, maxLength:8}}},
    }}},
    'a.b':{type:'integer', maximum:0},
  }, additionalProperties:false};
  const projected = projection.projectToolInterface({type:'function', name:'unrelated_tool', description:'Existing semantics.', inputSchema});
  assert.equal(projected.inputSchema, inputSchema);
  assert.match(projected.description, /steps: 0\.\.2 items/);
  assert.match(projected.description, /steps\[\]\.offset: integer -4\.\.0, multiple of 2/);
  assert.match(projected.description, /steps\[\]\.gain: 0\.05\.\.32/);
  assert.match(projected.description, /steps\[\]\.data: >=1 properties/);
  assert.match(projected.description, /steps\[\]\.data\.\*: <=3 items/);
  assert.match(projected.description, /steps\[\]\.data\.\*\[\]: 1\.\.8 characters/);
  assert.ok(projected.description.includes('["a.b"]: integer <=0'));
  assert.ok(!projected.description.includes('choices'), 'do not repeat enums already rendered in TS');
  const unbounded = {type:'function', name:'plain', description:'Plain.', inputSchema:{type:'object', properties:{name:{type:'string'}}}};
  assert.deepEqual(projection.projectToolInterface(unbounded), unbounded);
});

test('schema changes flow through without tool-specific constants', () => {
  const changed = structuredClone(catalog);
  changed.tools.find(t => t.name === 'inspect_circuit').inputSchema.properties.wireLimit.maximum = 37;
  const registry = new CircuitToolRegistry(changed, executors);
  assert.match(registry.tools.find(t => t.name === 'inspect_circuit').description, /wireLimit: integer 1\.\.37/);
  assert.notEqual(registry.signature, new CircuitToolRegistry(catalog, executors).signature);
});

test('signature includes the actual projected interface even when the catalog version is unchanged', () => {
  const registry = new CircuitToolRegistry(catalog, executors);
  // Load the same registry with a changed renderer, not a changed manifest.
  // A future wording/projection change must invalidate an old native binding.
  const sandbox = {module:{exports:{}}, structuredClone, require:name => name === './schema-constraints-projection.cjs'
    ? {projectToolInterface:tool => ({...projection.projectToolInterface(tool), description:projection.projectToolInterface(tool).description + '\nFixture interface change.'})}
    : require(name)};
  vm.runInNewContext(fs.readFileSync(require.resolve('./circuit-tools.cjs'), 'utf8'), sandbox);
  const changed = new sandbox.module.exports.CircuitToolRegistry(catalog, executors);
  assert.equal(changed.identity.version, registry.identity.version);
  assert.notEqual(changed.signature, registry.signature);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const legacySignature = createHash('sha256').update(JSON.stringify(canonical({
    ...registry.identity, tools:[...registry.records.values()].sort((a,b) => a.name.localeCompare(b.name)),
  }))).digest('hex');
  assert.notEqual(registry.signature, legacySignature, 'existing 1.9 threads need a new binding');
  const reordered = structuredClone(catalog);
  reordered.tools.reverse();
  for (const tool of reordered.tools) tool.inputSchema.properties = Object.fromEntries(Object.entries(tool.inputSchema.properties).reverse());
  assert.equal(new CircuitToolRegistry(reordered, executors).signature, registry.signature, 'key/registration order is not a capability change');
});
