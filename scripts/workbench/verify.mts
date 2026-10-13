/** Real Rust -> Java and Pi -> Rust paths, with an entirely local model fixture. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { verifyHistory } from "./history-scenarios.mts";
import { eventStream } from "./event-stream.mts";
import { verifySimulation } from "./simulation-scenarios.mts";
import { verifyEditing } from "./editing-scenarios.mts";
import { verifyProposals } from "./proposal-scenarios.mts";
import { verifySimulationViewport } from "./viewport-scenarios.mts";
const root = path.resolve(import.meta.dirname, "../..");
const state = await mkdtemp(path.join(tmpdir(), "vibe-native-check-"));
let child: ChildProcess | undefined,
  url = "",
  logs = "",
  requests = 0;
const bodies: any[] = [];
let stream: Awaited<ReturnType<typeof eventStream>> | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const model = http.createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  bodies.push(body);
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: unknown, finish_reason: string | null = null) =>
    res.write(
      "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    );
  const toolMessages = body.messages.filter((m: any) => m.role === "tool");
  const snapshot =
    toolMessages.find((m: any) => m.name === "read_circuit") || toolMessages[0];
  const revision = snapshot ? JSON.parse(snapshot.content).revision : null;
  const calls = [
    { name: "read_circuit", args: {} },
    { name: "observe_circuit", args: { circuit: "main" } },
    {
      name: "render_circuit",
      args: { circuit: "main", x: 0, y: 0, width: 400, height: 300, scale: 1 },
    },
    {
      name: "edit_circuit",
      args: {
        revision,
        circuit: "main",
        edit: {
          kind: "wire",
          points: [
            { x: 50, y: 240 },
            { x: 180, y: 240 },
          ],
        },
      },
    },
  ];
  calls.push(
    { name: "project_files", args: { path: "", read: false } } as any,
    { name: "project_files", args: { path: "notes.txt", read: true } } as any,
    { name: "kept_observations", args: {} },
    {
      name: "simulate_circuit",
      args: {
        circuit: "main",
        vectors: [
          { inputs: { input: 0 }, expected: { output: 1 } },
          { inputs: { input: 1 }, expected: { output: 0 } },
        ],
      },
    } as any,
    {
      name: "trace_circuit",
      args: {
        circuit: "main",
        ticks: 2,
        inputs: { input: 0 },
        watches: [
          {
            component: snapshot
              ? JSON.parse(snapshot.content).circuits[0].components.find(
                  (c: any) => c.attributes.label === "output",
                ).id
              : "unused",
            port: 0,
          },
        ],
        events: [{ tick: 1, input: "input", value: 1 }],
      },
    } as any,
  );
  const call = calls[requests - 1];
  if (call) {
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "tool-" + requests,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      ],
    });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: "检查完成" });
    send({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
async function start() {
  const executable =
    process.env.VIBE_VERIFY_HOST ||
    path.join(
      root,
      "target",
      "debug",
      "vibe-workbench-host" + (process.platform === "win32" ? ".exe" : ""),
    );
  child = spawn(executable, [], {
    cwd: process.env.VIBE_VERIFY_CWD || root,
    env: {
      ...process.env,
      VIBE_WORKBENCH_STATE: state,
      VIBE_WORKBENCH_PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  url = "";
  logs = "";
  child.stderr!.on("data", (b) => {
    logs += b;
    const match = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) url = match[1];
  });
  for (let n = 0; n < 200 && !url; n++) {
    if (child.exitCode !== null) throw new Error(logs);
    await sleep(25);
  }
  assert(url, logs || "Host did not start");
  stream = await eventStream(url);
  await stream.wait((e) => e.topic === "resync");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
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
    const [code] = await once(kill, "exit");
    assert.equal(code, 0, "Windows host process tree did not terminate");
  } else child.kill();
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Host did not close live event streams")),
        10000,
      );
      timer.unref();
    }),
  ]);
  await stream?.close();
  child = undefined;
}
async function command(request: any) {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}
const agent = (method: string, args: unknown = {}) =>
  command({ op: "agent", method, args });
try {
  await start();
  let doc = await command({ op: "new", name: "example.circ" });
  const edit = async (value: any) =>
    (doc = await command({
      op: "edit",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      edit: value,
    }));
  await edit({
    kind: "place",
    name: "Pin",
    library: "0",
    location: { x: 100, y: 100 },
    attributes: { label: "input" },
  });
  await edit({
    kind: "place",
    name: "NOT Gate",
    library: "1",
    location: { x: 200, y: 100 },
    attributes: {},
  });
  await edit({
    kind: "place",
    name: "Pin",
    library: "0",
    location: { x: 280, y: 100 },
    attributes: { label: "output", output: "true", facing: "west" },
  });
  await assert.rejects(
    () => command({ op: "source", id: doc.id, revision: "obsolete" }),
    /版本|revision|改变/,
  );
  const matchingSource = await command({
    op: "source",
    id: doc.id,
    revision: doc.revision,
  });
  assert.equal(matchingSource.revision, doc.revision);
  const observed = await command({
    op: "observe",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
  });
  const gateInput = observed.focus.components
    .find((c: any) => c.factoryName === "NOT Gate")
    .ends.find((p: any) => p.direction === "input").location;
  await edit({ kind: "wire", points: [{ x: 100, y: 100 }, gateInput] });
  await edit({
    kind: "wire",
    points: [
      { x: 200, y: 100 },
      { x: 280, y: 100 },
    ],
  });
  const project = path.join(state, "project");
  await mkdir(project);
  await writeFile(
    path.join(project, "notes.txt"),
    "Observe the output after each input change.",
  );
  await command({ op: "folderOpen", path: project });
  const source = path.join(project, "example.circ");
  doc = await command({
    op: "save",
    id: doc.id,
    revision: doc.revision,
    path: source,
  });
  const saved = await readFile(source, "utf8");
  const input = doc.circuits[0].components.find(
    (c: any) => c.attributes.label === "input",
  );
  const output = doc.circuits[0].components.find(
    (c: any) => c.attributes.label === "output",
  );
  const props = await command({
    op: "properties",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    component: input.id,
  });
  assert(
    props.children.some(
      (n: any) => n.tag === "attribute" && n.attributes.name === "width",
    ),
  );
  const beforeInvalid = doc.revision;
  await assert.rejects(() =>
    edit({ kind: "attributes", id: input.id, values: { width: "0" } }),
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    beforeInvalid,
  );
  await command({
    op: "simulationStart",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
  });
  await command({
    op: "simulationCommand",
    id: doc.id,
    revision: doc.revision,
    command: "input",
    attributes: { componentId: input.id, bits: "1" },
  });
  const frame = (
    await stream!.wait(
      (e) =>
        e.topic === "simulation" &&
        e.data?.documentId === doc.id &&
        e.data.frame?.children?.some(
          (c: any) =>
            c.tag === "component" &&
            c.attributes.id === output.id &&
            c.children.some(
              (p: any) => p.tag === "port" && p.attributes.bits === "0",
            ),
        ),
    )
  ).data;
  const verify = (vectors: any[]) =>
    command({
      op: "simulate",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      vectors,
    });
  const check = await verify([
    { inputs: { input: 0 }, expected: { output: 1 } },
    { inputs: { input: 1 }, expected: { output: 0 } },
    { inputs: { input: 0 }, expected: { output: 0 } },
    { inputs: { input: 1 } },
  ]);
  assert.deepEqual([check.passed, check.failed, check.unchecked], [2, 1, 1]);
  await assert.rejects(() => verify([{ inputs: { input: 2 } }]), /range/);
  await assert.rejects(
    () => verify([{ inputs: { input: 0 }, expected: { typo: 1 } }]),
    /输出引脚/,
  );
  assert.equal(
    (await verify([{ inputs: { input: 1 }, expected: { output: 0 } }])).passed,
    1,
    "Native rejection must not poison the next verification",
  );
  const stillLive = await command({ op: "simulationStatus" });
  assert.equal(
    stillLive.viewId,
    frame.viewId,
    "Verification replaced the user live session",
  );
  assert(
    stillLive.frame.children
      .find((n: any) => n.attributes?.id === output.id)
      .children.some((p: any) => p.tag === "port" && p.attributes.bits === "0"),
    "Verification modified the user input state",
  );
  assert.equal(await readFile(source, "utf8"), saved);
  const outputState = frame.frame.children.find(
    (n: any) => n.tag === "component" && n.attributes.id === output.id,
  );
  assert(
    outputState?.children.some(
      (p: any) => p.tag === "port" && p.attributes.bits === "0",
    ),
    JSON.stringify(outputState),
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    doc.revision,
    "Stimulus changed document",
  );
  await edit({
    kind: "wire",
    points: [
      { x: 30, y: 200 },
      { x: 80, y: 200 },
    ],
  });
  const restoredRevision = doc.revision,
    id = doc.id;
  await stop();
  await start();
  doc = await command({ op: "read", id });
  assert.equal(doc.revision, restoredRevision);
  assert.equal(doc.dirty, true);
  assert.equal(doc.canUndo, true);
  assert.equal(
    await readFile(source, "utf8"),
    saved,
    "Recovery changed the source",
  );
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const port = (model.address() as any).port;
  await agent("bind", {
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    workspaceKey: "test:independent-circuit",
  });
  await agent("configure", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "local-fixture",
    model: "fixture",
    api: "openai-completions",
    effort: "none",
    vision: true,
  });
  await agent("ask", { question: "检查这个电路并画一段导线" });
  let status: any;
  for (let n = 0; n < 500; n++) {
    status = await agent("status");
    if (!status.busy) break;
    await sleep(50);
  }
  assert.equal(status.busy, false);
  const completed = await stream!.wait(
    (e) =>
      e.topic === "agent" &&
      e.data.event.type === "assistant-completed" &&
      e.data.event.text === "检查完成",
  );
  assert(
    status.eventCursor >= completed.data.sequence,
    "Snapshot cursor must cover already applied sidecar events",
  );
  const sequences = stream!.events
    .filter((e) => e.topic === "agent")
    .map((e) => e.data.sequence);
  assert.equal(
    new Set(sequences).size,
    sequences.length,
    "Event stream duplicated an agent event",
  );
  assert.equal(status.transmission, null, JSON.stringify(status.transmission));
  assert.equal(requests, 10, JSON.stringify(status.messages));
  for (const body of bodies)
    for (const m of body.messages.filter((m: any) => m.role === "tool"))
      assert(!String(m.content).includes('"error"'), m.content);
  assert(
    bodies.some((b) =>
      b.messages.some(
        (m: any) =>
          Array.isArray(m.content) &&
          m.content.some((c: any) => c.type === "image_url"),
      ),
    ),
    "Native image missing from model input",
  );
  assert(
    status.messages.some(
      (m: any) => m.type === "assistant" && m.text === "检查完成",
    ),
  );
  const after = await command({ op: "read", id });
  assert.notEqual(after.revision, restoredRevision);
  assert.equal(
    await readFile(source, "utf8"),
    saved,
    "AI edit saved source without explicit save",
  );
  const results = bodies
    .at(-1)
    .messages.filter((m: any) => m.role === "tool")
    .map((m: any) => JSON.parse(m.content));
  assert(
    results.some((r: any) => r.isolated && r.passed === 2),
    "Model must receive real vector comparisons",
  );
  assert(
    results.some(
      (r: any) => r.isolated && r.completed && r.samples?.length === 3,
    ),
    "Model must receive native tick samples",
  );
  const previous = status.conversationId;
  await agent("conversations", { action: "new" });
  await agent("conversations", { action: "select", id: previous });
  assert(
    (await agent("status")).messages.some((m: any) => m.text === "检查完成"),
  );
  const reply = (await agent("status")).messages.find(
    (m: any) => m.type === "assistant" && m.canFork,
  );
  assert(reply, "Completed reply must expose a valid fork boundary");
  await agent("conversations", {
    action: "rename",
    id: previous,
    title: "Inspection",
  });
  const forked = await agent("conversations", {
    action: "fork",
    messageId: reply.id,
  });
  assert.notEqual(forked.activeId, previous);
  await agent("conversations", { action: "archive", id: forked.activeId });
  await agent("conversations", { action: "restore", id: forked.activeId });
  await agent("conversations", { action: "select", id: previous });
  const editable = (await agent("status")).messages.find(
    (m: any) => m.type === "user" && m.canEdit,
  );
  assert(editable, "Editable message must retain its native checkpoint");
  await agent("ask", {
    question: "Recheck the output",
    editMessageId: editable.id,
  });
  for (let n = 0; n < 200 && (await agent("status")).busy; n++) await sleep(25);
  const revised = await agent("status");
  assert.equal(
    revised.messages.filter((m: any) => m.type === "user").length,
    1,
  );
  assert(revised.messages.some((m: any) => m.text === "Recheck the output"));
  await verifyHistory(agent, state, previous);
  // Save As must not alias the old path to the open copy, including after restart.
  const copyPath = path.join(state, "copy.circ");
  const copied = await command({
    op: "save",
    id,
    revision: after.revision,
    path: copyPath,
  });
  const reopened = await command({ op: "open", path: source });
  assert.notEqual(reopened.id, id);
  assert.equal((await command({ op: "read", id })).path, copyPath);
  await writeFile(copyPath, saved);
  const changed = await command({ op: "sourceStatus", id });
  assert.equal(changed.state, "modified");
  const reloaded = await command({
    op: "reload",
    id,
    revision: copied.revision,
    source_revision: changed.revision,
  });
  assert.equal(reloaded.dirty, false);
  assert.equal(reloaded.id, id);
  const undoReload = await command({
    op: "undo",
    id,
    revision: reloaded.revision,
  });
  assert.equal(undoReload.revision, copied.revision);
  assert.equal(undoReload.dirty, true);
  await assert.rejects(() =>
    command({ op: "close", id, revision: reloaded.revision, discard: true }),
  );
  await command({
    op: "simulationStart",
    id,
    revision: undoReload.revision,
    circuit: "main",
  });
  await command({
    op: "close",
    id,
    revision: undoReload.revision,
    discard: true,
  });
  assert.equal(await command({ op: "simulationStatus" }), null);
  await stream!.wait((e) => e.topic === "simulation" && e.data === null);
  assert.equal(
    (await command({ op: "read", id: reopened.id })).revision,
    reopened.revision,
  );
  await stop();
  await start();
  assert.equal((await command({ op: "open", path: copyPath })).id, id);
  await verifySimulationViewport(command);
  await verifyProposals(command);
  await verifyEditing(command);
  const retained = await verifySimulation(command, state);
  await stop();
  await start();
  assert(
    (await command({ op: "observations", id: retained.documentId })).some(
      (r: any) => r.id === retained.recordId,
    ),
    "Observation did not survive restart",
  );
  console.log(
    "Verified: native placement and property rejection; NOT simulation; isolated vector comparisons and tick traces; transient stimuli; dirty recovery and undo; Pi tool/image roundtrip; conversation selection; explicit source save; Save As identity; external reload and undo; guarded close and simulation cleanup.",
  );
} finally {
  await stop();
  model.closeAllConnections();
  model.close();
  await rm(state, { recursive: true, force: true });
}
