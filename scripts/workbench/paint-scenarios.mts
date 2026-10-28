import assert from "node:assert/strict";
import type { DocumentView as Document } from "../../apps/workbench/src/generated/DocumentView.ts";
import type { StateEvent } from "../../apps/workbench/src/generated/StateEvent.ts";
import { simulationClient } from "./simulation-client.mts";
type Command = (request: any) => Promise<any>;
interface Stream {
  events: any[];
  wait(predicate: (event: any) => boolean, from?: number): Promise<any>;
}

/** The run's picture as the window gets it: a run's first state event
 * carries the whole view, later ones only what changed, and a circuit may
 * lie anywhere. */
export async function verifySimulationPaint(command: Command, stream: Stream) {
  const client = simulationClient(command);
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
  /** The first state event of a run from event `from` on that `holds`. */
  const state = (
    sessionId: string,
    from: number,
    holds: (event: StateEvent) => boolean = () => true,
  ): Promise<StateEvent> =>
    stream
      .wait(
        (e) =>
          e.topic === "simulation" &&
          e.data?.kind === "state" &&
          e.data.sessionId === sessionId &&
          holds(e.data),
        from,
      )
      .then((e) => e.data);
  /** The run's picture as the window lays its state events over each other,
   * up to `last`: wire colors by geometry, component ops by id. */
  const picture = (last: StateEvent) => {
    const wires = new Map<string, string>();
    const components = new Map<string, unknown[]>();
    let ops: unknown[] = [];
    let lists: unknown[][] = [];
    for (const { topic, data } of stream.events) {
      if (topic !== "simulation" || data?.kind !== "state") continue;
      if (data.sessionId !== last.sessionId) continue;
      const paint: StateEvent["paint"] = data.paint;
      if (paint.full) {
        wires.clear();
        components.clear();
        ops = [];
        lists = [];
      }
      for (const [color, xs] of Object.entries(paint.wires))
        for (let i = 0; i < xs.length; i += 4)
          wires.set(xs.slice(i, i + 4).join(), color);
      ops.push(...paint.ops);
      for (const list of paint.lists) lists.push(list.map((n) => ops[n]));
      for (const [id, list] of Object.entries(paint.components))
        components.set(id, lists[list]);
      if (data === last) break;
    }
    return { wire: wires.get("100,100,200,100"), components };
  };

  let from = stream.events.length;
  let run = await client.started(doc, "main");
  const first = await state(run.sessionId, from);
  assert(first.paint.full, "A run's first state event carries its picture");
  const before = picture(first);
  assert(before.wire, "The picture has the wire");
  assert(
    before.components.get(input)?.length &&
      before.components.get(output)?.length,
    "The picture has both pins",
  );
  from = stream.events.length;
  const ack = await client.run(doc, run, {
    kind: "input",
    componentId: input,
    bits: "1",
  });
  const next = await state(
    run.sessionId,
    from,
    (e) => e.commandSequence >= (ack.commandSequence ?? 0),
  );
  assert(!next.paint.full, "Later state events carry what changed");
  const after = picture(next);
  assert(
    after.wire && after.wire !== before.wire,
    "The wire takes its new value's color",
  );
  assert.notDeepEqual(
    after.components.get(output),
    before.components.get(output),
    "The output pin shows its new value",
  );
  assert(
    Object.keys(next.paint.components).every(
      (id) => id === input || id === output,
    ),
  );
  const mainView = run.viewId;

  from = stream.events.length;
  run = await client.started(doc, "empty");
  const empty = await state(run.sessionId, from);
  assert.notEqual(run.viewId, mainView, "Another circuit starts another run");
  assert.equal(empty.circuit, "empty");
  assert(
    empty.paint.full &&
      [empty.paint.wires, empty.paint.dots, empty.paint.components].every(
        (map) => !Object.keys(map).length,
      ),
    "An empty circuit paints nothing",
  );
  // A tick on a circuit with no clock still advances the run's clock and keeps
  // it live, as the released version did; it is not a failure.
  const ticked = await client.run(doc, run, { kind: "tick" });
  assert.equal(ticked.clock?.ticks, 1);
  assert.equal((await client.status()).session?.sessionId, run.sessionId);

  for (const circuit of ["far", "outside"]) {
    from = stream.events.length;
    run = await client.started(doc, circuit);
    const far = await state(run.sessionId, from);
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
  console.log(
    "Verified run pictures: the whole view first, then what changed; empty and distant circuits start.",
  );
}
