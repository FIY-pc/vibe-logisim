'use strict';

const {isDeepStrictEqual} = require('node:util');

// Only the model transport consumes this projection. Studio/UI/history keep
// their original response. Known duplicate metadata has one canonical location,
// checked against the complete value in THIS result. No decoder/map is sent.
// This is not a recursive JSON compressor: rows, ports, nets, stimuli, errors,
// execution identity and unknown/future fields are never scanned or truncated.
// Identifies the checked-in contract, not a field added to each model response.
const MODEL_OUTPUT_SCHEMA = 'vibe-logisim.canonical-model-view/v1';
const RESULT_SCHEMA = 'vibe-logisim.circuit-plugin.result/v1';

// All tools that return the result envelope carry the same binding/run
// metadata inside their observation for legacy consumers. Keep the model
// transport canonical for the combined harness entry point as well.
const BOUND_TOOLS = new Set([
  'trace_circuit', 'evaluate_circuit', 'render_circuit', 'harness_run',
  'compare_circuit', 'run_verification',
]);

// Paths are fixed JSON Pointers, never supplied by a tool or user. Sources do
// not overlap destinations; the canonical value is always directly available.
const BOUND_DUPLICATES = [
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
  ['/result/run', '/run'],
  ['/result/runId', '/run/id'],
  ['/result/stimulusSha256', '/run/stimulusSha256'],
  ['/result/authority', '/run/authority'],
  ['/session/mode', '/run/mode'],
  ['/session/authority', '/run/authority'],
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
  if (result.schema === RESULT_SCHEMA && BOUND_TOOLS.has(tool)) rules = BOUND_DUPLICATES;
  else if (!Object.hasOwn(result, 'schema') && tool === 'inspect_circuit') return projectInspection(result);
  else return result;

  let projected;
  for (const [destination, source] of rules) {
    const original = at(result, destination), canonical = at(result, source);
    // Nulls (including unknown observations) and absent fields stay verbatim.
    if (original == null || !isDeepStrictEqual(original, canonical)) continue;
    projected ||= structuredClone(result);
    const target = parent(projected, destination);
    delete target.value[target.key];
  }
  return projected || result;
}

function projectInspection(result) {
  const template = result.objectReferenceTemplate;
  // Reuse the existing COMPONENT_ID template contract. Ambiguous templates or
  // IDs that would require a different escaping/substitution rule stay intact.
  if (typeof template !== 'string' || !template.startsWith('circuit://object?')
      || template.split('COMPONENT_ID').length !== 2
      || !/[?&]componentId=COMPONENT_ID(?:&|$)/.test(template)
      || !Array.isArray(result.components)) return result;
  let projected;
  result.components.forEach((component, index) => {
    if (!component || typeof component.componentId !== 'string'
        || !/^[A-Za-z0-9._~-]+$/.test(component.componentId)
        || typeof component.reference !== 'string'
        || component.reference !== template.replace('COMPONENT_ID', component.componentId)) return;
    projected ||= structuredClone(result);
    delete projected.components[index].reference;
  });
  return projected || result;
}

module.exports = {MODEL_OUTPUT_SCHEMA, projectModelResult};
