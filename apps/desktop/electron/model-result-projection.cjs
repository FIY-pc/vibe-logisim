'use strict';

const {isDeepStrictEqual} = require('node:util');

// Only the model transport consumes this projection. Studio/UI/history keep
// their original response. Known duplicate metadata becomes an explicit alias;
// every alias is equality-checked against a still-present value in THIS result.
// This is not a recursive JSON compressor: rows, ports, nets, stimuli, errors,
// execution identity and unknown/future fields are never scanned or truncated.
const MODEL_OUTPUT_SCHEMA = 'vibe-logisim.model-tool-output/v1';
const RESULT_SCHEMA = 'vibe-logisim.circuit-plugin.result/v1';
const SESSION_SCHEMA = 'vibe-logisim.circuit-lens/v0';

const BOUND_TOOLS = new Set(['trace_circuit', 'evaluate_circuit', 'render_circuit']);
const HOST_TOOLS = new Set(['open_circuit', 'submit_circuit']);

// Paths are fixed JSON Pointers, never supplied by a tool or user. Sources do
// not overlap destinations, so aliases are always one hop and order independent.
const BOUND_ALIASES = [
  ['/result/binding', '/binding'],
  ['/runtimeProfile', '/binding/runtimeProfile'],
  ['/result/runtimeProfile', '/binding/runtimeProfile'],
  ...['runtimeProfileId', 'artifactSha256', 'revisionId', 'circuit', 'candidateId'].flatMap(key => [
    [`/${key}`, `/binding/${key}`],
    [`/result/${key}`, `/binding/${key}`],
    [`/session/${key}`, `/binding/${key}`],
  ]),
  ['/invocation/projectId', '/binding/projectId'],
  ['/invocation/revisionId', '/binding/revisionId'],
  ['/run/runtimeProfileId', '/binding/runtimeProfileId'],
  ['/result/schema', '/schema'],
  ['/result/plugin', '/plugin'],
  ['/result/runId', '/run/id'],
  ['/result/stimulusSha256', '/run/stimulusSha256'],
  ['/result/authority', '/run/authority'],
  ['/session/mode', '/run/mode'],
  ['/session/authority', '/run/authority'],
];
const HOST_ALIASES = [
  ['/capabilities/profile', '/capabilities/observationProfile'],
  ['/invocation/projectId', '/workspace/id'],
  ['/invocation/revisionId', '/revision/id'],
  ['/workspace/currentRevisionId', '/revision/id'],
  ['/workspace/savedRevisionId', '/revision/id'],
  ['/sourceStatus/currentSha256', '/revision/artifactSha256'],
];

function at(value, pointer) {
  for (const key of pointer.slice(1).split('/')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function parent(value, pointer) {
  const keys = pointer.slice(1).split('/');
  const key = keys.pop();
  for (const part of keys) value = value[part];
  return {value, key};
}

function projectModelResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.hasOwn(result, 'modelProjection') || result.error != null) return result;
  const tool = result.invocation?.tool;
  let rules;
  if (result.schema === RESULT_SCHEMA && BOUND_TOOLS.has(tool)) rules = BOUND_ALIASES;
  else if (result.schema === SESSION_SCHEMA && HOST_TOOLS.has(tool)) rules = HOST_ALIASES;
  else return result;

  const aliases = {};
  for (const [destination, source] of rules) {
    const original = at(result, destination), canonical = at(result, source);
    // Nulls (including unknown observations) and absent fields stay verbatim.
    if (original == null || !isDeepStrictEqual(original, canonical)) continue;
    const key = destination.slice(destination.lastIndexOf('/') + 1);
    const removedBytes = Buffer.byteLength(JSON.stringify({[key]:original}));
    const aliasBytes = Buffer.byteLength(JSON.stringify({[destination]:source}));
    if (removedBytes > aliasBytes) aliases[destination] = source;
  }
  if (!Object.keys(aliases).length) return result;

  const projected = structuredClone(result);
  for (const destination of Object.keys(aliases)) {
    const target = parent(projected, destination);
    delete target.value[target.key];
  }
  projected.modelProjection = {schema:MODEL_OUTPUT_SCHEMA, aliases};
  // A small result can cost more to describe than it saves. In that case send
  // the original JSON; there is no imposed response-size budget or pagination.
  return Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(JSON.stringify(result))
    ? projected : result;
}

module.exports = {MODEL_OUTPUT_SCHEMA, projectModelResult};
