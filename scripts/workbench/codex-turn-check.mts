/**
 * One ask through the real sidecar and the real Codex app-server, with the
 * model provider at a localhost port nothing listens on. The turn must start
 * and then fail at the network layer: a JSON-RPC parameter error means the
 * thread or turn requests no longer match the bundled runtime. The sidecar
 * keeps its own fresh profile; no model is reachable and no account is used.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createCodexInstaller } from "../../packages/agent-runtime/src/installer.mts";

const root = path.resolve(import.meta.dirname, "../..");
if (process.env.VIBE_LOGISIM_CODEX)
  throw new Error(
    "Unset VIBE_LOGISIM_CODEX; this check uses the locked Codex runtime.",
  );
const { installer, codex } = await createCodexInstaller(
  path.join(root, ".workbench-cache/codex-protocol"),
);
await installer!.ensure();
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});
const state = await mkdtemp(path.join(tmpdir(), "vibe-codex-turn-"));
const home = path.join(state, "home");
await mkdir(home);
// No proxy variables and no user home: the provider is reached directly.
const env: NodeJS.ProcessEnv = {
  HOME: home,
  VIBE_LOGISIM_CODEX: codex,
  VIBE_LOGISIM_CODE_MODE_HOST: process.env.VIBE_LOGISIM_CODE_MODE_HOST,
};
for (const key of [
  "PATH",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
])
  if (process.env[key]) env[key] = process.env[key];
const child = spawn(
  process.execPath,
  [
    "--use-env-proxy",
    path.join(root, "packages/agent-runtime/src/worker.mts"),
    state,
  ],
  { stdio: ["pipe", "pipe", "pipe"], env },
);
const PARAM_ERROR = /-32600|Invalid request/i;
const documentId = "document-a";
const revision = "revision-a";
const view = {
  id: documentId,
  name: "main.circ",
  path: null,
  revision,
  dirty: false,
  canUndo: false,
  canRedo: false,
  main: "main",
  circuits: [{ name: "main", components: [], wires: [] }],
  libraries: [],
};
const source =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<project source="2.7.1" version="1.0">\n  <main name="main"/>\n  <circuit name="main"/>\n</project>\n';
let sequence = 0,
  logs = "";
const events: any[] = [];
const hostOps: string[] = [];
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
let ready!: () => void;
const started = new Promise<void>((resolve) => (ready = resolve));
child.stderr.on("data", (data) => {
  logs += data;
});
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.kind === "ready") ready();
  else if (message.kind === "event") events.push(message.event);
  else if (message.kind === "host") {
    const op = message.request?.op;
    hostOps.push(op);
    const reply =
      op === "read"
        ? { result: view }
        : op === "source"
          ? { result: { xml: source } }
          : {
              error: {
                message: "unexpected host request " + op,
                code: "AGENT_OP_UNKNOWN",
                retryable: false,
              },
            };
    child.stdin.write(
      JSON.stringify({ kind: "hostResult", id: message.id, ...reply }) + "\n",
    );
  } else if (message.kind === "result") {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error));
    else request?.resolve(message.result);
  }
});
child.on("exit", (code) => {
  for (const request of pending.values())
    request.reject(new Error(`Sidecar exited (${code}): ${logs}`));
  pending.clear();
});
const call = (method: string, args: any = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
  });
const timeout = setTimeout(() => child.kill(), 120_000);
const transmission = () =>
  events
    .filter((event) => event.type === "status" && event.transmission)
    .map((event) => event.transmission)
    .find((value) => ["retrying", "failed"].includes(value.phase));
try {
  await started;
  await call("bind", {
    id: documentId,
    revision,
    circuit: "main",
    workspaceKey: documentId,
    folderId: null,
  });
  await call("runtime", { runtime: "codex" });
  const configured = await call("configure", {
    name: "unreachable",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "synthetic-key",
    model: "synthetic-model",
    effort: "low",
  });
  assert.equal(
    configured.customProvider?.baseUrl,
    `http://127.0.0.1:${port}/v1`,
  );
  assert.equal(configured.status, "ready", "Codex accepted the provider");
  let turn: any = null,
    failure: string | null = null;
  try {
    turn = await call("ask", {
      question: "Describe this circuit.",
      references: [],
      selection: [],
    });
  } catch (error: any) {
    failure = error.message;
  }
  assert.equal(failure, null, `ask did not start a turn: ${failure}`);
  assert.equal(typeof turn?.turnId, "string", "turn/start returned a turn");
  for (let i = 0; i < 900 && !transmission(); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const seen = transmission();
  assert.ok(seen, "the turn reported a transport failure");
  const messages = [
    seen.message,
    ...events.filter((e) => e.type === "error").map((e) => e.message),
    logs,
  ];
  for (const text of messages)
    assert.doesNotMatch(String(text), PARAM_ERROR, "no JSON-RPC param error");
  assert.deepEqual(hostOps.slice(0, 2), ["read", "source"]);
  assert.equal(
    existsSync(path.join(state, "profile/auth.json")),
    false,
    "the sidecar profile holds no account",
  );
  await call("stop");
  console.log(
    `Verified a real app-server turn: thread/start and turn/start accepted, then ${seen.phase} at the network layer (${seen.message.slice(0, 120)}).`,
  );
} finally {
  const exited = once(child, "exit");
  child.stdin.end();
  if (child.exitCode === null) await exited;
  clearTimeout(timeout);
  // The app-server runs in a transient user unit named after the sidecar pid.
  let units = "";
  for (let i = 0; i < 50; i++) {
    units = execFileSync(
      "systemctl",
      [
        "--user",
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        `vibe-logisim-agent-${child.pid}-*`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (!units) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await rm(state, { recursive: true, force: true });
  assert.equal(units, "", "the app-server unit was collected");
}
