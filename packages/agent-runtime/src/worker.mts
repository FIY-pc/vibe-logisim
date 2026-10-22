import { ProposalStore } from "./proposals.mts";
import { storeReference, readReferences } from "./references.mts";
import {
  createCircuitContextHost,
  selectionContext,
} from "./circuit/context.mts";
import { CircuitPlugin } from "./circuit/plugin.mts";
import { handlers } from "./circuit/handlers.mts";
import { Turn } from "./circuit/turn.mts";
import { systemProxy, networkFetch, closeNetwork } from "./network.mts";
/** Runtime process entry. stdout is exclusively JSONL. */
import { AgentRuntime } from "../core/agent-runtime.mts";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCodexInstaller } from "./installer.mts";
const state = path.resolve(process.argv[2]);
const workDir = path.join(state, "agent-workspace");
await mkdir(workDir, { recursive: true });
const proposals = new ProposalStore(state, workDir);
// Recovery failure must not hide existing conversations or model settings.
// Listing candidates and preparing new work retry it without overwriting scratch.
await proposals.recover().catch(() => undefined);
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
const turn = new Turn(host, proposals, () => binding, workDir);
const plugin = new CircuitPlugin({ handlers });
const toolHost = plugin;
const {
  installer: runtimeInstaller,
  codexRoot,
  codex,
} = await createCodexInstaller(state);
const toolNames: ReadonlySet<string> = new Set(
  toolHost.tools.map((tool) => tool.name),
);
const instructions =
  "You collaborate on digital circuits in Vibe Logisim. Respond in the user language and send short progress messages before tool calls. The Rust host owns the open document. The general file tools work in a scratch folder that holds circuit.circ, a copy of the open file; inspect it with inspect_circuit and change it with edit_candidate, wire_candidate, move_candidate and reroute_candidate, or by writing circuit.circ directly with the file tools. Every change there is a candidate: the open file stays as it is until the user reviews and applies it. Candidate edits return candidateId and artifactSha256; pass the hash from your latest inspection so an edit never lands on content you have not seen. inspect_circuit returns bounded pages (componentDirectory, componentIds, portConnections, includeWires), so ask for what you need instead of reading the whole file. Native observations are authoritative for electrical facts. render_circuit draws the current circuit; simulate_circuit checks test vectors and trace_circuit checks a tick sequence in an isolated simulation, leaving the user's live simulation alone; evaluate_circuit compares a trace against expected rows. describe_component gives a component's default attributes and allowed values. checkout_candidate moves the candidate into the open file right away when the user asked for that. Keep unknown XML, libraries and unrelated circuits. Circuit organization is part of delivery: preserve behavior and make the drawing readable. Never invent tool results or claim you looked at an image that was not delivered as image input.";
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
  contextHost: createCircuitContextHost({
    changeMode: "review",
    visibleTools: () => toolNames,
  }),
  ownProfile: true,
  nodeExecutable: process.execPath,
  codex,
  codexRoot,
  runtimeInstaller,
  workspaceHost: {
    mode: "review",
    async prepare(revision: string) {
      const revisionId = revision || binding.revision;
      const source = await host({
        op: "source",
        id: binding.id,
        revision: revisionId,
      });
      const prepared = await proposals.prepare({
        projectId: binding.id,
        revisionId,
        original: source.xml,
      });
      // The plugin finds this turn through the work record it was given.
      return { ...prepared, turn };
    },
    async finish(work: any) {
      return proposals.finish(work);
    },
    finishEvent: (outcome: any) => outcome,
    async abort() {
      await proposals.recover();
    },
  },
});
function messageActions(snapshot: any) {
  const record = binding ? backend.store.active(binding.workspaceKey) : null;
  const prefixIds = new Set(
    (record?.contextTransfer?.prefix || []).flatMap((m: any) =>
      [m.id, m.clientId].filter(Boolean),
    ),
  );
  return {
    ...snapshot,
    messages: (snapshot.messages || []).map((m: any) => ({
      ...m,
      canEdit:
        m.type === "user" &&
        Boolean(
          record?.runtime === "builtin"
            ? record.runtimeCheckpoints?.[m.id]
            : record?.threadId && !m.contextTransferred && !prefixIds.has(m.id),
        ),
      canFork:
        m.type === "assistant" &&
        m.phase !== "commentary" &&
        Boolean(
          record?.runtime === "builtin"
            ? record.runtimeCheckpoints?.[m.id]
            : record?.threadId && !m.contextTransferred && !prefixIds.has(m.id),
        ),
    })),
  };
}
runtimeInstaller?.on("change", () => backend.emitStatus());
backend.on("event", (event: any) =>
  send({
    kind: "event",
    event: event.type === "status" ? messageActions(event) : event,
  }),
);
async function dispatch(method: string, args: any) {
  switch (method) {
    case "status":
      return messageActions(backend.snapshot());
    case "proposals":
      await host({ op: "read", id: args.documentId });
      if (!backend.snapshot().busy) await proposals.recover();
      return proposals.list(args.documentId);
    case "discardProposal":
      await host({ op: "read", id: args.documentId });
      return proposals.discard(args.documentId, args.id);
    case "stageReferences": {
      if (
        !binding ||
        args.workspaceKey !== binding.workspaceKey ||
        args.documentId !== binding.id
      )
        throw new Error("对话已切换，请重新添加引用");
      if (!Array.isArray(args.references) || args.references.length > 8)
        throw new Error("每条问题最多引用 8 处资料或观察");
      const captured = binding;
      const references = await Promise.all(
        args.references.map((input: any) =>
          storeReference(
            state,
            captured.workspaceKey,
            captured.id,
            input,
            host,
          ),
        ),
      );
      if (binding !== captured)
        throw new Error("对话已切换，引用未加入其他对话");
      return references;
    }
    case "readReferences": {
      if (!binding || args.workspaceKey !== binding.workspaceKey)
        throw new Error("引用属于另一工作区");
      return readReferences(state, binding.workspaceKey, args.ids);
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
      return backend.selectModel(args?.inherit === true ? null : args);
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
      const references = await readReferences(
        state,
        binding.workspaceKey,
        args.references || [],
      );
      const current = await host({ op: "read", id: binding.id });
      if (args.startupEpoch !== stopEpoch) throw new Error("已停止");
      const graph = current.circuits.find(
        (c: any) => c.name === binding.circuit,
      );
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
          folder: { path: workDir, activeFile: "circuit.circ" },
          workspaceKey: binding.workspaceKey,
          folderId: binding.folderId,
          projectId: binding.id,
          revisionId: binding.revision,
          circuit: binding.circuit,
          ...selectionContext({
            graph,
            circuit: binding.circuit,
            projectId: binding.id,
            revisionId: binding.revision,
            ids: args.selection,
            visibleTools: toolNames,
          }),
          references,
        },
      });
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
    case "defaultProvider":
      return backend.defaultProvider(args);
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
  "defaultProvider",
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
        // Host failures carry code, hint, retryable and context beside the message.
        message.error
          ? pending.reject(
              Object.assign(new Error(message.error.message), message.error),
            )
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
