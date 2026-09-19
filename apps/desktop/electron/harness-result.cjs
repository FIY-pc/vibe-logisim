'use strict';

const MAX_PREVIEW = 4096;

function clipped(value) {
  if (typeof value !== 'string') return value;
  return value.length <= MAX_PREVIEW ? value : value.slice(0, MAX_PREVIEW) + '\n…(结果预览已截断)';
}

function previewObservation(observation) {
  if (observation == null) return null;
  if (typeof observation !== 'object' || Array.isArray(observation)) return clipped(String(observation));
  const preview = {};
  for (const key of ['id', 'label', 'schema', 'status', 'summary', 'message', 'error', 'stdout', 'stderr', 'exitCode', 'timedOut', 'durationMs', 'circuit']) {
    if (observation[key] !== undefined) preview[key] = clipped(observation[key]);
  }
  if (observation.parsed !== undefined) {
    try {
      const serialized = JSON.stringify(observation.parsed);
      preview.parsed = serialized.length <= MAX_PREVIEW ? observation.parsed : serialized.slice(0, MAX_PREVIEW) + '\n…(解析结果预览已截断)';
    } catch {
      preview.parsed = '[无法预览解析结果]';
    }
  }
  if (Object.keys(preview).length) return preview;
  try {
    return clipped(JSON.stringify(observation));
  } catch {
    return '[无法预览验证结果]';
  }
}

function harnessResultEvent(result, {itemId = null, turnId = null} = {}) {
  if (!result || typeof result !== 'object') return null;
  const feedback = result.feedback && typeof result.feedback === 'object' ? result.feedback : null;
  if (!feedback) return null;
  return {
    type: 'harness-result',
    itemId,
    turnId,
    // session remains for the native runtime's existing locate action.
    // binding/run are the protocol-level identity for every result kind.
    session: result.session || null,
    binding: result.binding || result.session || null,
    run: result.run || null,
    feedback,
    observation: previewObservation(result.result),
  };
}

module.exports = {harnessResultEvent, previewObservation};
