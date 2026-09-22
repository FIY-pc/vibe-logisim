'use strict';

// The Base Harness only needs a small workspace lifecycle. The adapter owns
// how a domain prepares files, refreshes a revision, or emits a domain event.
// Keep the mode explicit so the base layer never infers it from a domain
// method such as `synchronize()`.
class AgentWorkspaceHost {
  constructor({adapter, mode = 'workspace'} = {}) {
    if (!adapter || typeof adapter.prepare !== 'function') {
      throw new TypeError('工作区宿主需要提供 prepare()');
    }
    this.adapter = adapter;
    this.mode = mode;
  }

  prepare(...args) { return this.adapter.prepare(...args); }
  finish(...args) {
    return typeof this.adapter.finish === 'function' ? this.adapter.finish(...args) : null;
  }
  abort(...args) {
    return typeof this.adapter.abort === 'function' ? this.adapter.abort(...args) : undefined;
  }
  finishEvent(outcome) {
    return typeof this.adapter.finishEvent === 'function'
      ? this.adapter.finishEvent(outcome)
      : null;
  }
}

module.exports = {AgentWorkspaceHost};
