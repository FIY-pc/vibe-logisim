/** Real Rust -> Java document, simulation and folder paths against the native host; no model service. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { eventStream } from "./event-stream.mts";
import { verifySimulation } from "./simulation-scenarios.mts";
import { verifyEditing } from "./editing-scenarios.mts";
import { verifySimulationViewport } from "./viewport-scenarios.mts";
import { placeOneGate, verifyAgentTurn } from "./agent-scenarios.mts";
import { scriptedProfile, startScriptedModel } from "./scripted-model.mts";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-native-check-"));
// The sidecar reads its model services at start: point them at a scripted model.
const model = await startScriptedModel(placeOneGate);
await mkdir(path.join(state, "profile"), { recursive: true });
await writeFile(
  path.join(state, "profile", "builtin-provider.json"),
  JSON.stringify(scriptedProfile(model.url)),
);
let child: ChildProcess | undefined,
  url = "",
  logs = "";
let stream: Awaited<ReturnType<typeof eventStream>> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function start() {
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
  url = "";
  logs = "";
  child.stderr!.on("data", (b) => {
    logs += b;
    const match = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) url = match[1];
  });
  for (let n = 0; n < 200 && !url; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    await sleep(25);
  }
  assert(url, logs || "Host did not start");
  stream = await eventStream(url);
  await stream.wait((e) => e.topic === "resync");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
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
        () => reject(new Error("Host did not close live event streams")),
        10000,
      );
      timer.unref();
    }),
  ]);
  await stream?.close();
  child = undefined;
}
/** Edits, undo and redo answer with an edit result; scripts work with the view. */
const documentOf = (result: any) =>
  result && result.view ? result.view : result;
async function command(request: any) {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (body.error)
    throw Object.assign(new Error(body.error.message), body.error);
  return documentOf(body.result);
}
try {
  await start();
  let doc = await command({ op: "new", name: "example.circ" });
  const edit = async (value: any) =>
    (doc = await command({
      op: "edit",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      edit: value,
    }));
  await edit({
    kind: "place",
    name: "Pin",
    library: "0",
    location: { x: 100, y: 100 },
    attributes: { label: "input" },
  });
  await edit({
    kind: "place",
    name: "NOT Gate",
    library: "1",
    location: { x: 200, y: 100 },
    attributes: {},
  });
  await edit({
    kind: "place",
    name: "Pin",
    library: "0",
    location: { x: 280, y: 100 },
    attributes: { label: "output", output: "true", facing: "west" },
  });
  await assert.rejects(
    () => command({ op: "source", id: doc.id, revision: "obsolete" }),
    /版本|revision|改变/,
  );
  const matchingSource = await command({
    op: "source",
    id: doc.id,
    revision: doc.revision,
  });
  assert.equal(matchingSource.revision, doc.revision);
  const observed = await command({
    op: "observe",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
  });
  const gateInput = observed.focus.components
    .find((c: any) => c.factoryName === "NOT Gate")
    .ends.find((p: any) => p.direction === "input").location;
  await edit({ kind: "wire", points: [{ x: 100, y: 100 }, gateInput] });
  await edit({
    kind: "wire",
    points: [
      { x: 200, y: 100 },
      { x: 280, y: 100 },
    ],
  });
  const project = path.join(state, "project");
  await mkdir(project);
  await command({ op: "folderOpen", path: project });
  const source = path.join(project, "example.circ");
  doc = await command({
    op: "save",
    id: doc.id,
    revision: doc.revision,
    path: source,
  });
  const saved = await readFile(source, "utf8");
  const input = doc.circuits[0].components.find(
    (c: any) => c.attributes.label === "input",
  );
  const output = doc.circuits[0].components.find(
    (c: any) => c.attributes.label === "output",
  );
  const props = await command({
    op: "properties",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: input.id,
  });
  assert(
    props.children.some(
      (n: any) => n.tag === "attribute" && n.attributes.name === "width",
    ),
  );
  const beforeInvalid = doc.revision;
  await assert.rejects(() =>
    edit({ kind: "attributes", id: input.id, values: { width: "0" } }),
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    beforeInvalid,
  );
  const started = await command({
    op: "simulationAct",
    documentId: doc.id,
    revision: doc.revision,
    target: { kind: "definition", circuit: "main" },
    command: { kind: "start" },
  });
  const live = { sessionId: started.sessionId, viewId: started.viewId };
  await command({
    op: "simulationAct",
    documentId: doc.id,
    revision: doc.revision,
    target: { kind: "run", ...live },
    command: { kind: "input", componentId: input.id, bits: "1" },
  });
  const frame = (
    await stream!.wait(
      (e) =>
        e.topic === "simulation" &&
        e.data?.kind === "state" &&
        e.data.sessionId === started.sessionId &&
        e.data.components?.items?.some(
          (item: any) =>
            item.id === output.id &&
            item.ports.some((port: any) => port.bits === "0"),
        ),
    )
  ).data;
  const verify = (vectors: any[]) =>
    command({
      op: "simulate",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      vectors,
    });
  const check = await verify([
    { inputs: { input: 0 }, expected: { output: 1 } },
    { inputs: { input: 1 }, expected: { output: 0 } },
    { inputs: { input: 0 }, expected: { output: 0 } },
    { inputs: { input: 1 } },
  ]);
  assert.deepEqual([check.passed, check.failed, check.unchecked], [2, 1, 1]);
  await assert.rejects(() => verify([{ inputs: { input: 2 } }]), /range/);
  await assert.rejects(
    () => verify([{ inputs: { input: 0 }, expected: { typo: 1 } }]),
    /输出引脚/,
  );
  assert.equal(
    (await verify([{ inputs: { input: 1 }, expected: { output: 0 } }])).passed,
    1,
    "Native rejection must not poison the next verification",
  );
  const stillLive = await command({ op: "simulationStatus" });
  assert.equal(
    stillLive.state.viewId,
    started.viewId,
    "Verification replaced the user live session",
  );
  const kept = await command({
    op: "simulationSnapshot",
    sessionId: started.sessionId,
    componentIds: [output.id],
    trace: false,
    memory: false,
  });
  const outputState = kept.frame.components.find(
    (item: any) => item.id === output.id,
  );
  assert(
    outputState?.ports.some((port: any) => port.bits === "0"),
    "Verification modified the user input state",
  );
  assert.equal(await readFile(source, "utf8"), saved);
  assert(
    frame.components.items
      .find((item: any) => item.id === output.id)
      .ports.some((port: any) => port.bits === "0"),
    JSON.stringify(frame.components),
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    doc.revision,
    "Stimulus changed document",
  );
  await edit({
    kind: "wire",
    points: [
      { x: 30, y: 200 },
      { x: 80, y: 200 },
    ],
  });
  const automaticallySaved = await readFile(source, "utf8");
  assert.notEqual(
    automaticallySaved,
    saved,
    "Folder edits must reach the source",
  );
  const restoredRevision = doc.revision,
    id = doc.id;
  await stop();
  await start();
  doc = await command({ op: "read", id });
  assert.equal(doc.revision, restoredRevision);
  assert.equal(doc.dirty, false);
  assert.equal(doc.canUndo, true);
  assert.equal(
    await readFile(source, "utf8"),
    automaticallySaved,
    "Recovery changed the source",
  );
  // Save As must not alias the old path to the open copy, including after restart.
  const copyPath = path.join(state, "copy.circ");
  const copied = await command({
    op: "save",
    id,
    revision: doc.revision,
    path: copyPath,
  });
  const reopened = await command({ op: "open", path: source });
  assert.notEqual(reopened.id, id);
  // Rust returns a canonical, namespaced Windows path while TEMP may use an
  // 8.3 alias. Resolve both existing files before comparing their identity.
  assert.equal(
    path.toNamespacedPath(
      realpathSync.native((await command({ op: "read", id })).path),
    ),
    path.toNamespacedPath(realpathSync.native(copyPath)),
  );
  await writeFile(copyPath, saved);
  const changed = await command({ op: "sourceStatus", id });
  assert.equal(changed.state, "modified");
  const reloaded = await command({
    op: "reload",
    id,
    revision: copied.revision,
    source_revision: changed.revision,
  });
  assert.equal(reloaded.dirty, false);
  assert.equal(reloaded.id, id);
  const undoReload = await command({
    op: "undo",
    id,
    revision: reloaded.revision,
  });
  assert.equal(undoReload.revision, copied.revision);
  assert.equal(undoReload.dirty, true);
  await assert.rejects(() =>
    command({ op: "close", id, revision: reloaded.revision, discard: true }),
  );
  await command({
    op: "simulationAct",
    documentId: id,
    revision: undoReload.revision,
    target: { kind: "definition", circuit: "main" },
    command: { kind: "start" },
  });
  await command({
    op: "close",
    id,
    revision: undoReload.revision,
    discard: true,
  });
  assert.equal((await command({ op: "simulationStatus" })).session, null);
  await stream!.wait(
    (e) => e.topic === "simulation" && e.data?.kind === "ended",
  );
  assert.equal(
    (await command({ op: "read", id: reopened.id })).revision,
    reopened.revision,
  );
  await stop();
  await start();
  assert.equal((await command({ op: "open", path: copyPath })).id, id);
  await verifySimulationViewport(command);
  await verifyEditing(command);
  // Files saved by 2.15 builds load on the bundled 2.15 runtime. A relocated
  // product must serve both runtimes from its precompiled bridge classes.
  const legacyPath = path.join(state, "legacy-2.15.circ");
  await writeFile(
    legacyPath,
    '<project source="2.15.0.2.exe" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Memory" name="1"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main"><comp lib="1" name="D Flip-Flop" loc="(300,100)"><a name="trigger" val="high"/></comp></circuit></project>',
  );
  const legacy = await command({ op: "open", path: legacyPath });
  assert(
    (
      await command({
        op: "observe",
        id: legacy.id,
        revision: legacy.revision,
        circuit: "main",
      })
    ).focus.components.some(
      (c: any) => c.factoryName === "D Flip-Flop" && c.storage === "delay",
    ),
    "2.15 flip-flop missing or not read as storage",
  );
  if (process.env.VIBE_WORKBENCH_RESOURCES)
    assert(
      ![state, path.join(state, "verification")].some((dir) =>
        existsSync(path.join(dir, "java")),
      ),
      "The product compiled the bridge instead of using its precompiled classes",
    );
  const retained = await verifySimulation(command, state);
  await stop();
  await start();
  assert(
    (await command({ op: "observationList", id: retained.documentId })).some(
      (r: any) => r.id === retained.recordId,
    ),
    "Observation did not survive restart",
  );
  await verifyAgentTurn(command, stream!, state);
  console.log(
    "Verified: native placement and property rejection; NOT simulation; isolated vector comparisons and tick traces; transient stimuli; recovery and undo; folder auto-save and external explicit save; Save As identity; external reload and undo; guarded close and simulation cleanup; a scripted AI turn's edit, folder checkpoint and undo.",
  );
} finally {
  await stop();
  await model.close();
  await rm(state, { recursive: true, force: true });
}
