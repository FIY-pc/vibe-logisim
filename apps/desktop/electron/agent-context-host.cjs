'use strict';

// The Base Harness transports prepared model context but does not know the
// domain-specific shape of that context. A provider owns projection and
// additionalContext construction; this adapter owns the lifecycle boundary
// and the shared size guard.
class AgentContextHost {
  constructor({provider, maxBytes = 512 * 1024} = {}) {
    if (!provider || typeof provider.prepare !== 'function' || typeof provider.additionalContext !== 'function') {
      throw new TypeError('上下文宿主需要提供 prepare() 和 additionalContext()');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('上下文大小上限无效');
    this.provider = provider;
    this.maxBytes = maxBytes;
  }

  prepare(context) {
    const prepared = this.provider.prepare(context);
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
      throw new Error('上下文宿主没有返回有效的准备结果');
    }
    const sizeBytes = Number(prepared.sizeBytes);
    if (Number.isFinite(sizeBytes) && sizeBytes > this.maxBytes) {
      const error = new Error('模型上下文超过当前限制，请缩小上下文后再继续。');
      error.code = 'CONTEXT_TOO_LARGE';
      error.context = {sizeBytes, maxBytes:this.maxBytes};
      throw error;
    }
    return prepared;
  }

  additionalContext(prepared, options) {
    return this.provider.additionalContext(prepared, options);
  }
}

module.exports = {AgentContextHost};
