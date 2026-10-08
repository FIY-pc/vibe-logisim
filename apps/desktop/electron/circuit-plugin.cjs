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
          const previousRevisionId = scope.pending.work?.previousRevisionId || null;
          const turnBaselineRevisionId = scope.pending.work?.turnBaselines?.[scope.pending.projectId] || null;
          const observed = await this.invokeDomain({
            projectId: scope.pending.projectId,
            revisionId: scope.pending.revisionId,
            threadId: request?.threadId || null,
            turnId: request?.turnId || null,
            callId: request?.callId ? `${request.callId}:loadability` : null,
            tool: 'check_native_loadability',
            arguments: {circuit, ...(previousRevisionId ? {previousRevisionId} : {}),
              ...(turnBaselineRevisionId ? {turnBaselineRevisionId} : {})},
          });
          if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
            return {...session, nativeLoadability: {
              status: 'unavailable',
              circuit,
              note: '文件刷新成功，但原生加载性检查没有返回结果；这不是功能正确性结论。',
            }};
          }
          const error = observed?.error && typeof observed.error === 'object'
            ? {code: observed.error.code || 'EXACT_OBSERVER_FAILED', message: observed.error.message || '原生观察失败',
               ...(typeof observed.error.hint === 'string' && observed.error.hint ? {hint: observed.error.hint} : {})}
            : observed?.error ? {code: 'EXACT_OBSERVER_FAILED', message: String(observed.error)} : null;
          const status = ['loadable', 'not-loadable', 'unavailable', 'unknown'].includes(observed.status)
            ? observed.status
            : error ? 'not-loadable' : 'unknown';
          const electrical = observed?.electrical && typeof observed.electrical === 'object' ? observed.electrical : null;
          const fileChange = observed?.fileChange && typeof observed.fileChange === 'object' ? observed.fileChange : null;
          const layoutReview = observed?.layoutReview && typeof observed.layoutReview === 'object' ? observed.layoutReview : null;
          const turnChanges = observed?.turnChanges && typeof observed.turnChanges === 'object' ? observed.turnChanges : null;
          const notes = [status === 'not-loadable'
            ? '文件刷新成功，但原生 Logisim 无法加载当前电路定义；这不是功能正确性结论。'
            : status === 'loadable'
              ? (electrical
                ? `原生 Logisim 已加载当前电路定义，但有 ${electrical.count} 个线束把不同位宽的端口接在一起（见 electrical）；这样的电路仿真会得到 X，先修好再验证。`
                : '原生 Logisim 已加载当前电路定义；这不是功能正确性结论。')
              : '文件刷新成功，但原生加载性预检不可用；这不是功能正确性结论。'];
          if (fileChange && fileChange.changed === false) {
            notes.push('文件内容与上次工具调用时相同：这次提交没有带来任何改动。若你刚写了文件，确认写的是当前打开的这个 .circ 路径且写入已落盘。');
          } else if (fileChange?.outsideTarget?.length) {
            notes.push(`注意：这次写入还改动了目标电路之外的定义：${fileChange.outsideTarget.join('、')}（见 fileChange.circuits）。若这不是任务要求的，先还原这些定义，别让已通过的子电路失效。`);
          }
          if (layoutReview?.status === 'observed') {
            notes.push(`当前定义有 ${layoutReview.overlapPairs} 对原生图形边界疑似遮挡（见 layoutReview 的对象和局部 viewport）；这不是美观评分，需看图确认。`);
            if (layoutReview.readingPaths?.nearbyNamedLinks?.length) {
              notes.push('layoutReview.readingPaths.nearbyNamedLinks 给出电气共网但靠同名 Tunnel 跳转的相邻运算端口。沿实际图面追踪，判断跳转是否帮助阅读；修正不清楚的局部关系后复看。命名连接本身不是错误，诊断不能代替组织判断。');
            }
            if (layoutReview.otherChangedDefinitions?.length) {
              notes.push(`本次还改动了 ${layoutReview.otherChangedDefinitions.join('、')}；这些定义尚未包含在本回执的图面检查中，可用 inspect_circuit 的 layoutReview 逐个查看。`);
            }
          }
          if (turnChanges) {
            notes.push('turnChanges 累计列出本回合首次已知基线以来的定义改动，包含更早步骤中的子图；它不代表这些定义已验收。结合 CIRCUIT-WORK.md 完成功能、保护和图面工作后再宣称交付。');
          }
          return {...session, nativeLoadability: {
            status,
            circuit,
            authority: observed?.authority || 'native-loader',
            ...(error ? {error} : {}),
            ...(electrical ? {electrical} : {}),
            ...(fileChange ? {fileChange} : {}),
            ...(layoutReview ? {layoutReview} : {}),
            ...(turnChanges ? {turnChanges} : {}),
            note: notes.join(' '),
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
  modelErrorPayload(error, request, scope) {
    return modelErrorPayload(error, request, scope);
  }
}

module.exports = {CircuitPlugin, attachInvocationIdentity, modelErrorPayload, ERROR_SCHEMA};
