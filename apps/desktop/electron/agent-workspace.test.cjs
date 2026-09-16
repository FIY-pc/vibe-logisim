"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {AgentWorkspace} = require("./agent-workspace.cjs");

test("restart retains draft; interruption publishes without applying; rebase archives draft", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-recovery-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const projectId = "project-0123456789abcdef";
  const revision = "a".repeat(64);
  const calls = [];
  const backend = {
    agentBundle: async revisionId => ({projectId, sourceName:"example.circ",
      files:{"design.circ":Buffer.from(`<project revision="${revisionId}"/>`).toString("base64")}}),
    circuitTool: async request => { calls.push(request); return {id:"candidate-0123456789abcdef"}; },
    candidateReview: async id => ({id}),
    projectAction: async () => { throw new Error("interrupted draft must not apply"); },
  };
  const first = new AgentWorkspace({root, backend});
  const binding = await first.prepare(revision);
  const draft = "<project><circuit name=\"unfinished\"/></project>";
  first.writeFile(binding.directory, "design.circ", draft);
  const restarted = new AgentWorkspace({root, backend});
  const resumed = await restarted.prepare(revision);
  assert.equal(restarted.readCircuit(resumed.directory).toString(), draft);
  assert.equal(resumed.initialDigest, binding.initialDigest);
  assert.equal(restarted.listRecoveries()[0].draftChanged, true);
  fs.writeFileSync(path.join(root, "recoveries", "notes.json"), "{}");
  assert.equal(restarted.listRecoveries().length, 1);
  await assert.rejects(restarted.reviewRecovery(projectId, "c".repeat(64)), /当前工程版本/);
  assert.equal(calls.length, 0);
  const preview = await restarted.reviewRecovery(projectId, revision);
  assert.equal(preview.id, "candidate-0123456789abcdef");
  restarted.clearRecovery(projectId);
  assert.equal(restarted.listRecoveries().length, 0);
  const result = await restarted.finish(resumed, {apply:true, completed:false});
  assert.equal(result.applied, false);
  assert.equal(calls[0].arguments.circuitXml, draft);
  assert.equal(restarted.readRecovery(projectId).candidateId, result.candidate.id);
  const rebased = await new AgentWorkspace({root, backend}).prepare("b".repeat(64));
  assert.match(fs.readFileSync(path.join(rebased.directory, "design.circ"), "utf8"), /bbbb/);
  const drafts = fs.readdirSync(path.join(rebased.directory, "drafts"));
  assert.ok(drafts.some(file => fs.readFileSync(path.join(rebased.directory, "drafts", file), "utf8") === draft));
});
