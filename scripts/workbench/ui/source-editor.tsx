import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { EditorView } from "@codemirror/view";
import { undo, redo, deleteCharForward } from "@codemirror/commands";
import { getChunks } from "@codemirror/merge";
import { openSearchPanel, closeSearchPanel } from "@codemirror/search";
import {
  XmlEditor,
  XmlDiff,
} from "../../../apps/workbench/src/shared/CodeEditor";
import { SourceDialog } from "../../../apps/workbench/src/editor/SourceDialog";
import { HistoryReview } from "../../../apps/workbench/src/history/HistoryReview";
import { createWorkbench } from "../../../apps/workbench/src/app/createWorkbench";
import { WorkbenchProvider } from "../../../apps/workbench/src/app/provider";
import { pickOption } from "./workbench";

const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

export async function verifySourceEditor() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const previous = (globalThis as any).__command;
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  const render = async (element: ReactNode) => {
    await act(async () => root.render(<Theme>{element}</Theme>));
    await settle();
  };
  const editor = (scope: ParentNode = node) => {
    const dom = scope.querySelector<HTMLElement>(".cm-editor");
    assert(dom, "CodeMirror mounted");
    return EditorView.findFromDOM(dom)!;
  };
  const click = async (text: string, scope: ParentNode = document) => {
    const target = [...scope.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    assert(target, `button ${text}`);
    await act(async () => target.click());
    await settle();
  };
  const crlf = '<project>\r\n  <circuit name="main"/>\r\n</project>\r\n';
  try {
    let draft = crlf;
    const onChange = (text: string) => {
      draft = text;
    };
    await render(<XmlEditor value={draft} onChange={onChange} label="XML" />);
    const view = editor();
    assert.equal(
      view.state.sliceDoc(),
      crlf,
      "opening preserves CRLF and final newline",
    );
    await act(async () =>
      view.dispatch({
        changes: { from: 10, insert: "<!--draft-->" },
        userEvent: "input",
      }),
    );
    assert.match(draft, /<!--draft-->/);
    assert(draft.endsWith("\r\n"));
    await render(<XmlEditor value={draft} onChange={onChange} label="XML" />);
    assert.equal(
      editor(),
      view,
      "controlled draft echo preserves the editor instance",
    );
    await act(async () => {
      undo(view);
    });
    assert.equal(draft, crlf);
    await act(async () => {
      redo(view);
    });
    assert.match(draft, /<!--draft-->/);
    await render(
      <XmlEditor value={draft} onChange={onChange} label="XML" readOnly />,
    );
    assert.equal(editor(), view);
    assert.equal(view.state.readOnly, true);
    assert.equal(view.contentDOM.getAttribute("contenteditable"), "false");
    assert.equal(deleteCharForward(view), false);
    await act(async () => {
      openSearchPanel(view);
    });
    assert(node.querySelector('input[aria-label="查找"]'));
    assert(
      !node.querySelector('input[aria-label="替换"]'),
      "read-only search cannot replace",
    );
    await act(async () => {
      closeSearchPanel(view);
    });

    const original =
      "<project>\n" +
      Array.from(
        { length: 4000 },
        (_, i) => `  <comp name="Pin" loc="(${i * 10},20)" label="P${i}"/>`,
      ).join("\n") +
      "\n</project>\n";
    const revised = original
      .replace('label="P10"', 'label="Changed10"')
      .replace('label="P2000"', 'label="Changed2000"')
      .replace('label="P3990"', 'label="Changed3990"');
    await render(
      <XmlDiff
        original={original}
        revised={revised}
        beforeLabel="Before"
        afterLabel="After"
      />,
    );
    const left = editor(),
      right = EditorView.findFromDOM(
        node.querySelectorAll<HTMLElement>(".cm-editor")[1],
      )!;
    const chunks = getChunks(left.state)!.chunks;
    assert.equal(chunks.length, 3, "distant XML edits remain separate chunks");
    assert(chunks.every((chunk) => chunk.precise));
    assert.equal(left.state.sliceDoc(), original);
    assert.equal(right.state.sliceDoc(), revised);
    for (const pane of [left, right]) {
      assert(pane.state.readOnly);
      assert.equal(pane.contentDOM.getAttribute("contenteditable"), "false");
      assert.equal(deleteCharForward(pane), false);
    }
    assert.equal(node.querySelector(".cm-merge-revert"), null);
    assert(node.querySelector(".cm-collapsedLines"));
    await render(
      <XmlDiff
        original={original}
        revised={revised}
        beforeLabel="Before"
        afterLabel="After"
        allLines
      />,
    );
    assert.equal(
      editor(),
      left,
      "expanding unchanged lines preserves merge editors",
    );
    assert.equal(node.querySelector(".cm-collapsedLines"), null);
    const minified = original.replaceAll("\n", "");
    await render(
      <XmlDiff
        original={minified}
        revised={minified.replace('label="P2000"', 'label="MinifiedChange"')}
        beforeLabel="Before"
        afterLabel="After"
      />,
    );
    assert.equal(getChunks(editor().state)!.chunks.length, 1);

    const rows = original.split("\n");
    const blocks = original
      .replace(rows.slice(40, 80).join("\n") + "\n", "")
      .replace(
        rows[3000],
        Array.from(
          { length: 30 },
          (_, i) => `  <comp label="INSERT${i}"/>`,
        ).join("\n") +
          "\n" +
          rows[3000],
      );
    await render(
      <XmlDiff
        original={original}
        revised={blocks}
        beforeLabel="Before"
        afterLabel="After"
      />,
    );
    assert.equal(
      getChunks(editor().state)!.chunks.length,
      2,
      "block insertion and deletion remain separate",
    );

    const workbench = createWorkbench();
    const doc: any = {
      id: "A",
      name: "A.circ",
      revision: "r1",
      main: "main",
      path: null,
      dirty: false,
      canUndo: false,
      canRedo: false,
      circuits: [{ name: "main", components: [], wires: [], attributes: {} }],
    };
    workbench.stores.documents.getState().setDocs([doc]);
    workbench.stores.documents.getState().setActive(doc.id);
    const source = {
      id: doc.id,
      revision: doc.revision,
      name: doc.name,
      circuit: "main",
      original: crlf,
      xml: crlf,
    };
    workbench.stores.editor.getState().setSource(source);
    let apply = deferred();
    const calls: any[] = [];
    (globalThis as any).__command = (request: any) => {
      calls.push(request);
      return apply.promise;
    };
    await render(
      <WorkbenchProvider value={workbench}>
        <SourceDialog />
      </WorkbenchProvider>,
    );
    const draftView = editor();
    await act(async () =>
      draftView.dispatch({ changes: { from: 0, insert: "<!--edit-->\r\n" } }),
    );
    await settle();
    const edited = workbench.stores.editor.getState().source!.xml;
    await click("取消", node);
    assert(document.querySelector('[role="alertdialog"]'));
    await click("取消", document.querySelector('[role="alertdialog"]')!);
    assert.equal(editor(), draftView);
    assert.equal(workbench.stores.editor.getState().source!.xml, edited);
    assert.equal(
      calls.length,
      0,
      "typing and cancelling confirmation never apply XML",
    );
    await click("应用修改", node);
    assert.equal(calls.at(-1).edit.xml, edited);
    assert.equal(calls.at(-1).revision, "r1");
    assert(editor().state.readOnly, "pending apply freezes editing");
    await act(async () => {
      apply.reject(new Error("Invalid circuit"));
      await apply.promise.catch(() => {});
    });
    await settle();
    assert.match(node.textContent!, /Invalid circuit/);
    assert.equal(editor().state.sliceDoc(), edited);
    await act(async () =>
      workbench.stores.documents
        .getState()
        .setDocs([{ ...doc, revision: "r2" }]),
    );
    await settle();
    assert(editor().state.readOnly);
    assert(
      [...node.querySelectorAll("button")].find(
        (b) => b.textContent === "应用修改",
      )!.disabled,
    );
    assert.equal(
      editor().state.sliceDoc(),
      edited,
      "stale revision keeps the unapplied draft",
    );
    await click("取消", node);
    await click("放弃修改", document.querySelector('[role="alertdialog"]')!);
    assert.equal(workbench.stores.editor.getState().source, null);

    // A successful old apply must not close a later source dialog.
    await act(async () => {
      workbench.stores.documents.getState().setDocs([doc]);
      workbench.stores.editor.getState().setSource(source);
    });
    apply = deferred();
    await act(async () => workbench.actions.editor.applySource(source));
    const later = {
      ...source,
      id: "B",
      name: "B.circ",
      xml: '<project name="B"/>',
    };
    await act(async () => workbench.stores.editor.getState().setSource(later));
    await act(async () => {
      apply.resolve({
        change: {
          ...doc,
          revision: "r2",
          base: "r1",
          order: ["main"],
          circuits: [],
        },
      });
      await apply.promise;
    });
    await settle();
    assert.equal(workbench.stores.editor.getState().source, later);
    const currentDraft = { ...source, xml: edited };
    await act(async () => {
      workbench.stores.documents.getState().setDocs([doc]);
      workbench.stores.editor.getState().setSource(currentDraft);
    });
    apply = deferred();
    await click("应用修改", node);
    await act(async () => {
      apply.resolve({
        change: {
          ...doc,
          revision: "r2",
          base: "r1",
          order: ["main"],
          circuits: [],
        },
      });
      await apply.promise;
    });
    await settle();
    assert.equal(
      workbench.stores.editor.getState().source,
      null,
      "acknowledged current apply closes its draft",
    );
    assert.equal(workbench.stores.documents.getState().docs[0].revision, "r2");

    const entry: any = {
      id: "old",
      title: "Edit",
      createdAt: 1234,
      beforeRevision: "before",
      revision: "old",
    };
    const reads: { request: any; gate: ReturnType<typeof deferred> }[] = [];
    const previews: { request: any; gate: ReturnType<typeof deferred> }[] = [];
    (globalThis as any).__command = (request: any) => {
      const item = { request, gate: deferred() };
      (request.op === "historyReview" ? reads : previews).push(item);
      return item.gate.promise;
    };
    const history = (current = doc) => (
      <HistoryReview
        entry={entry}
        doc={current}
        circuit="main"
        onClose={() => {}}
        onDocument={() => {}}
      />
    );
    await render(history());
    await pickOption("对照方式", "与当前工程比较");
    await act(async () => {
      reads[1].gate.resolve({
        entry,
        mode: "current",
        original: crlf,
        xml: '<project>\n<circuit name="main"/>\n</project>',
      });
    });
    await settle();
    await act(async () => {
      reads[0].gate.resolve({
        entry,
        mode: "change",
        original: "wrong-old",
        xml: "wrong-new",
      });
    });
    await settle();
    const details = node.querySelector<HTMLDetailsElement>(
      ".history-review-source",
    )!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await settle();
    assert.equal(
      editor().state.sliceDoc(),
      crlf,
      "late history mode response is discarded",
    );
    await click("历史版本", node);
    await act(async () => {
      previews.at(-1)!.gate.resolve({ image: "data:image/svg+xml,before" });
    });
    await settle();
    await act(async () => {
      previews[0].gate.resolve({ image: "data:image/svg+xml,stale" });
    });
    await settle();
    assert.equal(
      node.querySelector(".history-review-image img")!.getAttribute("src"),
      "data:image/svg+xml,before",
    );
    await render(history({ ...doc, revision: "r-later" }));
    assert(
      [...node.querySelectorAll("button")].find(
        (b) => b.textContent === "恢复到这个版本",
      )!.disabled,
    );
    assert.equal(editor().state.sliceDoc(), crlf);
    console.log(
      "PASS: XML drafts preserve line endings/undo/apply boundaries; immutable merge handles distant/minified edits and stale reads",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    (globalThis as any).__command = previous;
  }
}
