'use strict';
const {CircuitToolRegistry} = require('./circuit-tools.cjs');
const {harnessResultEvent} = require('./harness-result.cjs');
const {splitModelContent} = require('./model-tool-output.cjs');
const {circuitActionResult} = require('./circuit-action-result.cjs');

function enrichNoCircuitOpen(error, workspaceIndex) {
  const toolError = error?.toolError;
  if (!toolError || toolError.code !== 'NO_CIRCUIT_OPEN') return error;
  const circuits = Array.isArray(workspaceIndex?.circuits) ? workspaceIndex.circuits : [];
  const availableFiles = circuits.map(file => ({
    path: file.path,
    mainCircuit: file.mainCircuit || null,
    circuits: Array.isArray(file.circuits)
      ? file.circuits.map(circuit => ({
        name: circuit.name,
        components: circuit.components,
        wireSegments: circuit.wireSegments,
      }))
      : [],
  }));
  error.toolError = {
    ...toolError,
    hint: availableFiles.length
      ? '先从 context.availableFiles 选择目标 .circ 的 path，再调用 open_circuit({path, circuit})；不要根据文件名猜测电路定义。'
      : '当前工作区索引中没有可用的 .circ 文件；先确认文件已放入工作区，再调用 open_circuit。',
    context: {
      ...(toolError.context || {}),
      availableFiles,
      indexTruncated: Boolean(workspaceIndex?.truncated),
    },
  };
  return error;
}

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
      open_circuit: async (args, scope, session, viewVersion) => this.workspace.navigate(scope.pending.work,session,args.circuit,scope.assertCurrent,viewVersion),
      submit_circuit: async (_args, scope, session, _viewVersion, request) => {
        const circuit = session?.canvas?.status === 'shown'
          ? session.canvas.circuit
          : session?.activeCircuit || session?.project?.mainCircuit || null;
        if (!circuit) {
          return {...session, nativeLoadability: {
            status: 'unknown',
            circuit: null,
            note: '当前没有可检查的电路定义。刷新文件状态成功，但没有建立原生加载性结论。',
          }};
        }
        if (typeof this.invokeDomain !== 'function') {
          return {...session, nativeLoadability: {
            status: 'unavailable', circuit,
            note: '原生加载性检查通道不可用。刷新文件状态成功，但没有建立加载性结论。',
          }};
        }
        try {
          // This is an internal, bounded observer call. It does not create a
          // second model tool item or turn submit into a behavior verdict.
          const observed = await this.invokeDomain({
            projectId: scope.pending.projectId,
            revisionId: scope.pending.revisionId,
            threadId: request?.threadId || null,
            turnId: request?.turnId || null,
            callId: request?.callId ? `${request.callId}:loadability` : null,
            tool: 'check_native_loadability',
            arguments: {circuit},
          });
          if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
            return {...session, nativeLoadability: {
              status: 'unavailable',
              circuit,
              note: '文件刷新成功，但原生加载性检查没有返回结果；这不是功能正确性结论。',
            }};
          }
          const error = observed?.error && typeof observed.error === 'object'
            ? {code: observed.error.code || 'EXACT_OBSERVER_FAILED', message: observed.error.message || '原生观察失败'}
            : observed?.error ? {code: 'EXACT_OBSERVER_FAILED', message: String(observed.error)} : null;
          const status = ['loadable', 'not-loadable', 'unavailable', 'unknown'].includes(observed.status)
            ? observed.status
            : error ? 'not-loadable' : 'unknown';
          return {...session, nativeLoadability: {
            status,
            circuit,
            authority: observed?.authority || 'native-loader',
            ...(error ? {error} : {}),
            note: status === 'not-loadable'
              ? '文件刷新成功，但原生 Logisim 无法加载当前电路定义；这不是功能正确性结论。'
              : status === 'loadable'
                ? '原生 Logisim 已加载当前电路定义；这不是功能正确性结论。'
                : '文件刷新成功，但原生加载性预检不可用；这不是功能正确性结论。',
          }};
        } catch (error) {
          return {...session, nativeLoadability: {
            status: 'unavailable',
            circuit,
            error: {code: error.code || 'LOADABILITY_CHECK_FAILED', message: error.message || String(error)},
            note: '文件刷新成功，但加载性检查本身不可用；这不是功能正确性结论。',
          }};
        }
      },
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
        if(args.circuit !== undefined && (typeof args.circuit !== 'string' || !args.circuit.trim()))throw new Error('工具参数需要非空 circuit');
      }
      const viewVersion = this.workspace.canvasVersion();
      const session = await this.workspace.synchronize(work, request.tool === 'open_circuit' ? args.path : null, scope.assertCurrent, {navigate:request.tool==='open_circuit'});
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
      let result;
      try {
        result = tool.owner === 'host'
          ? await this.hostExecutors[tool.name](args, scope, session, viewVersion, request)
          : await this.invokeDomain({...identity, observationId:scope.pending.observationId, arguments:domainArgs});
      } catch (error) {
        throw enrichNoCircuitOpen(error, work.workspaceIndex);
      }
      scope.assertCurrent();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('电路工具没有返回有效结果');
      const separated = splitModelContent(result);
      result = separated.publicResult;
      if (request.tool === 'simulate_circuit' && result.vectorsFile && args.vectorsFile !== undefined) {
        result = {...result, vectorsFile: {...result.vectorsFile, path: args.vectorsFile}};
      }
      if (tool.owner === 'host') {
        scope.updateBinding(result);
        result = {...result,canvas:result.canvas ?? this.workspace.canvasState(result)};
        result = circuitActionResult(result, args);
      }
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
