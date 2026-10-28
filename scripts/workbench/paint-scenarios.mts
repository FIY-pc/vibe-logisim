import assert from "node:assert/strict";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import type { FrameEvent } from "../../apps/workbench/src/generated/FrameEvent.ts";
import type { RunInfo } from "../../apps/workbench/src/generated/RunInfo.ts";
import { eventStream } from "./event-stream.mts";
import { sameRun, simulationClient, type Stream } from "./simulation-client.mts";
type Command = (request: any) => Promise<any>;

/** The frames of `run` in a stream's events, from its `run` event on. */
function framesOf(events: any[], run: RunInfo): FrameEvent[] {
  const start = events.findLastIndex(
    (e) =>
      e.topic === "simulation" &&
      e.data.kind === "run" &&
      sameRun(e.data.run, run),
  );
  const frames: FrameEvent[] = [];
  for (const { topic, data } of events.slice(start + 1)) {
    if (topic !== "simulation") continue;
    if (data.kind !== "frame") break;
    frames.push(data);
  }
  return frames;
}
/** The picture as the window lays frames over each other: wire and junction
 * colors by geometry, component ops by id. */
function picture(frames: FrameEvent[]) {
  const wires = new Map<string, string>(),
    dots = new Map<string, string>(),
    components = new Map<string, unknown[]>();
  for (const { full, paint } of frames) {
    if (full) {
      wires.clear();
      dots.clear();
      components.clear();
    }
    for (const [color, xs] of Object.entries(paint.wires))
      for (let i = 0; i < xs.length; i += 4)
        wires.set(xs.slice(i, i + 4).join(), color);
    for (const [color, xs] of Object.entries(paint.dots))
      for (let i = 0; i < xs.length; i += 2)
        dots.set(xs.slice(i, i + 2).join(), color);
    for (const [id, list] of Object.entries(paint.components))
      components.set(
        id,
        paint.lists[list].map((n) => paint.ops[n]),
      );
  }
  return { wires, dots, components };
}

/** The run's picture as the window gets it: the first frame carries the
 * whole view, later ones only what changed, a new subscription starts with
 * the whole state again, and a circuit may lie anywhere. */
export async function verifySimulationPaint(
  command: Command,
  stream: Stream,
  url: string,
) {
  const client = simulationClient(command, stream);
  const pin = (x: number, y: number, output = false) =>
    `<comp lib="0" name="Pin" loc="(${x},${y})">${output ? '<a name="facing" val="west"/><a name="output" val="true"/>' : ""}</comp>`;
  const xml = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main"><wire from="(100,100)" to="(200,100)"/>${pin(100, 100)}${pin(200, 100, true)}</circuit><circuit name="empty"/><circuit name="far">${pin(120000, 90000)}</circuit><circuit name="outside">${pin(20000000, 20000000)}</circuit></project>`;
  const doc: Document = await command({
    op: "import",
    name: "paint.circ",
    xml,
  });
  const main = doc.circuits.find((c) => c.name === "main")!;
  const at = (x: number) => main.components.find((c) => c.location.x === x)!.id;
  const input = at(100),
    output = at(200);
  const wire = "100,100,200,100";

  const run = await client.start(doc, "main");
  const [first] = framesOf(stream.events, run);
  assert(first.full, "A run's first frame carries its picture");
  const before = picture([first]);
  assert(before.wires.get(wire), "The picture has the wire");
  assert(
    before.components.get(input)?.length &&
      before.components.get(output)?.length,
    "The picture has both pins",
  );
  const sequence = await client.send({
    kind: "input",
    componentId: input,
    bits: "1",
  });
  await client.settled(sequence);
  const frames = framesOf(stream.events, run);
  const next = frames.findIndex((f) => f.commandSequence >= sequence);
  assert(!frames[next].full, "Later frames carry what changed");
  const after = picture(frames.slice(0, next + 1));
  assert(
    after.wires.get(wire) && after.wires.get(wire) !== before.wires.get(wire),
    "The wire takes its new value's color",
  );
  assert.notDeepEqual(
    after.components.get(output),
    before.components.get(output),
    "The output pin shows its new value",
  );
  assert(
    Object.keys(frames[next].paint.components).every(
      (id) => id === input || id === output,
    ),
  );

  // A reloaded page subscribes again and gets the whole state: the picture
  // and values the first page laid over from deltas.
  const again = await eventStream(url);
  try {
    const replay = simulationClient(command, again);
    await replay.until(
      (m) => sameRun(m.run, run) && m.frame !== null,
      "the whole state on a new subscription",
    );
    const [head, whole] = again.events
      .filter((e) => e.topic === "simulation")
      .map((e) => e.data);
    assert(head.kind === "run" && sameRun(head.run, run));
    assert(
      whole.kind === "frame" && whole.full,
      "A new subscription starts with the whole state",
    );
    assert.equal(whole.commandSequence, client.mirror().frame?.commandSequence);
    assert.deepEqual(
      picture([whole]),
      picture(framesOf(stream.events, run)),
      "A new subscription's picture is the one laid over from deltas",
    );
    assert.deepEqual(replay.mirror().components, client.mirror().components);
  } finally {
    await again.close();
  }

  const empty = await client.start(doc, "empty");
  assert(!sameRun(empty, run), "Another circuit starts another run");
  const [blank] = framesOf(stream.events, empty);
  assert.equal(blank.circuit, "empty");
  assert(
    blank.full &&
      [blank.paint.wires, blank.paint.dots, blank.paint.components].every(
        (map) => !Object.keys(map).length,
      ),
    "An empty circuit paints nothing",
  );
  // A tick on a circuit with no clock still advances the run's clock and keeps
  // it live, as the released version did; it is not a failure.
  const ticked = await client.act({ kind: "tick" });
  assert.equal(ticked.frame?.clock.ticks, 1);
  assert(sameRun(ticked.run, empty));

  for (const circuit of ["far", "outside"]) {
    const started = await client.start(doc, circuit);
    const [far] = framesOf(stream.events, started);
    assert.equal(far.circuit, circuit);
    assert.equal(
      Object.keys(far.paint.components).length,
      1,
      "A circuit anywhere starts and paints",
    );
  }
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    doc.revision,
  );
  await command({
    op: "close",
    id: doc.id,
    revision: doc.revision,
    discard: true,
  });
  assert.equal(
    (await client.ended())?.reasonCode,
    "document-closed",
    "Closing the document ends its run",
  );
  console.log(
    "Verified run pictures: the whole view first, then what changed, the whole state again on a new subscription; empty and distant circuits start.",
  );
}
