/** Synthetic version/proposal lifecycle against the native host; no paid model. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
async function command(request: any) {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await response.json();
  if (data.error)
    throw Object.assign(new Error(data.error.message), data.error);
  return data.result;
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
  const live = await command({
    op: "simulationStart",
    ...binding(),
    circuit: "child",
  });
  const layout = source.replace(
    /\((\d+),100\)/g,
    (_, x) => `(${Number(x) + 200},100)`,
  );
  const moved = await command({
    op: "proposalDetail",
    ...binding(),
    original: source,
    xml: layout,
    circuit: "child",
  });
  assert.equal(moved.connectivity.status, "unchanged", JSON.stringify(moved));
  assert.equal(moved.parents.after[0].count, 2);
  assert(
    moved.rows.some(
      (row: any) =>
        row.category === "layout" &&
        row.beforeObjects.length &&
        row.afterObjects.length,
    ),
  );
  const xml = source
    .replace(/<comp lib="1" name="NOT Gate".*?<\/comp>/, " ")
    .replace(
      '<wire from="(100,100)" to="(170,100)"/><wire from="(200,100)" to="(280,100)"/>',
      '<wire from="(100,100)" to="(280,100)"/>',
    );
  const details = await command({
    op: "proposalDetail",
    ...binding(),
    original: source,
    xml,
    circuit: "child",
  });
  assert.equal(details.connectivity.status, "changed", JSON.stringify(details));
  assert(details.connectivity.rows.length > 0);
  const proof = await command({
    op: "proposalVerify",
    ...binding(),
    original: source,
    xml,
    circuit: "child",
    verification: {
      kind: "vectors",
      vectors: [
        { inputs: { A: 3 }, expected: { Y: 3 } },
        { inputs: { A: 0 }, expected: { Y: 15 } },
      ],
    },
  });
  assert.equal(proof.result.passed, 1);
  assert.equal(proof.result.failed, 1);
  assert.notEqual(proof.revision, initial);
  assert.equal(proof.baseRevision, initial);
  const originalRun = await command({
    op: "simulate",
    ...binding(),
    circuit: "child",
    vectors: [{ inputs: { A: 3 }, expected: { Y: 12 } }],
  });
  assert.equal(originalRun.passed, 1);
  assert.equal((await command({ op: "read", id: doc.id })).revision, initial);
  assert.equal((await command({ op: "simulationStatus" })).viewId, live.viewId);
  assert.equal(await readFile(file, "utf8"), source);
  const preview = await command({
    op: "proposalPreview",
    ...binding(),
    original: source,
    xml,
    circuit: "child",
    candidate: true,
  });
  assert(preview.image.startsWith("data:image/png"));
  assert(preview.bounds.width > 0);
  const reviewed = await command({
    op: "proposalReview",
    ...binding(),
    original: source,
    xml,
  });
  const output = reviewed.after.circuits
    .find((c: any) => c.name === "child")
    .components.find((c: any) => c.attributes.label === "Y");
  const trace = await command({
    op: "proposalVerify",
    ...binding(),
    original: source,
    xml,
    circuit: "child",
    verification: {
      kind: "trace",
      ticks: 3,
      inputs: { A: 3 },
      watches: [{ component: output.id, port: 0 }],
      events: [{ tick: 2, input: "A", value: 7 }],
    },
  });
  assert.equal(trace.result.completed, true);
  assert.equal(trace.result.samples.length, 4);
  doc = await command({
    op: "edit",
    ...binding(),
    circuit: "child",
    edit: { kind: "replace", xml },
  });
  list = await history();
  assert.equal(list.entries.length, 2);
  const change = list.entries[0];
  assert.equal(change.beforeRevision, initial);
  assert.equal(change.revision, proof.revision);
  const review = await command({
    op: "historyReview",
    ...binding(),
    entry: change.id,
    mode: "change",
  });
  assert.equal(review.original, source);
  assert.equal(review.xml, xml);
  assert.equal(review.evidence.length, 2);
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
  assert.equal(doc.revision, proof.revision);
  assert.equal((await history()).entries[0].kind, "undo");
  const againstCurrent = await command({
    op: "historyReview",
    ...binding(),
    entry: baseline,
    mode: "current",
  });
  assert.equal(againstCurrent.original, source);
  assert.equal(againstCurrent.xml, xml);
  assert.equal(againstCurrent.evidence.length, 2);
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
  assert.equal(restartReview.evidence.length, 2);
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
  // immutable source comparison and the original verification record survive.
  const library = path.join(state, "parts.circ");
  await writeFile(library, source);
  const withLibrary = (text: string) =>
    text.replace(
      '<main name="main"/>',
      '<lib desc="file#parts.circ" name="9"/><main name="main"/>',
    );
  const externalSource = withLibrary(source),
    externalCandidate = withLibrary(xml);
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
  const externalProof = await command({
    op: "proposalVerify",
    ...externalBinding,
    original: externalSource,
    xml: externalCandidate,
    circuit: "child",
    verification: {
      kind: "vectors",
      vectors: [{ inputs: { A: 2 }, expected: { Y: 2 } }],
    },
  });
  assert.equal(externalProof.result.passed, 1);
  await mkdir(path.join(state, "relocated"));
  const movedFile = path.join(state, "relocated", "external.circ");
  const savedAs = await command({
    op: "save",
    ...externalBinding,
    path: movedFile,
  });
  assert.notEqual(savedAs.revision, external.revision);
  assert.equal(await readFile(externalFile, "utf8"), externalSource);
  // Old candidate previews retain the original source-directory basis.
  const oldProposalImage = await command({
    op: "proposalPreview",
    ...externalBinding,
    original: externalSource,
    xml: externalCandidate,
    circuit: "child",
    candidate: true,
  });
  assert(oldProposalImage.image.startsWith("data:image/png"));
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
  const unavailable = await command({
    op: "historyDetail",
    ...historicalBinding,
    entry: externalEntry,
    mode: "current",
    circuit: "child",
  });
  assert.equal(unavailable.connectivity.status, "unavailable");
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
  const staleEvidence = (
    await command({
      op: "proposalReview",
      ...externalBinding,
      original: externalSource,
      xml: externalCandidate,
    })
  ).evidence;
  assert.equal(staleEvidence[0].dependenciesVerified, false);
  const evidenceFile = path.join(
    state,
    "verification-records",
    external.id,
    externalProof.id + ".json",
  );
  const damaged = JSON.parse(await readFile(evidenceFile, "utf8"));
  damaged.record.result.passed = 99;
  await writeFile(evidenceFile, JSON.stringify(damaged));
  const corruptReview = await command({
    op: "proposalReview",
    ...externalBinding,
    original: externalSource,
    xml: externalCandidate,
  });
  assert.match(corruptReview.evidenceWarning, /记录内容已改变/);
  assert.equal(corruptReview.evidence.length, 0);
  assert(corruptReview.rows.length > 0);
  console.log(
    "Verified immutable history baselines, before/after and current comparison, native connectivity and parent impact, candidate-bound vector/trace evidence, readonly live simulation, restore+undo, stale/source guards and restart recovery.",
  );
} finally {
  await stop();
  await rm(state, { recursive: true, force: true });
}
