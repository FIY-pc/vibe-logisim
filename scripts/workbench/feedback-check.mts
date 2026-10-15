/** Public feedback boundary; no credentials or project files. Network checks are opt-in. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-feedback-"));
let child: ChildProcess | undefined;
let url = "",
  logs = "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function start(network = false) {
  url = "";
  logs = "";
  child = spawn(
    process.env.VIBE_VERIFY_HOST ||
      path.join(
        root,
        "target",
        "debug",
        "vibe-workbench-host" + (process.platform === "win32" ? ".exe" : ""),
      ),
    [],
    {
      cwd: root,
      env: {
        ...process.env,
        VIBE_WORKBENCH_STATE: state,
        VIBE_WORKBENCH_PORT: "0",
        VIBE_LOGISIM_NO_UPDATE_CHECK: network ? "0" : "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr!.on("data", (chunk) => {
    logs += chunk;
    url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || url;
  });
  for (let n = 0; n < 200 && !url; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    await sleep(25);
  }
  assert(url, logs);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = once(child, "exit");
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/taskkill.exe",
      ),
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore" },
    );
    assert.equal((await once(killer, "exit"))[0], 0);
  } else child.kill();
  await Promise.race([stopped, sleep(5000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await stopped;
  }
}
async function command(request: unknown) {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (body.error)
    throw Object.assign(new Error(body.error.message), body.error);
  return body.result;
}
try {
  await start();
  const status = await command({ op: "feedbackStatus" });
  assert.equal(status.forcedOff, true);
  const skipped = await command({ op: "feedbackCheck", manual: true });
  assert.equal(skipped.lastCheckedAt, null);
  assert.equal(
    (await command({ op: "feedbackPreference", enabled: false })).enabled,
    false,
  );
  const report = await command({ op: "diagnostics" });
  assert.deepEqual(Object.keys(report).sort(), [
    "appVersion",
    "architecture",
    "nativeRuntimeAvailable",
    "platform",
    "recoveryIssue",
    "schema",
    "simulationActive",
  ]);
  const target = path.join(state, "diagnostics.json");
  await command({ op: "diagnosticsExport", path: target, report });
  const preview = JSON.stringify(report, null, 2) + "\n";
  assert.equal(
    await readFile(target, "utf8"),
    preview,
    "Saved bytes differ from the displayed preview",
  );
  const digest = createHash("sha256").update(preview).digest("hex");
  await assert.rejects(() =>
    command({ op: "diagnosticsExport", path: target, report }),
  );
  await writeFile(target, "other writer");
  await assert.rejects(() =>
    command({
      op: "diagnosticsExport",
      path: target,
      report,
      expected_revision: digest,
    }),
  );
  assert.equal(await readFile(target, "utf8"), "other writer");
  await assert.rejects(() =>
    command({
      op: "diagnosticsExport",
      path: target,
      report: { ...report, source: "private" },
    }),
  );
  await stop();
  await start();
  assert.equal(
    (await command({ op: "feedbackStatus" })).enabled,
    false,
    "Disabled preference did not survive restart",
  );
  console.log(
    "Feedback preview/export, private-field rejection, concurrent target protection and disabled checks: passed",
  );
  if (process.env.VIBE_VERIFY_UPDATES === "1") {
    await stop();
    await start(true);
    const checked = await command({ op: "feedbackCheck", manual: true });
    if (checked.error) throw new Error(checked.error);
    assert.match(checked.latest, /^\d+\.\d+\.\d+$/);
    assert.equal(
      checked.url,
      `https://github.com/FIY-pc/vibe-logisim/releases/tag/v${checked.latest}`,
    );
    assert.equal(checked.development, /-/.test(checked.current));
    console.log(
      JSON.stringify({
        publicRelease: checked.latest,
        current: checked.current,
        development: checked.development,
      }),
    );
  }
} finally {
  await stop();
  await rm(state, { recursive: true, force: true });
}
