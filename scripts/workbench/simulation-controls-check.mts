/** Actual Rust -> Java simulation commands; no model or user workspace involved. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import { eventStream } from "./event-stream.mts";
import { sameRun, simulationClient } from "./simulation-client.mts";

const root = path.resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(
  path.join(tmpdir(), "vibe-simulation-controls-"),
);
const executable =
  process.env.VIBE_VERIFY_HOST ||
  path.join(
    root,
    "target/debug/vibe-workbench-host" +
      (process.platform === "win32" ? ".exe" : ""),
  );
const child = spawn(executable, [], {
  cwd: process.env.VIBE_VERIFY_CWD || root,
  env: {
    ...process.env,
    VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
    VIBE_WORKBENCH_STATE: path.join(directory, "state"),
    VIBE_WORKBENCH_RESOURCES: root,
    VIBE_WORKBENCH_PORT: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let url = "";
let logs = "";
let startupError: Error | null = null;
child.on("error", (error) => {
  startupError = error;
});
child.stderr.on("data", (chunk) => {
  logs += chunk;
  url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || "";
});

async function command<T>(request: Record<string, unknown>): Promise<T> {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    error?: { code: string; message: string };
    result: T;
  };
  if (body.error)
    throw Object.assign(new Error(body.error.message), body.error);
  assert(response.ok, `Host returned HTTP ${response.status}`);
  return body.result;
}
let stream: Awaited<ReturnType<typeof eventStream>> | undefined;
let client: ReturnType<typeof simulationClient> | undefined;

try {
  for (let attempts = 0; attempts < 200 && !url; attempts++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(url, logs || "Rust host did not start");
  stream = await eventStream(url);
  const run = simulationClient((request) => command(request), stream);
  client = run;
  const clock = () => run.mirror().frame!.clock;
  /** A command that changes nothing, for a frame of the run as it is. */
  const probe = () => run.act({ kind: "configure" });
  const source = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#I/O" name="5"/><main name="main"/><options/><mappings/><toolbar/>
<circuit name="main"><comp lib="0" name="Clock" loc="(100,100)"/><comp lib="0" name="Pin" loc="(100,160)"><a name="label" val="input"/></comp><comp name="bank" loc="(300,100)"/><comp name="bank" loc="(500,100)"/></circuit>
<circuit name="bank"><comp lib="0" name="Clock" loc="(100,100)"/><comp lib="0" name="Pin" loc="(100,160)"><a name="label" val="input"/></comp><comp lib="5" name="Button" loc="(100,240)"/><comp lib="5" name="Button" loc="(160,240)"/></circuit></project>`;
  const firstPath = path.join(directory, "first.circ");
  const secondPath = path.join(directory, "second.circ");
  await writeFile(firstPath, source);
  await writeFile(secondPath, source);
  const first = await command<Document>({ op: "open", path: firstPath });
  const second = await command<Document>({ op: "open", path: secondPath });
  assert.notEqual(
    first.id,
    second.id,
    "Separate documents must retain identity",
  );

  const main = await run.start(first, "main", 7.5);
  assert.equal(main.rootCircuit, "main");
  assert.equal(clock().automatic, true, "A run starts with propagation on");
  assert.equal(clock().frequency, 7.5, "A run starts at the frequency asked");
  assert.equal(clock().running, false);
  assert.deepEqual(run.mirror().frame?.instancePath, []);

  await run.act({ kind: "toggle-propagation" });
  assert.equal(clock().automatic, false);
  assert.equal(clock().frequency, 7.5);
  await run.act({ kind: "toggle-propagation" });
  assert.equal(clock().automatic, true);
  assert.equal(
    (await run.act({ kind: "toggle-clock" })).frame?.clock.running,
    true,
  );
  assert.equal(
    (await run.act({ kind: "toggle-clock" })).frame?.clock.running,
    false,
  );
  // The runtime decides each toggle from its own state, so toggles sent at
  // once both count, without a frame in between.
  const toggles = await Promise.all([
    run.send({ kind: "toggle-clock" }),
    run.send({ kind: "toggle-clock" }),
  ]);
  assert.equal(
    (await run.settled(Math.max(...toggles))).frame?.clock.running,
    false,
  );
  assert(sameRun(run.mirror().run, main));

  await run.act({ kind: "toggle-clock" });
  const bank = await run.start(first, "bank", 3.25);
  assert(!sameRun(bank, main), "A start ends the run and starts another");
  assert.equal(run.mirror().frame?.circuit, "bank");
  assert.equal(clock().running, false, "A run starts paused");
  assert.equal(clock().frequency, 3.25);
  await run.act({ kind: "toggle-clock" });

  // A start that cannot happen keeps the run there is.
  for (const frequency of [0, 0.2, 4096.1]) {
    await assert.rejects(run.start(second, "main", frequency), /时钟频率/);
    const kept = await probe();
    assert(sameRun(kept.run, bank), "A rejected start ended the run");
    assert.equal(kept.frame?.clock.running, true);
    assert.equal(kept.frame?.clock.frequency, 3.25);
  }

  const other = await run.start(second, "main", 11.5);
  assert.equal(other.documentId, second.id);
  assert.equal(clock().automatic, true);
  assert.equal(clock().running, false);
  assert.equal(clock().frequency, 11.5);

  const instances = first.circuits
    .find((c) => c.name === "main")!
    .components.filter((c) => c.name === "bank");
  const button = first.circuits
    .find((c) => c.name === "bank")!
    .components.find((c) => c.name === "Button")!;
  const otherButton = first.circuits
    .find((c) => c.name === "bank")!
    .components.find((c) => c.name === "Button" && c.id !== button.id)!;
  assert.equal(instances.length, 2);
  assert(
    button && otherButton,
    "Native fixture must contain two momentary buttons",
  );
  const buttonValue = (id = button.id) => run.bits(id);
  const press = (id = button.id, value: "0" | "1" = "1") =>
    run.act({ kind: "button", componentId: id, value });
  await run.start(first, "main");
  await run.navigate([instances[0].id]);
  assert.equal(buttonValue(), "0");
  await press();
  assert.equal(buttonValue(), "1");
  await press(button.id, "0");
  assert.equal(buttonValue(), "0");
  await press();
  await press(otherButton.id);
  assert.equal(buttonValue(otherButton.id), "1");
  await assert.rejects(
    run.send({ kind: "button", componentId: "missing-button", value: "1" }),
    /Unknown input|可操作输入/,
  );
  await assert.rejects(run.navigate(["missing-instance"]), /子电路实例/);
  await probe();
  assert.equal(
    buttonValue(),
    "1",
    "Reject an invalid target before releasing the current button",
  );
  await run.navigate([]);
  await run.navigate([instances[0].id]);
  assert.equal(
    buttonValue(),
    "0",
    "Leaving a pressed child instance must release the momentary button",
  );
  assert.equal(
    buttonValue(otherButton.id),
    "0",
    "All held buttons are released",
  );
  await run.navigate([]);
  await run.navigate([instances[1].id]);
  assert.equal(
    buttonValue(),
    "0",
    "A sibling instance must not inherit a pressed button",
  );
  await press();
  await run.act({ kind: "reset" });
  assert.equal(
    buttonValue(),
    "0",
    "Reset clears held stimuli and their release bookkeeping",
  );
  await press();
  await run.start(first, "main");
  await run.navigate([instances[1].id]);
  assert.equal(buttonValue(), "0", "A new run must not inherit held stimuli");

  for (const document of [first, second]) {
    const current = await command<Document>({ op: "read", id: document.id });
    assert.equal(current.revision, document.revision);
    assert.equal(current.dirty, false);
    assert.equal(current.canUndo, document.canUndo);
  }
  assert.equal(await readFile(firstPath, "utf8"), source);
  assert.equal(await readFile(secondPath, "utf8"), source);
  console.log(
    "Verified runs starting at their frequency with propagation on, sequential/concurrent toggles decided by the runtime, starts of other circuits and documents, rejected starts keeping the run, held buttons across instances/reset/new runs, and unchanged revisions/source bytes.",
  );
} finally {
  if (url && child.exitCode === null) await client?.stop().catch(() => {});
  await stream?.close();
  if (child.pid && child.exitCode === null) {
    const exited = once(child, "exit");
    if (process.platform === "win32") {
      const kill = spawn(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
      const [code] = await once(kill, "exit");
      assert.equal(code, 0, "Windows host process tree did not terminate");
    } else child.kill();
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Rust host did not terminate")),
          10_000,
        );
        timer.unref();
      }),
    ]);
  }
  await rm(directory, { recursive: true, force: true });
}
