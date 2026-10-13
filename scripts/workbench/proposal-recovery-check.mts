import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProposalStore } from "../../packages/agent-runtime/src/proposals.mts";
const state = await mkdtemp(path.join(tmpdir(), "vibe-proposal-recovery-"));
try {
  const workDir = path.join(state, "scratch");
  await mkdir(workDir);
  const original = '<project><circuit name="main"/></project>',
    xml =
      '<project><circuit name="main"><wire from="(0,0)" to="(10,0)"/></circuit></project>';
  const store = new ProposalStore(state, workDir);
  await store.prepare({ projectId: "A", revisionId: "r1", original });
  await writeFile(path.join(workDir, "circuit.circ"), xml);
  assert.equal((await store.workingCopy("A")).xml, xml);
  await assert.rejects(store.workingCopy("B"), /不属于/);
  const restarted = new ProposalStore(state, workDir);
  const recovered = await restarted.recover();
  assert.equal(recovered?.xml, xml);
  assert.equal(recovered?.original, original);
  await restarted.recover();
  assert.equal((await restarted.list("A")).length, 1);
  const preparedB = await restarted.prepare({
    projectId: "B",
    revisionId: "r2",
    original,
  });
  assert.equal((await restarted.list("A"))[0].xml, xml);
  await writeFile(path.join(workDir, "circuit.circ"), xml + "\n");
  await restarted.finish(preparedB);
  await assert.rejects(restarted.discard("B", recovered!.id), /另一/);
  await restarted.discard("A", recovered!.id);
  assert.deepEqual(await restarted.list("A"), []);
  assert.equal((await restarted.list("B")).length, 1);
  assert.equal(
    await readFile(path.join(workDir, "circuit.circ"), "utf8"),
    xml + "\n",
  );
  // Recovering legacy scratch remains supported without claiming a new turn identity.
  await writeFile(
    path.join(state, "active-agent-work.json"),
    JSON.stringify({ projectId: "legacy", revisionId: "legacy-r", original }),
  );
  const legacy = await restarted.recover();
  assert.equal(legacy?.documentId, "legacy");
  assert.equal(legacy?.xml, xml + "\n");

  const turnA = await restarted.prepare({
    projectId: "race-A",
    revisionId: "race-r1",
    original,
  });
  await writeFile(path.join(workDir, "circuit.circ"), xml);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const list = restarted.list.bind(restarted);
  let first = true;
  restarted.list = async (id) => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
    return list(id);
  };
  const recovering = restarted.recover();
  await started;
  let prepared = false;
  const preparation = restarted
    .prepare({ projectId: "race-B", revisionId: "race-r2", original: "<B/>" })
    .then((work) => {
      prepared = true;
      return work;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    prepared,
    false,
    "A new scratch file must wait for recovery to finish persisting the old one",
  );
  release();
  const raceProposal = await recovering,
    turnB = await preparation;
  assert.equal(raceProposal?.documentId, "race-A");
  assert.equal(raceProposal?.xml, xml);
  assert.equal((await restarted.workingCopy("race-B")).xml, "<B/>");
  await assert.rejects(restarted.finish(turnA), /另一回合/);
  assert.equal(
    JSON.parse(
      await readFile(path.join(state, "active-agent-work.json"), "utf8"),
    ).workId,
    turnB.workId,
  );
  assert.equal((await restarted.workingCopy("race-B")).xml, "<B/>");

  // Identical document/revision/content in another turn is not the same work.
  const nextB = await restarted.prepare({
    projectId: "race-B",
    revisionId: "race-r2",
    original: "<B/>",
  });
  assert.notEqual(nextB.workId, turnB.workId);
  await writeFile(path.join(workDir, "circuit.circ"), "<B-edited/>");
  await assert.rejects(restarted.finish(turnB), /另一回合/);
  await assert.rejects(
    restarted.finish({ ...nextB, original: "<wrong/>" }),
    /另一回合/,
  );
  const completed = await restarted.finish(nextB);
  assert.equal(completed?.xml, "<B-edited/>");
  assert.equal(
    await restarted.finish(nextB),
    null,
    "Repeated acknowledged finish never reads a later scratch without an active manifest",
  );
  assert.equal((await restarted.list("race-A")).length, 1);
  assert.equal((await restarted.list("race-B")).length, 1);
  await writeFile(path.join(workDir, "circuit.circ"), xml + "\n");
  await writeFile(path.join(state, "active-agent-work.json"), "{}");
  await assert.rejects(restarted.recover(), /恢复信息无效/);
  await assert.rejects(
    restarted.prepare({ projectId: "C", revisionId: "r3", original }),
    /恢复信息无效/,
  );
  assert.equal(
    await readFile(path.join(workDir, "circuit.circ"), "utf8"),
    xml + "\n",
  );
  assert.equal((await restarted.list("B")).length, 1);
  console.log(
    "Proposed source survives restart and legacy recovery; concurrent recovery/prepare serialize, and late or same-revision prior-turn finishes cannot consume another working copy.",
  );
} finally {
  await rm(state, { recursive: true, force: true });
}
