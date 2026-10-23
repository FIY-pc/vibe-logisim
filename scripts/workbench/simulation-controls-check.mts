/** Actual Rust -> Java simulation commands; no model or user workspace involved. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import type { ComponentState } from "../../apps/workbench/src/generated/ComponentState.ts";
import { simulationClient, type Run } from "./simulation-client.mts";

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
const client = simulationClient((request) => command(request));
const status = () => client.status();
/** Waits until a frame shows the commands sent so far. */
const settled = async () => {
  const acknowledged = await status();
  const wanted = acknowledged.state?.commandSequence ?? 0;
  for (let attempt = 0; attempt < 500; attempt++) {
    const current = await status();
    if ((current.state?.commandSequence ?? 0) >= wanted) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no frame after command ${wanted}`);
};
/** The run a definition command found or started, and its clock. */
const owns = async (document: Document, circuit: string) => {
  const current = await settled();
  assert.equal(current.session?.documentId, document.id);
  assert.equal(current.session?.revision, document.revision);
  assert.equal(current.session?.rootCircuit, circuit);
  assert.equal(current.state?.circuit, circuit);
  assert.deepEqual(current.state?.instancePath, []);
  return current;
};

try {
  for (let attempts = 0; attempts < 200 && !url; attempts++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(url, logs || "Rust host did not start");
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

  await client.definition(first, "main", { kind: "toggle-propagation" }, 7.5);
  const cold = await owns(first, "main");
  assert.equal(
    cold.state?.clock.automatic,
    true,
    "Cold Ctrl+E must start propagation without immediately disabling it",
  );
  assert.equal(cold.state?.clock.frequency, 7.5);
  assert.equal(cold.state?.clock.running, false);
  const mainView = cold.state!.viewId;

  await client.definition(first, "main", { kind: "toggle-propagation" }, 32);
  const toggled = await owns(first, "main");
  assert.equal(toggled.state?.clock.automatic, false);
  assert.equal(
    toggled.state?.clock.frequency,
    7.5,
    "The cold-start preference must not reconfigure an existing simulation",
  );
  await client.definition(first, "main", { kind: "toggle-propagation" });
  const again = await owns(first, "main");
  assert.equal(again.state?.clock.automatic, true);
  assert.equal(again.state?.viewId, mainView);

  // No UI frame refresh or timing delay between acknowledged toggles.
  await client.definition(first, "main", { kind: "toggle-clock" });
  assert.equal((await owns(first, "main")).state?.clock.running, true);
  await client.definition(first, "main", { kind: "toggle-clock" });
  const paused = await owns(first, "main");
  assert.equal(paused.state?.clock.running, false);
  assert.equal(paused.state?.viewId, mainView);
  // Concurrent callers must also resolve the toggle under the run's own lock.
  await Promise.all([
    client.definition(first, "main", { kind: "toggle-clock" }),
    client.definition(first, "main", { kind: "toggle-clock" }),
  ]);
  assert.equal((await status()).state?.clock.running, false);

  await client.definition(first, "main", { kind: "toggle-clock" });
  await client.definition(first, "bank", { kind: "toggle-clock" }, 3.25);
  const bank = await owns(first, "bank");
  assert.equal(bank.state?.clock.running, true);
  assert.equal(bank.state?.clock.frequency, 3.25);
  assert.notEqual(bank.state?.viewId, mainView);
  const bankView = bank.state!.viewId;

  // Invalid configuration of a different target must not tear down this run.
  for (const initialFrequency of [0, 0.2, 4096.1]) {
    await assert.rejects(
      client.definition(
        second,
        "main",
        { kind: "toggle-clock" },
        initialFrequency,
      ),
      /时钟频率/,
    );
    const retained = await owns(first, "bank");
    assert.equal(retained.state?.viewId, bankView);
    assert.equal(retained.state?.clock.running, true);
    assert.equal(retained.state?.clock.frequency, 3.25);
  }

  await client.definition(second, "main", { kind: "toggle-propagation" }, 11.5);
  const other = await owns(second, "main");
  assert.equal(other.state?.clock.automatic, true);
  assert.equal(other.state?.clock.running, false);
  assert.equal(other.state?.clock.frequency, 11.5);
  assert.notEqual(other.state?.viewId, bankView);

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
  /** The sequence of the newest accepted command of the current run, so a
   * frame can be waited for. A new run counts from zero, and a command a
   * stopped run ignores raises nothing. */
  let acknowledged = 0,
    ackSession = "";
  const act = async (
    work: Promise<{ commandSequence?: number; sessionId?: string }>,
  ) => {
    const result = await work;
    const session = result.sessionId ?? "";
    // Without a session the run ignored the command; nothing to wait for.
    if (!session) return result;
    if (session !== ackSession) {
      ackSession = session;
      acknowledged = result.commandSequence ?? 0;
    } else acknowledged = Math.max(acknowledged, result.commandSequence ?? 0);
    return result;
  };
  const settle = async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = await status();
      const session = current.session?.sessionId ?? "";
      if (session !== ackSession) {
        ackSession = session;
        acknowledged = 0;
      }
      const state = current.state;
      if (state && state.commandSequence >= acknowledged) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no frame after command ${acknowledged}`);
  };
  const live = async () => {
    const current = await status();
    assert(current.session, "the run must still be live");
    return {
      sessionId: current.session.sessionId,
      viewId: current.state?.viewId,
    };
  };
  /** Shows an instance of the run and waits for its frame. */
  const view = async (instancePath: string[]): Promise<Run> => {
    const current = await status();
    assert(current.session, "the run must still be live");
    const target = {
      sessionId: current.session.sessionId,
      viewId: current.state?.viewId ?? "",
    };
    const result = await client.navigate(target, instancePath);
    for (let attempt = 0; attempt < 500; attempt++) {
      const state = (await status()).state;
      if (state?.viewId === result.viewId)
        return { sessionId: target.sessionId, viewId: result.viewId };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`view ${result.viewId} never became the run's view`);
  };
  /** The buttons of the shown instance in the settled frame. */
  const sample = async (): Promise<Record<string, ComponentState>> => {
    await settle();
    const run = await live();
    const ids = [button.id, otherButton.id];
    for (let attempt = 0; attempt < 500; attempt++) {
      const { frame } = await client.snapshot(
        { sessionId: run.sessionId, viewId: run.viewId ?? "" },
        { componentIds: ids, limit: ids.length, offset: 0 },
      );
      const show = frame.viewId === run.viewId;
      const applied = frame.commandSequence >= acknowledged;
      const complete = ids.every((id) =>
        frame.components.some((component) => component.id === id),
      );
      if (show && applied && complete)
        return Object.fromEntries(frame.components.map((c) => [c.id, c]));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the shown instance never produced its frame");
  };
  const buttonValue = (
    state: Record<string, ComponentState>,
    componentId = button.id,
  ) => state[componentId]?.ports.find((port) => port.index === 0)?.bits;
  const press = (target: Run) =>
    act(
      client.run(first, target, {
        kind: "button",
        componentId: button.id,
        value: "1",
      }),
    );
  const release = (target: Run) =>
    act(
      client.run(first, target, {
        kind: "button",
        componentId: button.id,
        value: "0",
      }),
    );
  await client.definition(first, "main", { kind: "toggle-propagation" });
  let instance = await view([instances[0].id]);
  assert.equal(buttonValue(await sample()), "0");
  await press(instance);
  assert.equal(buttonValue(await sample()), "1");
  await act(
    client.run(first, instance, {
      kind: "button",
      componentId: otherButton.id,
      value: "1",
    }),
  );
  assert.equal(buttonValue(await sample(), otherButton.id), "1");
  await assert.rejects(
    client.run(first, instance, {
      kind: "button",
      componentId: "missing-button",
      value: "1",
    }),
    /Unknown input|可操作输入/,
  );
  await assert.rejects(view(["missing-instance"]), /子电路实例/);
  assert.equal(
    buttonValue(await sample()),
    "1",
    "Reject an invalid target before releasing the current button",
  );
  const oldView = instance;
  await view([]);
  instance = await view([instances[0].id]);
  assert.equal(
    buttonValue(await sample()),
    "0",
    "Leaving a pressed child instance must release the momentary button before changing view",
  );
  assert.equal(
    buttonValue(await sample(), otherButton.id),
    "0",
    "All acknowledged button presses must be released",
  );
  await view([]);
  instance = await view([instances[1].id]);
  assert.equal(
    buttonValue(await sample()),
    "0",
    "A sibling instance must not inherit a pressed button",
  );
  await press(instance);
  await release(oldView);
  assert.equal(
    buttonValue(await sample()),
    "1",
    "A late release from another view must not release this instance's button",
  );
  await view([]);
  instance = await view([instances[1].id]);
  assert.equal(buttonValue(await sample()), "0");
  await press(instance);
  await act(client.run(first, instance, { kind: "reset" }));
  assert.equal(
    buttonValue(await sample()),
    "0",
    "Reset clears held stimuli and their release bookkeeping",
  );
  await view([]);
  instance = await view([instances[1].id]);
  assert.equal(buttonValue(await sample()), "0");
  await press(instance);
  await client.stop(instance);
  await release(instance);
  assert.equal(
    (await status()).session,
    null,
    "A late release must never resurrect a stopped simulation",
  );
  await client.definition(first, "main", { kind: "toggle-propagation" });
  instance = await view([instances[1].id]);
  assert.equal(
    buttonValue(await sample()),
    "0",
    "A new run must not inherit held stimuli",
  );

  for (const document of [first, second]) {
    const current = await command<Document>({ op: "read", id: document.id });
    assert.equal(current.revision, document.revision);
    assert.equal(current.dirty, false);
    assert.equal(current.canUndo, document.canUndo);
  }
  assert.equal(await readFile(firstPath, "utf8"), source);
  assert.equal(await readFile(secondPath, "utf8"), source);
  console.log(
    "Verified native cold propagation, sequential/concurrent clock toggles, cold-only tick/s settings, direct circuit/document switching, invalid-setting recovery, held-button navigation/reset/stop and unchanged circuit revisions/source bytes.",
  );
} finally {
  if (url && child.exitCode === null) {
    const run = await client.status().catch(() => null);
    if (run?.session) await client.stop(run.session.sessionId).catch(() => {});
  }
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
