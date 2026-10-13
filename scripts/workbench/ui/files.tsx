import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Files } from "../../../apps/workbench/src/components/Files";

export async function verifyFilesUI() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const g = globalThis as any,
    previousCommand = g.__command,
    previousPoint = document.elementFromPoint;
  const folder = {
    id: "fixture-project",
    path: "/fixture/project",
    name: "project",
  };
  const entry = (name: string, directory = false, parent = "") => ({
    name,
    directory,
    path: parent ? parent + "/" + name : name,
    size: 0,
  });
  const rows: Record<string, any[]> = {
    "": [entry("dir", true), entry("main.circ"), entry("readme.txt")],
    dir: [entry("child.circ", false, "dir")],
  };
  const calls: any[] = [],
    opened: string[] = [],
    previews: any[] = [],
    errors: unknown[] = [];
  let conflict = true;
  g.__desktop = true;
  g.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "folderList")
      return { folder, entries: rows[request.path] ?? [] };
    if (request.op === "folderRename") {
      const source = Object.values(rows)
        .flat()
        .find((e) => e.path === request.from);
      assert(source);
      rows[request.from.split("/").slice(0, -1).join("/")] = rows[
        request.from.split("/").slice(0, -1).join("/")
      ].filter((e) => e.path !== request.from);
      const parent = request.to.split("/").slice(0, -1).join("/");
      rows[parent] ??= [];
      rows[parent].push({
        ...source,
        path: request.to,
        name: request.to.split("/").at(-1),
      });
      return {};
    }
    if (request.op === "folderImportPrepare")
      return {
        id: "fixture-plan",
        items: [
          {
            index: 0,
            name: "new.circ",
            path: "dir/new.circ",
            directory: false,
            conflict,
            replaceable: true,
          },
        ],
      };
    if (request.op === "folderImportApply") {
      if (!rows.dir.some((e) => e.name === "new.circ"))
        rows.dir.push(entry("new.circ", false, "dir"));
      return { imported: ["dir/new.circ"] };
    }
    if (request.op === "folderImportCancel") return {};
    if (request.op === "folderHistory")
      return [
        {
          id: "change-1",
          title: "导入文件",
          at: 1,
          undoable: true,
          files: [{ path: "dir/new.circ", kind: "modified" }],
        },
      ];
    if (request.op === "folderHistoryDetail")
      return {
        before: { kind: "text", text: "before fixture" },
        after: { kind: "text", text: "after fixture" },
      };
    if (request.op === "folderHistoryUndo") return {};
    if (request.op === "folderRead")
      return {
        path: "/fixture/project/readme.txt",
        relativePath: "readme.txt",
        folderId: folder.id,
        revision: "immutable-digest",
        text: "fixture text",
      };
    throw new Error("Unexpected Files request: " + request.op);
  };
  const button = (label: string, scope: ParentNode = document) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.textContent?.trim() === label,
    );
    assert(found, "button " + label);
    return found;
  };
  const row = (path: string) => {
    const found = [
      ...node.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
    ].find((b) => b.title === path);
    assert(found, "tree row " + path);
    return found;
  };
  const key = async (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  const click = async (label: string) => act(async () => button(label).click());
  const flush = async () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  try {
    await act(async () =>
      root.render(
        <Files
          folder={folder}
          activePath="/fixture/project/main.circ"
          onFolder={() => {}}
          onOpen={(p) => opened.push(p)}
          onPreview={(p) => previews.push(p)}
          onError={(e) => errors.push(e)}
          onRename={async () => {}}
        />,
      ),
    );
    await act(async () => row("dir").focus());
    await key("ArrowRight");
    await key("ArrowDown");
    assert.equal(
      (document.activeElement as HTMLElement).title,
      "dir/child.circ",
    );
    assert.equal(
      opened.length,
      0,
      "Keyboard selection must not open documents",
    );
    await key("Enter");
    assert.deepEqual(opened, ["/fixture/project/dir/child.circ"]);
    await key("ArrowLeft");
    assert.equal((document.activeElement as HTMLElement).title, "dir");
    await key("F2");
    assert(
      document
        .querySelector('dialog[aria-label="重命名"]')
        ?.hasAttribute("open"),
    );
    await click("取消");
    await click("定位当前文件");
    await flush();
    assert.equal((document.activeElement as HTMLElement).title, "main.circ");
    assert.equal(row("main.circ").getAttribute("aria-current"), "page");
    await key("Delete");
    assert(document.querySelector('dialog[aria-label="移入回收站"]'));
    await click("取消");
    assert(!calls.some((c) => c.op === "folderTrash"));
    document.elementFromPoint = () => row("dir");
    await act(async () =>
      row("main.circ").dispatchEvent(
        new MouseEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      ),
    );
    await act(async () =>
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 40,
          clientY: 20,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () =>
      window.dispatchEvent(
        new MouseEvent("pointerup", {
          clientX: 40,
          clientY: 20,
          bubbles: true,
        }),
      ),
    );
    await flush();
    assert(
      calls.some(
        (c) =>
          c.op === "folderRename" &&
          c.from === "main.circ" &&
          c.to === "dir/main.circ",
      ),
    );
    assert.equal(opened.length, 1, "Moving a file must not also open it");
    assert(row("dir/main.circ"));
    // Native paths come from the OS event; physical coordinates map to CSS pixels.
    let position: number[] = [];
    const oldScale = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });
    document.elementFromPoint = (x, y) => {
      position = [x, y];
      return row("dir");
    };
    assert.equal(typeof g.__fileDropHandler, "function");
    await act(async () =>
      g.__fileDropHandler({
        payload: {
          type: "drop",
          paths: ["/outside/new.circ"],
          position: { x: 40, y: 20 },
        },
      }),
    );
    assert.deepEqual(position, [20, 10]);
    Object.defineProperty(window, "devicePixelRatio", {
      value: oldScale,
      configurable: true,
    });
    const prepare = calls.find((c) => c.op === "folderImportPrepare");
    assert.equal(prepare.destination, "dir");
    assert.deepEqual(prepare.sources, ["/outside/new.circ"]);
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="new.circ 的重名处理"]',
    );
    assert(select);
    assert.equal(select.value, "keepBoth");
    assert(
      !calls.some((c) => c.op === "folderImportApply"),
      "Conflicts must wait for explicit choice",
    );
    await act(async () => {
      select.value = "replace";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("导入");
    await flush();
    assert.equal(
      calls.find((c) => c.op === "folderImportApply").choices[0].action,
      "replace",
    );
    const prepared = calls.filter((c) => c.op === "folderImportPrepare").length;
    document.elementFromPoint = () => null;
    await act(async () =>
      g.__fileDropHandler({
        payload: {
          type: "drop",
          paths: ["/outside/ignored"],
          position: { x: 1, y: 1 },
        },
      }),
    );
    assert.equal(
      calls.filter((c) => c.op === "folderImportPrepare").length,
      prepared,
      "Dropping outside Files never imports into an accidental destination",
    );
    conflict = false;
    g.__pickedFiles = ["/outside/picked-folder"];
    await click("文件夹操作");
    await click("导入文件夹…");
    await flush();
    assert(
      calls.some(
        (c) =>
          c.op === "folderImportPrepare" &&
          c.sources[0] === "/outside/picked-folder" &&
          c.destination === "",
      ),
    );
    await act(async () => row("readme.txt").click());
    assert.equal(previews.at(-1).revision, "immutable-digest");
    assert.equal(previews.at(-1).path, "readme.txt");
    assert.equal(previews.at(-1).folderId, folder.id);
    await click("文件夹操作");
    await click("文件改动…");
    await click("修改dir/new.circ");
    assert(
      document
        .querySelector(".file-history-comparison")
        ?.textContent?.includes("before fixture"),
    );
    assert(
      document
        .querySelector(".file-history-comparison")
        ?.textContent?.includes("after fixture"),
    );
    await click("撤销");
    assert(!calls.some((c) => c.op === "folderHistoryUndo"));
    await click("撤销这次改动");
    assert(
      calls.some(
        (c) =>
          c.op === "folderHistoryUndo" &&
          c.id === "change-1" &&
          c.folder_id === folder.id,
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: file tree keyboard selection/open/F2/Delete/locate, pointer move, native drop destination/scale, explicit conflict handling, picker import, immutable text references, and history comparison/undo entry",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    g.__desktop = false;
    g.__command = previousCommand;
    delete g.__pickedFiles;
    document.elementFromPoint = previousPoint;
  }
}
