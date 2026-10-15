import assert from "node:assert/strict";
type Command = (request: any) => Promise<any>;
export async function verifySimulationViewport(command: Command) {
  const pin = (x: number, y: number) =>
    `<comp lib="0" name="Pin" loc="(${x},${y})"><a name="label" val="signal"/></comp>`;
  const xml = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main">${pin(100, 100)}</circuit><circuit name="empty"/><circuit name="far">${pin(120000, 90000)}</circuit><circuit name="outside">${pin(20000000, 20000000)}</circuit></project>`;
  const doc = await command({ op: "import", name: "viewport.circ", xml });
  const start = (circuit: string) =>
    command({
      op: "simulationAction",
      id: doc.id,
      revision: doc.revision,
      circuit,
      command: "start",
    });
  const frame = (simulation: any) => {
    assert.equal(simulation.documentId, doc.id);
    assert.equal(simulation.revision, doc.revision);
    assert.equal(simulation.frame.tag, "frame");
    const render = simulation.frame.children.find(
      (n: any) => n.tag === "render",
    );
    assert(
      render,
      "A native simulation must produce a render, including empty circuits",
    );
    const width = Number(render.attributes.pixelWidth),
      height = Number(render.attributes.pixelHeight);
    assert(
      width > 0 &&
        height > 0 &&
        width <= 4096 &&
        height <= 4096 &&
        width * height <= 8_000_000,
    );
    assert(
      Buffer.from(render.text, "base64")
        .subarray(1, 4)
        .equals(Buffer.from("PNG")),
    );
    return render;
  };
  let simulation = await start("main");
  frame(simulation);
  const main = simulation.viewId;
  simulation = await start("empty");
  frame(simulation);
  assert.equal(simulation.circuit, "empty");
  assert.notEqual(
    simulation.viewId,
    main,
    "Switching to an empty circuit must replace the original session",
  );
  assert.equal(
    (await command({ op: "simulationStatus" })).viewId,
    simulation.viewId,
  );
  await command({
    op: "simulationAction",
    id: doc.id,
    revision: doc.revision,
    circuit: "empty",
    command: "tick",
  });
  simulation = await start("far");
  const render = frame(simulation);
  assert(
    Number(render.attributes.x) > 119900 && Number(render.attributes.y) > 89900,
    "Auto framing must retain distant circuit coordinates, not force the origin",
  );
  const retained = simulation.viewId;
  await assert.rejects(start("outside"), (error: any) => {
    assert.match(error.message, /仿真未启动.*画面范围超过限制/);
    assert(
      !error.message.includes('"frame"') && !error.message.includes("viewId"),
      "An actionable message must replace serialized internal state",
    );
    return true;
  });
  assert.equal(
    (await command({ op: "simulationStatus" })).viewId,
    retained,
    "A failed replacement must keep the prior valid simulation",
  );
  simulation = await start("empty");
  frame(simulation);
  assert.equal(
    simulation.circuit,
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
