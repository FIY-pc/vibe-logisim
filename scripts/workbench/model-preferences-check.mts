/** Check settings commands through the actual JSONL adapter without model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-model-preferences-"));
const preload = path.join(state, "capture-selection.cjs");
await writeFile(
  preload,
  `const {AgentRuntime}=require(${JSON.stringify(path.join(root, "packages/agent-runtime/core/agent-runtime.cjs"))});AgentRuntime.prototype.selectModel=async function(selection){return {receivedSelection:selection};};`,
);
const child = spawn(
  process.execPath,
  [
    "--require",
    preload,
    path.join(root, "packages/agent-runtime/src/worker.mts"),
    state,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let sequence = 0,
  logs = "";
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
child.stderr.on("data", (data) => {
  logs += data;
});
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind !== "result") return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request?.reject(new Error(message.error));
  else request?.resolve(message.result);
});
child.on("exit", (code) => {
  for (const request of pending.values())
    request.reject(new Error(`Sidecar exited (${code}): ${logs}`));
  pending.clear();
});
const timeout = setTimeout(() => child.kill(), 15000);
const call = (method: string, args: any) =>
  new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
  });
try {
  assert.equal(
    (await call("selectModel", { inherit: true })).receivedSelection,
    null,
    "inherit must reach the existing backend as null after JSONL and transition serialization",
  );
  const chosen = (
    await call("selectModel", { model: "fixture", effort: "max" })
  ).receivedSelection;
  assert.equal(chosen.model, "fixture");
  assert.equal(chosen.effort, "max");
  const configuration = (name: string) => ({
    name,
    baseUrl: `https://${name}.invalid/v1`,
    api: "openai-completions",
    apiKey: "fixture-only",
    model: "fixture",
    effort: "none",
    contextWindow: 256000,
    vision: false,
  });
  await call("configure", configuration("first"));
  const second = await call("configure", configuration("second"));
  const target = second.services.find(
    (service: any) => service.name === "second",
  );
  assert.notEqual(second.defaultServiceId, target.id);
  const updated = await call("defaultProvider", { id: target.id });
  assert.equal(updated.defaultServiceId, target.id);
  assert.equal(
    updated.services.some((service: any) => "apiKey" in service),
    false,
  );
  console.log(
    "PASS: JSONL model inheritance reaches backend as null; default-service commands preserve separate registry selection and masked settings",
  );
} finally {
  const exited = once(child, "exit");
  child.stdin.end();
  if (child.exitCode === null) await exited;
  clearTimeout(timeout);
  await rm(state, { recursive: true, force: true });
}
