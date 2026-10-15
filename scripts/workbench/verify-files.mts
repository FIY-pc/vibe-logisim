/** Linux filesystem integration with a temporary, isolated freedesktop trash. */
import assert from "node:assert/strict";
import { verifyFileHistory } from "./file-history-scenarios.mts";
import { verifyFileReferences } from "./file-reference-scenarios.mts";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
if (process.platform !== "linux")
  throw new Error("This isolated freedesktop trash check requires Linux");
const root = path.resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(path.join(tmpdir(), "vibe-files-check-"));
const project = path.join(directory, "project");
const dataHome = path.join(directory, "desktop-data");
await mkdir(path.join(project, "source/child"), { recursive: true });
await mkdir(dataHome);
await writeFile(path.join(project, "existing.txt"), "retain target");
const source =
  '<?xml version="1.0" encoding="UTF-8"?><project source="2.7.1" version="1.0"><lib desc="#Wiring" name="0"/><main name="main"/><options/><mappings/><toolbar/><circuit name="main"><a name="circuit" val="main"/></circuit></project>';
await writeFile(path.join(project, "source/main.circ"), source);
const child = spawn(path.join(root, "target/debug/vibe-workbench-host"), [], {
  cwd: directory,
  env: {
    ...process.env,
    VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
    XDG_DATA_HOME: dataHome,
    VIBE_WORKBENCH_STATE: path.join(directory, "state"),
    VIBE_WORKBENCH_RESOURCES: root,
    VIBE_WORKBENCH_PORT: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let folderId = "";
let logs = "",
  url = "";
child.stderr.on("data", (chunk) => {
  logs += chunk;
  url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || "";
});
async function command(value: Record<string, unknown>): Promise<any> {
  if (
    ["folderCreate", "folderRename", "folderTrash"].includes(String(value.op))
  )
    value = { folder_id: folderId, ...value };
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  if (result.error)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.result;
}
try {
  for (let tries = 0; tries < 200 && !url; tries++) {
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(url, logs || "Host failed to start");
  folderId = (await command({ op: "folderOpen", path: project })).id;
  await assert.rejects(
    command({ op: "folderTrash", path: "source", folder_id: "stale-folder" }),
    /文件夹已改变/,
  );
  let doc = await command({
    op: "open",
    path: path.join(project, "source/main.circ"),
  });
  const id = doc.id;
  // A concurrent disk edit must keep a recoverable draft when automatic saving conflicts.
  await writeFile(path.join(project, "source/main.circ"), source + "\n");
  doc = await command({
    op: "edit",
    id,
    revision: doc.revision,
    circuit: "main",
    edit: { kind: "renameCircuit", name: "draft" },
  });
  assert(doc.dirty);
  assert(doc.saveError);
  await writeFile(path.join(project, "source/main.circ"), source);
  await assert.rejects(
    command({ op: "folderTrash", path: "source" }),
    /未保存/,
  );
  assert.equal(
    await readFile(path.join(project, "source/main.circ"), "utf8"),
    source,
  );
  await assert.rejects(
    command({ op: "folderRename", from: "source", to: "source/child/nested" }),
  );
  await assert.rejects(
    command({
      op: "folderRename",
      from: "source/main.circ",
      to: "existing.txt",
    }),
  );
  assert.equal(
    await readFile(path.join(project, "existing.txt"), "utf8"),
    "retain target",
  );
  await assert.rejects(
    command({ op: "folderRename", from: "source", to: "../escaped" }),
  );
  await command({ op: "folderRename", from: "source", to: "moved" });
  const reopened = await command({
    op: "open",
    path: path.join(project, "moved/main.circ"),
  });
  assert.equal(reopened.id, id);
  assert.equal(reopened.revision, doc.revision);
  assert.equal(reopened.path, path.join(project, "moved/main.circ"));
  assert(reopened.dirty);
  doc = await command({ op: "undo", id, revision: reopened.revision });
  assert.equal(doc.dirty, false);
  const removed = await command({ op: "folderTrash", path: "moved" });
  assert.deepEqual(removed.closed, [id]);
  assert.equal((await command({ op: "status" })).documents.length, 0);
  await assert.rejects(access(path.join(project, "moved")));
  const trashed = (await readdir(path.join(dataHome, "Trash/files"))).find(
    (name) => name.startsWith("moved"),
  );
  assert(
    trashed,
    "Directory must be recoverable in the OS trash, not permanently deleted",
  );
  assert.equal(
    await readFile(
      path.join(dataHome, "Trash/files", trashed, "main.circ"),
      "utf8",
    ),
    source,
  );
  await assert.rejects(command({ op: "folderTrash", path: "" }));
  const outside = path.join(directory, "outside.txt");
  await writeFile(outside, "retain outside");
  await symlink(outside, path.join(project, "link"));
  await command({ op: "folderTrash", path: "link" });
  assert.equal(await readFile(outside, "utf8"), "retain outside");
  await verifyFileHistory(command, directory, project, folderId, source);
  await verifyFileReferences(command, directory, project, folderId);
  console.log(
    "Verified project move identity/undo, dirty-delete rejection, no overwrite/escape/self-move, clean-tab closure, and recoverable system trash including symlink safety.",
  );
} finally {
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
