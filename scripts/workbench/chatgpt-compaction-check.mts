/** Real runner + Pi transport with a local subscription SSE fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnRunner } from "../../packages/agent-runtime/src/turn/runner.mts";
import { ChatGPTAccounts } from "../../packages/agent-runtime/src/models/chatgpt.mts";
import { ServiceStore } from "../../packages/agent-runtime/src/models/services.mts";
import { ConversationContext } from "../../packages/agent-runtime/src/turn/context-budget.mts";
import { closeNetwork } from "../../packages/agent-runtime/src/network/fetch.mts";

const dir = await mkdtemp(path.join(tmpdir(), "vibe-remote-context-"));
await writeFile(
  path.join(dir, "evidence.txt"),
  "Interface A/B/Cin/Sum/Cout. Validation pending.\n",
);
const payloads: any[] = [],
  errors: unknown[] = [];
let mode = "tools";
const first = {
  id: "cmp_first",
  type: "compaction",
  encrypted_content: "opaque-first",
};
const second = {
  id: "cmp_second",
  type: "compaction",
  encrypted_content: "opaque-second",
};
let finalPrefix: any[] = [];
const server = createServer(
  (req, res) =>
    void (async () => {
      assert.equal(
        req.url,
        "/v1/responses",
        "no separate compact endpoint or local summarization",
      );
      assert.equal(req.headers.authorization, "Bearer fixture-access");
      const parts = [];
      for await (const part of req) parts.push(part);
      const p = JSON.parse(Buffer.concat(parts).toString());
      payloads.push(p);
      assert.equal(p.store, false);
      assert.equal(p.stream, true);
      assert.equal(p.reasoning.effort, "high");
      assert.deepEqual(p.context_management, [
        { type: "compaction", compact_threshold: 48000 },
      ]);
      assert.doesNotMatch(
        JSON.stringify(p),
        /context summarization assistant|context-checkpoint/,
      );
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type: string, fields: any) => {
        const bytes = Buffer.from(
          `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`,
        );
        // Split framing and multibyte characters across arbitrary network chunks.
        for (let i = 0; i < bytes.length; i += 13)
          res.write(bytes.subarray(i, i + 13));
      };
      const item = (value: any, index: number) => {
        event("response.output_item.added", {
          output_index: index,
          item: value,
        });
        event("response.output_item.done", {
          output_index: index,
          item: value,
        });
      };
      event("response.created", {
        response: {
          id: `resp_${payloads.length}`,
          status: "in_progress",
          output: [],
        },
      });
      if (mode === "fail" || mode === "hold") {
        item(
          {
            ...second,
            id: "cmp_unfinished",
            encrypted_content: "must-not-persist",
          },
          0,
        );
        if (mode === "hold") {
          req.on("close", () => res.end());
          return;
        }
        event("response.failed", {
          response: {
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Fixture limit",
            },
          },
        });
        res.end();
        return;
      }
      const toolResult = p.input.find(
        (x: any) => x.type === "function_call_output",
      );
      const tool = {
        type: "function_call",
        namespace: "vibe_logisim",
        id: "fc_read",
        call_id: "call_read",
        name: "read_file",
        arguments: '{"path":"evidence.txt"}',
        status: "completed",
      };
      if (mode === "tools" && !toolResult) {
        item(first, 0);
        item(tool, 1);
      } else {
        if (mode === "tools") {
          assert.deepEqual(
            p.input.slice(1, 3),
            [first, tool],
            "canonical prefix is unmodified",
          );
          assert.equal(
            toolResult.call_id,
            tool.call_id,
            "result pairs with the remote prefix call",
          );
          assert.match(JSON.stringify(toolResult), /Validation pending/);
        }
        item(
          {
            type: "message",
            role: "assistant",
            id: `msg_${payloads.length}`,
            status: "completed",
            phase: "final_answer",
            content: [
              {
                type: "output_text",
                text: "接口保持，验证尚未完成。",
                annotations: [],
              },
            ],
          },
          0,
        );
        if (mode === "tools") {
          item(second, 1);
          finalPrefix = [second];
          mode = "followup";
        }
      }
      // Actual subscription responses may provide output only through item.done.
      event("response.completed", {
        response: {
          id: `resp_${payloads.length}`,
          status: "completed",
          output: [],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      });
      res.end();
    })().catch((error) => {
      errors.push(error);
      console.error(error);
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const api = `http://127.0.0.1:${address.port}/v1`;
await writeFile(
  path.join(dir, "chatgpt-accounts.json"),
  JSON.stringify({
    version: 1,
    hostId: "fixture-host",
    accounts: [
      {
        id: "fixture-account",
        clientId: "fixture-client",
        subject: "fixture-subject",
        email: "fixture@example.com",
        tokens: {
          access: "fixture-access",
          refresh: "fixture-refresh",
          identity: "fixture-identity",
          scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
          expiresAt: Date.now() + 3600000,
          earliestRefreshAt: 0,
        },
        model: "fixture-chatgpt",
        effort: "high",
        models: [
          {
            model: "fixture-chatgpt",
            name: "Fixture",
            defaultEffort: "high",
            efforts: [{ value: "high" }],
            metadata: { contextWindow: 64000, vision: true, source: "account" },
          },
        ],
      },
    ],
  }),
);
const file = path.join(dir, "conversations.json");
const create = () => {
  const runner = new TurnRunner({
    profileDir: dir,
    conversationsFile: file,
    instructions: "Preserve interface and report verified facts.",
    host: {
      call: async (r: any): Promise<any> => {
        if (r.op === "status")
          return {
            folder: { id: "fixture", path: dir, name: "Fixture" },
            documents: [],
          };
        if (r.op === "folderCheckpoint") return { change: null };
        throw new Error(`Unexpected operation ${r.op}`);
      },
    },
  });
  const auth = new ChatGPTAccounts(dir, {
    api,
    fetchFor: async () => fetch,
    changed: () => {},
  });
  Object.assign(runner, {
    chatgpt: auth,
    services: new ServiceStore(dir, auth),
  });
  runner.services.setDefault("fixture-account");
  return runner;
};
let runner = create();
const ask = async (extra: any = {}) => {
  const end = new Promise<any>((resolve) => {
    const receive = (e: any) => {
      if (e.type === "turn-completed") {
        runner.off("event", receive);
        resolve(e);
      }
    };
    runner.on("event", receive);
  });
  await runner.ask({
    question: "Inspect evidence; keep the interface. 用户约束。",
    references: [],
    selection: [],
    documentId: null,
    circuit: null,
    ...extra,
  });
  return end;
};
const savedContext = async () => {
  const saved = JSON.parse(await readFile(file, "utf8"));
  const records = JSON.stringify(saved);
  assert.doesNotMatch(
    records,
    /fixture-access|fixture-refresh|fixture-identity/,
  );
  return (runner as any).context as ConversationContext;
};
try {
  await runner.resume("fixture");
  let done = await ask();
  assert.equal(done.status, "completed", done.error);
  assert.equal(payloads.length, 2);
  assert.equal(
    runner.transcript.filter((m) => m.role === "toolResult").length,
    1,
  );
  let context = await savedContext();
  assert.equal(context.checkpoints.length, 2);
  assert.equal(
    runner.snapshot().contextUsage?.source,
    "estimate",
    "pre-compaction usage does not describe opaque context",
  );
  const checkpoint = context.checkpoints.at(-1)!;
  assert.equal(checkpoint.through, runner.transcript.length);
  assert.equal(checkpoint.kind, "openai");
  if (checkpoint.kind !== "openai") throw new Error("Wrong checkpoint");
  assert.deepEqual(checkpoint.output, finalPrefix);
  assert.equal(
    context.checkpoint(runner.transcript, "different-account"),
    undefined,
  );
  assert.equal(
    context.checkpoint(runner.transcript),
    undefined,
    "custom services use raw history instead of encrypted checkpoints",
  );
  const original = runner.history.find((m) => m.type === "user")!;
  await runner.stop();
  runner = create();
  await runner.resume("fixture");
  done = await ask({ question: "Continue from the checkpoint." });
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(payloads.at(-1).input.slice(1, 2), finalPrefix);
  assert.equal(
    payloads.at(-1).input.length,
    3,
    "only current instructions, compacted prefix and new input",
  );
  assert.equal(runner.snapshot().contextUsage?.source, "usage");
  const count = runner.snapshot().contextUsage!.compactions;
  mode = "fail";
  done = await ask();
  assert.equal(done.status, "failed");
  assert.equal(runner.snapshot().contextUsage?.compactions, count);
  assert.equal(runner.snapshot().contextUsage?.status, "ready");
  mode = "hold";
  const compacting = new Promise<void>((resolve) => {
    const receive = (e: any) => {
      if (e.contextUsage?.status === "compacting") {
        runner.off("event", receive);
        resolve();
      }
    };
    runner.on("event", receive);
  });
  const pending = ask();
  await compacting;
  await runner.interrupt();
  assert.equal((await pending).status, "interrupted");
  assert.equal(runner.snapshot().contextUsage?.compactions, count);
  mode = "followup";
  done = await ask({
    editMessageId: original.id,
    question: "Start a different circuit.",
  });
  assert.equal(done.status, "completed", done.error);
  assert.equal(runner.snapshot().contextUsage?.compactions, 0);
  assert.ok(!payloads.at(-1).input.some((x: any) => x.type === "compaction"));
  assert.deepEqual(errors, []);
  console.log(
    "Verified subscription server compaction, canonical replay, tool pairing, restart, account isolation, intact history, rewind, failure and cancellation; no real model calls.",
  );
} finally {
  await runner.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeNetwork();
  await rm(dir, { recursive: true, force: true });
}
