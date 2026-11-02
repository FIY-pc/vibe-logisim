/** Record the website's eight frames with the real Rust -> Java simulator.
 * Uses an isolated temporary profile; no model service or classroom account.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { eventStream } from "../../../scripts/workbench/event-stream.mts";
import { simulationClient } from "../../../scripts/workbench/simulation-client.mts";

const root = path.resolve(import.meta.dirname, "../../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-showcase-record-"));
const host = spawn(
  process.env.VIBE_VERIFY_HOST ||
    path.join(
      root,
      "target/debug/vibe-workbench-host" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
  [],
  {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      VIBE_WORKBENCH_STATE: state,
      VIBE_WORKBENCH_PORT: "0",
      VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
    },
  },
);
let url = "",
  logs = "",
  stream: Awaited<ReturnType<typeof eventStream>> | undefined;
host.stderr.on("data", (chunk) => {
  logs += chunk;
  url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || "";
});
try {
  for (let n = 0; !url && n < 200; n++)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(url, logs || "Native host did not start");
  const command = async (body: Record<string, unknown>) => {
    const r = await fetch(url + "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await r.json()) as any;
    assert.ok(!d.error, JSON.stringify(d.error));
    return d.result;
  };
  const xml = await readFile(
    path.join(root, "packages/showcase/public/assets/full-adder.circ"),
    "utf8",
  );
  const document = await command({ op: "import", name: "全加器.circ", xml });
  const circuit = document.circuits.find((c: any) => c.name === document.main);
  const symbols = await command({
    op: "symbols",
    id: document.id,
    revision: document.revision,
    circuit: circuit.name,
    symbols: circuit.components.map((c: any) => ({
      name: c.name,
      library: c.library,
      attributes: c.attributes,
    })),
  });
  assert.ok(symbols.symbols.every((s: any) => Array.isArray(s.ops)));
  stream = await eventStream(url);
  const client = simulationClient(command, stream);
  await client.start(document, circuit.name);
  const pins = Object.fromEntries(
    circuit.components
      .filter((c: any) => c.name === "Pin")
      .map((c: any) => [c.attributes.label, c.id]),
  );
  assert.ok(pins.A && pins.B && pins.Cin && pins.S && pins.Cout);
  const cases = [];
  for (let n = 0; n < 8; n++) {
    const bits = n.toString(2).padStart(3, "0");
    for (const [i, name] of ["A", "B", "Cin"].entries())
      await client.act({
        kind: "input",
        componentId: pins[name],
        bits: bits[i],
      });
    const sum = Number(bits[0]) + Number(bits[1]) + Number(bits[2]);
    assert.equal(client.bits(pins.S), String(sum % 2));
    assert.equal(client.bits(pins.Cout), String(sum >= 2 ? 1 : 0));
    const picture = {
      wires: {} as Record<string, string>,
      dots: {} as Record<string, string>,
      components: {} as Record<string, unknown>,
    };
    const ops: unknown[] = [],
      lists: number[][] = [];
    for (const event of stream.events) {
      const f = event.data;
      if (event.topic !== "simulation" || f.kind !== "frame") continue;
      if (f.full) {
        picture.wires = {};
        picture.dots = {};
        picture.components = {};
        ops.length = lists.length = 0;
      }
      ops.push(...f.paint.ops);
      lists.push(...f.paint.lists);
      for (const [color, xs] of Object.entries(f.paint.wires) as [
        string,
        number[],
      ][])
        for (let i = 0; i < xs.length; i += 4)
          picture.wires[xs.slice(i, i + 4).join()] = color;
      for (const [color, xs] of Object.entries(f.paint.dots) as [
        string,
        number[],
      ][])
        for (let i = 0; i < xs.length; i += 2)
          picture.dots[xs.slice(i, i + 2).join()] = color;
      for (const [id, index] of Object.entries(f.paint.components) as [
        string,
        number,
      ][])
        picture.components[id] = lists[index].map((i) => ops[i]);
    }
    cases.push({
      inputs: bits,
      sum: client.bits(pins.S),
      cout: client.bits(pins.Cout),
      picture,
    });
  }
  // Exclude machine paths, session identifiers and timestamps from the asset.
  await writeFile(
    path.join(root, "packages/showcase/public/assets/demo-recording.json"),
    JSON.stringify({
      schema: 1,
      source: "Logisim native simulation; assets/full-adder.circ",
      circuit,
      symbols: symbols.symbols,
      cases,
    }) + "\n",
  );
  console.log(
    `Recorded ${circuit.components.length} components, ${circuit.wires.length} wires and ${cases.length} verified native frames.`,
  );
} finally {
  await stream?.close();
  if (host.exitCode === null) {
    if (process.platform === "win32")
      execFileSync("taskkill.exe", ["/PID", String(host.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else host.kill();
  }
}
