import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProposalReview } from "../../../apps/workbench/src/components/ProposalReview";
import { sourceDiff } from "../../../apps/workbench/src/lib/sourceDiff";

export async function verifyProposalUI() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const previous = (globalThis as any).__command;
  const calls: any[] = [];
  const proposal = {
    id: "candidate-a",
    createdAt: 1,
    documentId: "proposal-A",
    revision: "r1",
    original: "<project>\n<before/>\n</project>",
    xml: "<project>\n<after/>\n</project>",
  };
  const doc: any = {
    id: "proposal-A",
    revision: "r1",
    name: "review.circ",
    main: "main",
    circuits: [{ name: "main", components: [], wires: [] }],
  };
  let applied = 0,
    discarded = 0,
    baseRevision: string | undefined;
  (globalThis as any).__command = async (request: any) => {
    calls.push(request);
    if (request.op === "proposalReview")
      return {
        before: doc,
        after: doc,
        currentRevision: "r1",
        rows: [
          {
            circuit: "main",
            kind: "modified",
            title: "Pin · signal",
            fields: [{ name: "标签", before: "input", after: "output" }],
          },
        ],
      };
    if (request.op === "proposalPreview")
      return { image: null, missing: false, warnings: [] };
    if (request.op === "edit") return { ...doc, revision: "r2" };
    throw new Error("Unexpected request " + request.op);
  };
  const render = async (current = doc) =>
    act(async () => {
      root.render(
        <ProposalReview
          proposal={proposal}
          doc={current}
          circuit="main"
          onClose={() => {}}
          onDiscard={() => {
            discarded++;
          }}
          onDocument={(_doc, base) => {
            baseRevision = base;
            applied++;
          }}
        />,
      );
    });
  const button = (label: string) => {
    const found = [...node.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    assert(found, label + " must be reachable");
    return found;
  };
  try {
    await render();
    assert(node.querySelector("dialog")?.open);
    assert(node.textContent?.includes("Pin · signal"));
    assert(node.textContent?.includes("input"));
    assert(node.textContent?.includes("output"));
    assert.equal(
      calls.find((c) => c.op === "proposalReview").original,
      proposal.original,
    );
    assert(
      !calls.some((c) => c.op === "edit"),
      "Opening review must not apply the proposal",
    );
    await act(async () => button("源码对照").click());
    assert(
      node.querySelector(".source-removed")?.textContent?.includes("<before/>"),
    );
    assert(
      node.querySelector(".source-added")?.textContent?.includes("<after/>"),
    );
    await render({ ...doc, revision: "r-new" });
    assert(button("应用全部改动").disabled);
    assert(node.textContent?.includes("只能查看"));
    await render({ ...doc, id: "proposal-B" });
    assert(
      button("应用全部改动").disabled,
      "A candidate must never target a different document",
    );
    await render();
    await act(async () => button("应用全部改动").click());
    const apply = calls.find((c) => c.op === "edit");
    assert.equal(apply.id, proposal.documentId);
    assert.equal(apply.revision, proposal.revision);
    assert.equal(apply.edit.xml, proposal.xml);
    assert.equal(applied, 1);
    assert.equal(baseRevision, proposal.revision);
    assert.equal(discarded, 1);
    const originalCommand = (globalThis as any).__command;
    (globalThis as any).__command = async (request: any) => {
      const response = await originalCommand(request);
      if (request.op !== "proposalReview") return response;
      const circuits = [
        ...doc.circuits,
        { name: "second", components: [], wires: [] },
      ];
      return {
        ...response,
        before: { ...doc, circuits },
        after: { ...doc, circuits },
        rows: response.rows.map((row: any) => ({ ...row, circuit: "second" })),
      };
    };
    await act(async () =>
      root.render(
        <ProposalReview
          key="changed-other-circuit"
          proposal={proposal}
          doc={doc}
          circuit="main"
          onClose={() => {}}
          onDiscard={() => {}}
          onDocument={() => {}}
        />,
      ),
    );
    assert.equal(
      node.querySelector<HTMLSelectElement>(".proposal-circuit select")?.value,
      "second",
      "Review should reveal the changed circuit when the current circuit has no changes",
    );
    assert(node.textContent?.includes("Pin · signal"));
    assert(!node.textContent?.includes("这份电路没有结构改动"));
    (globalThis as any).__command = originalCommand;
    const lines = sourceDiff("a\nb\nc\nd", "a\nx\nc\ny\nd");
    assert.deepEqual(
      lines.filter((l) => l.after !== undefined).map((l) => l.after),
      ["a", "x", "c", "y", "d"],
    );
    assert.deepEqual(
      lines.filter((l) => l.before !== undefined).map((l) => l.before),
      ["a", "b", "c", "d"],
    );
    assert(
      lines.some((l) => l.before === "c" && !l.changed),
      "Separate edits retain their unchanged context",
    );
    console.log(
      "Verified proposal review before application, source comparison, document/revision guards, and exact original/candidate bindings.",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    (globalThis as any).__command = previous;
  }
}
