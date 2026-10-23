import assert from "node:assert/strict";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import { simulationClient } from "./simulation-client.mts";
type Command = (request: any) => Promise<any>;
/** Edits, undo and redo answer with an edit result; scripts work with the view. */
const documentOf = (result: any) =>
  result && result.view ? result.view : result;

// Independently constructed circuits. Expected behavior is checked through real native stimuli.
export async function verifyEditing(command: Command) {
  const client = simulationClient(command);
  const project = (body: string) =>
    `<?xml version="1.0"?><project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main">${body}</circuit></project>`;
  const pin = (
    label: string,
    x: number,
    y: number,
    output = false,
    width = 1,
  ) =>
    `<comp lib="0" name="Pin" loc="(${x},${y})"><a name="label" val="${label}"/><a name="output" val="${output}"/><a name="width" val="${width}"/></comp>`;
  const wire = (x1: number, y1: number, x2: number, y2: number) =>
    `<wire from="(${x1},${y1})" to="(${x2},${y2})"/>`;
  const open = (body: string): Promise<Document> =>
    command({ op: "import", name: "routing.circ", xml: project(body) });
  const move = (
    doc: Document,
    ids: string[],
    x: number,
    y: number,
  ): Promise<Document> =>
    command({
      op: "edit",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      edit: { kind: "move", ids, delta: { x, y } },
    }).then(documentOf);
  const component = (doc: Document, label: string) =>
    doc.circuits[0].components.find((c) => c.attributes.label === label)!.id;
  const signal = async (
    doc: Document,
    input: string,
    bits: string,
    outputs: string[],
  ) => {
    const ids = outputs.map((label) => component(doc, label));
    const acknowledged = await client.definition(doc, "main", {
      kind: "input",
      componentId: component(doc, input),
      bits,
    });
    assert(acknowledged.sessionId && acknowledged.viewId);
    const run = {
      sessionId: acknowledged.sessionId,
      viewId: acknowledged.viewId,
    };
    // Frames arrive as the runtime settles, after the acknowledgement.
    for (let attempt = 0; ; attempt++) {
      const { frame } = await client.settled(run, acknowledged, {
        componentIds: ids,
      });
      const actual = outputs.map(
        (label) =>
          frame.components
            .find((c) => c.id === component(doc, label))
            ?.ports.find((port) => port.index === 0)?.bits,
      );
      if (actual.every((b) => b === bits)) return;
      if (attempt === 99)
        assert.deepEqual(
          actual,
          outputs.map(() => bits),
          "Moving changed the circuit behavior",
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let fanout = await open(
    pin("input", 100, 100, false, 4) +
      pin("out", 300, 100, true, 4) +
      pin("branch", 200, 200, true, 4) +
      wire(100, 100, 300, 100) +
      wire(200, 100, 200, 200),
  );
  await signal(fanout, "input", "1010", ["out", "branch"]);
  const original = fanout.revision;
  const simulationBeforePreview = (await client.status()).state?.viewId;
  const preview = await command({
    op: "movePreview",
    id: fanout.id,
    revision: fanout.revision,
    circuit: "main",
    ids: [component(fanout, "input")],
    delta: { x: 0, y: 60 },
  });
  assert.deepEqual(
    await command({ op: "read", id: fanout.id }),
    fanout,
    "Dragging a preview must preserve document revision, source and undo",
  );
  assert.equal(
    (await client.status()).state?.viewId,
    simulationBeforePreview,
    "Movement previews must not replace the live simulation",
  );
  const beforeWires = fanout.circuits[0].wires;
  const segment = ({ from, to }: { from: any; to: any }) =>
    `${from.x},${from.y}:${to.x},${to.y}`;
  fanout = await move(fanout, [component(fanout, "input")], 0, 60);
  const expected = new Set(
    beforeWires
      .filter((w) => !preview.removedWires.includes(w.id))
      .map(segment),
  );
  for (const added of preview.addedWires) expected.add(segment(added));
  assert.deepEqual(
    new Set(fanout.circuits[0].wires.map(segment)),
    expected,
    "Preview and committed movement must use the same routing plan",
  );
  await assert.rejects(
    command({
      op: "movePreview",
      id: fanout.id,
      revision: original,
      circuit: "main",
      ids: [component(fanout, "input")],
      delta: { x: 0, y: 60 },
    }),
  );
  await signal(fanout, "input", "0101", ["out", "branch"]);
  fanout = documentOf(
    await command({
      op: "undo",
      id: fanout.id,
      revision: fanout.revision,
    }),
  );
  assert.equal(fanout.revision, original, "Move must be one undo step");
  fanout = await move(fanout, [component(fanout, "branch")], 60, 0);
  await signal(fanout, "input", "1100", ["out", "branch"]);

  let shared = await open(
    pin("input", 100, 100) +
      `<comp lib="0" name="Probe" loc="(100,100)"><a name="label" val="shared"/></comp>` +
      pin("out", 300, 100, true) +
      wire(100, 100, 300, 100),
  );
  shared = await move(shared, [component(shared, "input")], 0, 60);
  await signal(shared, "input", "1", ["shared", "out"]);

  let floating = await open(
    '<comp lib="0" name="Probe" loc="(100,100)"><a name="label" val="floating"/></comp>',
  );
  floating = await move(floating, [component(floating, "floating")], 50, 40);
  assert.deepEqual(floating.circuits[0].components[0].location, {
    x: 150,
    y: 140,
  });

  let wireOnly = await open(
    pin("input", 100, 100) +
      pin("out", 300, 100, true) +
      wire(100, 100, 300, 100),
  );
  wireOnly = await move(wireOnly, [wireOnly.circuits[0].wires[0].id], 0, 80);
  await signal(wireOnly, "input", "1", ["out"]);

  const short = await open(
    pin("a", 100, 100) +
      pin("outA", 200, 100, true) +
      pin("b", 100, 140) +
      pin("outB", 200, 140, true) +
      wire(100, 100, 200, 100) +
      wire(100, 140, 200, 140),
  );
  await assert.rejects(
    () => move(short, [component(short, "outA")], -50, 40),
    /改变端口连接/,
  );
  const unchanged = await command({ op: "read", id: short.id });
  assert.equal(unchanged.revision, short.revision);
  assert.equal(unchanged.canUndo, false, "Rejected move entered history");

  let crossing = await open(
    pin("a", 100, 100) +
      pin("outA", 300, 100, true) +
      pin("b", 200, 50) +
      pin("outB", 200, 150, true) +
      wire(100, 100, 300, 100) +
      wire(200, 50, 200, 150),
  );
  crossing = await move(
    crossing,
    [...crossing.circuits[0].components, ...crossing.circuits[0].wires].map(
      (c) => c.id,
    ),
    40,
    30,
  );
  await signal(crossing, "a", "1", ["outA"]);
  await signal(crossing, "b", "0", ["outB"]);
  await signal(crossing, "a", "1", ["outA"]);
  await client.stop((await client.status()).session!.sessionId);
  console.log(
    "Verified native routing: multi-bit fanout and T junction; shared port; moving a wire; independent crossings; short rejection; one-step undo.",
  );
}
