import { systemProxy, networkFetch, closeNetwork } from "./network.mts";
import {
  previewHistory,
  importHistory,
  historyContext,
} from "./history-import.mts";
/** Process adapter for the existing runtime. stdout is exclusively JSONL. */
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createCodexInstaller } from "./installer.mts";
const require = createRequire(import.meta.url);
const { AgentRuntime } = require("../core/agent-runtime.cjs");
const editSchema = require("./generated/edit-schema.json");
const editDefinitions = editSchema.$defs;
delete editSchema.$defs;
delete editSchema.$schema;
const state = path.resolve(process.argv[2]);
const workDir = path.join(state, "agent-workspace");
await mkdir(workDir, { recursive: true });
const send = (message: unknown) =>
  process.stdout.write(JSON.stringify(message) + "\n");
const requests = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const host = (request: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = randomUUID();
    requests.set(id, { resolve, reject });
    send({ kind: "host", id, request });
  });
let binding: any = null;
const toolHost = {
  tools: [
    {
      name: "project_files",
      description:
        "List or read text files in the active document's project folder. Paths are relative. Reads never modify the source. For PDF excerpts use the user's cited page text; binary files are not interpreted as text.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative file or directory path; empty lists the root",
          },
          read: {
            type: "boolean",
            description: "true to read a text file; false to list a directory",
          },
        },
        required: ["path", "read"],
        additionalProperties: false,
      },
    },
    {
      name: "kept_observations",
      description:
        "Read retained simulation observations for this document. Each carries its exact source revision, instance path and watched signals. Historical values do not describe the current draft unless those identities match.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "read_circuit",
      description: "Read the active circuit document, revision and source XML.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "observe_circuit",
      description:
        "Inspect connectivity and component geometry using the compatible Logisim runtime.",
      inputSchema: {
        type: "object",
        properties: { circuit: { type: "string" } },
        required: ["circuit"],
        additionalProperties: false,
      },
    },
    {
      name: "render_circuit",
      description:
        "Render the current circuit through Logisim. Coordinates are world coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          circuit: { type: "string" },
          x: { type: "integer" },
          y: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          scale: { type: "number" },
        },
        required: ["circuit", "x", "y", "width", "height", "scale"],
        additionalProperties: false,
      },
    },
    {
      name: "simulate_circuit",
      description:
        "Run 1–256 independent input vectors in a separate native simulation. Each vector starts from fresh state. Use Pin labels and unsigned integer values; every input Pin must be supplied. Optional expected output values produce explicit pass/fail results. This does not alter the user's live simulation or source. Use trace_circuit for sequential behavior.",
      inputSchema: {
        type: "object",
        properties: {
          circuit: { type: "string" },
          vectors: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: {
              type: "object",
              properties: {
                inputs: {
                  type: "object",
                  additionalProperties: {
                    type: "integer",
                    minimum: 0,
                    maximum: 4294967295,
                  },
                },
                expected: {
                  type: "object",
                  additionalProperties: {
                    type: "integer",
                    minimum: 0,
                    maximum: 4294967295,
                  },
                },
              },
              required: ["inputs"],
              additionalProperties: false,
            },
          },
        },
        required: ["circuit", "vectors"],
        additionalProperties: false,
      },
    },
    {
      name: "trace_circuit",
      description:
        "Run a fresh isolated sequential simulation for 1–256 native ticks. Supply initial input Pin values by label and exact component IDs/port indexes to watch. Samples include tick 0 and every requested tick. Input events apply before sampling their tick, in array order. Results expose unknown bits and oscillation; they do not modify the user's live simulation or source.",
      inputSchema: {
        type: "object",
        properties: {
          circuit: { type: "string" },
          ticks: { type: "integer", minimum: 1, maximum: 256 },
          inputs: {
            type: "object",
            additionalProperties: {
              type: "integer",
              minimum: 0,
              maximum: 4294967295,
            },
          },
          watches: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              properties: {
                component: { type: "string" },
                port: { type: "integer", minimum: 0, maximum: 255 },
              },
              required: ["component", "port"],
              additionalProperties: false,
            },
          },
          events: {
            type: "array",
            maxItems: 1024,
            items: {
              type: "object",
              properties: {
                tick: { type: "integer", minimum: 0 },
                input: { type: "string" },
                value: { type: "integer", minimum: 0, maximum: 4294967295 },
              },
              required: ["tick", "input", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["circuit", "ticks", "inputs", "watches"],
        additionalProperties: false,
      },
    },
    {
      name: "edit_circuit",
      description:
        "Apply a structural edit to the active in-memory document. Supply the revision from read_circuit. Editing does not save the source file.",
      inputSchema: {
        type: "object",
        properties: {
          revision: { type: "string" },
          circuit: { type: "string" },
          edit: editSchema,
        },
        required: ["revision", "circuit", "edit"],
        additionalProperties: false,
        $defs: editDefinitions,
      },
    },
  ],
  mode: "native-workspace",
  async prepare() {
    return {
      identity: { id: "vibe.native-circuit", version: "1" },
      signature: createHash("sha256")
        .update(JSON.stringify(this.tools))
        .digest("hex"),
    };
  },
  get(name: string) {
    return this.tools.find((t) => t.name === name);
  },
  label: (name: string) =>
    ({
      read_circuit: "读取电路",
      project_files: "读取工程资料",
      kept_observations: "读取留存观察",
      observe_circuit: "检查电路",
      render_circuit: "查看电路",
      edit_circuit: "修改电路",
      simulate_circuit: "验证测试向量",
      trace_circuit: "验证时序",
    })[name] || name,
  errorPayload: (e: Error) => ({ message: e.message }),
  async call(request: any, scope: any) {
    scope.assertCurrent();
    if (!binding) throw new Error("没有活动电路");
    const id = binding.id;
    if (request.tool === "project_files") {
      if (!binding.folderId) throw new Error("当前电路没有所属的工程文件夹");
      const result = await host({
        op: "projectFiles",
        id,
        folder_id: binding.folderId,
        path: request.arguments.path,
        read: request.arguments.read,
      });
      return request.arguments.read ? result : { entries: result };
    }
    if (request.tool === "kept_observations") {
      const records = await host({ op: "observations", id });
      return {
        observations: records.map(({ frame, ...record }: any) => ({
          ...record,
          state: frame.attributes,
          trace: frame.children.find((n: any) => n.tag === "trace"),
        })),
      };
    }
    if (request.tool === "read_circuit") {
      const document = await host({ op: "read", id });
      const source = await host({
        op: "source",
        id,
        revision: document.revision,
      });
      return { ...document, ...source };
    }
    const current = await host({ op: "read", id });
    const op = (
      {
        observe_circuit: "observe",
        render_circuit: "render",
        edit_circuit: "edit",
        simulate_circuit: "simulate",
        trace_circuit: "trace",
      } as Record<string, string>
    )[request.tool];
    if (!op) throw new Error("未知的电路工具");
    const result = await host({
      ...request.arguments,
      op,
      id,
      revision: request.arguments.revision || current.revision,
    });
    if (op === "edit") {
      send({
        kind: "event",
        event: { type: "document-changed", document: result },
      });
      binding = { ...binding, revision: result.revision };
      scope.updateBinding?.({
        workspace: { id },
        revision: { id: result.revision },
      });
    }
    if (op === "render")
      return {
        circuit: request.arguments.circuit,
        modelContentItems: [
          {
            type: "inputImage",
            mimeType: "image/png",
            imageData: result.image.split(",")[1],
          },
        ],
      };
    return result;
  },
};
const {
  installer: runtimeInstaller,
  codexRoot,
  codex,
} = await createCodexInstaller(state);
const instructions =
  "You collaborate on digital circuits in Vibe Logisim. Respond in the user language and send concise progress messages before tools. The Rust host owns the current document and revision. Use read_circuit, observe_circuit, render_circuit, and edit_circuit to work on that shared document. Editing does not save the user source file. Native observations are authoritative for electrical facts. simulate_circuit tests independent vectors and trace_circuit tests tick sequences in an isolated native simulation, leaving the user live simulation unchanged. project_files reads text files from the active project folder without writing them. kept_observations reads historical simulation evidence; check revision and instance identity before comparing. The general file tools operate in a scratch workspace, not the original project. A copy named circuit.circ is prepared for direct edits and scripts; changed content is offered to the user for explicit application at the end of the turn. Keep unknown XML, libraries and unrelated circuits. Circuit organization is part of delivery: preserve behavior and make the resulting drawing readable. Never invent tool results or claim you inspected an image if it was not delivered as image input.";
const backend = new AgentRuntime({
  resolveProxy: systemProxy,
  networkFetch,
  profileDir: path.join(state, "profile"),
  sessionStorePath: path.join(state, "conversations.json"),
  workDir,
  toolHost,
  instructions,
  developerInstructions: instructions,
  includeAgentContext: true,
  startOnResume: false,
  contextHost: {
    prepare(context: any) {
      return {
        frozenContext: {
          projectId: context.projectId,
          revisionId: context.revisionId,
          circuit: context.circuit,
          selection: context.selection,
        },
        history: context.transferredHistory,
      };
    },
    additionalContext(prepared: any) {
      return {
        ...prepared.frozenContext,
        ...(prepared.history
          ? { "vibe-logisim.transferred-history": prepared.history }
          : {}),
      };
    },
  },
  ownProfile: true,
  nodeExecutable: process.execPath,
  codex,
  codexRoot,
  runtimeInstaller,
  workspaceHost: {
    mode: "review",
    async prepare(revision: string) {
      const source = await host({ op: "source", id: binding.id, revision });
      await writeFile(path.join(workDir, "circuit.circ"), source.xml);
      return {
        projectId: binding.id,
        revisionId: revision,
        original: source.xml,
      };
    },
    async finish(work: any) {
      const xml = await readFile(path.join(workDir, "circuit.circ"), "utf8");
      return xml === work.original
        ? null
        : {
            type: "proposed-source",
            documentId: work.projectId,
            revision: work.revisionId,
            original: work.original,
            xml,
          };
    },
    finishEvent: (outcome: any) => outcome,
    async abort() {},
  },
});
function messageActions(snapshot: any) {
  const record = binding ? backend.store.active(binding.workspaceKey) : null;
  const prefixIds = new Set((record?.contextTransfer?.prefix || []).flatMap((m: any) => [m.id, m.clientId].filter(Boolean)));
  return {
    ...snapshot,
    messages: (snapshot.messages || []).map((m: any) => ({
      ...m,
      canEdit:
        m.type === "user" &&
        Boolean(
          record?.runtime === "builtin"
            ? record.runtimeCheckpoints?.[m.id]
            : record?.threadId && !m.contextTransferred && !prefixIds.has(m.id) && !record?.migration?.requiresContext,
        ),
      canFork:
        m.type === "assistant" &&
        m.phase !== "commentary" &&
        Boolean(
          record?.runtime === "builtin"
            ? record.runtimeCheckpoints?.[m.id]
            : record?.threadId && !m.contextTransferred && !prefixIds.has(m.id) && !record?.migration?.requiresContext,
        ),
    })),
  };
}
runtimeInstaller?.on("change", () => backend.emitStatus());
backend.on("event", (event: any) =>
  send({
    kind: "event",
    event:
      event.type === "status"
        ? {
            ...messageActions(event),
            migration: binding
              ? backend.store.active(binding.workspaceKey)?.migration
              : null,
          }
        : event,
  }),
);
async function dispatch(method: string, args: any) {
  switch (method) {
    case "status":
      return {
        ...messageActions(backend.snapshot()),
        migration: binding
          ? backend.store.active(binding.workspaceKey)?.migration
          : null,
      };
    case "previewHistory":
      return previewHistory(args.file);
    case "importHistory": {
      if (!binding) throw new Error("请先打开电路");
      if (backend.snapshot().busy) throw new Error("请先停止当前回答");
      const result = await importHistory(
        backend.store,
        args,
        binding.workspaceKey,
      );
      backend.emit("event", {
        type: "conversations-changed",
        ...backend.conversationState(binding.workspaceKey),
      });
      return result;
    }
    case "bind": {
      if (backend.snapshot().busy) throw new Error("请先停止当前回答");
      binding = args;
      await backend.resumeWorkspace({
        workspaceKey: args.workspaceKey,
        revisionId: args.revision,
      });
      return backend.snapshot();
    }
    case "configure":
      return backend.configureCustomProvider(args);
    case "removeProvider":
      return backend.clearCustomProvider(args);
    case "discover":
      return backend.probeCustomProvider("discover", args);
    case "probe":
      return backend.probeCustomProvider("test", args);
    case "models":
      return backend.listModels(Boolean(args?.refresh));
    case "selectModel":
      return backend.selectModel(args);
    case "conversations": {
      if (!binding) return null;
      if (args?.action) {
        if (backend.snapshot().busy) throw new Error("请先停止当前回答");
        await backend.changeConversation(
          binding.workspaceKey,
          args.action,
          args,
        );
      }
      return backend.conversationState(binding.workspaceKey);
    }
    case "ask": {
      if (!binding) throw new Error("请先打开电路");
      const record = backend.store.active(binding.workspaceKey);
      if (
        (args.documentId && args.documentId !== binding.id) ||
        (args.circuit && args.circuit !== binding.circuit)
      )
        throw new Error("电路已切换，请重新发送");
      const current = await host({ op: "read", id: binding.id });
      if (args.startupEpoch !== stopEpoch) throw new Error("已停止");
      const graph = current.circuits.find(
        (c: any) => c.name === binding.circuit,
      );
      const selection = Array.isArray(args.selection)
        ? args.selection
            .filter(
              (id: string) =>
                graph?.components.some((c: any) => c.id === id) ||
                graph?.wires.some((w: any) => w.id === id),
            )
            .slice(0, 1024)
        : [];
      if (!args.expectedTurnId && current.revision !== binding.revision)
        throw new Error("电路已改变，请重新发送");
      await backend.start();
      if (args.startupEpoch !== stopEpoch) throw new Error("已停止");
      const result = await backend.ask({
        question: args.question,
        editMessageId: args.editMessageId || null,
        expectedTurnId: args.expectedTurnId || null,
        workspaceKey: binding.workspaceKey,
        context: {
          folder: { path: workDir },
          projectId: binding.id,
          revisionId: binding.revision,
          circuit: binding.circuit,
          selection,
          transferredHistory: record?.runtime === "builtin" ? historyContext(record) : null,
        },
      });
      if (record?.runtime === "builtin" && record?.migration?.requiresContext)
        backend.store.runtimeData(
          binding.workspaceKey,
          { migration: { ...record.migration, requiresContext: false } },
          record.id,
        );
      return result;
    }
    case "runtime":
      return backend.newRuntimeConversation(args.runtime);
    case "defaultRuntime":
      return backend.setDefaultRuntime(args.runtime);
    case "login":
      return backend.login();
    case "cancelLogin":
      return backend.cancelLogin();
    case "logout":
      return backend.logout();
    case "reconnect":
      return backend.reconnect();
    case "answer":
      return backend.answer(args.requestId, args.answers);
    case "cancelInstall":
      await runtimeInstaller?.cancel();
      return backend.snapshot();
    case "bindProvider":
      return backend.bindProvider(args);
    case "stop":
      return backend.interrupt();
    default:
      throw new Error("未知运行时请求");
  }
}
// A bind or turn startup can await native I/O before the backend becomes busy.
// Do not allow another state transition to change its document in that gap.
// Stop, answers and installer cancellation remain available during preparation.
const transitions = new Set([
  "bind",
  "ask",
  "conversations",
  "runtime",
  "configure",
  "removeProvider",
  "selectModel",
  "bindProvider",
  "importHistory",
  "login",
  "logout",
  "reconnect",
]);
let transitioning = false;
let stopEpoch = 0;
async function receive(method: string, args: any) {
  if (method === "stop") stopEpoch++;
  const exclusive =
    transitions.has(method) &&
    (method !== "conversations" || Boolean(args.action));
  if (!exclusive) return dispatch(method, args);
  if (transitioning) throw new Error("正在切换或准备对话，请稍后重试");
  transitioning = true;
  const epoch = stopEpoch;
  try {
    return await dispatch(method, { ...args, startupEpoch: epoch });
  } finally {
    transitioning = false;
  }
}
createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.kind === "hostResult") {
      const pending = requests.get(message.id);
      if (pending) {
        requests.delete(message.id);
        message.error
          ? pending.reject(new Error(message.error))
          : pending.resolve(message.result);
      }
      return;
    }
    void receive(message.method, message.args || {})
      .then((result) => send({ kind: "result", id: message.id, result }))
      .catch((error) =>
        send({ kind: "result", id: message.id, error: error.message }),
      );
  })
  .on("close", () => {
    void backend
      .stop()
      .finally(closeNetwork)
      .finally(() => process.exit(0));
  });
// Reading the local conversation index must not trigger an optional runtime download.
if (backend.kind === "builtin") await backend.start();
send({ kind: "ready" });
