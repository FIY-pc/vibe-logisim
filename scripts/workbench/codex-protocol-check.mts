/** Explicit optional-runtime check: synthetic native history, no account or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createCodexInstaller } from "../../packages/agent-runtime/src/installer.mts";
const require = createRequire(import.meta.url);
const {
  AgentRuntime,
} = require("../../packages/agent-runtime/core/agent-runtime.cjs");
const {
  ConversationStore,
} = require("../../packages/agent-runtime/core/conversation-store.cjs");
const {
  POLICY_SIGNATURE,
} = require("../../packages/agent-runtime/core/codex-capabilities.cjs");
const root = path.resolve(import.meta.dirname, "../..");
if (process.env.VIBE_LOGISIM_CODEX)
  throw new Error("Unset VIBE_LOGISIM_CODEX to verify the locked runtime");
const installed = await createCodexInstaller(
  path.join(root, ".workbench-cache/codex-protocol"),
);
await installed.installer!.ensure();
const version = execFileSync(installed.codex, ["--version"], {
  encoding: "utf8",
}).trim();
const state = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-codex-protocol-"));
const profile = path.join(state, "profile"),
  work = path.join(state, "scratch");
fs.mkdirSync(work);
const store = new ConversationStore(path.join(state, "conversations.json"));
const options = {
  ownProfile: true,
  profileDir: profile,
  sessionStorePath: store.file,
  workDir: work,
  codex: installed.codex,
  codexRoot: installed.codexRoot,
  nodeExecutable: process.execPath,
  startOnResume: false,
  resolveProxy: async () => "DIRECT",
};
let runtime: any;
function instance() {
  const value = new AgentRuntime(options);
  value.backends.codex.ask = async () => {
    throw new Error("Model turns are forbidden in protocol verification");
  };
  return value;
}
function seed() {
  const threadId = randomUUID(),
    timestamp = new Date().toISOString();
  const records: any[] = [],
    turns: string[] = [];
  const put = (type: string, payload: any) =>
    records.push({ timestamp, ordinal: records.length, type, payload });
  put("session_meta", {
    id: threadId,
    session_id: threadId,
    timestamp,
    cwd: work,
    originator: "vibe-native-protocol-fixture",
    cli_version: version.replace("codex-cli ", ""),
    source: "vscode",
    model_provider: "openai",
    history_mode: "paginated",
    base_instructions: {
      text: "Synthetic local history. No model generation.",
    },
  });
  for (let n = 1; n <= 3; n++) {
    const turnId = randomUUID();
    turns.push(turnId);
    const question = "Synthetic circuit question " + n,
      answer = "Synthetic reply " + n;
    put("event_msg", {
      type: "task_started",
      turn_id: turnId,
      model_context_window: 100000,
      collaboration_mode_kind: "default",
    });
    put("event_msg", {
      type: "user_message",
      message: question,
      images: [],
      local_images: [],
      text_elements: [],
    });
    put("response_item", {
      type: "message",
      role: "user",
      id: "user-" + n,
      content: [{ type: "input_text", text: question }],
    });
    put("response_item", {
      type: "function_call",
      id: "call-" + n,
      call_id: "call-" + n,
      name: "read_circuit",
      arguments: "{}",
    });
    put("response_item", {
      type: "function_call_output",
      call_id: "call-" + n,
      output: "LOCAL_TOOL_EVIDENCE_" + n,
    });
    put("response_item", {
      type: "message",
      role: "assistant",
      id: "assistant-" + n,
      phase: "final_answer",
      content: [{ type: "output_text", text: answer }],
    });
    put("event_msg", {
      type: "agent_message",
      message: answer,
      phase: "final_answer",
    });
    put("event_msg", {
      type: "item_completed",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        type: "UserMessage",
        id: "user-" + n,
        client_id: "user-" + n,
        content: [{ type: "text", text: question, text_elements: [] }],
      },
      started_at_ms: 1,
      completed_at_ms: 2,
    });
    put("event_msg", {
      type: "item_completed",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        type: "AgentMessage",
        id: "assistant-" + n,
        phase: "final_answer",
        content: [{ type: "Text", text: answer }],
      },
      started_at_ms: 2,
      completed_at_ms: 3,
    });
    put("event_msg", {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: answer,
    });
  }
  const directory = path.join(
    profile,
    "sessions",
    ...timestamp.slice(0, 10).split("-"),
  );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    "rollout-" +
      timestamp.slice(0, 19).replaceAll(":", "-") +
      "-" +
      threadId +
      ".jsonl",
  );
  fs.writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return { threadId, turns, file };
}
try {
  store.runtimeData("fixture", { runtime: "codex" });
  runtime = instance();
  await runtime.resumeWorkspace({
    workspaceKey: "fixture",
    revisionId: "fixture-revision",
  });
  await runtime.start();
  const contract = {
    mode: "base",
    workspaceMode: null,
    signature: null,
    harnessSignature: POLICY_SIGNATURE,
    developerInstructionsSha256:
      runtime.backends.codex.developerInstructionsSha256,
  };
  await runtime.stop();
  const source = seed(),
    bytes = fs.readFileSync(source.file);
  store.remember("fixture", {
    threadId: source.threadId,
    toolContract: contract,
  });
  runtime = instance();
  await runtime.resumeWorkspace({
    workspaceKey: "fixture",
    revisionId: "fixture-revision",
  });
  const status = runtime.snapshot();
  assert.equal(status.threadId, source.threadId);
  assert.equal(
    status.messages.filter((message: any) => message.type === "assistant")
      .length,
    3,
  );
  assert.equal(status.account, null);
  const reply = status.messages.find(
    (message: any) => message.type === "assistant",
  );
  await runtime.changeConversation("fixture", "fork", { messageId: reply.id });
  const child = store.active("fixture");
  assert.notEqual(child.threadId, source.threadId);
  assert.equal(
    child.messages.filter((message: any) => message.type === "assistant")
      .length,
    1,
  );
  assert.equal(child.forkedFrom.turnId, source.turns[0]);
  assert.deepEqual(fs.readFileSync(source.file), bytes);
  const childFile = fs
    .readdirSync(path.dirname(source.file))
    .find((name) => name.endsWith(child.threadId + ".jsonl"));
  assert(childFile);
  const contents = fs.readFileSync(
    path.join(path.dirname(source.file), childFile),
    "utf8",
  );
  const meta = JSON.parse(contents.split("\n")[0]).payload;
  const inherited = Number.isInteger(meta.forked_from_ordinal_exclusive)
    ? bytes
        .toString()
        .trim()
        .split("\n")
        .filter(
          (line) =>
            JSON.parse(line).ordinal < meta.forked_from_ordinal_exclusive,
        )
        .join("\n")
    : contents;
  if (Number.isInteger(meta.forked_from_ordinal_exclusive))
    assert.equal(meta.forked_from_id, source.threadId);
  assert(inherited.includes("LOCAL_TOOL_EVIDENCE_1"));
  assert(!inherited.includes("LOCAL_TOOL_EVIDENCE_2"));
  await runtime.stop();
  runtime = instance();
  await runtime.resumeWorkspace({
    workspaceKey: "fixture",
    revisionId: "fixture-revision",
  });
  assert.equal(runtime.snapshot().threadId, child.threadId);
  assert.equal(
    runtime
      .snapshot()
      .messages.filter((message: any) => message.type === "assistant").length,
    1,
  );
  assert.equal(fs.existsSync(path.join(profile, "auth.json")), false);
  console.log(
    JSON.stringify({
      codex: version,
      nativeResume: true,
      nativeFork: true,
      inheritedToolContext: true,
      laterTurnsExcluded: true,
      restart: true,
      sourceHistoryUnchanged: true,
      modelTurns: 0,
      authenticated: false,
    }),
  );
} finally {
  await runtime?.stop();
  fs.rmSync(state, { recursive: true, force: true });
}
