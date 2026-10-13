import assert from "node:assert/strict";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
type Command = (request: any) => Promise<any>;

// Independently constructed circuits. Expected behavior is checked through real native stimuli.
export async function verifyEditing(command: Command) {
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
    });
  const component = (doc: Document, label: string) =>
    doc.circuits[0].components.find((c) => c.attributes.label === label)!.id;
  const signal = async (
    doc: Document,
    input: string,
    bits: string,
    outputs: string[],
  ) => {
    await command({
      op: "simulationAction",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      command: "input",
      attributes: { componentId: component(doc, input), bits },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const sim = await command({ op: "simulationStatus" });
      const actual = outputs.map(
        (label) =>
          sim.frame.children
            .find(
              (n: any) =>
                n.tag === "component" &&
                n.attributes.id === component(doc, label),
            )
            ?.children.find((n: any) => n.tag === "port")?.attributes.bits,
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
  fanout = await move(fanout, [component(fanout, "input")], 0, 60);
  await signal(fanout, "input", "0101", ["out", "branch"]);
  fanout = await command({
    op: "undo",
    id: fanout.id,
    revision: fanout.revision,
  });
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
  await command({ op: "simulationStop" });
  console.log(
    "Verified native routing: multi-bit fanout and T junction; shared port; moving a wire; independent crossings; short rejection; one-step undo.",
  );
}
