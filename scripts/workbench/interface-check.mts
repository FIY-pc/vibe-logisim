/** Independent child definition and three parent instances; no model or course artifacts. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-interface-"));
let child: ChildProcess | undefined;
let url = "",
  logs = "";
const pin = (x: number, y: number, label: string, output = false, width = 4) =>
  `<comp lib="0" name="Pin" loc="(${x},${y})"><a name="label" val="${label}"/><a name="width" val="${width}"/>${output ? '<a name="output" val="true"/><a name="facing" val="west"/>' : ""}</comp>`;
const wire = (a: string, b: string) => `<wire from="(${a})" to="(${b})"/>`;
const parent = (y: number, label: string) =>
  `${pin(100, y, "in" + label)}<comp name="child" loc="(300,${y})"/>${pin(400, y, "out" + label, true)}${wire("100," + y, "240," + y)}${wire("300," + y, "400," + y)}`;
const source = `<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><main name="main"/><options/><mappings/><toolbar/>
<circuit name="main">${parent(100, "A")}${parent(260, "B")}</circuit>
<circuit name="rotated">${pin(600, 450, "inR")}<comp name="child" loc="(600,300)"><a name="facing" val="north"/></comp>${pin(600, 200, "outR", true)}${wire("600,450", "600,360")}${wire("600,300", "600,200")}</circuit>
<circuit name="child"><a name="appearance" val="custom"/><appear><rect x="30" y="40" width="60" height="20" fill="none" stroke="#000000" stroke-width="2"/><circ-port x="26" y="46" width="8" height="8" pin="100,100"/><circ-port x="85" y="45" width="10" height="10" pin="280,100"/><circ-anchor x="87" y="47" width="6" height="6" facing="east"/></appear>${pin(100, 100, "input")}<comp lib="1" name="NOT Gate" loc="(200,100)"><a name="width" val="4"/></comp>${pin(280, 100, "output", true)}${wire("100,100", "170,100")}${wire("200,100", "280,100")}</circuit></project>`;
async function command(request: any) {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await response.json();
  if (data.error) throw Error(data.error);
  return data.result;
}
try {
  const executable = path.join(
    root,
    "target/debug/vibe-workbench-host" +
      (process.platform === "win32" ? ".exe" : ""),
  );
  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      VIBE_WORKBENCH_STATE: state,
      VIBE_WORKBENCH_PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr!.on("data", (chunk) => {
    logs += chunk;
    url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || url;
  });
  for (let i = 0; i < 400 && !url; i++) {
    if (child.exitCode !== null) throw Error(logs);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert(url, logs);
  const file = path.join(state, "symbols.circ");
  await writeFile(file, source);
  let doc = await command({ op: "open", path: file });
  const initial = doc.revision;
  const scope = () => ({
    id: doc.id,
    revision: doc.revision,
    circuit: "child",
  });
  const base = await command({ op: "interfaceRead", ...scope() });
  assert.equal(base.uses.length, 3);
  assert.equal(base.ports.length, 2);
  const draft = () =>
    structuredClone({ ports: base.ports, shapes: base.shapes });
  const output = (d: any) => d.ports.find((p: any) => p.label === "output");
  const apply = (d: any, p: any) =>
    command({
      op: "interfaceApply",
      ...scope(),
      draft: d,
      preview_id: p.previewId,
    });
  const preview = (d: any) =>
    command({ op: "interfacePreview", ...scope(), draft: d });
  const unchanged = async () => {
    assert.equal((await command({ op: "read", id: doc.id })).revision, initial);
    assert.equal(await readFile(file, "utf8"), source);
  };
  const simulate = async (circuit: string, inputs: any, expected: any) => {
    const result = await command({
      op: "simulate",
      ...scope(),
      circuit,
      vectors: [{ inputs, expected }],
    });
    assert.equal(result.passed, 1, JSON.stringify(result));
  };
  await simulate("main", { inA: 0, inB: 3 }, { outA: 15, outB: 12 });
  await simulate("rotated", { inR: 5 }, { outR: 10 });
  const running = await command({
    op: "simulationStart",
    ...scope(),
    circuit: "main",
  });
  const noop = draft();
  const nochange = await preview(noop);
  assert.equal(nochange.changed, false);
  await apply(noop, nochange);
  await unchanged();
  const narrow = draft();
  output(narrow).width = 2;
  await assert.rejects(() => preview(narrow), /位宽|匹配|保持/);
  await unchanged();
  const overlap = draft();
  overlap.ports[1].x = overlap.ports[0].x;
  overlap.ports[1].y = overlap.ports[0].y;
  await assert.rejects(() => preview(overlap), /同一位置/);
  const collision = draft();
  collision.shapes[0].attrs.width = "400";
  await assert.rejects(() => preview(collision), /遮住|重叠|占用/);
  await unchanged();
  const changed = draft();
  output(changed).y += 20;
  output(changed).label = "result";
  changed.shapes[0].attrs.height = "60";
  changed.shapes.push({
    id: "new-caption",
    tag: "text",
    attrs: {
      x: "45",
      y: "80",
      "font-size": "12",
      "font-family": "Dialog",
      fill: "#000000",
    },
    text: "Gate",
    editable: true,
  });
  const prepared = await preview(changed);
  assert.equal(prepared.impacts.length, 3);
  assert.equal(
    prepared.impacts.find((i: any) => i.circuit === "main").movedPorts,
    2,
  );
  assert.equal(
    prepared.impacts.find((i: any) => i.circuit === "rotated").movedPorts,
    1,
  );
  await unchanged();
  assert.equal(
    (await command({ op: "simulationStatus" })).viewId,
    running.viewId,
  );
  const image = await command({
    op: "interfaceRender",
    ...scope(),
    preview_id: prepared.previewId,
    circuit: "rotated",
  });
  assert(image.image.startsWith("data:image/png;base64,"));
  await unchanged();
  const altered = structuredClone(changed);
  altered.ports[0].label = "changed-again";
  await assert.rejects(() => apply(altered, prepared), /草稿|改变/);
  doc = await apply(changed, prepared);
  assert.notEqual(doc.revision, initial);
  assert.equal(await readFile(file, "utf8"), source);
  await simulate("main", { inA: 0, inB: 3 }, { outA: 15, outB: 12 });
  await simulate("rotated", { inR: 5 }, { outR: 10 });
  const accepted = await command({ op: "interfaceRead", ...scope() });
  assert.equal(
    accepted.ports.find((p: any) => p.label === "result").y,
    changed.ports.find((p: any) => p.label === "result").y,
  );
  assert(accepted.shapes.some((s: any) => s.text === "Gate"));
  await assert.rejects(() => apply(changed, prepared), /改变|失效/);
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  await unchanged();
  await assert.rejects(() => apply(changed, prepared), /失效/);
  const stale = await preview(changed);
  doc = await command({
    op: "edit",
    ...scope(),
    edit: {
      kind: "wire",
      points: [
        { x: 500, y: 500 },
        { x: 540, y: 500 },
      ],
    },
  });
  await assert.rejects(() => apply(changed, stale), /改变/);
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  await unchanged();
  const disconnected = draft();
  output(disconnected).width = 2;
  output(disconnected).disconnect = true;
  const detach = await preview(disconnected);
  assert.equal(
    detach.impacts.reduce((n: number, i: any) => n + i.detachedPorts, 0),
    4,
  );
  doc = await apply(disconnected, detach);
  assert.equal(
    (await command({ op: "interfaceRead", ...scope() })).ports.find(
      (p: any) => p.label === "output",
    ).width,
    2,
  );
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  await unchanged();
  const removed = draft();
  removed.ports = removed.ports.filter((p: any) => p.label !== "output");
  const removal = await preview(removed);
  assert.equal(removal.removedPorts, 1);
  doc = await apply(removed, removal);
  assert.equal(
    (await command({ op: "interfaceRead", ...scope() })).ports.length,
    1,
  );
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  await unchanged();
  const added = draft();
  added.ports.push({
    id: "new-extra",
    label: "EXTRA",
    direction: "input",
    width: 8,
    x: 30,
    y: 90,
    internalX: 100,
    internalY: 300,
    disconnect: false,
  });
  const addition = await preview(added);
  assert.equal(addition.addedPorts, 1);
  doc = await apply(added, addition);
  assert.equal(
    (await command({ op: "interfaceRead", ...scope() })).ports.length,
    3,
  );
  doc = await command({ op: "undo", id: doc.id, revision: doc.revision });
  await unchanged();
  await writeFile(file, source + "\n");
  await assert.rejects(() => preview(changed), /磁盘/);
  await writeFile(file, source);
  console.log(
    "Verified native interface editing: three parent instances including rotation; port mapping, preserved bus behavior, readonly preview, live simulation continuity, width/disconnect choice, add/remove, artwork, stale drafts, consumed previews, source guards and single undo.",
  );
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    if (process.platform === "win32") {
      const kill = spawn(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
      await once(kill, "exit");
    } else child.kill();
    await exited;
  }
  await rm(state, { recursive: true, force: true });
}
