import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
} from "node:fs/promises";
import path from "node:path";
export async function verifyFileHistory(
  command: (request: Record<string, unknown>) => Promise<any>,
  directory: string,
  project: string,
  folderId: string,
  source: string,
) {
  const call = (request: Record<string, unknown>) =>
    command({ folder_id: folderId, ...request });
  const incoming = path.join(directory, "incoming");
  await mkdir(path.join(incoming, "bundle/empty"), { recursive: true });
  await writeFile(path.join(incoming, "bundle/note.txt"), "from outside");
  const prepare = (sources: string[], destination = "") =>
    call({ op: "folderImportPrepare", sources, destination });
  const apply = (plan: any, action = "keepBoth") =>
    call({
      op: "folderImportApply",
      plan_id: plan.id,
      choices: plan.items.map((item: any) => ({ index: item.index, action })),
    });
  const latest = async () => (await call({ op: "folderHistory" }))[0];
  let plan = await prepare([path.join(incoming, "bundle")]);
  assert.equal(plan.items[0].conflict, false);
  assert.deepEqual((await apply(plan)).imported, ["bundle"]);
  assert.equal(
    await readFile(path.join(project, "bundle/note.txt"), "utf8"),
    "from outside",
  );
  const imported = await latest();
  assert.equal(imported.title, "导入文件");
  assert(imported.files.some((f: any) => f.path === "bundle/empty"));
  const detail = await call({
    op: "folderHistoryDetail",
    id: imported.id,
    path: "bundle/note.txt",
  });
  assert.equal(detail.before, null);
  assert.equal(detail.after.text, "from outside");
  await writeFile(
    path.join(project, "bundle/new-edit.txt"),
    "retain later edit",
  );
  await assert.rejects(
    call({ op: "folderHistoryUndo", id: imported.id }),
    /后续新增|又有改动/,
  );
  assert.equal(
    await readFile(path.join(project, "bundle/note.txt"), "utf8"),
    "from outside",
  );
  await rm(path.join(project, "bundle/new-edit.txt"));
  // Ignored paths also prevent a recursive undo from deleting new contents.
  await mkdir(path.join(project, "bundle/.git"));
  await assert.rejects(
    call({ op: "folderHistoryUndo", id: imported.id }),
    /后续新增/,
  );
  await rm(path.join(project, "bundle/.git"), { recursive: true });
  await call({ op: "folderHistoryUndo", id: imported.id });
  await assert.rejects(access(path.join(project, "bundle")));

  const input = path.join(incoming, "existing.txt");
  await writeFile(input, "replacement");
  plan = await prepare([input]);
  assert(plan.items[0].conflict);
  assert(plan.items[0].replaceable);
  assert.deepEqual((await apply(plan)).imported, ["existing (2).txt"]);
  assert.equal(
    await readFile(path.join(project, "existing.txt"), "utf8"),
    "retain target",
  );
  plan = await prepare([input]);
  await apply(plan, "skip");
  assert.equal(
    await readFile(path.join(project, "existing.txt"), "utf8"),
    "retain target",
  );
  plan = await prepare([input]);
  await writeFile(path.join(project, "existing.txt"), "new user edit");
  await assert.rejects(apply(plan, "replace"), /确认后发生改变/);
  await call({ op: "folderImportCancel", plan_id: plan.id });
  assert.equal(
    await readFile(path.join(project, "existing.txt"), "utf8"),
    "new user edit",
  );
  plan = await prepare([input]);
  await writeFile(input, "changed source after confirmation");
  await apply(plan, "replace");
  assert.equal(
    await readFile(path.join(project, "existing.txt"), "utf8"),
    "replacement",
    "Import uses the reviewed staged source",
  );
  const replacement = await latest();
  await call({ op: "folderHistoryUndo", id: replacement.id });
  assert.equal(
    await readFile(path.join(project, "existing.txt"), "utf8"),
    "new user edit",
  );

  await mkdir(path.join(incoming, "linked"));
  await symlink(
    path.join(directory, "outside.txt"),
    path.join(incoming, "linked/leak.txt"),
  );
  await assert.rejects(prepare([path.join(incoming, "linked")]), /符号链接/);
  await assert.rejects(access(path.join(project, "linked")));
  await assert.rejects(prepare([project]), /自身或子目录/);
  await assert.rejects(prepare([input], "../"));
  await assert.rejects(
    call({
      op: "folderImportPrepare",
      folder_id: "stale",
      sources: [input],
      destination: "",
    }),
    /文件夹已改变/,
  );

  const circuitPath = path.join(project, "history.circ");
  await writeFile(circuitPath, source);
  await call({ op: "folderHistory" });
  let doc = await call({ op: "open", path: circuitPath });
  const id = doc.id;
  await writeFile(circuitPath, source + "\n");
  doc = await call({
    op: "edit",
    id,
    revision: doc.revision,
    circuit: "main",
    edit: { kind: "renameCircuit", name: "draft" },
  });
  assert(doc.saveError);
  await writeFile(circuitPath, source);
  await call({
    op: "folderRename",
    from: "history.circ",
    to: "moved-history.circ",
  });
  const movement = await latest();
  await call({ op: "folderHistoryUndo", id: movement.id });
  const movedBack = await call({ op: "open", path: circuitPath });
  assert.equal(movedBack.id, id);
  assert.equal(movedBack.revision, doc.revision);
  assert(movedBack.dirty);
  const replacementSource = path.join(incoming, "history.circ");
  await writeFile(
    replacementSource,
    source
      .replaceAll('name="main"', 'name="imported"')
      .replace('val="main"', 'val="imported"'),
  );
  plan = await prepare([replacementSource]);
  await assert.rejects(apply(plan, "replace"), /未保存/);
  doc = await call({ op: "undo", id, revision: doc.revision });
  await apply(plan, "replace");
  const overwrite = await latest();
  doc = await call({ op: "open", path: circuitPath });
  assert.equal(doc.id, id);
  assert.equal(doc.main, "imported");
  assert(!doc.dirty);
  const importedBytes = await readFile(circuitPath);
  await writeFile(
    circuitPath,
    Buffer.concat([importedBytes, Buffer.from("\n")]),
  );
  doc = await call({
    op: "edit",
    id,
    revision: doc.revision,
    circuit: "imported",
    edit: { kind: "renameCircuit", name: "new-draft" },
  });
  assert(doc.saveError);
  await writeFile(circuitPath, importedBytes);
  await assert.rejects(
    call({ op: "folderHistoryUndo", id: overwrite.id }),
    /未保存/,
  );
  doc = await call({ op: "undo", id, revision: doc.revision });
  await call({ op: "folderHistoryUndo", id: overwrite.id });
  doc = await call({ op: "open", path: circuitPath });
  assert.equal(doc.id, id);
  assert.equal(doc.main, "main");
  assert(!doc.dirty);
  await call({ op: "folderTrash", path: "history.circ" });
  const deletion = await latest();
  await call({ op: "folderHistoryUndo", id: deletion.id });
  assert.equal(await readFile(circuitPath, "utf8"), source);
  assert.equal((await call({ op: "open", path: circuitPath })).id, id);
  await call({ op: "folderOpen", path: project });
  assert(
    (await call({ op: "folderHistory" })).some(
      (c: any) => c.id === deletion.id,
    ),
    "History survives reopening from its persisted index",
  );
  const read = await call({ op: "folderRead", path: "existing.txt" });
  assert.equal(read.relativePath, "existing.txt");
  assert.equal(read.folderId, folderId);
  assert.match(read.revision, /^[a-f0-9]{64}$/);
  console.log(
    "Verified recursive external import, explicit keep-both/skip/replace, frozen source and stale-target protection, symlink/self/escape rejection, persistent before/after history, later-edit and dirty-draft guards, identity-preserving move undo, clean document reload, and trash restoration.",
  );
}
