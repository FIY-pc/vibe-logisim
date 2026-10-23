import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import { courseSizeProject } from "./fixtures/course-size.mts";
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
    (e: any) =>
      e.code === "CONNECTIONS_CHANGED" && /Pin “a”.*Pin “b”.*接到一起/.test(e.message),
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

/** Milliseconds per request of one repetition, by request. */
type Sample = Record<string, number>;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
};
/** `p50/p95` of each column, one row per operation. */
export function latencyTable(rows: [string, Sample[]][], columns: string[]) {
  const cell = (samples: Sample[], column: string) => {
    const values = samples.map((s) =>
      column === "total"
        ? Object.values(s).reduce((a, b) => a + b, 0)
        : column === "drawn"
          ? s.edit + s.render
          : s[column],
    );
    return values.some((v) => v === undefined || Number.isNaN(v))
      ? "-"
      : `${Math.round(percentile(values, 50))}/${Math.round(percentile(values, 95))}`;
  };
  const table = [
    ["operation", ...columns],
    ...rows.map(([name, samples]) => [
      name,
      ...columns.map((c) => cell(samples, c)),
    ]),
  ];
  const widths = table[0].map((_, i) =>
    Math.max(...table.map((row) => row[i].length)),
  );
  return table
    .map((row) => row.map((v, i) => v.padEnd(widths[i])).join("  "))
    .join("\n");
}

/**
 * Course-size editing latency, as the window sees it. Opens the synthetic
 * 1 MB project from a folder (so each edit also saves the file) and repeats
 * every edit the way the canvas issues it: the edit, then render and observe
 * of the new revision. Prints p50/p95 per request in milliseconds; `drawn` is
 * the edit plus the render, when the canvas shows the new picture.
 */
export async function measureEditing(command: Command, rounds = 5) {
  const folder = await mkdtemp(path.join(tmpdir(), "vibe-latency-"));
  const file = path.join(folder, "course-size.circ");
  await writeFile(file, courseSizeProject().xml);
  const timed = async (request: any) => {
    const start = performance.now();
    const result = await command(request);
    return [result, performance.now() - start] as const;
  };
  const circuit = "main";
  await command({ op: "folderOpen", path: folder });
  const [opened, open] = await timed({ op: "open", path: file });
  let doc: Document = opened;
  const scope = () => ({ id: doc.id, revision: doc.revision, circuit });
  const [first, firstObserve] = await timed({ op: "observe", ...scope() });
  const page = doc.circuits.find((c) => c.name === circuit)!;
  const bounds = first.focus.bounds;
  const free = { x: bounds.x + bounds.width + 100, y: bounds.y + 40 };
  const viewport = {
    x: bounds.x,
    y: bounds.y,
    width: 1400,
    height: 900,
    scale: 1,
  };
  const gates = page.components.filter((c) => c.name === "AND Gate");
  let moving = gates[0].location;
  const labelled = gates[1].location;
  const find = (at: { x: number; y: number }) =>
    doc.circuits
      .find((c) => c.name === circuit)!
      .components.find(
        (c) =>
          c.name === "AND Gate" &&
          c.location.x === at.x &&
          c.location.y === at.y,
      )!.id;
  /** Applies an edit, then renders and observes the new revision like the canvas. */
  const edit = async (change: any, sample: Sample) => {
    const [result, ms] = await timed({ op: "edit", ...scope(), edit: change });
    doc = documentOf(result);
    sample.edit = ms;
    sample.render = (await timed({ op: "render", ...scope(), ...viewport }))[1];
    sample.observe = (await timed({ op: "observe", ...scope() }))[1];
    return result;
  };
  const rows: Record<string, Sample[]> = {
    observe: [],
    move: [],
    wire: [],
    place: [],
    delete: [],
    attributes: [],
  };
  for (let round = 0; round < rounds; round++) {
    rows.observe.push({
      observe: (await timed({ op: "observe", ...scope() }))[1],
    });
    const delta = { x: round % 2 ? -10 : 10, y: 0 };
    const move: Sample = {};
    move.preview = (
      await timed({ op: "movePreview", ...scope(), ids: [find(moving)], delta })
    )[1];
    await edit({ kind: "move", ids: [find(moving)], delta }, move);
    moving = { x: moving.x + delta.x, y: moving.y + delta.y };
    rows.move.push(move);
    const y = free.y + 40 * round;
    const wire: Sample = {};
    await edit(
      {
        kind: "wire",
        points: [
          { x: free.x, y },
          { x: free.x + 40, y },
        ],
      },
      wire,
    );
    rows.wire.push(wire);
    const place: Sample = {};
    const placed = await edit(
      {
        kind: "place",
        name: "AND Gate",
        library: "1",
        location: { x: free.x + 200, y },
        attributes: {},
      },
      place,
    );
    rows.place.push(place);
    const remove: Sample = {};
    await edit({ kind: "delete", ids: placed.selection.components }, remove);
    rows.delete.push(remove);
    const attributes: Sample = {};
    await edit(
      {
        kind: "attributes",
        id: find(labelled),
        values: { label: `g${round}` },
      },
      attributes,
    );
    rows.attributes.push(attributes);
  }
  console.log(
    `Course-size editing: ${(await command({ op: "source", id: doc.id, revision: doc.revision })).xml.length} bytes, ` +
      `"${circuit}" ${page.components.length} components and ${page.wires.length} wires; ` +
      `open ${Math.round(open)} ms, first observe ${Math.round(firstObserve)} ms; ${rounds} rounds, ms p50/p95:`,
  );
  console.log(
    latencyTable(Object.entries(rows), [
      "preview",
      "edit",
      "render",
      "drawn",
      "observe",
      "total",
    ]),
  );
  return { rows, folder };
}
