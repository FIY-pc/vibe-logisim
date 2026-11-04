import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { Files } from "../../../apps/workbench/src/workspace/Files";
import { clickMenuItem, openMenu, pickOption } from "./workbench";

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
    errors: unknown[] = [],
    references: string[][] = [];
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
    ].find((b) => b.dataset.tip === path);
    assert(found, "tree row " + path);
    return found;
  };
  const key = async (key: string, code = key) => {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code,
          bubbles: true,
          cancelable: true,
        }),
      );
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key, code, bubbles: true }),
      );
    });
    // Headless Tree restores DOM focus after the state-driven rows commit.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
  };
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
          onReference={(paths) => references.push(paths)}
          onRename={async () => {}}
        />,
      ),
    );
    await flush();
    await act(async () => row("dir").focus());
    await key("ArrowRight");
    await key("ArrowDown");
    assert.equal(
      (document.activeElement as HTMLElement).dataset.tip,
      "dir/child.circ",
    );
    assert.equal(
      opened.length,
      0,
      "Keyboard selection must not open documents",
    );
    assert.equal(row("dir/child.circ").getAttribute("aria-level"), "2");
    assert(row("dir/child.circ").closest('[role="group"]'));
    assert.equal(
      node.querySelectorAll('[role="treeitem"][tabindex="0"]').length,
      1,
    );
    await key("Enter");
    assert.deepEqual(opened, ["/fixture/project/dir/child.circ"]);
    await key("ArrowLeft");
    assert.equal((document.activeElement as HTMLElement).dataset.tip, "dir");
    await key("End");
    assert.equal(
      (document.activeElement as HTMLElement)?.dataset.tip,
      "readme.txt",
    );
    await key("Home");
    assert.equal((document.activeElement as HTMLElement)?.dataset.tip, "dir");
    await key("r", "KeyR");
    await flush();
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "按名称定位文件",
    );
    await key("Escape");
    assert.equal(
      (document.activeElement as HTMLElement)?.dataset.tip,
      "readme.txt",
    );
    assert.equal(previews.length, 0, "Typeahead only moves selection");
    await key("Home");
    await key("F2");
    assert(
      document
        .querySelector('[role="dialog"][aria-label="重命名"]')
        ?.getAttribute("data-state") === "open",
    );
    await click("取消");
    // Let the dialog finish returning focus before issuing another command.
    await flush();
    await click("定位当前文件");
    await flush();
    assert.equal(
      (document.activeElement as HTMLElement).dataset.tip,
      "main.circ",
    );
    assert.equal(row("main.circ").getAttribute("aria-current"), "page");
    await key("Delete");
    assert(
      document.querySelector('[role="alertdialog"][aria-label="移入回收站"]'),
    );
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
    const select = document.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="new.circ 的重名处理"]',
    );
    assert(select);
    assert.equal(select.textContent?.trim(), "保留两者");
    assert(
      !calls.some((c) => c.op === "folderImportApply"),
      "Conflicts must wait for explicit choice",
    );
    await pickOption("new.circ 的重名处理", "覆盖现有文件");
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
    await openMenu("文件夹操作", node);
    await clickMenuItem("导入文件夹…");
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
    await openMenu("文件夹操作", node);
    await clickMenuItem("文件改动…");
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
    await click("关闭");
    await flush();
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "文件夹操作",
      "History returns focus to its menu trigger",
    );

    // Removing the focused file during refresh leaves a usable keyboard tree.
    await act(async () => row("readme.txt").focus());
    rows[""] = rows[""].filter((entry) => entry.path !== "readme.txt");
    await key("F5");
    await flush();
    assert.equal((document.activeElement as HTMLElement)?.dataset.tip, "dir");
    assert.equal(
      node.querySelectorAll('[role="treeitem"][tabindex="0"]').length,
      1,
    );
    await key("ArrowDown");
    assert.equal(
      (document.activeElement as HTMLElement)?.dataset.tip,
      "dir/child.circ",
    );

    const referenceZone = document.createElement("div");
    referenceZone.setAttribute("data-reference-drop", "");
    node.append(referenceZone);
    document.elementFromPoint = () => referenceZone;
    await act(async () => {
      row("dir/child.circ").dispatchEvent(
        new MouseEvent("pointerdown", {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 40,
          clientY: 20,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("pointerup", {
          clientX: 40,
          clientY: 20,
          bubbles: true,
        }),
      );
    });
    assert.deepEqual(
      references,
      [["dir/child.circ"]],
      "Internal reference drops retain the relative file path",
    );
    referenceZone.remove();

    // An unresolved expansion belongs to its folder identity, even if another
    // folder opens before the host replies. A collapsed loading folder stays closed.
    await act(async () => row("dir").focus());
    await key("ArrowLeft");
    let resolveListing!: (value: any) => void;
    const originalCommand = g.__command;
    g.__command = (request: any) =>
      request.op === "folderList" && request.path === "dir"
        ? new Promise((resolve) => {
            resolveListing = resolve;
          })
        : originalCommand(request);
    await key("ArrowRight");
    assert.equal(typeof resolveListing, "function");
    assert.equal(row("dir").getAttribute("aria-expanded"), "true");
    await key("ArrowLeft");
    assert.equal(row("dir").getAttribute("aria-expanded"), "false");
    const nextFolder = {
      id: "next-project",
      path: "/fixture/next",
      name: "next",
    };
    g.__command = async () => ({
      folder: nextFolder,
      entries: [entry("fresh.circ")],
    });
    await act(async () =>
      root.render(
        <Files
          folder={nextFolder}
          onFolder={() => {}}
          onOpen={(path) => opened.push(path)}
          onPreview={(preview) => previews.push(preview)}
          onError={(error) => errors.push(error)}
          onRename={async () => {}}
        />,
      ),
    );
    await flush();
    await act(async () =>
      resolveListing({ folder, entries: [entry("late.circ", false, "dir")] }),
    );
    await flush();
    assert.equal(node.querySelectorAll('[role="treeitem"]').length, 1);
    assert(row("fresh.circ"));
    assert(!node.textContent?.includes("late.circ"));
    await act(async () => row("fresh.circ").focus());
    await key("Enter");
    assert.equal(opened.at(-1), "/fixture/next/fresh.circ");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Headless Tree async hierarchy/stale-folder isolation, roles/keyboard/typeahead/refresh focus, pointer move/reference, native drop destination/scale, import conflicts and dialog history/undo/focus",
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
