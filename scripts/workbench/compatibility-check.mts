/** Synthetic compatibility workloads; no course files, credentials or model calls. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  connectionIndex,
  documentComponent,
  portSignal,
  signalTrace,
  wireSignal,
} from "../../apps/workbench/src/editor/connectivity.ts";

const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-compatibility-"));
let child: ChildProcess | undefined;
let url = "",
  logs = "";
const measurements: Record<string, number[]> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function measured<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  (measurements[name] ??= []).push(
    Math.round((performance.now() - start) * 10) / 10,
  );
  return result;
}
async function command(request: any) {
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
const libs = '<lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/>';
const project = (circuits: string, libraries = libs) =>
  `<project source="2.7.1" version="1.0">${libraries}<main name="main"/><options/><mappings/><toolbar/>${circuits}</project>`;
const pin = (x: number, y: number, label: string, output = false) =>
  `<comp lib="0" name="Pin" loc="(${x},${y})"><a name="label" val="${label}"/>${output ? '<a name="output" val="true"/><a name="facing" val="west"/>' : ""}</comp>`;
const wire = (x1: number, y1: number, x2: number, y2: number) =>
  `<wire from="(${x1},${y1})" to="(${x2},${y2})"/>`;
const appearance =
  '<appear><rect x="30" y="40" width="60" height="20" fill="none" stroke="#000000" stroke-width="2"/><circ-port x="26" y="46" width="8" height="8" pin="100,100"/><circ-port x="86" y="46" width="8" height="8" pin="280,100"/><circ-anchor x="86" y="46" width="8" height="8" facing="east"/></appear>';
const inverter = (name: string) =>
  `<circuit name="${name}"><a name="appearance" val="custom"/>${appearance}${pin(100, 100, "input")}<comp lib="1" name="NOT Gate" loc="(200,100)"/>${pin(280, 100, "output", true)}${wire(100, 100, 170, 100)}${wire(200, 100, 280, 100)}</circuit>`;
const shell = (instance: string, library = "") =>
  `<circuit name="main">${pin(100, 100, "input")}<comp ${library} name="${instance}" loc="(300,100)"/>${pin(400, 100, "output", true)}${wire(100, 100, 240, 100)}${wire(300, 100, 400, 100)}</circuit>`;
const scope = (doc: any, circuit = "main") => ({
  id: doc.id,
  revision: doc.revision,
  circuit,
});
async function open(name: string, xml: string) {
  const file = path.join(state, name);
  await writeFile(file, xml);
  return command({ op: "open", path: file });
}
/** Starts or reuses a circuit's run; the released version's start did both. */
async function start(doc: any, circuit = "main") {
  const result = await command({
    op: "simulationAct",
    documentId: doc.id,
    revision: doc.revision,
    target: { kind: "definition", circuit },
    command: { kind: "start" },
  });
  assert(result.sessionId && result.viewId, JSON.stringify(result));
  return {
    sessionId: result.sessionId as string,
    viewId: result.viewId as string,
  };
}
/** Drives the run's current view. */
const drive = (
  doc: any,
  run: { sessionId: string; viewId: string },
  request: any,
) =>
  command({
    op: "simulationAct",
    documentId: doc.id,
    revision: doc.revision,
    target: { kind: "run", ...run },
    command: request,
  });
const halt = (run: { sessionId: string }) =>
  command({ op: "simulationStop", sessionId: run.sessionId });
async function evaluate(doc: any, invert: boolean) {
  const result = await command({
    op: "simulate",
    ...scope(doc),
    vectors: [
      { inputs: { input: 0 }, expected: { output: invert ? 1 : 0 } },
      { inputs: { input: 1 }, expected: { output: invert ? 0 : 1 } },
    ],
  });
  assert.equal(result.passed, 2, JSON.stringify(result));
}
async function render(doc: any) {
  const image = await command({
    op: "render",
    ...scope(doc),
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    scale: 1,
  });
  const bytes = Buffer.from(
    image.image.replace("data:image/png;base64,", ""),
    "base64",
  );
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return bytes;
}
try {
  await measured("host_start", async () => {
    const executable =
      process.env.VIBE_VERIFY_HOST ||
      path.join(
        root,
        "target",
        "debug",
        "vibe-workbench-host" + (process.platform === "win32" ? ".exe" : ""),
      );
    child = spawn(executable, [], {
      cwd: process.env.VIBE_VERIFY_CWD || root,
      env: {
        ...process.env,
        VIBE_WORKBENCH_STATE: state,
        VIBE_WORKBENCH_PORT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (chunk) => {
      logs += chunk;
      url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || url;
    });
    for (let n = 0; n < 400 && !url; n++) {
      if (child.exitCode !== null) throw new Error(logs);
      await sleep(25);
    }
    assert(url, logs || "Host did not start");
  });
  const local = await open(
    "custom.circ",
    project(shell("inverter") + inverter("inverter")),
  );
  const observed = await measured(
    "cold_java_observe_including_bridge_setup",
    () => command({ op: "observe", ...scope(local) }),
  );
  const instance = observed.focus.components.find(
    (c: any) => c.factoryName === "inverter",
  );
  assert(instance, "Custom appearance instance missing");
  assert.deepEqual(
    instance.ends.map((p: any) => [p.location.x, p.location.y]).sort(),
    [
      [240, 100],
      [300, 100],
    ],
  );
  const nativeIndex = connectionIndex(observed.focus);
  const nativeInput = instance.ends.find(
    (end: any) => end.direction === "input",
  );
  const target = portSignal(instance, nativeInput);
  const traced = signalTrace(nativeIndex, target.bits, target.origin);
  assert.equal(traced.singleSource?.component.factoryName, "Pin");
  assert.equal(traced.singleSource?.component.selector?.label, "input");
  assert(documentComponent(local.circuits[0], traced.singleSource!.component));
  assert(wireSignal(nativeIndex, observed.focus.wires[0]));
  const unknownBit = signalTrace(
    nativeIndex,
    [...target.bits, { bit: 1, netId: null }],
    target.origin,
  );
  assert.equal(
    unknownBit.singleSource,
    null,
    "Incomplete bit coverage must not guess a unique source",
  );
  await evaluate(local, true);
  await render(local);
  // Files saved by 2.15 builds run on the bundled 2.15 runtime, which accepts
  // level-triggered flip-flops that ITA 2.16 rejects.
  const legacy = await open(
    "legacy-2.15.circ",
    '<project source="2.15.0.2.exe" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Memory" name="1"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main"><comp lib="1" name="D Flip-Flop" loc="(300,100)"><a name="trigger" val="high"/></comp></circuit></project>',
  );
  const legacyObserved = await command({ op: "observe", ...scope(legacy) });
  assert(
    legacyObserved.focus.components.some(
      (c: any) => c.factoryName === "D Flip-Flop",
    ),
    "2.15 flip-flop missing",
  );
  const legacyInfo = await command({
    op: "projectInfo",
    id: legacy.id,
    revision: legacy.revision,
  });
  assert.match(String(legacyInfo.runtimeVersion), /^2\.15\./);
  assert.equal(
    (await command({ op: "observe", ...scope(local) })).focus.components.some(
      (c: any) => c.factoryName === "inverter",
    ),
    true,
    "Switching back to a 2.16 file must restart on the 2.16 runtime",
  );
  // Loading splits a wire where another wire ends or a port sits on it, on
  // both runtimes; a '+' crossing stays two separate signals.
  const junctions = `<circuit name="main">${pin(100, 100, "a")}${pin(400, 100, "y", true)}${pin(500, 120, "b", true)}${wire(100, 100, 400, 100)}${wire(200, 100, 200, 160)}${wire(300, 40, 300, 200)}${wire(500, 40, 500, 200)}</circuit>`;
  for (const source of ["2.7.1", "2.15.0.2.exe"]) {
    const doc = await open(
      `junctions-${source}.circ`,
      project(junctions).replace('source="2.7.1"', `source="${source}"`),
    );
    const { focus } = await command({ op: "observe", ...scope(doc) });
    const key = (w: any) => `${w.from.x},${w.from.y}-${w.to.x},${w.to.y}`;
    assert.deepEqual(
      focus.wires.map(key).sort(),
      [
        "100,100-200,100",
        "200,100-200,160",
        "200,100-400,100",
        "300,40-300,200",
        "500,120-500,200",
        "500,40-500,120",
      ],
      source,
    );
    const bundle = (k: string) =>
      focus.wires.find((w: any) => key(w) === k).bundleId;
    assert.equal(bundle("200,100-200,160"), bundle("100,100-200,100"), source);
    assert.equal(bundle("500,40-500,120"), bundle("500,120-500,200"), source);
    assert.notEqual(
      bundle("300,40-300,200"),
      bundle("100,100-200,100"),
      source,
    );
  }
  const unrotated = await command({
    op: "template",
    ...scope(local),
    library: "1",
    name: "NOT Gate",
  });
  const eastInput = unrotated.children.find(
    (node: any) => node.tag === "port" && node.attributes.direction === "input",
  );
  const rotated = await command({
    op: "template",
    ...scope(local),
    library: "1",
    name: "NOT Gate",
    attributes: { facing: "north" },
  });
  const rotatedInput = rotated.children.find(
    (node: any) => node.tag === "port" && node.attributes.direction === "input",
  );
  assert.equal(rotatedInput.attributes.x, "0");
  assert.equal(
    rotatedInput.attributes.y,
    String(-Number(eastInput.attributes.x)),
    "Template preview ignored rotation attributes",
  );
  const nestedRun = await start(local);
  const nested = await command({
    op: "simulationNavigate",
    sessionId: nestedRun.sessionId,
    instancePath: [
      local.circuits[0].components.find((c: any) => c.name === "inverter").id,
    ],
  });
  assert.equal(nested.circuit, "inverter", JSON.stringify(nested));
  await halt(nestedRun);
  assert.equal(
    await readFile(path.join(state, "custom.circ"), "utf8"),
    project(shell("inverter") + inverter("inverter")),
  );

  await mkdir(path.join(state, "library"));
  await writeFile(
    path.join(state, "library", "leaf.circ"),
    project(inverter("inverter")),
  );
  await writeFile(
    path.join(state, "library", "module.circ"),
    project(
      shell("inverter", 'lib="2"').replace(
        '<circuit name="main">',
        '<circuit name="main"><a name="appearance" val="custom"/>' +
          appearance.replace('pin="280,100"', 'pin="400,100"'),
      ),
      libs + '<lib desc="file#leaf.circ" name="2"/>',
    ),
  );
  const external = await open(
    "external.circ",
    project(
      shell("main", 'lib="2"'),
      libs + '<lib desc="file#library/module.circ" name="2"/>',
    ),
  );
  const externalObserved = await measured(
    "nested_external_library_observe",
    () => command({ op: "observe", ...scope(external) }),
  );
  assert(
    externalObserved.focus.components.some(
      (c: any) => c.factoryName === "main",
    ),
  );
  await render(external);
  await evaluate(external, true);
  await halt(await start(external));
  const direct = await open(
    "direct.circ",
    project(
      shell("inverter", 'lib="2"'),
      libs + '<lib desc="file#library/leaf.circ" name="2"/>',
    ),
  );
  await evaluate(direct, true);
  const directOutput = direct.circuits[0].components.find(
    (component: any) => component.attributes.label === "output",
  );
  /** The output pin in the run's newest frame, or the first one after `after`. */
  const outputValue = async (
    run: { sessionId: string; viewId: string },
    after = 0,
  ) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const snapshot = await command({
        op: "simulationSnapshot",
        sessionId: run.sessionId,
        componentIds: [directOutput.id],
        trace: false,
        memory: false,
      });
      if (snapshot.frame.commandSequence >= after)
        return {
          frameSequence: snapshot.frame.frameSequence as number,
          bits: snapshot.frame.components
            .find((item: any) => item.id === directOutput.id)
            .ports.find((port: any) => port.index === 0).bits as string,
        };
      await sleep(10);
    }
    throw new Error(`no frame after command ${after}`);
  };
  const originalSimulation = await start(direct);
  /** Drives the input low and keeps the frame it settled in. */
  const settledOutput = async (run: { sessionId: string; viewId: string }) => {
    const acknowledged = await drive(direct, run, {
      kind: "input",
      componentId: direct.circuits[0].components.find(
        (c: any) => c.attributes.label === "input",
      ).id,
      bits: "0",
    });
    const output = await outputValue(run, acknowledged.commandSequence);
    const captured = await command({
      op: "observationCapture",
      sessionId: run.sessionId,
      viewId: run.viewId,
      frameSequence: output.frameSequence,
      title: "Synthetic library check",
    });
    assert.equal(captured.viewId, run.viewId);
    return output.bits;
  };
  assert.equal(await settledOutput(originalSimulation), "1");
  const beforeLibraryChange = await command({
    op: "observe",
    ...scope(direct),
  });
  assert(
    beforeLibraryChange.focus.components
      .find((c: any) => c.factoryName === "inverter")
      .ends.some((p: any) => p.location.x === 240),
  );
  await writeFile(
    path.join(state, "library", "leaf.circ"),
    project(inverter("inverter").replace('x="26"', 'x="16"')),
  );
  const afterLibraryChange = await command({ op: "observe", ...scope(direct) });
  assert(
    afterLibraryChange.focus.components
      .find((c: any) => c.factoryName === "inverter")
      .ends.some((p: any) => p.location.x === 230),
    "Changed external library returned cached port geometry",
  );
  await writeFile(
    path.join(state, "library", "leaf.circ"),
    project(inverter("inverter").replace("NOT Gate", "Missing Gate")),
  );
  await assert.rejects(
    () => command({ op: "observe", ...scope(direct) }),
    /Missing Gate|加载|load|覆盖/,
  );
  await writeFile(
    path.join(state, "library", "leaf.circ"),
    project(
      inverter("inverter")
        .replace("NOT Gate", "Buffer")
        .replace('to="(170,100)"', 'to="(180,100)"'),
    ),
  );
  await evaluate(direct, false);
  const unchangedSimulation = (await command({ op: "simulationStatus" })).state;
  assert.equal(unchangedSimulation.viewId, originalSimulation.viewId);
  assert.equal(
    (await outputValue(originalSimulation)).bits,
    "1",
    "External checks reset the user's transient simulation",
  );
  const reusedSimulation = await start(direct);
  assert.equal(
    reusedSimulation.viewId,
    originalSimulation.viewId,
    "A start reuses the run of the same circuit and revision",
  );
  assert.equal(
    (await outputValue(reusedSimulation)).bits,
    "1",
    "Reusing a run keeps the library it started with",
  );
  await halt(reusedSimulation);
  const restartedSimulation = await start(direct);
  assert.equal(
    await settledOutput(restartedSimulation),
    "0",
    "A new run must load the changed library",
  );
  await halt(restartedSimulation);
  await writeFile(
    path.join(state, "library", "leaf.circ"),
    project(inverter("inverter").replace('to="(170,100)"', 'to="(170,110)"')),
  );
  await assert.rejects(
    () => command({ op: "observe", ...scope(direct) }),
    /水平|垂直|斜线/,
  );
  await writeFile(
    path.join(state, "library", "leaf.circ"),
    project(inverter("inverter")),
  );
  await evaluate(direct, true);
  const stoppedAndStarted = await start(direct);
  assert.notEqual(
    stoppedAndStarted.viewId,
    restartedSimulation.viewId,
    "A start after a stop makes a new run",
  );
  assert.equal(
    await settledOutput(stoppedAndStarted),
    "1",
    "Stop/start retained the previous library",
  );
  await halt(stoppedAndStarted);
  const originalPath = path.join(state, "direct.circ");
  const originalBytes = await readFile(originalPath);
  await mkdir(path.join(state, "exported", "nested"), { recursive: true });
  const moved = await command({
    op: "save",
    id: direct.id,
    revision: direct.revision,
    path: path.join(state, "exported", "nested", "copy.circ"),
  });
  assert.equal(moved.id, direct.id, "Save As must retain document identity");
  assert.deepEqual(
    await readFile(originalPath),
    originalBytes,
    "Save As changed the original source",
  );
  const movedObserved = await command({ op: "observe", ...scope(moved) });
  assert(
    movedObserved.focus.components.some(
      (c: any) => c.factoryName === "inverter",
    ),
  );
  await render(moved);
  await evaluate(moved, true);

  console.log(
    "Custom appearance, local subcircuit navigation, relative and nested external libraries: passed",
  );

  // The worker applies each new revision to the project it holds. After
  // edits of every kind, including pins of a subcircuit whose instances
  // follow them, it observes exactly what a whole load of the file does.
  const pair = `<circuit name="pair">${pin(100, 100, "a")}<comp lib="1" name="NOT Gate" loc="(200,100)"/>${pin(280, 100, "y", true)}${wire(100, 100, 170, 100)}${wire(200, 100, 280, 100)}</circuit>`;
  let live = await open(
    "revisions.circ",
    project(
      `<circuit name="main">${pin(100, 100, "input")}<comp name="pair" loc="(300,100)"/><comp name="pair" loc="(300,300)"/><comp name="inverter" loc="(300,500)"/><comp lib="1" name="NOT Gate" loc="(500,100)"/>${pin(600, 100, "output", true)}${wire(100, 100, 240, 100)}${wire(300, 100, 470, 100)}${wire(500, 100, 600, 100)}</circuit>` +
        pair +
        inverter("inverter"),
    ),
  );
  const part = (circuit: string, name: string) =>
    live.circuits
      .find((c: any) => c.name === circuit)
      .components.find(
        (c: any) => c.name === name || c.attributes.label === name,
      ).id;
  const observeAll = async () => {
    const result: Record<string, any> = {};
    for (const circuit of ["main", "pair", "inverter"]) {
      const observed = await command({
        op: "observe",
        ...scope(live, circuit),
      });
      // Text is measured once per loaded project, which can widen the
      // bounds other circuits report; the rest must match.
      for (const summary of observed.project.circuits) delete summary.bounds;
      result[circuit] = observed;
    }
    return result;
  };
  const step = async (circuit: string, edit: any) => {
    live = (
      await command({ op: "edit", ...scope(live, circuit), edit })
    ).view;
    await observeAll();
  };
  await observeAll();
  await step("inverter", {
    kind: "attributes",
    id: part("inverter", "input"),
    values: { label: "in" },
  });
  await step("main", {
    kind: "move",
    ids: [part("main", "NOT Gate")],
    delta: { x: 10, y: 0 },
  });
  await step("main", {
    kind: "wire",
    points: [
      { x: 700, y: 200 },
      { x: 760, y: 200 },
    ],
  });
  await step("main", {
    kind: "place",
    name: "NOT Gate",
    library: "1",
    location: { x: 800, y: 300 },
    attributes: { label: "extra" },
  });
  await step("main", { kind: "delete", ids: [part("main", "output")] });
  await step("pair", {
    kind: "place",
    name: "Pin",
    library: "0",
    location: { x: 100, y: 200 },
    attributes: { label: "b" },
  });
  await step("pair", { kind: "delete", ids: [part("pair", "a")] });
  for (const verb of ["undo", "undo", "redo"])
    live = (await command({ op: verb, id: live.id, revision: live.revision }))
      .view;
  const applied = await observeAll();
  // Three unrelated files take the worker's places; the same revision then loads whole.
  for (let n = 0; n < 3; n++) {
    const other = await open(
      `unrelated-${n}.circ`,
      project(`<circuit name="main">${pin(100, 100, `x${n}`)}</circuit>`),
    );
    await command({ op: "observe", ...scope(other) });
  }
  assert.deepEqual(await observeAll(), applied);
  console.log("Revisions applied in place observe like a whole load: passed");

  const columns = 32,
    rows = 32;
  const branches: string[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      const x = 100 + col * 300,
        y = 100 + row * 80,
        n = row * columns + col;
      branches.push(
        pin(x, y, `in_${n}`),
        `<comp lib="1" name="NOT Gate" loc="(${x + 100},${y})"/>`,
        pin(x + 180, y, `out_${n}`, true),
        wire(x, y, x + 70, y),
        wire(x + 100, y, x + 180, y),
      );
    }
  const large = await measured("large_open_3072_components_2048_wires", () =>
    open(
      "large.circ",
      project(`<circuit name="main">${branches.join("")}</circuit>`),
    ),
  );
  await measured("large_first_observe", async () => {
    const result = await command({ op: "observe", ...scope(large) });
    console.log(
      "Observation JSON bytes:",
      Buffer.byteLength(JSON.stringify(result)),
    );
    assert.equal(result.focus.components.length, columns * rows * 3);
  });
  for (let i = 0; i < 5; i++)
    await measured("large_warm_observe", () =>
      command({ op: "observe", ...scope(large) }),
    );
  for (let i = 0; i < 5; i++)
    await measured("large_viewport_render_1200x800", () => render(large));
  const run = await measured("large_simulation_start", () => start(large));
  const input = large.circuits[0].components.find(
    (c: any) => c.attributes.label === "in_0",
  );
  for (let i = 0; i < 5; i++)
    await measured("large_input_ack", () =>
      drive(large, run, {
        kind: "input",
        componentId: input.id,
        bits: String(i % 2),
      }),
    );
  assert(run.sessionId);
  await halt(run);
  console.log(
    JSON.stringify(
      {
        environment: {
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          node: process.version,
        },
        workload: { components: 3072, wires: 2048, canvas: [1200, 800] },
        milliseconds: measurements,
        limits: [
          "Host API and native JVM measured; does not measure webview paint or pointer interaction.",
          "Synthetic combinational grid; not representative of every CPU, memory, oscillating circuit or external jar plugin.",
          "Cold first observation includes bridge compilation when precompiled resources are not selected.",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (child && child.exitCode === null) {
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
      const [code] = await once(killer, "exit");
      assert.equal(code, 0, "Windows host process tree did not terminate");
    } else child.kill();
    await Promise.race([stopped, sleep(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (!process.env.VIBE_KEEP_COMPATIBILITY)
    await rm(state, { recursive: true, force: true });
  else console.log("Synthetic state:", state);
}
