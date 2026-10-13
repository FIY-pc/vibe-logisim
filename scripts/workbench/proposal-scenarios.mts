import assert from "node:assert/strict";
type Command = (request: any) => Promise<any>;
/** Frozen candidate review, using only synthetic source and native rendering. */
export async function verifyProposals(command: Command) {
  const original =
    '<?xml version="1.0"?><project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main"><a name="circuit" val="main"/><comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="input"/></comp></circuit></project>';
  const doc = await command({
    op: "import",
    name: "review.circ",
    xml: original,
  });
  const xml = original
    .replace('val="input"', 'val="renamed"')
    .replace(
      "</project>",
      '<circuit name="added"><a name="circuit" val="added"/></circuit></project>',
    );
  const binding = { id: doc.id, revision: doc.revision, original, xml };
  const review = await command({ op: "proposalReview", ...binding });
  assert.equal(
    review.before.circuits[0].components[0].attributes.label,
    "input",
  );
  assert.equal(
    review.after.circuits[1].components[0]?.attributes.label ||
      review.after.circuits[0].components[0]?.attributes.label,
    "renamed",
  );
  assert(
    review.rows.some(
      (r: any) =>
        r.kind === "modified" &&
        r.fields.some(
          (f: any) =>
            f.name === "标签" && f.before === "input" && f.after === "renamed",
        ),
    ),
  );
  assert(
    review.rows.some((r: any) => r.circuit === "added" && r.kind === "added"),
  );
  await assert.rejects(
    command({ op: "proposalReview", ...binding, original: xml }),
    /不匹配/,
  );
  await assert.rejects(
    command({ op: "proposalReview", ...binding, xml: "<broken>" }),
  );
  const live = await command({
    op: "simulationStart",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
  });
  for (const candidate of [false, true]) {
    const preview = await command({
      op: "proposalPreview",
      ...binding,
      circuit: "main",
      candidate,
    });
    assert(preview.image.startsWith("data:image/png;base64,"));
    assert(
      Buffer.from(preview.image.split(",")[1], "base64")
        .subarray(1, 4)
        .equals(Buffer.from("PNG")),
    );
    assert.equal(
      (await command({ op: "simulationStatus" })).viewId,
      live.viewId,
    );
    assert.equal(
      (await command({ op: "read", id: doc.id })).revision,
      doc.revision,
    );
  }
  assert.equal(
    (
      await command({
        op: "proposalPreview",
        ...binding,
        circuit: "added",
        candidate: false,
      })
    ).missing,
    true,
  );
  assert.equal((await command({ op: "read", id: doc.id })).canUndo, false);
  const applied = await command({
    op: "edit",
    id: doc.id,
    revision: doc.revision,
    circuit: "main",
    edit: { kind: "replace", xml },
  });
  assert.equal(applied.circuits.length, 2);
  const undone = await command({
    op: "undo",
    id: doc.id,
    revision: applied.revision,
  });
  assert.equal(
    undone.revision,
    doc.revision,
    "One undo must restore the entire pre-application draft",
  );
  const newer = await command({
    op: "edit",
    id: doc.id,
    revision: undone.revision,
    circuit: "main",
    edit: { kind: "addCircuit", name: "manual" },
  });
  const oldReview = await command({ op: "proposalReview", ...binding });
  assert.equal(oldReview.currentRevision, newer.revision);
  assert.equal(
    oldReview.before.revision,
    doc.revision,
    "Old candidate must show its original source, not the newer draft",
  );
  await assert.rejects(
    command({
      op: "edit",
      id: doc.id,
      revision: doc.revision,
      circuit: "main",
      edit: { kind: "replace", xml },
    }),
  );
  assert.equal(
    (await command({ op: "read", id: doc.id })).revision,
    newer.revision,
  );
  await command({
    op: "close",
    id: doc.id,
    revision: newer.revision,
    discard: true,
  });
  console.log(
    "Verified frozen proposal comparison, native before/after preview without changing live simulation, stale-apply rejection, and one-step undo.",
  );
}
