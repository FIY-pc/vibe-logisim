'use strict';
const {CircuitToolRegistry} = require('./circuit-tools.cjs');
const {harnessResultEvent} = require('./harness-result.cjs');
const {splitModelContent} = require('./model-tool-output.cjs');
const {circuitActionResult} = require('./circuit-action-result.cjs');

const ERROR_SCHEMA = 'vibe-logisim.circuit-plugin.error/v1';

function hostToolError(code, message, {retryable = false, hint = null, context = null} = {}) {
  const error = new Error(message);
  error.code = code;
  error.toolError = {
    code,
    message,
    retryable,
    ...(hint ? {hint} : {}),
    ...(context && typeof context === 'object' ? {context} : {}),
  };
  return error;
}

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

function invocationIdentity(request, pending) {
  return {
    projectId: pending?.projectId || null,
    revisionId: pending?.revisionId || null,
    observationId: pending?.observationId || null,
    threadId: request?.threadId || null,
    turnId: request?.turnId || null,
    callId: request?.callId || null,
    tool: request?.tool || null,
  };
}

// Keep the same bounded binding on failed calls as on successful calls. The
// model needs to know which workspace/revision an error belongs to before it
// decides whether to repair, observe, or retry. Do not copy arguments, paths,
// or native stderr into this identity.
function attachInvocationIdentity(error, request, scope) {
  const target = error && typeof error === 'object' ? error : new Error(String(error));
  const current = target.toolError && typeof target.toolError === 'object'
    ? target.toolError
    : {
      code: target.code || 'CIRCUIT_TOOL_FAILED',
      message: target.message || String(target),
      retryable: false,
      hint: '检查当前工作区和连接状态后再决定是否重试。',
    };
  const context = current.context && typeof current.context === 'object' && !Array.isArray(current.context)
    ? current.context
    : {};
  if (context.invocation) return target;
  target.toolError = {
    ...current,
    context: {...context, invocation: invocationIdentity(request, scope?.pending)},
  };
  return target;
}

function modelErrorPayload(error, request, scope) {
  const enriched = attachInvocationIdentity(error, request, scope);
  return {...enriched.toolError, schema: ERROR_SCHEMA};
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
      if (!tool) {
        throw hostToolError('TOOL_NOT_REGISTERED', '电路工具未注册或未向模型开放：' + request.tool, {
          hint: '只调用当前插件目录中已开放的工具。',
          context: {tool: request.tool || null},
        });
      }
      const args = request.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw hostToolError('INVALID_ARGUMENT', '工具参数必须为对象', {
          hint: '将 arguments 改为当前工具声明的 JSON 对象。',
        });
      }
      const work = scope.pending.work;
      if (!work || !this.workspace?.synchronize) {
        throw hostToolError('WORKSPACE_NOT_OPEN', '请先打开文件夹工作区', {
          hint: '先打开一个文件夹工作区，再调用电路工具。',
        });
      }
      // Host actions must be validated before even selecting or refreshing a file.
      if (tool.owner === 'host') {
        const required = tool.inputSchema.required || [];
        for (const name of required) {
          if (typeof args[name] !== 'string' || !args[name].trim()) {
            throw hostToolError('INVALID_ARGUMENT', '工具参数需要非空 ' + name, {
              hint: `补充 ${name} 后再调用此工具。`,
              context: {path: name, expected: '非空字符串'},
            });
          }
        }
        const unknown = Object.keys(args).filter(key => !Object.hasOwn(tool.inputSchema.properties, key));
        if (unknown.length) {
          throw hostToolError('INVALID_ARGUMENT', '工具包含未声明的参数', {
            hint: '删除未出现在工具声明中的参数后重试。',
            context: {unknownParameters: unknown.sort()},
          });
        }
        if (args.circuit !== undefined && (typeof args.circuit !== 'string' || !args.circuit.trim())) {
          throw hostToolError('INVALID_ARGUMENT', '工具参数需要非空 circuit', {
            hint: '补充目标电路定义名后再调用此工具。',
            context: {path: 'circuit', expected: '非空字符串'},
          });
        }
      }
      const viewVersion = this.workspace.canvasVersion();
      const session = await this.workspace.synchronize(work, request.tool === 'open_circuit' ? args.path : null, scope.assertCurrent, {navigate:request.tool==='open_circuit'});
      scope.assertCurrent();
      scope.updateBinding(session);
      const identity = {
        ...invocationIdentity(request, scope.pending),
      };
      let domainArgs = args;
      if (request.tool === 'simulate_circuit' && args.vectorsFile !== undefined) {
        if (typeof this.workspace.resolveFile !== 'function') {
          throw hostToolError('WORKSPACE_NOT_OPEN', '文件输入需要已打开共享文件夹', {
            hint: '先打开文件夹工作区，再使用 vectorsFile。',
          });
        }
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
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw hostToolError('TOOL_INVALID_RESULT', '电路工具没有返回有效结果', {
          hint: '不要把该结果当作电路事实；检查当前插件连接后再决定是否重试。',
          context: {tool: request.tool},
        });
      }
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
      const finalIdentity = invocationIdentity(request, scope.pending);
      if (tool.candidate && result.id?.startsWith('candidate-')) {
        work.candidate = result;
        scope.emit({type:'candidate-ready', candidateId:result.id, title:result.title});
        result = {...result, changes:(result.changes || []).map(({diff,beforeRender,render,...change}) => ({...change,difference:diff?.counts}))};
      }
      const harnessEvent = harnessResultEvent(result, {itemId:request.itemId || null, turnId:request.turnId});
      if (harnessEvent) scope.emit(harnessEvent);
      return {...result, invocation:finalIdentity, modelContentItems:separated.modelContentItems};
    };
    const operation = this.queue.then(execute, execute).catch(error => {
      throw attachInvocationIdentity(error, request, scope);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = {CircuitPlugin, attachInvocationIdentity, modelErrorPayload, ERROR_SCHEMA};
