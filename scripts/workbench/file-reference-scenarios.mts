import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, readFile, rename, rm, mkdir, open } from "node:fs/promises";
import path from "node:path";
export async function verifyFileReferences(
  command: (request: Record<string, unknown>) => Promise<any>,
  directory: string,
  project: string,
  folderId: string,
) {
  const call = (request: Record<string, unknown>) =>
    command({ folder_id: folderId, ...request });
  await writeFile(path.join(project, "reference.txt"), "quoted text");
  const ref = await call({ op: "folderRead", path: "reference.txt" });
  assert(Number.isSafeInteger(ref.pathVersion));
  assert.equal(ref.folderId, folderId);
  const resolve = () =>
    call({
      op: "folderResolve",
      path: "reference.txt",
      path_version: ref.pathVersion,
    });
  await assert.rejects(
    call({ op: "folderResolve", path: "reference.txt" }),
    /缺少路径版本/,
  );
  await assert.rejects(
    call({
      op: "folderResolve",
      path: "reference.txt",
      path_version: 4294967295,
    }),
    /路径记录不存在/,
  );
  await assert.rejects(
    call({ op: "folderRead", folder_id: "other", path: "reference.txt" }),
    /文件夹已改变/,
  );
  await mkdir(path.join(project, "ref-folder"));
  await call({
    op: "folderRename",
    from: "reference.txt",
    to: "ref-folder/renamed.txt",
  });
  await writeFile(path.join(project, "reference.txt"), "quoted text");
  assert.equal(
    (await resolve()).path,
    "ref-folder/renamed.txt",
    "A same-name replacement must not steal an earlier reference",
  );
  const move = (await call({ op: "folderHistory" })).find(
    (entry: any) => entry.title === "移动文件",
  );
  await assert.rejects(call({ op: "folderHistoryUndo", id: move.id }));
  await rm(path.join(project, "reference.txt"));
  await call({ op: "folderHistoryUndo", id: move.id });
  assert.equal((await resolve()).path, "reference.txt");
  for (let index = 0; index < 102; index++)
    await call({
      op: "folderRename",
      from: index % 2 ? "cycled.txt" : "reference.txt",
      to: index % 2 ? "reference.txt" : "cycled.txt",
    });
  assert.equal((await call({ op: "folderHistory" })).length, 100);
  await call({ op: "folderOpen", path: project });
  assert.equal(
    (await resolve()).path,
    "reference.txt",
    "Move identity outlives bounded history and reopening",
  );
  await rename(
    path.join(project, "reference.txt"),
    path.join(directory, "original-reference.txt"),
  );
  await writeFile(path.join(project, "reference.txt"), "quoted text");
  await assert.rejects(resolve(), /文件身份已改变/);
  await rm(path.join(project, "reference.txt"));
  await rename(
    path.join(directory, "original-reference.txt"),
    path.join(project, "reference.txt"),
  );
  assert.equal((await resolve()).path, "reference.txt");
  await call({ op: "folderTrash", path: "reference.txt" });
  await writeFile(path.join(project, "reference.txt"), "quoted text");
  await assert.rejects(resolve(), /已删除或被覆盖/);
  const png = path.join(project, "reference.png");
  await writeFile(png, Buffer.from([137, 80, 78, 71, 0, 1]));
  const preview = await call({ op: "folderPreview", path: "reference.png" });
  assert.equal(preview.folderId, folderId);
  assert.equal(preview.path, "reference.png");
  assert(Number.isSafeInteger(preview.pathVersion));
  await assert.rejects(
    call({ op: "folderPreview", folder_id: "other", path: "reference.png" }),
    /文件夹已改变/,
  );

  const circuitRef = await call({ op: "folderRead", path: "history.circ" });
  let document = await call({
    op: "open",
    path: path.join(project, "history.circ"),
  });
  // What the AI runtime's read_file sees: the folder-bound reference of the file.
  const toolRead = await call({ op: "folderRead", path: "history.circ" });
  assert.equal(toolRead.folderId, folderId);
  assert.match(toolRead.url, /^workspace:\/\/history\.circ\?pathVersion=\d+$/);
  document = await call({
    op: "edit",
    id: document.id,
    revision: document.revision,
    circuit: "main",
    edit: { kind: "renameCircuit", name: "saved" },
  });
  document = await call({
    op: "save",
    id: document.id,
    revision: document.revision,
  });
  assert.equal(
    (
      await call({
        op: "folderResolve",
        path: "history.circ",
        path_version: circuitRef.pathVersion,
      })
    ).path,
    "history.circ",
    "Known atomic saves preserve logical identity",
  );
  const sourceRevision = document.revision;
  document = await call({
    op: "save",
    id: document.id,
    revision: document.revision,
    path: path.join(project, "copy.circ"),
  });
  assert.equal(
    (
      await call({
        op: "folderResolve",
        path: "history.circ",
        path_version: circuitRef.pathVersion,
      })
    ).path,
    "history.circ",
    "Save As does not transfer the original reference to its copy",
  );
  assert.equal(
    (await call({ op: "folderRead", path: "history.circ" })).revision,
    sourceRevision,
  );
  await call({ op: "folderTrash", path: "history.circ" });
  const deletion = (await call({ op: "folderHistory" }))[0];
  await assert.rejects(
    call({
      op: "folderResolve",
      path: "history.circ",
      path_version: circuitRef.pathVersion,
    }),
    /已删除或被覆盖/,
  );
  await call({ op: "folderHistoryUndo", id: deletion.id });
  assert.equal(
    (
      await call({
        op: "folderResolve",
        path: "history.circ",
        path_version: circuitRef.pathVersion,
      })
    ).path,
    "history.circ",
    "History restoration revives the original logical binding",
  );
  // Binary history retains bytes; oversized entries stay visible but cannot undo.
  await call({ op: "folderHistory" });
  await writeFile(png, Buffer.from([0, 9, 8, 7]));
  const binary = (await call({ op: "folderHistory" }))[0];
  assert(binary.undoable);
  assert.equal(
    (
      await call({
        op: "folderHistoryDetail",
        id: binary.id,
        path: "reference.png",
      })
    ).before.kind,
    "binary",
  );
  await call({ op: "folderHistoryUndo", id: binary.id });
  assert.deepEqual(await readFile(png), Buffer.from([137, 80, 78, 71, 0, 1]));
  assert.equal(
    (
      await call({
        op: "folderResolve",
        path: "reference.png",
        path_version: preview.pathVersion,
      })
    ).path,
    "reference.png",
    "Binary history restoration preserves a known binding",
  );
  const large = await open(path.join(project, "large.bin"), "w");
  await large.truncate(33 * 1024 * 1024);
  await large.close();
  const big = (await call({ op: "folderHistory" }))[0];
  assert.equal(big.undoable, false);
  assert(big.files.some((f: any) => f.path === "large.bin"));
  await assert.rejects(call({ op: "folderHistoryUndo", id: big.id }), /大文件/);
  await rm(path.join(project, "large.bin"));
  const index = path.join(
    directory,
    "state/file-history",
    createHash("sha256").update(folderId).digest("hex"),
    "index.json",
  );
  const saved = await readFile(index);
  await writeFile(index, "invalid history fixture");
  try {
    assert((await call({ op: "folderOpen", path: project })).historyWarning);
    assert((await call({ op: "folderList", path: "" })).historyWarning);
    assert(
      (
        await call({
          op: "folderCreate",
          path: "history-unavailable.txt",
          directory: false,
        })
      ).historyWarning,
    );
    assert.equal(
      await readFile(path.join(project, "history-unavailable.txt"), "utf8"),
      "",
    );
  } finally {
    await writeFile(index, saved);
  }
  console.log(
    "Verified scoped immutable file reads, persistent move/undo path bindings beyond 100-entry history, no same-name substitution, external replacement and missing-version rejection, binary/oversize history visibility, and nonblocking history failure.",
  );
}
