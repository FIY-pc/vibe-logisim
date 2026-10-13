import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
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
  let simulation = await command({
    op: "simulationStart",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
  });
  const root = doc.circuits.find((c) => c.name === "main")!;
  const clock = root.components.find((c) => c.name === "Clock")!,
    input = root.components.find((c) => c.name === "Pin")!;
  const action = (op: string, attributes: Record<string, string> = {}) =>
    command({
      op: "simulationCommand",
      id: doc.id,
      revision: doc.revision,
      command: op,
      attributes,
    });
  await action("trace", { signals: `${clock.id}:0,${input.id}:0` });
  for (let n = 0; n < 8; n++) {
    await action("input", { componentId: input.id, bits: String(n % 2) });
    await action("tick");
  }
  const captured = await command({
    op: "observationCapture",
    id: doc.id,
    revision: doc.revision,
    view_id: simulation.viewId,
    title: "Clock and input",
  });
  let trace = captured.frame.children.find((n: any) => n.tag === "trace");
  const samples = trace.children.filter((n: any) => n.tag === "sample");
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
  assert.equal(samples.at(-1).attributes.tick, "8");
  assert(
    samples.some((n: any) => n.text.endsWith("|0")) &&
      samples.some((n: any) => n.text.endsWith("|1")),
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
  const afterCheck = await command({ op: "simulationStatus" });
  assert.equal(afterCheck.viewId, simulation.viewId);
  assert.equal(
    afterCheck.frame.attributes.ticks,
    "8",
    "Isolated trace advanced the user clock",
  );
  await action("configure", { frequency: "4096" });
  await action("play");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = await command({ op: "simulationStatus" });
    const window = current.frame.children.find((n: any) => n.tag === "trace");
    if (Number(window?.attributes.dropped) > 0) break;
    await sleep(50);
  }
  await action("pause");
  const bounded = await command({
    op: "observationCapture",
    id: doc.id,
    revision: doc.revision,
    view_id: simulation.viewId,
    title: "Bounded trace",
  });
  trace = bounded.frame.children.find((n: any) => n.tag === "trace");
  assert.equal(
    trace.children.filter((n: any) => n.tag === "sample").length,
    512,
  );
  assert(
    Number(trace.attributes.dropped) > 0,
    "Evicted steps must be visible, not silently treated as complete history",
  );
  await action("reset");
  const reset = await command({
    op: "observationCapture",
    id: doc.id,
    revision: doc.revision,
    view_id: simulation.viewId,
    title: "Reset",
  });
  const resetTrace = reset.frame.children.find((n: any) => n.tag === "trace");
  assert.notEqual(resetTrace.attributes.id, trace.attributes.id);
  assert.equal(
    resetTrace.children.filter((n: any) => n.tag === "sample").length,
    1,
  );
  const instances = root.components.filter((c) => c.name === "bank");
  const ram = doc.circuits.find((c) => c.name === "bank")!.components[0];
  const navigate = async (ids: string[]) =>
    (simulation = await command({
      op: "simulationView",
      id: doc.id,
      revision: doc.revision,
      path: ids,
    }));
  const memory = async () => {
    await action("memory", {
      viewId: simulation.viewId,
      componentId: ram.id,
      offset: "0",
      count: "16",
    });
    const record = await command({
      op: "observationCapture",
      id: doc.id,
      revision: doc.revision,
      view_id: simulation.viewId,
      title: "RAM view",
    });
    assert.equal(
      record.signals.length,
      0,
      "Moving into an instance must not reuse another view's watched IDs",
    );
    const current = await command({ op: "simulationStatus" });
    return current.frame.children.find((n: any) => n.tag === "memory");
  };
  await navigate([instances[1].id]);
  const second = await memory();
  const secondOriginal = second.children[0].attributes.value;
  await navigate([instances[0].id]);
  const first = await memory();
  const original = first.children[0].attributes.value;
  const changed = (Number(original) ^ 255).toString(16);
  await action("memory-write", {
    viewId: simulation.viewId,
    componentId: ram.id,
    offset: "0",
    count: "16",
    address: "0",
    expected: Number(original).toString(16),
    value: changed,
  });
  assert.equal(
    (await memory()).children[0].attributes.value,
    String(parseInt(changed, 16)),
  );
  await assert.rejects(
    () =>
      action("memory-write", {
        componentId: ram.id,
        offset: "0",
        count: "16",
        address: "0",
        expected: Number(original).toString(16),
        value: "1",
      }),
    /changed/,
  );
  const previousView = simulation.viewId;
  await navigate([instances[1].id]);
  assert.equal(
    (await memory()).children[0].attributes.value,
    secondOriginal,
    "RAM leaked across instances",
  );
  await assert.rejects(
    () =>
      action("memory-write", {
        viewId: previousView,
        componentId: ram.id,
        offset: "0",
        count: "16",
        address: "0",
        expected: secondOriginal,
        value: "1",
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
  await navigate([]);
  const rom = root.components.find((c) => c.name === "ROM")!;
  const page = (
    await command({
      op: "memory",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      component: rom.id,
      offset: 0,
      count: 16,
    })
  ).children.find((n: any) => n.tag === "memory");
  doc = await command({
    op: "memoryWrite",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: rom.id,
    address: 0,
    expected: Number(page.children[0].attributes.value).toString(16),
    value: "a5",
  });
  const edited = (
    await command({
      op: "memory",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      component: rom.id,
      offset: 0,
      count: 16,
    })
  ).children.find((n: any) => n.tag === "memory");
  assert.equal(edited.children[0].attributes.value, "165");
  assert(doc.dirty);
  assert.equal(
    await readFile(source, "utf8"),
    before,
    "ROM edit must remain a draft until Save",
  );
  await assert.rejects(
    () =>
      command({
        op: "observationCapture",
        id: doc.id,
        revision: doc.revision,
        view_id: simulation.viewId,
        title: "stale",
      }),
    /视图/,
  );
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  assert.equal(
    doc.revision,
    captured.revision,
    "ROM editing must undo in one step",
  );
  const records = await command({ op: "observations", id: doc.id });
  assert(
    records.some(
      (r: any) => r.id === captured.id && r.revision === captured.revision,
    ),
  );
  await command({ op: "simulationStop" });
  await command({
    op: "simulationAction",
    id: doc.id,
    revision: "stale-revision",
    circuit: "main",
    command: "button-release",
    attributes: { componentId: clock.id },
  });
  assert.equal(
    await command({ op: "simulationStatus" }),
    null,
    "A delayed release must never start a stopped circuit",
  );
  console.log(
    "Verified: settled-step traces independent of rendering, bounded retention, reset epochs, exact watches, RAM instance isolation and conflict guards, ROM draft/undo, immutable observations.",
  );
  return { documentId: doc.id, recordId: captured.id };
}
