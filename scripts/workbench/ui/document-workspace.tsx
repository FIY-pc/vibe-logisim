import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { createWorkbench } from "../../../apps/workbench/src/app/createWorkbench";
import { WorkbenchProvider } from "../../../apps/workbench/src/app/provider";
import { handleShortcuts } from "../../../apps/workbench/src/app/keyboard";
import { DocumentWorkspace } from "../../../apps/workbench/src/workspace/DocumentWorkspace";

export async function verifyDocumentWorkspace() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const workbench = createWorkbench();
  const { stores, actions } = workbench;
  const doc: any = {
    id: "document-tabs",
    name: "logic.circ",
    main: "main",
    revision: "r1",
    dirty: true,
    canUndo: false,
    canRedo: false,
    circuits: ["main", "ALU"].map((name) => ({
      name,
      components: [],
      wires: [],
      attributes: {},
    })),
  };
  const material = { name: "notes.md", path: "notes.md", text: "notes" };
  const second = {
    name: "reference.txt",
    path: "reference.txt",
    text: "reference",
  };
  stores.documents.getState().setDocs([doc]);
  stores.documents.getState().setActive(doc.id);
  stores.editor.getState().setCircuitName("ALU");
  let historyCalls = 0;
  const history = actions.editor.history;
  actions.editor.history = (...args) => {
    historyCalls++;
    return history(...args);
  };
  const stop = handleShortcuts(stores, actions);
  const click = async (label: string) => {
    const button = node.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    assert(button, label);
    await act(async () => button.click());
  };
  const tab = (name: string) => {
    const result = [
      ...node.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((item) => item.title === name);
    assert(result, name);
    return result;
  };
  const choose = async (name: string) => {
    await act(async () => {
      tab(name).focus();
      tab(name).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  };
  const panels = () => [
    ...node.querySelectorAll<HTMLElement>('[role="tabpanel"]'),
  ];
  try {
    await act(async () =>
      root.render(
        <WorkbenchProvider value={workbench}>
          <DocumentWorkspace>
            <main>circuit content</main>
          </DocumentWorkspace>
        </WorkbenchProvider>,
      ),
    );
    await act(async () => stores.files.getState().setPreview(material));
    assert.equal(tab("notes.md").getAttribute("aria-selected"), "true");
    assert.equal(panels().filter((item) => !item.hidden).length, 1);
    const reader = node.querySelector(".document-reader");
    assert(reader);
    await choose("logic.circ");
    assert.equal(
      stores.editor.getState().circuitName,
      "ALU",
      "returning to a file retains its selected subcircuit",
    );
    assert.equal(
      node.querySelector(".document-reader"),
      reader,
      "switching to the circuit keeps the reader mounted",
    );
    await choose("notes.md");
    const otherDoc = { ...doc, id: "other-document", name: "other.circ" };
    await act(async () => {
      stores.documents.getState().setDocs([doc, otherDoc]);
      stores.documents.getState().setActive(otherDoc.id);
    });
    await act(async () => {
      const quote = [
        ...node.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "引用文件");
      assert(quote);
      quote.click();
    });
    assert.equal(
      stores.conversation.getState().quotation?.documentId,
      otherDoc.id,
      "a retained reader sends its quotation to the newly active document",
    );
    await act(async () => {
      stores.documents.getState().setActive(doc.id);
      stores.documents.getState().setDocs([doc]);
    });
    await click("并排查看电路与资料");
    assert.equal(panels().filter((item) => !item.hidden).length, 2);
    await act(async () => {
      stores.shell.getState().setSide("rail", false);
      window.dispatchEvent(new Event("resize"));
    });
    assert.equal(stores.files.getState().readerMode, "split");
    await click("单栏查看");
    assert.equal(panels().filter((item) => !item.hidden).length, 1);
    const keyboard = async (key: string) =>
      act(async () =>
        tab("notes.md").dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    await keyboard("z");
    assert.equal(
      historyCalls,
      0,
      "material commands do not act on the hidden circuit",
    );
    await keyboard("w");
    assert.equal(stores.files.getState().preview, null);
    assert.equal(
      stores.documents.getState().docs.length,
      1,
      "closing material does not close the circuit",
    );
    await act(async () => {
      stores.files.getState().setPreview(material);
      stores.files.getState().setPreview(second);
      stores.files.getState().setReaderMode("split");
    });
    await click("关闭文档 reference.txt");
    assert.equal(stores.files.getState().preview?.name, "notes.md");
    await click("关闭文档 notes.md");
    assert.equal(stores.files.getState().readerMode, "single");
    await click("关闭文档 logic.circ");
    assert.equal(
      stores.notices.getState().decision?.title,
      "关闭 logic.circ？",
      "dirty circuit close keeps the existing save decision",
    );
    assert.equal(stores.documents.getState().docs.length, 1);
    console.log(
      "PASS: peer document tabs retain the current subcircuit and reader; explicit split and close respect document state",
    );
  } finally {
    stop();
    await act(async () => root.unmount());
    node.remove();
  }
}
