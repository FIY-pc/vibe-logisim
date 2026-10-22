import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import { simulationClient } from "./simulation-client.mts";
type Command = (request: any) => Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function verifySimulation(command: Command, state: string) {
  const xml = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Memory" name="4"/><main name="main"/><options/><mappings/><toolbar/>
  <circuit name="main"><comp lib="0" name="Clock" loc="(100,100)"/><comp lib="0" name="Pin" loc="(100,200)"><a name="label" val="stimulus"/></comp><comp name="bank" loc="(300,100)"/><comp name="bank" loc="(500,100)"/><comp lib="4" name="ROM" loc="(300,300)"><a name="addrWidth" val="4"/><a name="dataWidth" val="8"/></comp></circuit>
  <circuit name="bank"><comp lib="4" name="RAM" loc="(100,100)"><a name="addrWidth" val="4"/><a name="dataWidth" val="8"/></comp></circuit></project>`;
  let doc: Document = await command({
    op: "import",
    name: "simulation.circ",
    xml,
  });
  const source = path.join(state, "simulation.circ");
  doc = await command({
    op: "save",
    id: doc.id,
    revision: doc.revision,
    path: source,
  });
  const before = await readFile(source, "utf8");
  const client = simulationClient(command);
  const run = await client.started(doc, "main");
  const root = doc.circuits.find((c) => c.name === "main")!;
  const clock = root.components.find((c) => c.name === "Clock")!,
    input = root.components.find((c) => c.name === "Pin")!;
  let current = run;
  let last: Awaited<ReturnType<typeof client.run>> | null = null;
  const send = async (request: Parameters<typeof client.run>[2]) =>
    (last = await client.run(doc, current, request));
  /** The frame the command settled in, with the waveform it left. */
  const settled = async (
    acknowledged: Awaited<ReturnType<typeof client.run>>,
    options: Parameters<typeof client.settled>[2] = {},
  ) => client.settled(current, acknowledged, { trace: true, ...options });
  /** Keeps the shown frame once it shows the last command, as a user would. */
  const capture = async (title: string) => {
    if (last) await settled(last);
    return client.keep(current, title);
  };
  const automatic = await capture("Named signals");
  assert.deepEqual(
    automatic.signals.map((signal) => signal.key),
    [`${input.id}:0`],
  );
  assert(automatic.frame.components.some((c) => c.id !== ""));
  assert.equal(
    automatic.trace?.signals.length || 0,
    0,
    "Capturing named signals must not change the live watch selection",
  );
  await send({
    kind: "trace",
    signals: [
      { componentId: clock.id, port: 0 },
      { componentId: input.id, port: 0 },
    ],
  });
  for (let n = 0; n < 8; n++) {
    await send({ kind: "input", componentId: input.id, bits: String(n % 2) });
    await send({ kind: "tick" });
  }
  const captured = await capture("Clock and input");
  const samples = captured.trace!.samples;
  assert.equal(
    samples.length,
    17,
    "Each command/tick must be captured even between image frames",
  );
  assert.equal(
    captured.signals.length,
    2,
    "Only explicitly watched ports are retained",
  );
  assert.equal(samples.at(-1)!.tick, 8);
  const pin = captured.trace!.signals.findIndex(
    (signal) => signal.componentId === input.id,
  );
  assert(
    samples.some((sample) => sample.values[pin] === "0") &&
      samples.some((sample) => sample.values[pin] === "1"),
  );
  const isolated = await command({
    op: "trace",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    ticks: 4,
    inputs: { stimulus: 0 },
    watches: [
      { component: clock.id, port: 0 },
      { component: input.id, port: 0 },
    ],
    events: [{ tick: 2, input: "stimulus", value: 1 }],
  });
  assert.equal(isolated.completed, true);
  assert.equal(isolated.samples.length, 5);
  assert.notEqual(
    isolated.samples[0].signals[`${clock.id}:0`].value,
    isolated.samples[1].signals[`${clock.id}:0`].value,
  );
  assert.equal(isolated.samples[0].signals[`${input.id}:0`].value, 0);
  assert.equal(isolated.samples[2].signals[`${input.id}:0`].value, 1);
  const afterCheck = await client.status();
  assert.equal(afterCheck.state?.viewId, current.viewId);
  assert.equal(
    afterCheck.state?.clock.ticks,
    8,
    "Isolated trace advanced the user clock",
  );
  await send({ kind: "configure", frequency: 4096 });
  await send({ kind: "play" });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const now = await client.status();
    if (now.state && now.state.clock.ticks > 512) break;
    await sleep(50);
  }
  await send({ kind: "pause" });
  const bounded = await capture("Bounded trace");
  assert.equal(
    bounded.trace!.samples.length,
    512,
    "The waveform keeps the bounded history",
  );
  assert(
    bounded.trace!.dropped > 0,
    "Evicted steps must be visible, not silently treated as complete history",
  );
  await send({ kind: "reset" });
  const reset = await capture("Reset");
  assert.notEqual(reset.trace!.id, bounded.trace!.id);
  assert.equal(reset.trace!.samples.length, 1);
  const instances = root.components.filter((c) => c.name === "bank");
  const ram = doc.circuits.find((c) => c.name === "bank")!.components[0];
  const navigate = async (ids: string[]) => {
    const view = await client.navigate(current, ids);
    return { sessionId: current.sessionId, viewId: view.viewId };
  };
  const memory = async () => {
    const opened = await client.run(doc, current, {
      kind: "memory",
      componentId: ram.id,
      offset: 0,
      count: 16,
    });
    const { frame } = await settled(opened, { memory: true });
    const record = await client.keep(current, "RAM view");
    assert.equal(
      record.signals.length,
      0,
      "Moving into an instance must not reuse another view's watched IDs",
    );
    return frame.memory!;
  };
  current = await navigate([instances[1].id]);
  const second = await memory();
  const secondOriginal = second.words[0];
  current = await navigate([instances[0].id]);
  const first = await memory();
  const original = first.words[0];
  const changed = original ^ 255;
  await client.run(doc, current, {
    kind: "memory-write",
    componentId: ram.id,
    offset: 0,
    count: 16,
    address: 0,
    expected: original,
    value: changed,
  });
  assert.equal((await memory()).words[0], changed);
  await assert.rejects(() =>
    client.run(doc, current, {
      kind: "memory-write",
      componentId: ram.id,
      offset: 0,
      count: 16,
      address: 0,
      expected: original,
      value: 1,
    }),
  );
  const previous = current;
  current = await navigate([instances[1].id]);
  assert.equal(
    (await memory()).words[0],
    secondOriginal,
    "RAM leaked across instances",
  );
  await assert.rejects(
    () =>
      client.run(doc, previous, {
        kind: "memory-write",
        componentId: ram.id,
        offset: 0,
        count: 16,
        address: 0,
        expected: secondOriginal,
        value: 1,
      }),
    /视图/,
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    doc.revision,
  );
  assert.equal(
    await readFile(source, "utf8"),
    before,
    "RAM/trace operations saved source",
  );
  current = await navigate([]);
  const rom = root.components.find((c) => c.name === "ROM")!;
  const page = await command({
    op: "memory",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: rom.id,
    offset: 0,
    count: 16,
  });
  doc = await command({
    op: "memoryWrite",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: rom.id,
    address: 0,
    expected: page.words[0].toString(16),
    value: "a5",
  });
  const edited = await command({
    op: "memory",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: rom.id,
    offset: 0,
    count: 16,
  });
  assert.equal(edited.words[0], 165);
  assert(doc.dirty);
  assert.equal(
    await readFile(source, "utf8"),
    before,
    "ROM edit must remain a draft until Save",
  );
  await assert.rejects(() =>
    command({
      op: "observationCapture",
      sessionId: current.sessionId,
      viewId: current.viewId,
      title: "stale",
    }),
  );
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  assert.equal(
    doc.revision,
    captured.revision,
    "ROM editing must undo in one step",
  );
  const records = await client.observations(doc);
  assert(
    records.some(
      (record) => record.id === captured.id && record.title === "Clock and input",
    ),
  );
  await client.stop(current);
  const late = await client.definition(doc, "main", {
    kind: "button",
    componentId: clock.id,
    value: "0",
  });
  assert.equal(
    late.started,
    false,
    "A delayed release must never start a stopped circuit",
  );
  assert.equal((await client.status()).session, null);
  console.log(
    "Verified: settled-step traces independent of rendering, bounded retention, reset epochs, exact watches, RAM instance isolation and conflict guards, ROM draft/undo, immutable observations.",
  );
  return { documentId: doc.id, recordId: captured.id };
}
