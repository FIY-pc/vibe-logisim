"use strict";

const assert = require("node:assert/strict");
const catalog = require("../circuit-lens/studio/domain/circuit-plugin.json");
const {CircuitToolRegistry, CONTRACT} = require("./circuit-tools.cjs");
const {CircuitPlugin} = require("./circuit-plugin.cjs");

const plugin = new CircuitPlugin({invoke: async () => ({}), workspace: null});
const hostExecutors = plugin.hostExecutors;
const registry = new CircuitToolRegistry(catalog, hostExecutors);
const directNames = registry.tools.map(tool => tool.name);

assert.equal(CONTRACT.schema, "vibe-logisim.circuit-plugin/v1");
assert.equal(CONTRACT.resultSchema, "vibe-logisim.circuit-plugin.result/v1");
assert.equal(registry.identity.version, catalog.version);
assert.equal(new Set(directNames).size, directNames.length);
assert.equal(registry.get("harness_run"), null, "the redundant common runner stays internal");
assert.equal(registry.tools.some(tool => tool.name === "harness_run"), false);
assert.equal(registry.get("import_candidate"), null, "internal candidate import must stay hidden");
plugin.configure(catalog);
assert.throws(() => plugin.configure({...catalog, version: "9.0.0"}), /版本/);
const mismatchedOwner = {...catalog, tools: catalog.tools.map(tool =>
  tool.name === 'open_circuit' ? {...tool, owner:'studio'} : tool)};
assert.throws(() => plugin.configure(mismatchedOwner), /owner|执行器/);
assert.throws(() => plugin.configure({...catalog, registeredToolNames:['inspect_circuit']}), /注册|目录/);
assert.throws(() => plugin.configure({...catalog, hostTools:['submit_circuit']}), /注册|目录/);
const updated = {...catalog, version:"1.2.0"};
assert.throws(() => plugin.configure(updated, {live:true}), /重新连接/);
assert.equal(plugin.registry.identity.version, catalog.version, 'failed handshake must preserve the active contract');
plugin.configure(updated);
assert.equal(plugin.registry.identity.version, '1.2.0', 'a new native thread may register the updated contract');

console.log(JSON.stringify({
  plugin: registry.identity.id,
  version: registry.identity.version,
  directToolCount: directNames.length,
  hiddenToolCount: catalog.tools.length - directNames.length,
}));
