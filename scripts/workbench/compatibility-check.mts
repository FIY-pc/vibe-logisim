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
} from "../../apps/workbench/src/lib/connections.ts";

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
  if (body.error) throw new Error(body.error);
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
  await command({ op: "simulationStart", ...scope(local) });
  const nested = await command({
    op: "simulationView",
    id: local.id,
    revision: local.revision,
    path: [
      local.circuits[0].components.find((c: any) => c.name === "inverter").id,
    ],
  });
  assert.equal(nested.circuit, "inverter", JSON.stringify(nested));
  await command({ op: "simulationStop" });
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
  await command({ op: "simulationStart", ...scope(external) });
  await command({ op: "simulationStop" });
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
  const outputValue = (simulation: any) =>
    simulation.frame.children
      .find((node: any) => node.attributes?.id === directOutput.id)
      .children.find((node: any) => node.tag === "port").attributes.bits;
  const originalSimulation = await command({
    op: "simulationStart",
    ...scope(direct),
  });
  const settledOutput = async (simulation: any) => {
    await command({
      op: "simulationCommand",
      id: direct.id,
      revision: direct.revision,
      command: "input",
      attributes: {
        componentId: direct.circuits[0].components.find(
          (c: any) => c.attributes.label === "input",
        ).id,
        bits: "0",
      },
    });
    const captured = await command({
      op: "observationCapture",
      id: direct.id,
      revision: direct.revision,
      view_id: simulation.viewId,
      title: "Synthetic library check",
    });
    assert.equal(captured.viewId, simulation.viewId);
    return outputValue(await command({ op: "simulationStatus" }));
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
  const unchangedSimulation = await command({ op: "simulationStatus" });
  assert.equal(unchangedSimulation.viewId, originalSimulation.viewId);
  assert.equal(
    outputValue(unchangedSimulation),
    "1",
    "External checks reset the user's transient simulation",
  );
  const restartedSimulation = await command({
    op: "simulationStart",
    ...scope(direct),
  });
  assert.notEqual(restartedSimulation.viewId, originalSimulation.viewId);
  assert.equal(
    await settledOutput(restartedSimulation),
    "0",
    "Explicit simulation restart retained the old library",
  );
  await command({ op: "simulationStop" });
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
  const stoppedAndStarted = await command({
    op: "simulationStart",
    ...scope(direct),
  });
  assert.equal(
    await settledOutput(stoppedAndStarted),
    "1",
    "Stop/start retained the previous library",
  );
  await command({ op: "simulationStop" });
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
  const run = await measured("large_simulation_start", () =>
    command({ op: "simulationStart", ...scope(large) }),
  );
  const input = large.circuits[0].components.find(
    (c: any) => c.attributes.label === "in_0",
  );
  for (let i = 0; i < 5; i++)
    await measured("large_input_ack", () =>
      command({
        op: "simulationCommand",
        id: large.id,
        revision: large.revision,
        command: "input",
        attributes: { componentId: input.id, bits: String(i % 2) },
      }),
    );
  assert(run.frame);
  await command({ op: "simulationStop" });
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
