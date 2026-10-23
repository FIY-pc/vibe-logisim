import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  storeReference,
  readReferences,
} from "../../packages/agent-runtime/src/conversations/references.mts";
const state = await mkdtemp(path.join(tmpdir(), "vibe-reference-"));
try {
  const observation = {
    id: "record",
    title: "before edge",
    revision: "revision-1",
    rootCircuit: "main",
    circuit: "child",
    instancePath: ["instance-1"],
    signals: [{ key: "q:0", label: "Q", bits: "0011" }],
    frame: {
      circuit: "child",
      instancePath: ["instance-1"],
      clock: { enabled: false, frequency: 4 },
      frameSequence: 7,
      children: [],
    },
  };
  const render = "data:image/png;base64,iVBORw0KGgo=";
  // One kept frame: the detail carries the state, the image op its picture.
  const host = async (request: any) =>
    request.op === "observationGet"
      ? observation
      : request.op === "observationImage"
        ? render
        : [observation];
  const ref = await storeReference(
    state,
    "folder",
    "document",
    { kind: "observation", documentId: "document", recordId: "record" },
    host,
  );
  observation.title = "renamed";
  observation.signals[0].bits = "1100";
  const [frozen] = await readReferences(state, "folder", [ref.id]);
  assert.equal(frozen.label, "before edge");
  assert(frozen.text.includes("0011"));
  assert(frozen.text.includes("instance-1"));
  assert(frozen.text.includes('"frameSequence":7'));
  assert.equal(frozen.image, render);
  await assert.rejects(readReferences(state, "other-folder", [ref.id]));
  await assert.rejects(readReferences(state, "folder", ["../../escape"]));
  await assert.rejects(
    storeReference(
      state,
      "folder",
      "other-document",
      { kind: "observation", documentId: "document", recordId: "record" },
      host,
    ),
    /另一/,
  );
  await assert.rejects(
    storeReference(
      state,
      "folder",
      "document",
      {
        kind: "material",
        label: "image",
        path: "x",
        image: "https://example.invalid/image",
      },
      host,
    ),
    /图片/,
  );
  const excerpt = await storeReference(
    state,
    "folder",
    "document",
    {
      kind: "material",
      label: "notes",
      path: "notes.txt",
      text: "a".repeat(24001),
      folderId: "folder",
      pathVersion: 7,
    },
    host,
  );
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.folderId, "folder");
  assert.equal(excerpt.pathVersion, 7);
  assert.equal(
    (await readReferences(state, "folder", [excerpt.id]))[0].text.length,
    24000,
  );
  console.log(
    "References retain immutable evidence, enforce workspace scope and report truncation.",
  );
} finally {
  await rm(state, { recursive: true, force: true });
}
