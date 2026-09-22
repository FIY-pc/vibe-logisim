'use strict';

// The Base Harness should not know which domain owns its dynamic tools.
// A host adapts one domain plugin to the small lifecycle the native Codex
// thread needs: refresh the contract, expose the model-facing tools, and
// dispatch calls. Domain semantics remain inside the plugin.
class AgentToolHost {
  constructor({plugin, manifest, mode = 'plugin'} = {}) {
    if (!plugin || typeof plugin.configure !== 'function' || typeof plugin.call !== 'function') {
      throw new TypeError('动态工具宿主需要提供 configure() 和 call()');
    }
    if (typeof manifest !== 'function') throw new TypeError('动态工具宿主需要提供 manifest()');
    this.plugin = plugin;
    this.manifest = manifest;
    this.mode = mode;
    this.identity = null;
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
  call(request, scope) { return this.plugin.call(request, scope); }
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
