import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DocumentHistory } from "../../../apps/workbench/src/components/DocumentHistory";
import { HistoryReview } from "../../../apps/workbench/src/components/ProposalReview";
import { useProposals } from "../../../apps/workbench/src/lib/useProposals";
import { Workbench } from "./workbench";

export async function verifyDocumentHistory() {
  const globals = globalThis as any,
    previous = { command: globals.__command, subscribe: globals.__subscribe };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const calls: any[] = [],
    errors: any[] = [],
    documents: any[] = [],
    located: any[] = [];
  const doc: any = {
    id: "history-doc",
    revision: "r-current",
    main: "main",
    name: "history.circ",
    dirty: true,
    path: null,
    circuits: [{ name: "main", components: [], wires: [] }],
  };
  const entry: any = {
    id: "entry-old",
    kind: "edit",
    title: "修改输入标签",
    createdAt: 1234,
    beforeRevision: "r-open",
    revision: "r-old",
    baseline: false,
    saved: true,
  };
  const baseline = {
    ...entry,
    id: "entry-open",
    kind: "open",
    title: "打开工程",
    revision: "r-open",
    beforeRevision: null,
    baseline: true,
    saved: false,
  };
  const object = {
    id: "c0",
    factory: "Pin",
    label: "input",
    location: { x: 100, y: 100 },
    bounds: { x: 90, y: 90, width: 20, height: 20 },
  };
  const row = {
    id: "component-0",
    circuit: "main",
    category: "components",
    kind: "modified",
    title: "Pin · input",
    fields: [{ name: "标签", before: "old", after: "input" }],
    beforeObjects: ["c0"],
    afterObjects: ["c0"],
  };
  const globalRow = {
    id: "settings",
    circuit: null,
    category: "settings",
    kind: "modified",
    title: "主电路",
    fields: [{ name: "main", before: "other", after: "main" }],
    beforeObjects: [],
    afterObjects: [],
  };
  const evidence = {
    id: "check-old",
    documentId: doc.id,
    revision: "r-old",
    baseRevision: "r-open",
    circuit: "main",
    createdAt: 1234,
    kind: "vectors",
    runtime: { native: "fixture-runtime" },
    dependenciesVerified: false,
    result: {
      passed: 0,
      failed: 1,
      unchecked: 0,
      rows: [
        {
          index: 0,
          inputs: { A: 1 },
          expected: { Y: 1 },
          outputs: { Y: { bits: "x", value: null } },
          oscillating: false,
          status: "failed",
        },
      ],
    },
  };
  const proposal = {
    id: "proposal-old",
    createdAt: 2,
    documentId: doc.id,
    revision: doc.revision,
    original: "<before/>",
    xml: "<after/>",
  };
  let persisted = [proposal],
    restoreFailure = true,
    latePreview: ((value: any) => void) | undefined,
    delayPreview = false,
    evidenceWarning: string | null = null,
    unavailableDetail = false;
  const listeners = new Set<any>();
  globals.__subscribe = (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  globals.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "agent" && request.method === "proposals")
      return persisted;
    if (request.op === "agent" && request.method === "discardProposal") {
      persisted = persisted.filter((item) => item.id !== request.args.id);
      return { ok: true };
    }
    if (request.op === "historyList")
      return {
        entries: [
          {
            ...entry,
            id: "entry-current",
            revision: doc.revision,
            saved: false,
          },
          entry,
          baseline,
        ],
        currentRevision: doc.revision,
        savedRevision: entry.revision,
      };
    if (request.op === "historyReview")
      return {
        entry,
        mode: request.mode,
        original: request.mode === "current" ? "<history/>" : "<before/>",
        xml: request.mode === "current" ? "<current/>" : "<history/>",
        evidence: evidenceWarning ? [] : [evidence],
        review: {
          before: {
            ...doc,
            revision: request.mode === "current" ? "r-old" : "r-open",
          },
          after: {
            ...doc,
            revision: request.mode === "current" ? doc.revision : "r-old",
          },
          currentRevision: doc.revision,
          rows: [row, globalRow],
          evidenceWarning,
          evidence: evidenceWarning ? [] : [evidence],
        },
      };
    if (request.op === "historyDetail")
      return {
        circuit: "main",
        rows: unavailableDetail ? [] : [row],
        connectivity: {
          status: unavailableDetail ? "unavailable" : "partial",
          unknownPorts: 2,
          matchedComponents: 1,
          rows: [
            {
              id: "connection-0",
              before: [
                [
                  {
                    componentId: "c0",
                    label: "input",
                    port: 0,
                    portName: "output",
                    bits: [0],
                    location: { x: 100, y: 100 },
                  },
                ],
              ],
              after: [],
            },
          ],
        },
        parents: {
          before: [{ circuit: "parent", count: 1 }],
          after: [{ circuit: "parent", count: 2 }],
        },
        objects: { before: [object], after: [object] },
        errors: [],
      };
    if (request.op === "historyPreview") {
      if (delayPreview)
        return new Promise((resolve) => {
          latePreview = resolve;
        });
      return {
        image: "data:image/svg+xml;base64,PHN2Zy8+",
        missing: false,
        warnings: [],
        bounds: { x: 0, y: 0, width: 300, height: 250 },
      };
    }
    if (request.op === "historyRestore") {
      if (restoreFailure) throw new Error("恢复被后续修改拒绝");
      return { ...doc, revision: entry.revision };
    }
    throw new Error(`Unexpected history UI request ${request.op}`);
  };
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const button = (label: string) => {
    const found = [...node.querySelectorAll("button")].find(
      (el) => el.textContent?.trim() === label,
    );
    assert(found, `Missing ${label}`);
    return found;
  };
  const click = async (el: Element) => {
    await act(async () =>
      el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await settle();
  };
  const choose = async (el: HTMLSelectElement, value: string) => {
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
  const common = {
    doc,
    circuit: "main",
    onClose: () => {},
    onDocument: (next: any, base?: string) => documents.push({ next, base }),
    onLocate: (target: any) => located.push(target),
  };
  const mirrorValues: any[] = [];
  function Mirror() {
    const state = useProposals(doc.id, 0, (error) => errors.push(error));
    mirrorValues.push(state.proposals);
    return <output data-mirror>{state.proposals.length}</output>;
  }
  try {
    await act(async () =>
      root.render(
        <Workbench>
          <DocumentHistory
            {...common}
            visible
            onError={(e) => errors.push(e)}
          />
          <Mirror />
        </Workbench>,
      ),
    );
    await settle();
    assert.equal(node.querySelector("[data-mirror]")?.textContent, "1");
    await click(button("放弃"));
    assert.equal(
      node.querySelector("[data-mirror]")?.textContent,
      "0",
      "Discarded candidate must disappear from simultaneous chat/change consumers",
    );
    await click(button("历史"));
    assert(node.textContent?.includes("已保存"));
    assert(node.textContent?.includes("打开时"));
    assert(
      !calls.some((call) => call.op === "historyRestore" || call.op === "edit"),
      "Opening immutable history never edits the document",
    );
    await act(async () =>
      root.render(<HistoryReview key="review" {...common} entry={entry} />),
    );
    await settle();
    assert(node.textContent?.includes("连接未完全核对"));
    assert(node.textContent?.includes("2 个端口未核对"));
    assert(node.textContent?.includes("parent：1 → 2 处"));
    assert(
      node.textContent?.includes("主电路"),
      "Native detail must not hide project-wide settings changes",
    );
    await click(
      [...node.querySelectorAll("summary")].find((el) =>
        el.textContent?.includes("Pin · input"),
      )!,
    );
    assert(node.querySelector("svg.comparison-picture rect"));
    assert(
      button("在当前工程中定位").disabled,
      "A historical object with no current-revision match cannot be located as if current",
    );
    await click(
      [...node.querySelectorAll("button")].find((el) =>
        el.textContent?.startsWith("信号连接 "),
      )!,
    );
    assert(
      node.textContent?.includes("input · output [0]"),
      "Connection comparison exposes endpoints, not unstable cross-version net ids",
    );
    assert(!node.textContent?.includes("Pin · input"));
    await click(button("源码对照"));
    assert(
      node.querySelector(".source-removed")?.textContent?.includes("<before/>"),
    );
    assert(
      node.querySelector(".source-added")?.textContent?.includes("<history/>"),
    );
    await choose(node.querySelector('[aria-label="历史对照方式"]')!, "current");
    assert(
      node
        .querySelector(".source-removed")
        ?.textContent?.includes("<history/>"),
    );
    assert(
      node.querySelector(".source-added")?.textContent?.includes("<current/>"),
    );
    await click(button("改动与预览"));
    await click(
      [...node.querySelectorAll("summary")].find((el) =>
        el.textContent?.includes("Pin · input"),
      )!,
    );
    assert(!button("在当前工程中定位").disabled);
    await click(button("在当前工程中定位"));
    assert.equal(located[0].revision, doc.revision);
    assert.equal(located[0].object.id, "c0");
    await click(
      [...node.querySelectorAll("button")].find((el) =>
        el.textContent?.startsWith("运行记录"),
      )!,
    );
    assert(node.textContent?.includes("历史版本 · 输入输出检查"));
    assert(
      node.textContent?.includes("Y = x"),
      "Unknown native values must not become zero",
    );
    assert(node.textContent?.includes("外部依赖未完全核验"));
    await act(async () =>
      root.render(
        <HistoryReview
          key="review"
          {...common}
          doc={{ ...doc, revision: "r-newer" }}
          entry={entry}
        />,
      ),
    );
    assert(button("恢复此版本").disabled);
    assert(node.textContent?.includes("只能查看"));
    await act(async () =>
      root.render(<HistoryReview key="review" {...common} entry={entry} />),
    );
    await click(button("恢复此版本"));
    assert(node.textContent?.includes("恢复被后续修改拒绝"));
    assert.equal(documents.length, 0);
    restoreFailure = false;
    await click(button("恢复此版本"));
    assert.equal(documents.length, 1);
    assert.equal(documents[0].base, doc.revision);
    assert.deepEqual(
      calls.filter((call) => call.op === "historyRestore").at(-1),
      {
        op: "historyRestore",
        id: doc.id,
        revision: doc.revision,
        entry: entry.id,
      },
    );
    delayPreview = true;
    await act(async () =>
      root.render(<HistoryReview key="delayed" {...common} entry={entry} />),
    );
    await settle();
    assert(latePreview);
    const respond = latePreview;
    delayPreview = false;
    await act(async () =>
      root.render(
        <HistoryReview
          key="next"
          {...common}
          entry={{ ...entry, id: "another-entry" }}
        />,
      ),
    );
    await settle();
    await act(async () =>
      respond!({
        image: "data:late-entry",
        missing: false,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      }),
    );
    assert(
      !node.innerHTML.includes("data:late-entry"),
      "Late preview cannot replace another history entry's picture",
    );
    unavailableDetail = true;
    await act(async () =>
      root.render(
        <HistoryReview key="unavailable-native" {...common} entry={entry} />,
      ),
    );
    await settle();
    assert(
      node.textContent?.includes("Pin · input"),
      "Unavailable native replay cannot erase structural comparison rows",
    );
    assert(node.textContent?.includes("连接对照暂不可用"));
    evidenceWarning = "原生验证记录内容已改变，原文件保留";
    await act(async () =>
      root.render(
        <HistoryReview key="damaged-record" {...common} entry={entry} />,
      ),
    );
    await settle();
    await click(
      [...node.querySelectorAll("button")].find((el) =>
        el.textContent?.startsWith("运行记录"),
      )!,
    );
    assert(node.textContent?.includes(evidenceWarning));
    assert(
      !node.textContent?.includes("没有留存的原生验证记录"),
      "Damaged evidence is not an empty result",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: immutable history and saved/open baselines, comparison polarity, structure/connection categories, partial native evidence, exact restore binding, stale read-only state, late-preview isolation and candidate discard synchronization",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    globals.__command = previous.command;
    globals.__subscribe = previous.subscribe;
  }
}
