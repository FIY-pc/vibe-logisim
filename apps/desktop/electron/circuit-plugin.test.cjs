"use strict";

const assert = require("node:assert/strict");
const { circuitPlugin } = require("./circuit-tools.cjs");

const names = circuitPlugin.tools.map(tool => tool.name);
assert.equal(circuitPlugin.schema, "vibe-logisim.circuit-plugin/v1");
assert.equal(circuitPlugin.resultSchema, "vibe-logisim.circuit-plugin.result/v1");
assert.equal(circuitPlugin.id, "vibe-logisim.circuit");
assert.equal(new Set(names).size, names.length, "plugin tool names must be unique");
assert.deepEqual(
  circuitPlugin.capabilities.map(capability => capability.name),
  names,
  "every model-visible tool must have a capability descriptor",
);
assert.equal(circuitPlugin.capabilities.find(item => item.name === "checkout_candidate").sourceMutation, true);
assert.equal(circuitPlugin.capabilities.find(item => item.name === "harness_run").category, "evaluate");
console.log(JSON.stringify({
  plugin: circuitPlugin.id,
  version: circuitPlugin.version,
  capabilityCount: circuitPlugin.capabilities.length,
  sourceMutationTools: circuitPlugin.capabilities.filter(item => item.sourceMutation).map(item => item.name),
}));
