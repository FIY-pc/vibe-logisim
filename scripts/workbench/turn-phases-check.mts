/** Real SDK events: pending text, tool commentary, final text, stop and length. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnRunner } from "../../packages/agent-runtime/src/turn/runner.mts";
import { ServiceStore } from "../../packages/agent-runtime/src/models/services.mts";

const directory = await mkdtemp(path.join(tmpdir(), "vibe-turn-phases-"));
let mode = "complete",
  requests = 0;
const server = createServer(async (req, res) => {
  for await (const _ of req) {
    /* Drain the SDK request. */
  }
  const tool = mode === "complete" && requests++ === 0;
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "phase-check", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  res.write(
    chunk({
      role: "assistant",
      content: tool ? "先检查文件。" : "这是一段回答。",
    }),
  );
  if (mode === "stop") return; // The test interrupts after the first real delta.
  if (tool)
    res.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "read-notes",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "notes.txt" }),
            },
          },
        ],
      }),
    );
  res.write(
    chunk({}, tool ? "tool_calls" : mode === "length" ? "length" : "stop"),
  );
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
          folder: { id: "fixture", path: directory, name: "Fixture" },
          documents: [],
        };
      if (request.op === "folderCheckpoint") return { change: null };
      throw new Error(`Unexpected host operation ${request.op}`);
    },
  },
};
new ServiceStore(options.profileDir).save({
  name: "Local phase fixture",
  baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
  apiKey: "fixture-only",
  model: "fixture",
  api: "openai-completions",
  contextWindow: 64000,
  effort: "none",
  vision: false,
});
const runner = new TurnRunner(options);
try {
  await writeFile(path.join(directory, "notes.txt"), "phase fixture");
  await runner.resume("fixture");
  for (mode of ["complete", "stop", "length"]) {
    const offset = runner.history.length;
    const phases: string[] = [];
    let pendingSeen = false,
      stopping = false;
    const ended = Promise.withResolvers<any>();
    const listener = (event: any) => {
      if (event.type === "assistant-delta") {
        pendingSeen =
          runner.history.find((item) => item.id === event.itemId)?.phase ===
          "pending";
        if (mode === "stop" && !stopping) {
          stopping = true;
          void runner.interrupt();
        }
      }
      if (event.type === "assistant-completed") phases.push(event.phase);
      if (event.type === "turn-completed") ended.resolve(event);
    };
    runner.on("event", listener);
    await runner.ask({
      question: `Check ${mode}`,
      documentId: null,
      circuit: null,
      references: [],
      selection: [],
    });
    const end = await ended.promise;
    runner.off("event", listener);
    assert.ok(
      pendingSeen,
      `${mode}: streamed text has the same pending phase as saved history`,
    );
    assert.equal(
      end.status,
      mode === "complete"
        ? "completed"
        : mode === "stop"
          ? "interrupted"
          : "failed",
    );
    if (mode === "complete") assert.deepEqual(phases, ["commentary", "final"]);
    else {
      assert.ok(
        !phases.includes("final"),
        `${mode}: no final answer is emitted`,
      );
      assert.equal(
        runner.history
          .slice(offset)
          .filter((item) => item.type === "assistant")
          .at(-1)?.phase,
        "incomplete",
      );
    }
  }
  console.log(
    "PASS: real SDK streaming, tool completion, stop and output limit preserve message phases.",
  );
} finally {
  await runner.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
