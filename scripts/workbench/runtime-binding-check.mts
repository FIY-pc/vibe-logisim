/** Exercise the real sidecar while native document reads are deliberately delayed. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-binding-check-"));
const child = spawn(
  process.execPath,
  [path.join(root, "packages/agent-runtime/src/worker.mts"), state],
  {
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let next = 0,
  logs = "";
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const native: any[] = [];
child.stderr.on("data", (b) => {
  logs += b;
});
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind === "host") native.push(message);
  if (message.kind !== "result") return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request?.reject(new Error(message.error));
  else request?.resolve(message.result);
});
function call(method: string, args: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
  });
}
const timeout = setTimeout(() => {
  child.kill();
}, 15000);
child.on("exit", (code) => {
  for (const request of pending.values())
    request.reject(new Error(`Sidecar exited (${code}): ${logs}`));
  pending.clear();
});
try {
  const a = {
    id: "document-a",
    revision: "revision-a",
    circuit: "main",
    workspaceKey: "document-a",
  };
  const b = { ...a, id: "document-b", workspaceKey: "document-b" };
  const first = call("bind", a);
  const overlapping = assert.rejects(call("bind", b), /正在切换|准备/);
  await Promise.all([first, overlapping]);
  await assert.rejects(
    call("ask", { question: "inspect", documentId: b.id, circuit: "main" }),
    /电路已切换/,
  );
  assert.equal(
    native.length,
    0,
    "Wrong-document sends must fail before any native access",
  );
  const starting = call("ask", {
    question: "inspect",
    documentId: a.id,
    circuit: "main",
  });
  const cancelled = assert.rejects(starting, /已停止/);
  for (let i = 0; i < 200 && !native.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    native.length,
    1,
    "Turn startup should await the real host read",
  );
  assert.equal(native[0].request.id, a.id);
  await assert.rejects(call("bind", b), /正在切换|准备/);
  assert.equal(
    (await call("status")).busy,
    false,
    "Backend is not busy yet; the adapter must guard preparation itself",
  );
  await call("stop");
  child.stdin.write(
    JSON.stringify({
      kind: "hostResult",
      id: native[0].id,
      result: {
        ...a,
        circuits: [{ name: "main", components: [], wires: [] }],
      },
    }) + "\n",
  );
  await cancelled;
  await call("bind", b);
  await assert.rejects(
    call("ask", { question: "inspect", documentId: a.id }),
    /电路已切换/,
  );
  assert.equal(
    native.length,
    1,
    "Cancelled startup must not prepare scratch files or access a model",
  );
  console.log(
    "Verified sidecar binding: overlapping binds rejected, wrong-document sends rejected, stop interrupts pre-turn native read, and a subsequent bind recovers.",
  );
} finally {
  const exited = once(child, "exit");
  child.stdin.end();
  if (child.exitCode === null) await exited;
  clearTimeout(timeout);
  await rm(state, { recursive: true, force: true });
}
