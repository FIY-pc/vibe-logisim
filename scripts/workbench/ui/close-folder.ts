import assert from "node:assert/strict";
import { createWorkbench } from "../../../apps/workbench/src/app/createWorkbench";
import type { Document } from "../../../apps/workbench/src/shared/types";

export async function verifyCloseFolder() {
  const g = globalThis as any;
  const previous = g.__command;
  const { stores, actions } = createWorkbench();
  const folder = { id: "folder-close", path: "/project", name: "project" };
  const calls: any[] = [];
  let docs: Document[] = [
    {
      id: "draft",
      name: "draft.circ",
      path: "/project/draft.circ",
      revision: "r1",
      paletteIdentity: "p1",
      dirty: true,
      canUndo: true,
      canRedo: false,
      main: "main",
      circuits: [],
      libraries: [],
    },
  ];
  const reset = () => {
    stores.documents.getState().setDocs(docs);
    stores.documents.getState().setActive("draft");
    stores.files.getState().setFolder(folder);
    stores.files.getState().setNewFilePrompt(true);
    stores.notices.getState().setDecision(null);
    calls.length = 0;
  };
  let failSave = false,
    failClose = false;
  try {
    reset();
    g.__command = async () => {
      throw new Error("stop failed");
    };
    await actions.workspace.closeFolder();
    assert.equal(stores.files.getState().folder, folder);
    assert.equal(stores.documents.getState().docs.length, 1);
    g.__command = async (request: any) => {
      calls.push(request);
      if (request.op === "status")
        return { documents: docs, active: "draft", folder };
      if (request.op === "save") {
        if (failSave) throw new Error("save failed");
        docs = docs.map((d) => ({ ...d, dirty: false, revision: "saved" }));
        return docs[0];
      }
      if (request.op === "folderClose" && failClose)
        throw new Error("close failed");
      return {};
    };
    // Cancellation is before the host closes any document.
    await actions.workspace.closeFolder();
    assert.equal(calls[0].method, "stop");
    assert(stores.notices.getState().decision);
    stores.notices.getState().setDecision(null);
    assert.equal(stores.files.getState().folder, folder);
    assert.equal(stores.documents.getState().docs[0].dirty, true);
    assert(!calls.some((c) => c.op === "close" || c.op === "folderClose"));
    // Save errors keep every tab and the decision; a retry saves then closes.
    await actions.workspace.closeFolder();
    const save = stores.notices.getState().decision!.actions[1].run;
    failSave = true;
    await assert.rejects(save, /save failed/);
    assert.equal(stores.files.getState().folder, folder);
    assert.equal(stores.documents.getState().docs.length, 1);
    failSave = false;
    await save();
    assert.deepEqual(calls.at(-1), {
      op: "folderClose",
      folder_id: folder.id,
      documents: { draft: "saved" },
      discard: false,
    });
    assert.equal(stores.files.getState().folder, null);
    assert.deepEqual(stores.documents.getState().docs, []);
    assert.equal(stores.documents.getState().active, null);
    assert.equal(stores.files.getState().newFilePrompt, false);
    // Multiple dirty documents are discarded together, never one at a time.
    docs = [
      { ...docs[0], dirty: true },
      { ...docs[0], id: "untitled", path: null, dirty: true },
    ];
    reset();
    await actions.workspace.closeFolder();
    const discard = stores.notices.getState().decision!.actions[0].run;
    failClose = true;
    await assert.rejects(discard, /close failed/);
    assert.equal(stores.documents.getState().docs.length, 2);
    assert.equal(stores.files.getState().folder, folder);
    failClose = false;
    await discard();
    assert.deepEqual(calls.at(-1), {
      op: "folderClose",
      folder_id: folder.id,
      documents: { draft: "saved", untitled: "saved" },
      discard: true,
    });
    assert.deepEqual(stores.documents.getState().docs, []);
    const before = calls.length;
    await actions.workspace.closeFolder();
    assert.equal(calls.length, before);
  } finally {
    g.__command = previous;
  }
}
