import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ToolContext } from "../../packages/agent-runtime/src/tools/context.mts";
import { connect } from "../../packages/agent-runtime/src/tools/edit.mts";

export async function verifyAtomicConnect(
  post: (request: any) => Promise<any>,
) {
  const status = await post({ op: "status", summary: true });
  const file = path.join(status.folder.path, "atomic-connect.circ");
  const xml =
    '<project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><lib desc="#Gates" name="1"/><main name="main"/><circuit name="main"><comp lib="0" name="Pin" loc="(100,100)"/><comp lib="0" name="Pin" loc="(300,100)"><a name="output" val="true"/><a name="facing" val="west"/></comp><wire from="(100,100)" to="(300,100)"/></circuit></project>';
  await writeFile(file, xml);
  const doc = await post({ op: "open", path: file });
  const context = new ToolContext({
    host: { call: post },
    folder: status.folder,
    emit() {},
    assertCurrent() {},
    userDocumentId: doc.id,
    userCircuit: "main",
  });
  const prelude = {
    removeWireIds: ["w0"],
    additions: [{ factory: "NOT Gate", location: { x: 200, y: 100 } }],
  };
  await assert.rejects(
    connect(context, {
      ...prelude,
      connections: [
        {
          from: { component: "missing", port: 0 },
          to: { component: "c300_100", port: 0 },
        },
      ],
    }),
    (e: any) => e.code === "PORT_NOT_FOUND",
  );
  assert.equal((await post({ op: "read", id: doc.id })).revision, doc.revision);
  assert.equal(await readFile(file, "utf8"), xml);
  const result = (await connect(context, {
    ...prelude,
    connections: [
      {
        from: { component: "c100_100", port: 0 },
        to: { component: "c200_100", port: 1 },
      },
      {
        from: { component: "c200_100", port: 0 },
        to: { component: "c300_100", port: 0 },
      },
    ],
  })) as any;
  assert.equal(result.ids.wires.length, 2);
  const current = await post({ op: "read", id: doc.id });
  assert.equal(current.circuits[0].components.length, 3);
  await post({ op: "undo", id: doc.id, revision: current.revision });
  assert.equal(await readFile(file, "utf8"), xml);
  assert.equal((await post({ op: "read", id: doc.id })).canUndo, false);
  console.log(
    "Verified atomic connect through real Rust/Java: failed preview leaves disk untouched; placement/removal/routing commit and undo as one change.",
  );
}
