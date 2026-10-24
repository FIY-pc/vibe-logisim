/**
 * Course-size editing latency against a real host. Starts the host (the debug
 * build, or `VIBE_VERIFY_HOST`) with `VIBE_WORKBENCH_TIMING=1`, runs the
 * editing scenario from `editing-scenarios.mts`, and adds the host's own
 * breakdown: the p50 of every stage it reported, per request kind.
 *
 *   node scripts/workbench/editing-latency.mts [rounds]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { measureEditing } from "./editing-scenarios.mts";

const root = path.resolve(import.meta.dirname, "../..");
const rounds = Number(process.argv[2] ?? 5);
const state = await mkdtemp(path.join(tmpdir(), "vibe-latency-state-"));
const executable =
  process.env.VIBE_VERIFY_HOST ||
  path.join(
    root,
    "target",
    "debug",
    "vibe-workbench-host" + (process.platform === "win32" ? ".exe" : ""),
  );
const host = spawn(executable, [], {
  cwd: process.env.VIBE_VERIFY_CWD || root,
  env: {
    ...process.env,
    VIBE_WORKBENCH_STATE: state,
    VIBE_WORKBENCH_PORT: "0",
    VIBE_WORKBENCH_TIMING: process.env.VIBE_WORKBENCH_TIMING ?? "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let logs = "";
host.stderr!.setEncoding("utf8");
host.stderr!.on("data", (chunk: string) => (logs += chunk));
let url = "";
for (let n = 0; n < 400 && !url; n++) {
  if (host.exitCode !== null) throw new Error(logs);
  url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
  await new Promise((resolve) => setTimeout(resolve, 25));
}
assert(url, logs || "Host did not start");
const command = async (request: unknown) => {
  const response = await fetch(`${url}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (body.error)
    throw Object.assign(new Error(body.error.message), body.error);
  return body.result;
};

let folder = "";
try {
  folder = (await measureEditing(command, rounds)).folder;
} finally {
  host.kill();
  await once(host, "exit");
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
type Reported = { totals: number[]; stages: Map<string, number[]> };
const byLabel = new Map<string, Reported>();
for (const line of logs.split("\n")) {
  const match = line.match(/^timing (\S+) ([\d.]+)ms(.*)$/);
  if (!match) continue;
  const entry: Reported = byLabel.get(match[1]) ?? {
    totals: [],
    stages: new Map(),
  };
  byLabel.set(match[1], entry);
  entry.totals.push(Number(match[2]));
  // A stage can repeat within one request (several Java round trips); sum it.
  const sums = new Map<string, number>();
  for (const [, name, ms] of match[3].matchAll(/ (\S+)=([\d.]+)/g))
    sums.set(name, (sums.get(name) ?? 0) + Number(ms));
  for (const [name, ms] of sums)
    entry.stages.set(name, [...(entry.stages.get(name) ?? []), ms]);
}
if (byLabel.size) {
  console.log("Host stages, p50 ms over the requests that reported them:");
  for (const [label, { totals, stages }] of byLabel) {
    const parts = [...stages].map(
      ([name, values]) => `${name}=${Math.round(median(values) * 10) / 10}`,
    );
    console.log(
      `  ${label} ×${totals.length} total=${Math.round(median(totals))}: ${parts.join(" ")}`,
    );
  }
}
await rm(state, { recursive: true, force: true });
if (folder) await rm(folder, { recursive: true, force: true });
