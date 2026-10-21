/** Actual Rust -> Java simulation commands; no model or user workspace involved. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import type { Simulation } from "../../apps/workbench/src/lib/types.ts";

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
const action = (
  document: Document,
  circuit: string,
  operation: string,
  attributes: Record<string, string> = {},
) =>
  command<Simulation>({
    op: "simulationAction",
    id: document.id,
    revision: document.revision,
    circuit,
    command: operation,
    attributes,
  });
const status = () => command<Simulation>({ op: "simulationStatus" });
const owns = (simulation: Simulation, document: Document, circuit: string) => {
  assert.equal(simulation.documentId, document.id);
  assert.equal(simulation.revision, document.revision);
  assert.equal(simulation.circuit, circuit);
  assert.equal(simulation.rootCircuit, circuit);
  assert.deepEqual(simulation.instancePath, []);
  assert.equal(simulation.frame.tag, "frame");
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

  let simulation = await action(first, "main", "toggle-propagation", {
    initialFrequency: "7.5",
  });
  owns(simulation, first, "main");
  assert.equal(
    simulation.frame.attributes.automatic,
    "true",
    "Cold Ctrl+E must start propagation without immediately disabling it",
  );
  assert.equal(Number(simulation.frame.attributes.frequency), 7.5);
  assert.equal(simulation.frame.attributes.running, "false");
  const mainView = simulation.viewId;

  simulation = await action(first, "main", "toggle-propagation", {
    initialFrequency: "32",
  });
  assert.equal(simulation.frame.attributes.automatic, "false");
  assert.equal(
    Number(simulation.frame.attributes.frequency),
    7.5,
    "The cold-start preference must not reconfigure an existing simulation",
  );
  simulation = await action(first, "main", "toggle-propagation");
  assert.equal(simulation.frame.attributes.automatic, "true");
  assert.equal(simulation.viewId, mainView);

  // No UI frame refresh or timing delay between acknowledged toggles.
  simulation = await action(first, "main", "toggle-clock");
  assert.equal(simulation.frame.attributes.running, "true");
  simulation = await action(first, "main", "toggle-clock");
  assert.equal(simulation.frame.attributes.running, "false");
  assert.equal(simulation.viewId, mainView);
  // Concurrent callers must also resolve the toggle under the native lock.
  await Promise.all([
    action(first, "main", "toggle-clock"),
    action(first, "main", "toggle-clock"),
  ]);
  assert.equal((await status()).frame.attributes.running, "false");

  await action(first, "main", "toggle-clock");
  simulation = await action(first, "bank", "toggle-clock", {
    initialFrequency: "3.25",
  });
  owns(simulation, first, "bank");
  assert.equal(simulation.frame.attributes.running, "true");
  assert.equal(Number(simulation.frame.attributes.frequency), 3.25);
  assert.notEqual(simulation.viewId, mainView);
  assert.equal((await status()).viewId, simulation.viewId);
  const bankView = simulation.viewId;

  // Invalid configuration of a different target must not tear down this run.
  for (const initialFrequency of ["0", "4096.1", "NaN", "invalid"]) {
    await assert.rejects(
      action(second, "main", "toggle-clock", { initialFrequency }),
      /时钟频率/,
    );
    const retained = await status();
    owns(retained, first, "bank");
    assert.equal(retained.viewId, bankView);
    assert.equal(retained.frame.attributes.running, "true");
    assert.equal(Number(retained.frame.attributes.frequency), 3.25);
  }

  simulation = await action(second, "main", "toggle-propagation", {
    initialFrequency: "11.5",
  });
  owns(simulation, second, "main");
  assert.equal(simulation.frame.attributes.automatic, "true");
  assert.equal(simulation.frame.attributes.running, "false");
  assert.equal(Number(simulation.frame.attributes.frequency), 11.5);
  assert.notEqual(simulation.viewId, bankView);
  assert.equal((await status()).viewId, simulation.viewId);

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
  const navigate = (path: string[]) =>
    command<Simulation>({
      op: "simulationView",
      id: first.id,
      revision: first.revision,
      path,
    });
  const sample = async () => {
    const ack = await command<{ attributes: Record<string, string> }>({
      op: "simulationCommand",
      id: first.id,
      revision: first.revision,
      command: "sample",
    });
    for (let attempts = 0; attempts < 1000; attempts++) {
      const current = await status();
      if (
        Number(current.frame.attributes.commandSequence) >=
        Number(ack.attributes.commandSequence)
      )
        return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Native sample acknowledgement did not reach a frame");
  };
  const buttonValue = (current: Simulation, componentId = button.id) =>
    current.frame.children
      .find(
        (node) =>
          node.tag === "component" && node.attributes.id === componentId,
      )
      ?.children.find(
        (node) => node.tag === "port" && node.attributes.index === "0",
      )?.attributes.value;
  const press = (view: Simulation) =>
    action(first, "bank", "button", {
      componentId: button.id,
      viewId: view.viewId,
      value: "1",
    });
  await action(first, "main", "toggle-propagation");
  let instance = await navigate([instances[0].id]);
  assert.equal(buttonValue(instance), "0");
  await press(instance);
  assert.equal(buttonValue(await sample()), "1");
  await action(first, "bank", "button", {
    componentId: otherButton.id,
    viewId: instance.viewId,
    value: "1",
  });
  assert.equal(buttonValue(await sample(), otherButton.id), "1");
  await assert.rejects(
    action(first, "bank", "button", {
      componentId: "missing-button",
      viewId: instance.viewId,
      value: "1",
    }),
    /Unknown input/,
  );
  await assert.rejects(navigate(["missing-instance"]), /子电路实例/);
  assert.equal(
    buttonValue(await sample()),
    "1",
    "Reject an invalid target before releasing the current button",
  );
  const oldViewId = instance.viewId;
  await navigate([]);
  instance = await navigate([instances[0].id]);
  assert.equal(
    buttonValue(instance),
    "0",
    "Leaving a pressed child instance must release the momentary button before changing view",
  );
  assert.equal(
    buttonValue(instance, otherButton.id),
    "0",
    "All acknowledged button presses must be released",
  );
  await navigate([]);
  instance = await navigate([instances[1].id]);
  assert.equal(
    buttonValue(instance),
    "0",
    "A sibling instance must not inherit a pressed button",
  );
  await press(instance);
  await action(first, "bank", "button-release", {
    componentId: button.id,
    viewId: oldViewId,
  });
  assert.equal(
    buttonValue(await sample()),
    "1",
    "A late release from another view must not release this instance's button",
  );
  await navigate([]);
  instance = await navigate([instances[1].id]);
  assert.equal(buttonValue(instance), "0");
  await press(instance);
  await action(first, "bank", "reset");
  assert.equal(
    buttonValue(await sample()),
    "0",
    "Reset clears held stimuli and their release bookkeeping",
  );
  await navigate([]);
  instance = await navigate([instances[1].id]);
  assert.equal(buttonValue(instance), "0");
  await press(instance);
  await command({ op: "simulationStop" });
  await action(first, "bank", "button-release", {
    componentId: button.id,
    viewId: instance.viewId,
  });
  assert.equal(
    await status(),
    null,
    "A late release must never resurrect a stopped simulation",
  );
  await action(first, "main", "toggle-propagation");
  instance = await navigate([instances[1].id]);
  assert.equal(
    buttonValue(instance),
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
    await command({ op: "simulationStop" }).catch(() => {});
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
