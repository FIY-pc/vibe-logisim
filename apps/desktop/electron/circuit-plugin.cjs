'use strict';
const {CircuitToolRegistry} = require('./circuit-tools.cjs');
const {harnessResultEvent} = require('./harness-result.cjs');
const {splitModelContent} = require('./model-tool-output.cjs');

// Owns only domain tool execution. Thread admission, stop, reconnect and the
// model loop remain in CodexBackend. All tools share the selected document, so
// synchronization plus execution is one serialized operation.
class CircuitPlugin {
  constructor({invoke, workspace}) {
    this.invokeDomain = invoke;
    this.workspace = workspace;
    this.registry = null;
    this.queue = Promise.resolve();
    this.hostExecutors = {
      open_circuit: async (_args, _scope, session) => session,
      submit_circuit: async (_args, _scope, session) => session,
      checkout_candidate: async (args, scope) => {
        const result = await this.workspace.checkout(scope.pending.work, args.candidateId, scope.assertCurrent);
        scope.assertCurrent();
        return result;
      },
    };
  }
  configure(manifest, {live = false} = {}) {
    const registry = new CircuitToolRegistry(manifest, this.hostExecutors);
    if (live && this.registry && registry.signature !== this.registry.signature) {
      throw new Error('电路插件工具已更新，请重新连接 AI 后继续；现有对话记录仍保留');
    }
    this.registry = registry;
    return registry;
  }
  call(request, scope) {
    const execute = async () => {
      scope.assertCurrent();
      const tool = this.registry?.get(request.tool);
      if (!tool) throw new Error('电路工具未注册或未向模型开放：' + request.tool);
      const args = request.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须为对象');
      const work = scope.pending.work;
      if (!work || !this.workspace?.synchronize) throw new Error('请先打开文件夹工作区');
      // Host actions must be validated before even selecting or refreshing a file.
      if (tool.owner === 'host') {
        for (const name of tool.inputSchema.required || []) {
          if (typeof args[name] !== 'string' || !args[name].trim()) throw new Error('工具参数需要非空 ' + name);
        }
        if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new Error('工具包含未声明的参数');
      }
      const session = await this.workspace.synchronize(work, request.tool === 'open_circuit' ? args.path : null, scope.assertCurrent);
      scope.assertCurrent();
      scope.updateBinding(session);
      const identity = {
        projectId: scope.pending.projectId,
        revisionId: scope.pending.revisionId,
        threadId: request.threadId,
        turnId: request.turnId,
        callId: request.callId,
        tool: request.tool,
      };
      let domainArgs = args;
      if (request.tool === 'simulate_circuit' && args.vectorsFile !== undefined) {
        if (typeof this.workspace.resolveFile !== 'function') throw new Error('文件输入需要已打开共享文件夹');
        domainArgs = {...args, vectorsFile: this.workspace.resolveFile(work, args.vectorsFile)};
      }
      let result = tool.owner === 'host'
        ? await this.hostExecutors[tool.name](args, scope, session)
        : await this.invokeDomain({...identity, observationId:scope.pending.observationId, arguments:domainArgs});
      scope.assertCurrent();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('电路工具没有返回有效结果');
      const separated = splitModelContent(result);
      result = separated.publicResult;
      if (request.tool === 'simulate_circuit' && result.vectorsFile && args.vectorsFile !== undefined) {
        result = {...result, vectorsFile: {...result.vectorsFile, path: args.vectorsFile}};
      }
      if (tool.owner === 'host') scope.updateBinding(result);
      const finalIdentity = {
        ...identity,
        projectId: scope.pending.projectId,
        revisionId: scope.pending.revisionId,
      };
      if (tool.candidate && result.id?.startsWith('candidate-')) {
        work.candidate = result;
        scope.emit({type:'candidate-ready', candidateId:result.id, title:result.title});
        result = {...result, changes:(result.changes || []).map(({diff,beforeRender,render,...change}) => ({...change,difference:diff?.counts}))};
      }
      const harnessEvent = harnessResultEvent(result, {itemId:request.itemId || null, turnId:request.turnId});
      if (harnessEvent) scope.emit(harnessEvent);
      return {...result, invocation:finalIdentity, modelContentItems:separated.modelContentItems};
    };
    const operation = this.queue.then(execute, execute);
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = {CircuitPlugin};
