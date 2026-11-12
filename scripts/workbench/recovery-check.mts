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
let writePath = "result.txt",
  disconnectOnce = false;
let httpStatus = 503,
  httpError = "service unavailable",
  errorsLeft = Infinity;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  if (mode === "http" && errorsLeft-- > 0) {
    res.writeHead(httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: httpError, type: httpError } }));
    return;
  }
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
              path: writePath,
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
    if (mode === "disconnect") {
      if (disconnectOnce) mode = "complete";
      setTimeout(() => res.destroy(), 80);
    }
    return;
  } else {
    delta({ role: "assistant", content: "保留已有改动，继续完成了检查。" });
    delta({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const options = {
  retryPolicy: { maxRetries: 0 },
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
  assert.equal(
    runner.history.find((m) => m.id === stopped.turnId)?.stoppedByUser,
    true,
  );
  mode = "complete";
  assert.equal(
    (await ask({ question: "继续", continueTurnId: stopped.turnId })).status,
    "completed",
  );
  mode = "stop";
  const shutDown = (event: any) => {
    if (event.type === "assistant-delta") void runner.stop();
  };
  runner.on("event", shutDown);
  const exited = await ask();
  runner.off("event", shutDown);
  assert.equal(exited.status, "interrupted");
  assert.equal(
    runner.history.find((m) => m.id === exited.turnId)?.stoppedByUser,
    false,
    "App shutdown is distinct from an explicit user stop",
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
  await runner.stop();
  runner = new TurnRunner({
    ...options,
    retryPolicy: { maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 },
  });
  await runner.resume("fixture");
  let notices: string[] = [];
  runner.on("event", (event: any) => {
    if (event.type === "status" && event.transmission?.phase === "retrying")
      notices.push(event.transmission.message);
  });
  mode = "write";
  writePath = "automatic.txt";
  disconnectOnce = true;
  const offset = runner.history.length,
    before = requests.length;
  assert.equal((await ask({ question: "自动恢复测试" })).status, "completed");
  const automatic = runner.history.slice(offset);
  assert.equal(
    requests.length - before,
    3,
    "Write, interrupted answer, recovered answer",
  );
  assert.equal(writes, 2, "One write in each independent task, none replayed");
  assert.equal(
    await readFile(path.join(directory, writePath), "utf8"),
    "written once",
  );
  assert.equal(automatic.filter((m) => m.type === "user").length, 1);
  assert.equal(automatic.filter((m) => m.type === "turn").length, 1);
  assert.ok(automatic.some((m) => m.phase === "incomplete"));
  assert.ok(automatic.some((m) => m.phase === "final"));
  assert.ok(
    runner.transcript.some(
      (m: any) =>
        m.role === "assistant" &&
        m.stopReason === "error" &&
        m.content.some((c: any) => c.text?.includes("接下来检查")),
    ),
    "Raw failed attempt is retained too",
  );
  assert.match(notices[0], /连接中断.*自动继续/);
  assert.ok(
    requests
      .at(-1)
      .messages.some(
        (m: any) => m.role === "tool" && m.content.includes(writePath),
      ),
    "Recovery receives the confirmed write result",
  );
  for (const [status, error] of [
    [401, "invalid api key"],
    [403, "forbidden"],
    [404, "unknown model"],
    [429, "insufficient_quota"],
    [400, "invalid_request"],
  ] as const) {
    mode = "http";
    httpStatus = status;
    httpError = error;
    errorsLeft = Infinity;
    notices = [];
    const before = requests.length;
    const end = await ask();
    assert.equal(end.status, "failed", error);
    assert.equal(
      requests.length - before,
      1,
      `${status} ${error} must fail without retry`,
    );
    assert.equal(notices.length, 0);
    assert.equal(
      runner.history.find((m) => m.id === end.turnId)?.recovery,
      "settings",
    );
  }
  for (const [status, error] of [
    [429, "rate limit"],
    [503, "service unavailable"],
    [400, "overloaded"],
    [400, "服务繁忙"],
  ] as const) {
    mode = "http";
    httpStatus = status;
    httpError = error;
    errorsLeft = 1;
    notices = [];
    const before = requests.length;
    assert.equal((await ask()).status, "completed", error);
    assert.equal(
      requests.length - before,
      2,
      `${status} ${error} retries the request once`,
    );
    assert.equal(notices.length, 1);
  }
  mode = "http";
  httpStatus = 503;
  httpError = "service unavailable";
  errorsLeft = Infinity;
  notices = [];
  const exhaustedAt = requests.length;
  assert.equal((await ask()).status, "failed");
  assert.equal(
    requests.length - exhaustedAt,
    3,
    "Exactly one initial request plus two retries; no hidden HTTP retry budget",
  );
  assert.equal(notices.length, 2);
  const stopRetry = (event: any) => {
    if (event.type === "status" && event.transmission?.phase === "retrying")
      void runner.interrupt();
  };
  runner.on("event", stopRetry);
  const stoppedAt = requests.length;
  assert.equal((await ask()).status, "interrupted");
  runner.off("event", stopRetry);
  assert.equal(
    requests.length - stoppedAt,
    1,
    "Stop during backoff prevents the next request",
  );
  console.log(
    "PASS: manual/automatic continuation, mid-stream disconnect, retained writes/history, restart, stale actions, 400/401/403/404/429/503 classification, bounded retries and stop during backoff.",
  );
} finally {
  await runner.stop();
  await closeNetwork();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
