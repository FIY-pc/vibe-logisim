/** Synthetic document history lifecycle against the native host; no model service. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simulationClient } from "./simulation-client.mts";
import { documentViews } from "./document-views.mts";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-history-"));
let child: ChildProcess | undefined,
  url = "",
  logs = "";
async function start() {
  url = "";
  logs = "";
  child = spawn(
    path.join(
      root,
      "target/debug/vibe-workbench-host" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      cwd: root,
      env: {
        ...process.env,
        VIBE_WORKBENCH_STATE: state,
        VIBE_WORKBENCH_PORT: "0",
        VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr!.on("data", (data) => {
    logs += data;
    url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || url;
  });
  for (let n = 0; n < 400 && !url; n++) {
    if (child.exitCode !== null) throw Error(logs);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert(url, logs);
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
    await once(kill, "exit");
  } else child.kill();
  await exited;
}
/** Edits, undo and redo answer with what they changed; scripts work with whole views. */
const documentOf = documentViews();
async function command(request: any) {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await response.json();
  if (data.error)
    throw Object.assign(new Error(data.error.message), data.error);
  return documentOf(data.result);
}
const source = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main"><comp name="child" loc="(300,100)"/><comp name="child" loc="(300,300)"/></circuit><circuit name="child"><comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="A"/><a name="width" val="4"/></comp><comp lib="1" name="NOT Gate" loc="(200,100)"><a name="width" val="4"/></comp><comp lib="0" name="Pin" loc="(280,100)"><a name="label" val="Y"/><a name="width" val="4"/><a name="output" val="true"/><a name="facing" val="west"/></comp><wire from="(100,100)" to="(170,100)"/><wire from="(200,100)" to="(280,100)"/></circuit></project>`;
try {
  await start();
  const file = path.join(state, "history.circ");
  await writeFile(file, source);
  let doc = await command({ op: "open", path: file });
  const initial = doc.revision;
  const binding = () => ({ id: doc.id, revision: doc.revision });
  const history = () => command({ op: "historyList", id: doc.id });
  let list = await history();
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].kind, "open");
  assert.equal(list.entries[0].baseline, true);
  assert.equal(list.entries[0].saved, true);
  const baseline = list.entries[0].id;
  const client = simulationClient(command);
  const live = await client.started(doc, "child");
  const xml = source
    .replace(/<comp lib="1" name="NOT Gate".*?<\/comp>/, " ")
    .replace(
      '<wire from="(100,100)" to="(170,100)"/><wire from="(200,100)" to="(280,100)"/>',
      '<wire from="(100,100)" to="(280,100)"/>',
    );
  const originalRun = await command({
    op: "simulate",
    ...binding(),
    circuit: "child",
    vectors: [{ inputs: { A: 3 }, expected: { Y: 12 } }],
  });
  assert.equal(originalRun.passed, 1);
  assert.equal((await command({ op: "read", id: doc.id })).revision, initial);
  assert.equal((await client.status()).state?.viewId, live.viewId);
  assert.equal(await readFile(file, "utf8"), source);
  doc = await command({
    op: "edit",
    ...binding(),
    circuit: "child",
    edit: { kind: "replace", xml },
  });
  const edited = doc.revision;
  assert.notEqual(edited, initial);
  list = await history();
  assert.equal(list.entries.length, 2);
  const change = list.entries[0];
  assert.equal(change.beforeRevision, initial);
  assert.equal(change.revision, edited);
  const review = await command({
    op: "historyReview",
    ...binding(),
    entry: change.id,
    mode: "change",
  });
  assert.equal(review.original, source);
  assert.equal(review.xml, xml);
  doc = await command({ op: "save", ...binding() });
  list = await history();
  assert.equal(list.entries[0].kind, "save");
  assert.equal(list.entries[0].baseline, true);
  assert.equal(list.entries[0].saved, true);
  const restoreRevision = doc.revision;
  doc = await command({ op: "historyRestore", ...binding(), entry: baseline });
  assert.equal(doc.revision, initial);
  list = await history();
  assert.equal(list.entries[0].kind, "restore");
  assert.equal(list.entries[0].restoredFrom, baseline);
  assert(list.entries.some((e: any) => e.id === change.id));
  await assert.rejects(
    () =>
      command({
        op: "historyRestore",
        id: doc.id,
        revision: restoreRevision,
        entry: change.id,
      }),
    /改变/,
  );
  doc = await command({ op: "undo", ...binding() });
  assert.equal(doc.revision, edited);
  assert.equal((await history()).entries[0].kind, "undo");
  const againstCurrent = await command({
    op: "historyReview",
    ...binding(),
    entry: baseline,
    mode: "current",
  });
  assert.equal(againstCurrent.original, source);
  assert.equal(againstCurrent.xml, xml);
  const count = (await history()).entries.length;
  await stop();
  await start();
  doc = await command({ op: "read", id: doc.id });
  assert.equal((await history()).entries.length, count);
  const restartReview = await command({
    op: "historyReview",
    ...binding(),
    entry: change.id,
    mode: "change",
  });
  assert.equal(restartReview.original, source);
  assert.equal(restartReview.xml, xml);
  await command({
    op: "historyPreview",
    ...binding(),
    entry: change.id,
    mode: "change",
    circuit: "child",
    candidate: false,
  });
  // A source conflict cannot silently restore over the externally changed file.
  await writeFile(file, xml.replace('val="A"', 'val="external"'));
  await assert.rejects(
    () => command({ op: "historyRestore", ...binding(), entry: baseline }),
    /磁盘|外部/,
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    doc.revision,
  );
  // Historical native views must reject changed external libraries, while
  // immutable source comparison survives.
  const library = path.join(state, "parts.circ");
  await writeFile(library, source);
  const withLibrary = (text: string) =>
    text.replace(
      '<main name="main"/>',
      '<lib desc="file#parts.circ" name="9"/><main name="main"/>',
    );
  const externalSource = withLibrary(source);
  const externalFile = path.join(state, "external.circ");
  await writeFile(externalFile, externalSource);
  const external = await command({ op: "open", path: externalFile });
  const externalBinding = { id: external.id, revision: external.revision };
  const externalEntry = (await command({ op: "historyList", id: external.id }))
    .entries[0].id;
  await command({
    op: "historyPreview",
    ...externalBinding,
    entry: externalEntry,
    mode: "current",
    circuit: "child",
    candidate: false,
  });
  await mkdir(path.join(state, "relocated"));
  const movedFile = path.join(state, "relocated", "external.circ");
  const savedAs = await command({
    op: "save",
    ...externalBinding,
    path: movedFile,
  });
  assert.notEqual(savedAs.revision, external.revision);
  assert.equal(await readFile(externalFile, "utf8"), externalSource);
  const restored = await command({
    op: "historyRestore",
    id: external.id,
    revision: savedAs.revision,
    entry: externalEntry,
  });
  assert.equal(restored.path, movedFile);
  const restoredRun = await command({
    op: "simulate",
    id: external.id,
    revision: restored.revision,
    circuit: "child",
    vectors: [{ inputs: { A: 2 }, expected: { Y: 13 } }],
  });
  assert.equal(restoredRun.passed, 1);
  const historicalBinding = { id: external.id, revision: restored.revision };
  await writeFile(library, source.replace('val="A"', 'val="changed"'));
  await assert.rejects(
    () =>
      command({
        op: "historyPreview",
        ...historicalBinding,
        entry: externalEntry,
        mode: "current",
        circuit: "child",
        candidate: false,
      }),
    /组件库已改变/,
  );
  assert.equal(
    (
      await command({
        op: "historyReview",
        ...historicalBinding,
        entry: externalEntry,
        mode: "current",
      })
    ).original,
    externalSource,
  );
  console.log(
    "Verified immutable history baselines, before/after and current comparison, readonly live simulation, restore+undo, stale/source guards, changed external libraries and restart recovery.",
  );
} finally {
  await stop();
  await rm(state, { recursive: true, force: true });
}
