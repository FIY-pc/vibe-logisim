'use strict';

const FAILURE_LIMIT = 20;
const FAILURE_ENTRY_BYTES = 4 * 1024;
const FAILURE_TOTAL_BYTES = 64 * 1024;
const ARGUMENT_STRING = 200;
const ERROR_STRING = 600;

// JSON-safe copy with every string redacted first, then cut; long arrays and
// deep nesting are summarised so one failure cannot crowd out the others.
function bounded(value, limits, level = 0) {
  if (typeof value === 'string') {
    const text = limits.redact(value);
    return text.length > limits.string ? `${text.slice(0, limits.string)}…(+${text.length - limits.string})` : text;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return value === undefined ? null : String(value);
  if (level >= limits.depth) return Array.isArray(value) ? `[${value.length} 项]` : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, limits.array).map(item => bounded(item, limits, level + 1));
    if (value.length > limits.array) items.push(`…(+${value.length - limits.array} 项)`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, limits, level + 1)]));
}

// One failed call as the model saw it: tool, error code/message/hint and the
// error context (minus the invocation ids), plus the redacted arguments.
// Shrinks in steps until it fits the per-entry budget.
function failureRecord({at, tool, payload, args, redact}) {
  const {invocation, ...context} = payload?.context && typeof payload.context === 'object' ? payload.context : {};
  const error = {
    code: payload?.code || 'TOOL_FAILED',
    message: bounded(String(payload?.message || ''), {redact, string: ERROR_STRING, array: 0, depth: 1}),
    ...(payload?.hint ? {hint: bounded(String(payload.hint), {redact, string: ERROR_STRING, array: 0, depth: 1})} : {}),
    retryable: Boolean(payload?.retryable),
  };
  for (const [array, depth] of [[20, 6], [8, 5], [3, 4], [1, 3]]) {
    const limits = {redact, string: ARGUMENT_STRING, array, depth};
    const record = {at, tool, error, context: bounded(context, limits), arguments: bounded(args ?? null, limits)};
    if (Buffer.byteLength(JSON.stringify(record)) <= FAILURE_ENTRY_BYTES) return record;
  }
  return {at, tool, error, context: '（过长，已省略）', arguments: '（过长，已省略）'};
}

// The Base Harness should not know which domain owns its dynamic tools.
// A host adapts one domain plugin to the small lifecycle the native Codex
// thread needs: refresh the contract, expose the model-facing tools, and
// dispatch calls. Domain semantics remain inside the plugin.
//
// Failed calls are also kept (last 20, bounded, redacted) for the
// diagnostics bundle: a user report of "the AI got stuck on an error" is not
// diagnosable without the exact request the model sent. Successful calls are
// never recorded.
class AgentToolHost {
  constructor({plugin, manifest, mode = 'plugin', failures = {}} = {}) {
    if (!plugin || typeof plugin.configure !== 'function' || typeof plugin.call !== 'function') {
      throw new TypeError('动态工具宿主需要提供 configure() 和 call()');
    }
    if (typeof manifest !== 'function') throw new TypeError('动态工具宿主需要提供 manifest()');
    this.plugin = plugin;
    this.manifest = manifest;
    this.mode = mode;
    this.identity = null;
    this.failureOptions = {
      limit: failures.limit ?? FAILURE_LIMIT,
      redact: failures.redact || (value => value),
      now: failures.now || (() => new Date()),
      onFailure: failures.onFailure || null,
    };
    this.failures = [];
  }

  get registry() { return this.plugin.registry || null; }
  get tools() { return this.registry?.tools || []; }
  get signature() { return this.identity?.signature || null; }

  async prepare({live = false} = {}) {
    const manifest = await this.manifest();
    const registry = this.plugin.configure(manifest, {live});
    this.identity = {...registry.identity, signature:registry.signature};
    return registry;
  }

  get(name) { return this.registry?.get(name) || null; }
  label(name) { return this.registry?.label(name) || name; }
  async call(request, scope) {
    try {
      return await this.plugin.call(request, scope);
    } catch (error) {
      this.recordFailure(error, request, scope);
      throw error;
    }
  }

  recordFailure(error, request, scope) {
    try {
      const {limit, redact, now, onFailure} = this.failureOptions;
      const record = failureRecord({
        at: now().toISOString(),
        tool: request?.tool || null,
        payload: this.errorPayload(error, request, scope),
        args: request?.arguments,
        redact,
      });
      this.failures.push(record);
      while (this.failures.length > limit) this.failures.shift();
      while (this.failures.length > 1 && Buffer.byteLength(JSON.stringify(this.failures)) > FAILURE_TOTAL_BYTES) this.failures.shift();
      onFailure?.(record);
    } catch (_) { /* Diagnostics must never change what the model receives. */ }
  }

  recentFailures() { return this.failures.map(record => structuredClone(record)); }
  errorPayload(error, request, scope) {
    if (typeof this.plugin.modelErrorPayload === 'function') {
      return this.plugin.modelErrorPayload(error, request, scope);
    }
    const toolError = error?.toolError && typeof error.toolError === 'object'
      ? error.toolError
      : {code:error?.code || 'TOOL_FAILED', message:error?.message || String(error), retryable:false};
    return {...toolError, context:{...(toolError.context || {}), invocation:{
      threadId:request?.threadId || null,
      turnId:request?.turnId || null,
      callId:request?.callId || null,
      tool:request?.tool || null,
    }}};
  }
}

module.exports = {AgentToolHost};
