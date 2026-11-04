import assert from "node:assert/strict";
import { createWorkbench } from "../../../apps/workbench/src/app/createWorkbench";

export async function verifyCloseFolder() {
  const g = globalThis as any;
  const previous = g.__command;
  const { stores, actions } = createWorkbench();
  const folder = { id: "folder-close", path: "/project", name: "project" };
  const calls: unknown[] = [];
  stores.documents.getState().setDocs([
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
  ]);
  stores.documents.getState().setActive("draft");
  const docs = stores.documents.getState().docs;
  stores.files.getState().setFolder(folder);
  stores.files.getState().setNewFilePrompt(true);
  try {
    g.__command = async () => {
      throw new Error("close failed");
    };
    await actions.workspace.closeFolder();
    assert.equal(stores.files.getState().folder, folder);
    g.__command = async (request: unknown) => {
      calls.push(request);
      return {};
    };
    await actions.workspace.closeFolder();
    assert.deepEqual(calls, [{ op: "folderClose", folder_id: folder.id }]);
    assert.equal(stores.files.getState().folder, null);
    assert.equal(stores.files.getState().newFilePrompt, false);
    assert.equal(stores.documents.getState().docs, docs);
    assert.equal(stores.documents.getState().active, "draft");
    assert.equal(docs[0].dirty, true);
    await actions.workspace.closeFolder();
    assert.equal(calls.length, 1);
  } finally {
    g.__command = previous;
  }
}
