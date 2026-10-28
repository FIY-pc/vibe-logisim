import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import { sameRun, simulationClient, type Stream } from "./simulation-client.mts";
type Command = (request: any) => Promise<any>;
export async function verifySimulation(
  command: Command,
  stream: Stream,
  state: string,
) {
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
  const client = simulationClient(command, stream);
  const run = await client.start(doc, "main");
  const root = doc.circuits.find((c) => c.name === "main")!;
  const clock = root.components.find((c) => c.name === "Clock")!,
    input = root.components.find((c) => c.name === "Pin")!;
  // Capture keeps what the run already delivered: wait for the last
  // command's frame, as the user would see it before keeping it.
  let last = 0;
  const send = async (change: Parameters<typeof client.send>[0]) =>
    (last = await client.send(change));
  const capture = async (title: string) => {
    await client.settled(last);
    return client.keep(title);
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
  assert.deepEqual(
    client.mirror().trace?.samples,
    samples,
    "The window's waveform, laid over from new samples, matches the run's",
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
  const afterCheck = await client.act({ kind: "pause" });
  assert(sameRun(afterCheck.run, run), "The isolated trace replaced the run");
  assert.equal(
    afterCheck.frame?.clock.ticks,
    8,
    "Isolated trace advanced the user clock",
  );
  await send({ kind: "configure", frequency: 4096 });
  await send({ kind: "play" });
  await client.until(
    (m) => (m.frame?.clock.ticks ?? 0) > 512,
    "512 ticks at 4096 Hz",
  );
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
  assert.deepEqual(client.mirror().trace?.samples, bounded.trace!.samples);
  await send({ kind: "reset" });
  const reset = await capture("Reset");
  assert.notEqual(reset.trace!.id, bounded.trace!.id);
  assert.equal(reset.trace!.samples.length, 1);
  const instances = root.components.filter((c) => c.name === "bank");
  const ram = doc.circuits.find((c) => c.name === "bank")!.components[0];
  const page = { componentId: ram.id, offset: 0, count: 16 };
  const memory = async () => {
    const { memory } = await client.act({ kind: "memory", ...page });
    const record = await client.keep("RAM view");
    assert.equal(
      record.signals.length,
      0,
      "Moving into an instance must not reuse another view's watched IDs",
    );
    return memory!;
  };
  await client.navigate([instances[1].id]);
  const secondOriginal = (await memory()).words[0];
  await client.navigate([instances[0].id]);
  const original = (await memory()).words[0];
  const changed = original ^ 255;
  await client.act({
    kind: "memory-write",
    ...page,
    address: 0,
    expected: original,
    value: changed,
  });
  assert.equal((await memory()).words[0], changed);
  await assert.rejects(() =>
    client.send({
      kind: "memory-write",
      ...page,
      address: 0,
      expected: original,
      value: 1,
    }),
  );
  await client.navigate([instances[1].id]);
  assert.equal(
    (await memory()).words[0],
    secondOriginal,
    "RAM leaked across instances",
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
  await client.navigate([]);
  const rom = root.components.find((c) => c.name === "ROM")!;
  const romPage = {
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: rom.id,
    offset: 0,
    count: 16,
  };
  const stored = await command({ op: "memory", ...romPage });
  doc = await command({
    op: "memoryWrite",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: rom.id,
    address: 0,
    expected: stored.words[0].toString(16),
    value: "a5",
  });
  const edited = await command({
    op: "memory",
    ...romPage,
    revision: doc.revision,
  });
  assert.equal(edited.words[0], 165);
  assert(doc.dirty);
  assert.equal(
    await readFile(source, "utf8"),
    before,
    "ROM edit must remain a draft until Save",
  );
  assert.equal(
    (await client.ended())?.reasonCode,
    "revision-changed",
    "An edit ends the run of the old revision",
  );
  await assert.rejects(() => client.keep("after the run"));
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  assert.equal(
    doc.revision,
    captured.revision,
    "ROM editing must undo in one step",
  );
  const records = await client.observations(doc);
  assert(
    records.some(
      (record) =>
        record.id === captured.id && record.title === "Clock and input",
    ),
  );
  console.log(
    "Verified: settled-step traces independent of rendering, bounded retention, reset epochs, exact watches, RAM instance isolation and conflict guards, ROM draft/undo ending the run, immutable observations.",
  );
  return { documentId: doc.id, recordId: captured.id };
}
