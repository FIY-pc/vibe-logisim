/** Fault injection through the real SDK/runner; no external model or workspace. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TurnRunner,
  recoverTranscript,
} from "../../packages/agent-runtime/src/turn/runner.mts";
import { ServiceStore } from "../../packages/agent-runtime/src/models/services.mts";
import { closeNetwork } from "../../packages/agent-runtime/src/network/fetch.mts";

const directory = await mkdtemp(path.join(tmpdir(), "vibe-recovery-"));
const requests: any[] = [];
let mode = "write",
  writes = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  const delta = (content: unknown, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "recovery", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`,
    );
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (mode === "write") {
    writes++;
    delta({
      role: "assistant",
      content: "先保存已完成的工作。",
      tool_calls: [
        {
          index: 0,
          id: "saved-file",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "result.txt",
              content: "written once",
            }),
          },
        },
      ],
    });
    delta({}, "tool_calls");
    mode = "disconnect";
  } else if (mode === "disconnect" || mode === "stop") {
    delta({ role: "assistant", content: "文件已经保存，接下来检查" });
    if (mode === "disconnect") setTimeout(() => res.destroy(), 80);
    return;
  } else {
    delta({ role: "assistant", content: "保留已有改动，继续完成了检查。" });
    delta({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const options = {
  profileDir: path.join(directory, "profile"),
  conversationsFile: path.join(directory, "conversations.json"),
  host: {
    call: async (request: any): Promise<any> => {
      if (request.op === "status")
        return {
          folder: { id: "fixture", path: directory, name: "Recovery" },
          documents: [],
        };
      if (request.op === "folderCheckpoint") return { change: null };
      throw new Error(`Unexpected host operation ${request.op}`);
    },
  },
};
new ServiceStore(options.profileDir).save({
  name: "Recovery fixture",
  baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  apiKey: "fixture-only",
  model: "fixture",
  api: "openai-completions",
  contextWindow: 64000,
  effort: "none",
  vision: false,
});
let runner = new TurnRunner(options);
const ask = async (extra: Record<string, unknown> = {}) => {
  const end = Promise.withResolvers<any>();
  const listener = (event: any) => {
    if (event.type === "turn-completed") end.resolve(event);
  };
  runner.on("event", listener);
  try {
    await runner.ask({
      question: "保存文件并检查结果",
      references: [],
      documentId: null,
      circuit: null,
      selection: [],
      ...extra,
    });
    return await end.promise;
  } finally {
    runner.off("event", listener);
  }
};
try {
  await runner.resume("fixture");
  const failed = await ask();
  assert.equal(failed.status, "failed");
  assert.equal(
    await readFile(path.join(directory, "result.txt"), "utf8"),
    "written once",
  );
  const retained = JSON.parse(JSON.stringify(runner.history));
  assert.ok(
    retained.some(
      (m: any) => m.phase === "incomplete" && m.text?.includes("接下来检查"),
    ),
  );
  assert.ok(
    retained.some(
      (m: any) => m.type === "activity" && m.status === "completed",
    ),
  );
  await runner.stop();
  runner = new TurnRunner(options);
  await runner.resume("fixture");
  mode = "complete";
  const resumed = await ask({
    question: "继续",
    continueTurnId: failed.turnId,
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(
    runner.history.slice(0, retained.length),
    retained,
    "Restart and continuation retain every visible record",
  );
  assert.equal(writes, 1, "The completed tool call is not replayed");
  const sent = requests.at(-1).messages;
  assert.equal(
    sent.filter(
      (m: any) => m.role === "tool" && m.tool_call_id === "saved-file",
    ).length,
    1,
  );
  assert.equal(
    sent.filter(
      (m: any) =>
        m.role === "user" &&
        JSON.stringify(m.content).includes("保存文件并检查结果"),
    ).length,
    1,
  );
  await assert.rejects(
    ask({ question: "继续", continueTurnId: failed.turnId }),
    /会话已变化/,
  );
  mode = "stop";
  let stopping = false;
  const interrupt = (event: any) => {
    if (event.type === "assistant-delta" && !stopping) {
      stopping = true;
      void runner.interrupt();
    }
  };
  runner.on("event", interrupt);
  const stopped = await ask();
  runner.off("event", interrupt);
  assert.equal(stopped.status, "interrupted");
  mode = "complete";
  assert.equal(
    (await ask({ question: "继续", continueTurnId: stopped.turnId })).status,
    "completed",
  );
  const call: any = {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "uncertain", name: "write_file", arguments: {} },
    ],
    timestamp: 1,
  };
  assert.match(JSON.stringify(recoverTranscript([call])), /结果未知/);
  assert.equal(
    recoverTranscript([{ ...call, stopReason: "error" }]).length,
    1,
    "Unexecuted partial tool calls must not gain orphaned results",
  );
  console.log(
    "PASS: partial disconnect, completed writes, restart, manual continuation, stale action rejection and stop/continue.",
  );
} finally {
  await runner.stop();
  await closeNetwork();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
