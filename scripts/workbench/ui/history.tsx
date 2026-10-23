import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DocumentHistory } from "../../../apps/workbench/src/history/DocumentHistory";
import { Workbench } from "./workbench";

export async function verifyDocumentHistory() {
  const globals = globalThis as any,
    previous = { command: globals.__command, subscribe: globals.__subscribe };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const calls: any[] = [],
    documents: any[] = [];
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
  const listeners = new Set<any>();
  globals.__subscribe = (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  globals.__command = async (request: any) => {
    calls.push(request);
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
    throw new Error(`Unexpected history UI request ${request.op}`);
  };
  const settle = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await act(async () =>
      root.render(
        <Workbench>
          <DocumentHistory
            doc={doc}
            circuit="main"
            visible
            onDocument={(next: any, base?: string) =>
              documents.push({ next, base })
            }
          />
        </Workbench>,
      ),
    );
    await settle();
    assert(node.textContent?.includes("已保存"));
    assert(node.textContent?.includes("打开时"));
    assert(
      !calls.some((call) => call.op === "historyRestore" || call.op === "edit"),
      "Opening immutable history never edits the document",
    );
    console.log("PASS: immutable history list with saved/open baselines");
  } finally {
    await act(async () => root.unmount());
    node.remove();
    globals.__command = previous.command;
    globals.__subscribe = previous.subscribe;
  }
}
