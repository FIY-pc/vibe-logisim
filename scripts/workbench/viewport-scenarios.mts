import assert from "node:assert/strict";
import { simulationClient } from "./simulation-client.mts";
type Command = (request: any) => Promise<any>;
export async function verifySimulationViewport(command: Command) {
  const client = simulationClient(command);
  const pin = (x: number, y: number) =>
    `<comp lib="0" name="Pin" loc="(${x},${y})"><a name="label" val="signal"/></comp>`;
  const xml = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main">${pin(100, 100)}</circuit><circuit name="empty"/><circuit name="far">${pin(120000, 90000)}</circuit><circuit name="outside">${pin(20000000, 20000000)}</circuit></project>`;
  const doc = await command({ op: "import", name: "viewport.circ", xml });
  const start = (circuit: string) => client.started(doc, circuit);
  const frame = async (run: Awaited<ReturnType<typeof start>>) => {
    const { session, frame } = await client.snapshot(run);
    assert.equal(session.documentId, doc.id);
    assert.equal(session.revision, doc.revision);
    const { width, height } = frame.image;
    assert(
      width > 0 &&
        height > 0 &&
        width <= 4096 &&
        height <= 4096 &&
        width * height <= 8_000_000,
    );
    const image = await client.image(run, frame.frameSequence);
    assert(image.startsWith("data:image/png;base64,"));
    assert(
      Buffer.from(image.split(",")[1], "base64")
        .subarray(1, 4)
        .equals(Buffer.from("PNG")),
      "A native simulation must produce a render, including empty circuits",
    );
    return frame;
  };
  let run = await start("main");
  await frame(run);
  const main = run.viewId;
  run = await start("empty");
  const emptyFrame = await frame(run);
  assert.equal(emptyFrame.circuit, "empty");
  assert.notEqual(
    run.viewId,
    main,
    "Switching to an empty circuit must replace the original session",
  );
  assert.equal((await client.status()).state?.viewId, run.viewId);
  // A tick on a circuit with no clock still advances the run's clock and keeps
  // it live, as the released version did; it is not a failure.
  const ticked = await client.run(doc, run, { kind: "tick" });
  assert.equal(ticked.clock?.ticks, 1);
  assert.equal((await client.status()).session?.sessionId, run.sessionId);
  run = await start("far");
  const far = await frame(run);
  assert(
    far.image.bounds.x > 119900 && far.image.bounds.y > 89900,
    "Auto framing must retain distant circuit coordinates, not force the origin",
  );
  const retained = run.viewId;
  await assert.rejects(start("outside"), (error: any) => {
    assert.match(error.message, /仿真未启动.*画面范围超过限制/);
    assert(
      !error.message.includes('"frame"') && !error.message.includes("viewId"),
      "An actionable message must replace serialized internal state",
    );
    return true;
  });
  assert.equal(
    (await client.status()).state?.viewId,
    retained,
    "A failed replacement must keep the prior valid simulation",
  );
  run = await start("empty");
  assert.equal(
    (await frame(run)).circuit,
    "empty",
    "Retry another circuit directly without returning to the old one",
  );
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
    "Verified empty/distant native simulation frames, safe session replacement, bounded failure messages and direct retry after failure.",
  );
}
