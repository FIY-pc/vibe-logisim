/**
 * Circuit tool execution for one runtime process. Calls are serialized: every
 * tool shares the active document, so synchronizing and executing is one step.
 */
import manifestSource from "./manifest.json" with { type: "json" };
import { splitModelContent } from "../../core/model-tool-output.mts";
import { circuitActionResult, type AgentSession } from "./action-result.mts";
import {
  CircuitToolError,
  attachInvocationIdentity,
  enrichNoCircuitOpen,
  hostToolFailure,
  invocationIdentity,
  modelErrorPayload,
  toolErrorFromException,
  type PendingBinding,
  type ToolRequest,
} from "./errors.mts";
import { projectModelResult, scrubModelResult } from "./projection.mts";
import {
  CircuitToolRegistry,
  type Manifest,
  type ManifestTool,
} from "./registry.mts";
import { validateArguments } from "./validate.mts";
import type { WorkspaceIndex } from "./workspace-index.mts";

export const MANIFEST = manifestSource as Manifest;

/** Host operations available to the tools of one AI turn. */
export interface CircuitTurn {
  /** The cwd the model sees; the only absolute path a result may carry. */
  modelCwd: string;
  workspaceIndex: WorkspaceIndex | null;
  /** Refresh the active document from disk, or select `path` first. */
  sync(request: { path?: string; navigate?: boolean }): Promise<AgentSession>;
  /** Show a definition of the active document; null shows its main circuit. */
  navigate(circuit: string | null): Promise<AgentSession["canvas"]>;
  /** Write a candidate into the active file and refresh it. */
  checkout(candidateId: string): Promise<AgentSession>;
  /** Host path of a workspace-relative file, for runtime inputs only. */
  resolveFile(relative: string): string;
}
export interface ToolContext {
  request: ToolRequest;
  session: AgentSession;
  turn: CircuitTurn;
  assertCurrent(): void;
}
export type ToolHandler = (
  args: Record<string, any>,
  context: ToolContext,
) => Promise<Record<string, any>> | Record<string, any>;
interface Pending extends PendingBinding {
  work?: { turn?: CircuitTurn; workspaceIndex?: WorkspaceIndex | null } | null;
}
export interface ToolScope {
  pending: Pending;
  assertCurrent(): void;
  updateBinding(session: {
    workspace: { id: string | null };
    revision: { id: string | null };
  }): void;
  emit(event: Record<string, unknown>): void;
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bindingOf = (session: AgentSession) => ({
  workspace: { id: session.documentId ?? null },
  revision: { id: session.revision ?? null },
});

function checkHostArguments(tool: ManifestTool, args: Record<string, any>) {
  for (const name of tool.inputSchema.required || [])
    if (typeof args[name] !== "string" || !args[name].trim())
      throw new CircuitToolError(
        "INVALID_ARGUMENT",
        "工具参数需要非空 " + name,
        {
          hint: `补充 ${name} 后再调用此工具。`,
          context: { path: name, expected: "非空字符串" },
        },
      );
  const unknown = Object.keys(args).filter(
    (key) => !Object.hasOwn(tool.inputSchema.properties, key),
  );
  if (unknown.length)
    throw new CircuitToolError("INVALID_ARGUMENT", "工具包含未声明的参数", {
      hint: "删除未出现在工具声明中的参数后重试。",
      context: { unknownParameters: unknown.sort() },
    });
  if (
    args.circuit !== undefined &&
    (typeof args.circuit !== "string" || !args.circuit.trim())
  )
    throw new CircuitToolError("INVALID_ARGUMENT", "工具参数需要非空 circuit", {
      hint: "补充目标电路定义名后再调用此工具。",
      context: { path: "circuit", expected: "非空字符串" },
    });
}

function loadabilityNote(
  status: string,
  {
    electrical,
    fileChange,
    layoutReview,
    turnChanges,
  }: Record<string, any | null>,
) {
  const notes = [
    status === "not-loadable"
      ? "文件刷新成功，但原生 Logisim 无法加载当前电路定义；这不是功能正确性结论。"
      : status === "loadable"
        ? electrical
          ? `原生 Logisim 已加载当前电路定义，但有 ${electrical.count} 个线束把不同位宽的端口接在一起（见 electrical）；这样的电路仿真会得到 X，先修好再验证。`
          : "原生 Logisim 已加载当前电路定义；这不是功能正确性结论。"
        : "文件刷新成功，但原生加载性预检不可用；这不是功能正确性结论。",
  ];
  if (fileChange && fileChange.changed === false)
    notes.push(
      "文件内容与上次工具调用时相同：这次提交没有带来任何改动。若你刚写了文件，确认写的是当前打开的这个 .circ 路径且写入已落盘。",
    );
  else if (fileChange?.outsideTarget?.length)
    notes.push(
      `注意：这次写入还改动了目标电路之外的定义：${fileChange.outsideTarget.join("、")}（见 fileChange.circuits）。若这不是任务要求的，先还原这些定义，别让已通过的子电路失效。`,
    );
  if (layoutReview?.status === "observed") {
    notes.push(
      `当前定义有 ${layoutReview.overlapPairs} 对原生图形边界疑似遮挡（见 layoutReview 的对象和局部 viewport）；这不是美观评分，需看图确认。`,
    );
    if (layoutReview.readingPaths?.nearbyNamedLinks?.length)
      notes.push(
        "layoutReview.readingPaths.nearbyNamedLinks 给出电气共网但靠同名 Tunnel 跳转的相邻运算端口。沿实际图面追踪，判断跳转是否帮助阅读；修正不清楚的局部关系后复看。命名连接本身不是错误，诊断不能代替组织判断。",
      );
    if (layoutReview.otherChangedDefinitions?.length)
      notes.push(
        `本次还改动了 ${layoutReview.otherChangedDefinitions.join("、")}；这些定义尚未包含在本回执的图面检查中，可用 inspect_circuit 的 layoutReview 逐个查看。`,
      );
  }
  if (turnChanges)
    notes.push(
      "turnChanges 累计列出本回合首次已知基线以来的定义改动，包含更早步骤中的子图；它不代表这些定义已验收。结合 CIRCUIT-WORK.md 完成功能、保护和图面工作后再宣称交付。",
    );
  return notes.join(" ");
}

export class CircuitPlugin {
  mode = "circuit";
  registry: CircuitToolRegistry;
  handlers: Record<string, ToolHandler>;
  queue: Promise<unknown> = Promise.resolve();
  hostExecutors: Record<
    string,
    (args: Record<string, any>, context: ToolContext) => Promise<AgentSession>
  >;
  constructor({
    handlers = {},
    manifest = MANIFEST,
  }: { handlers?: Record<string, ToolHandler>; manifest?: Manifest } = {}) {
    this.handlers = handlers;
    this.hostExecutors = {
      open_circuit: async (args, { session, turn, assertCurrent }) => {
        const available = session.project?.circuits || [];
        if (args.circuit !== undefined && !available.includes(args.circuit))
          throw new CircuitToolError(
            "CIRCUIT_NOT_FOUND",
            "文件已载入，但电路定义不存在：" +
              args.circuit +
              "。可用电路：" +
              available.join("、"),
            {
              hint: available.length
                ? "从 context 或上一次 open_circuit 回执的 circuits 中选择一个定义名后重试。"
                : "当前文件没有可用的电路定义；先检查文件内容。",
              context: {
                requested: args.circuit,
                availableCircuits: available,
              },
            },
          );
        const canvas = await turn.navigate(args.circuit ?? null);
        assertCurrent();
        return { ...session, canvas };
      },
      submit_circuit: (_args, context) => this.submit(context),
      checkout_candidate: async (args, { session, turn, assertCurrent }) => {
        if (!session.activeFile)
          throw new CircuitToolError(
            "NO_CIRCUIT_OPEN",
            "先用 open_circuit 选择电路文件",
          );
        const result = await turn.checkout(args.candidateId);
        assertCurrent();
        return result;
      },
    };
    this.registry = new CircuitToolRegistry(manifest, {
      hostTools: Object.keys(this.hostExecutors),
      handlers: Object.keys(handlers),
    });
  }
  get tools() {
    return this.registry.tools;
  }
  async prepare(_options?: { live?: boolean }) {
    return {
      identity: this.registry.identity,
      signature: this.registry.signature,
    };
  }
  get(name: string) {
    return this.registry.get(name);
  }
  label(name: string) {
    return this.registry.label(name);
  }
  errorPayload(error: unknown, request?: ToolRequest, scope?: ToolScope) {
    return modelErrorPayload(error, request, scope?.pending);
  }

  // A loadability failure never fails the call; the receipt carries the status.
  private async submit(context: ToolContext): Promise<AgentSession> {
    const { session, request } = context;
    const circuit =
      session.canvas?.status === "shown"
        ? session.canvas.circuit
        : session.activeCircuit || session.project?.mainCircuit || null;
    if (!circuit)
      return {
        ...session,
        nativeLoadability: {
          status: "unknown",
          circuit: null,
          note: "当前没有可检查的电路定义。刷新文件状态成功，但没有建立原生加载性结论。",
        },
      };
    const check = this.handlers.check_native_loadability;
    if (!check)
      return {
        ...session,
        nativeLoadability: {
          status: "unavailable",
          circuit,
          note: "原生加载性检查通道不可用。刷新文件状态成功，但没有建立加载性结论。",
        },
      };
    try {
      const previousRevisionId = session.previousRevision;
      const turnBaselineRevisionId = session.documentId
        ? session.baselines?.[session.documentId]
        : null;
      // Internal and bounded: no second model tool item, no behavior verdict.
      const observed: any = await check(
        {
          circuit,
          ...(previousRevisionId ? { previousRevisionId } : {}),
          ...(turnBaselineRevisionId ? { turnBaselineRevisionId } : {}),
        },
        {
          ...context,
          request: {
            ...request,
            callId: request.callId ? `${request.callId}:loadability` : null,
            tool: "check_native_loadability",
          },
        },
      );
      if (!object(observed))
        return {
          ...session,
          nativeLoadability: {
            status: "unavailable",
            circuit,
            note: "文件刷新成功，但原生加载性检查没有返回结果；这不是功能正确性结论。",
          },
        };
      const error = object(observed.error)
        ? {
            code: observed.error.code || "EXACT_OBSERVER_FAILED",
            message: observed.error.message || "原生观察失败",
            ...(typeof observed.error.hint === "string" && observed.error.hint
              ? { hint: observed.error.hint }
              : {}),
          }
        : observed.error
          ? { code: "EXACT_OBSERVER_FAILED", message: String(observed.error) }
          : null;
      const status = [
        "loadable",
        "not-loadable",
        "unavailable",
        "unknown",
      ].includes(observed.status)
        ? observed.status
        : error
          ? "not-loadable"
          : "unknown";
      const facts = Object.fromEntries(
        ["electrical", "fileChange", "layoutReview", "turnChanges"].map(
          (key) => [key, object(observed[key]) ? observed[key] : null],
        ),
      );
      return {
        ...session,
        nativeLoadability: {
          status,
          circuit,
          authority: observed.authority || "native-loader",
          ...(error ? { error } : {}),
          ...Object.fromEntries(
            Object.entries(facts).filter(([, value]) => value),
          ),
          note: loadabilityNote(status, facts),
        },
      };
    } catch (error: any) {
      return {
        ...session,
        nativeLoadability: {
          status: "unavailable",
          circuit,
          error: {
            code: error?.code || "LOADABILITY_CHECK_FAILED",
            message: error?.message || String(error),
          },
          note: "文件刷新成功，但加载性检查本身不可用；这不是功能正确性结论。",
        },
      };
    }
  }

  call(request: ToolRequest, scope: ToolScope) {
    const execute = async () => {
      scope.assertCurrent();
      const tool = this.registry.get(request.tool || "");
      if (!tool)
        throw new CircuitToolError(
          "TOOL_NOT_REGISTERED",
          "电路工具未注册或未向模型开放：" + request.tool,
          {
            hint: "只调用当前插件目录中已开放的工具。",
            context: { tool: request.tool || null },
          },
        );
      const args = request.arguments;
      if (!object(args))
        throw new CircuitToolError("INVALID_ARGUMENT", "工具参数必须为对象", {
          hint: "将 arguments 改为当前工具声明的 JSON 对象。",
        });
      const work = scope.pending?.work;
      const turn = work?.turn;
      if (!turn)
        throw new CircuitToolError(
          "WORKSPACE_NOT_OPEN",
          "请先打开文件夹工作区",
          {
            hint: "先打开一个文件夹工作区，再调用电路工具。",
          },
        );
      // Arguments are checked before any file is selected or refreshed.
      if (tool.owner === "host") checkHostArguments(tool, args);
      else
        try {
          validateArguments(tool.inputSchema, args);
        } catch (error) {
          throw toolErrorFromException(tool.name, error);
        }
      const session = await turn.sync(
        tool.name === "open_circuit" ? { path: args.path, navigate: true } : {},
      );
      scope.assertCurrent();
      scope.updateBinding(bindingOf(session));
      const context: ToolContext = {
        request,
        session,
        turn,
        assertCurrent: scope.assertCurrent,
      };
      const domainArgs =
        tool.name === "simulate_circuit" && args.vectorsFile !== undefined
          ? { ...args, vectorsFile: turn.resolveFile(args.vectorsFile) }
          : args;
      let result: Record<string, any>;
      try {
        result =
          tool.owner === "host"
            ? await this.hostExecutors[tool.name](args, context)
            : await this.handlers[tool.name](domainArgs, context);
      } catch (error) {
        throw enrichNoCircuitOpen(
          tool.owner === "host"
            ? hostToolFailure(error)
            : toolErrorFromException(tool.name, error),
          work?.workspaceIndex,
        );
      }
      scope.assertCurrent();
      if (!object(result))
        throw new CircuitToolError(
          "TOOL_INVALID_RESULT",
          "电路工具没有返回有效结果",
          {
            hint: "不要把该结果当作电路事实；检查当前插件连接后再决定是否重试。",
            context: { tool: request.tool },
          },
        );
      const separated = splitModelContent(result);
      result = separated.publicResult;
      if (
        tool.name === "simulate_circuit" &&
        result.vectorsFile &&
        args.vectorsFile !== undefined
      )
        result = {
          ...result,
          vectorsFile: { ...result.vectorsFile, path: args.vectorsFile },
        };
      if (tool.owner === "host") {
        scope.updateBinding(bindingOf(result as AgentSession));
        result = circuitActionResult(result as AgentSession, args);
      }
      if (
        tool.candidate &&
        typeof result.id === "string" &&
        result.id.startsWith("candidate-")
      ) {
        scope.emit({
          type: "candidate-ready",
          turnId: request.turnId || null,
          candidateId: result.id,
          title: result.title,
        });
        result = {
          ...result,
          changes: (result.changes || []).map(
            ({ diff, beforeRender, render, ...change }: any) => ({
              ...change,
              difference: diff?.counts,
            }),
          ),
        };
      }
      const view = scrubModelResult(
        projectModelResult({
          ...result,
          invocation: invocationIdentity(request, scope.pending),
        }),
        turn.modelCwd,
      ) as Record<string, unknown>;
      return { ...view, modelContentItems: separated.modelContentItems };
    };
    const operation = this.queue.then(execute, execute).catch((error) => {
      throw attachInvocationIdentity(error, request, scope.pending);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
