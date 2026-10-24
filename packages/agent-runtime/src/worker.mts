/**
 * Process entry. The Rust host spawns `node worker.mts <state>` and talks
 * JSONL over stdin/stdout (protocol/messages.mts): UI methods come in, results
 * and events go out, and host requests go out and come back as hostResult.
 * stdout carries nothing else; diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TurnRunner } from "./turn/runner.mts";
import { storeReference, readReferences } from "./conversations/references.mts";
import { closeNetwork } from "./network/fetch.mts";
import {
  TRANSITIONS,
  type HostMessage,
  type RuntimeMethod,
  type WorkerMessage,
} from "./protocol/messages.mts";
import type { HostClient, HostStatus, Request } from "./protocol/host.mts";

const state = path.resolve(process.argv[2]);
await mkdir(state, { recursive: true });
const send = (message: WorkerMessage) =>
  process.stdout.write(JSON.stringify(message) + "\n");
const requests = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const host: HostClient = {
  call: (request: Request) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      requests.set(id, { resolve, reject });
      send({ kind: "host", id, request });
    }),
};
const runtimeRoot = process.env.VIBE_LOGISIM_RUNTIME_ROOT || null;
const runner = new TurnRunner({
  host,
  profileDir: path.join(state, "profile"),
  conversationsFile: path.join(state, "conversations.json"),
  runtimeRoot,
});
runner.on("event", (event) => send({ kind: "event", event }));

/** The document the UI bound; `ask` and references check against it. */
let binding: { documentId: string | null; workspaceKey: string | null } | null =
  null;
const folderOf = async () =>
  (await host.call<HostStatus>({ op: "status", summary: true })).folder;

async function dispatch(method: RuntimeMethod, args: any) {
  switch (method) {
    case "status":
      return runner.snapshot();
    case "history":
      return runner.historySnapshot();
    case "bind": {
      if (runner.snapshot().busy) throw new Error("请先停止当前回答");
      const folder = await folderOf();
      binding = {
        documentId: args.documentId ?? null,
        workspaceKey: folder?.id ?? null,
      };
      if (folder) await runner.resume(folder.id);
      return runner.snapshot();
    }
    case "ask": {
      const folder = await folderOf();
      if (!folder) throw new Error("请先打开工作文件夹");
      if (args.startupEpoch !== stopEpoch) throw new Error("已停止");
      const references = await readReferences(
        state,
        folder.id,
        args.references || [],
      );
      await runner.start();
      if (args.startupEpoch !== stopEpoch) throw new Error("已停止");
      return runner.ask({
        question: String(args.question ?? ""),
        references,
        documentId: args.documentId ?? null,
        circuit: args.circuit ?? null,
        selection: Array.isArray(args.selection) ? args.selection : [],
        editMessageId: args.editMessageId || null,
        expectedTurnId: args.expectedTurnId || null,
      });
    }
    case "stop":
      return runner.interrupt();
    case "reconnect":
      return runner.reconnect();
    case "conversations": {
      const folder = await folderOf();
      if (!folder) return null;
      if (args?.action) {
        if (runner.snapshot().busy) throw new Error("请先停止当前回答");
        await runner.changeConversation(folder.id, args.action, args);
      }
      return runner.conversationState(folder.id);
    }
    case "models":
      return runner.listModels(Boolean(args?.refresh));
    case "selectModel":
      return runner.selectModel(args?.inherit === true ? null : args);
    case "configure":
      return runner.configureService(args);
    case "removeProvider":
      return runner.removeService(args);
    case "discover":
      return runner.probeService("discover", args);
    case "probe":
      return runner.probeService("test", args);
    case "defaultProvider":
      return runner.defaultService(args);
    case "bindProvider":
      return runner.bindService(args);
    case "stageReferences": {
      const folder = await folderOf();
      if (!folder || !binding || args.documentId !== binding.documentId)
        throw new Error("对话已切换，请重新添加引用");
      if (!Array.isArray(args.references) || args.references.length > 8)
        throw new Error("每条问题最多引用 8 处资料或观察");
      const captured = binding;
      const references = await Promise.all(
        args.references.map((input: any) =>
          storeReference(state, folder.id, args.documentId, input, (request) =>
            host.call(request as Request),
          ),
        ),
      );
      if (binding !== captured)
        throw new Error("对话已切换，引用未加入其他对话");
      return references;
    }
    case "readReferences": {
      const folder = await folderOf();
      if (!folder) throw new Error("引用属于另一个工程文件夹");
      return readReferences(state, folder.id, args.ids);
    }
    default:
      throw new Error("未知运行时请求");
  }
}

// A bind or turn startup can await host I/O before the runner becomes busy.
// No other state transition may change the conversation in that gap.
let transitioning = false;
let stopEpoch = 0;
async function receive(method: RuntimeMethod, args: any) {
  if (method === "stop") stopEpoch += 1;
  const exclusive =
    TRANSITIONS.has(method) &&
    (method !== "conversations" || Boolean(args.action));
  if (!exclusive) return dispatch(method, args);
  if (transitioning) throw new Error("正在切换或准备对话，请稍后重试");
  transitioning = true;
  try {
    return await dispatch(method, { ...args, startupEpoch: stopEpoch });
  } finally {
    transitioning = false;
  }
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message: HostMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if ("kind" in message && message.kind === "hostResult") {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      // Host refusals carry code, hint, retryable and context beside the message.
      if (message.error)
        pending.reject(
          Object.assign(new Error(message.error.message), message.error),
        );
      else pending.resolve(message.result);
      return;
    }
    const { id, method, args } = message as Extract<
      HostMessage,
      { method: RuntimeMethod }
    >;
    void receive(method, args || {})
      .then((result) => send({ kind: "result", id, result }))
      .catch((error) =>
        send({ kind: "result", id, error: error?.message ?? String(error) }),
      );
  })
  .on("close", () => {
    void runner
      .stop()
      .finally(closeNetwork)
      .finally(() => process.exit(0));
  });
await runner.start();
send({ kind: "ready" });
