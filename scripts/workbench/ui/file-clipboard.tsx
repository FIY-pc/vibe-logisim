import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { Files } from "../../../apps/workbench/src/workspace/Files";
import { clickMenuItem, openMenu } from "./workbench";

export async function verifyFileClipboard() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const g = globalThis as any;
  const originalCommand = g.__command;
  const originalDesktop = g.__desktop;
  const originalInvoke = g.__nativeInvoke;
  const originalListen = g.__nativeListen;
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  const originalPlatform = Object.getOwnPropertyDescriptor(
    navigator,
    "platform",
  );
  let text = "",
    failMove = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        text = value;
      },
      readText: async () => text,
    },
  });
  g.__desktop = false;
  const folder = {
    id: "clipboard-project",
    path: "/fixture/project",
    name: "project",
  };
  const entry = (path: string, directory = false) => ({
    path,
    name: path.split("/").at(-1)!,
    directory,
    size: 0,
  });
  let loadedFolder = folder;
  const entries = [
    entry("target", true),
    entry("source.circ"),
    entry("target/source.circ"),
    entry("note.txt"),
    entry(".env"),
    entry("target/.env"),
  ];
  const calls: any[] = [],
    errors: unknown[] = [];
  let prepared: any,
    copies = 0;
  g.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "folderList")
      return {
        folder: loadedFolder,
        entries: entries.filter(
          (e) => e.path.split("/").slice(0, -1).join("/") === request.path,
        ),
      };
    if (request.op === "folderImportPrepare") {
      prepared = request;
      return {
        id: "clipboard-plan",
        items: [
          {
            index: 0,
            name: "note.txt",
            path: "target/note.txt",
            directory: false,
            conflict: true,
            replaceable: true,
          },
        ],
      };
    }
    if (request.op === "folderImportApply") {
      const path = `${prepared.destination}/note (${++copies + 1}).txt`;
      entries.push(entry(path));
      return { imported: [path] };
    }
    if (request.op === "folderImportCancel") return {};
    if (request.op === "folderRename") {
      if (failMove) throw new Error("fixture: source no longer available");
      assert(
        !entries.some((e) => e.path === request.to),
        "A move cannot overwrite",
      );
      const index = entries.findIndex((e) => e.path === request.from);
      assert(index >= 0);
      entries[index] = entry(request.to, entries[index].directory);
      return {};
    }
    throw new Error("Unexpected clipboard request: " + request.op);
  };
  const render = (currentFolder = folder) => {
    loadedFolder = currentFolder;
    return root.render(
      <Files
        folder={currentFolder}
        onFolder={() => {}}
        onOpen={() => {}}
        onPreview={() => {}}
        onError={(error) => errors.push(error)}
        onRename={async () => {}}
      />,
    );
  };
  const flush = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  const row = (path: string) => {
    const found = [
      ...node.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ].find((e) => e.dataset.tip === path);
    assert(found, path);
    return found;
  };
  const focus = async (path: string) => act(async () => row(path).focus());
  const shortcut = async (letter: string, mac = false) => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: mac ? "MacIntel" : "Win32",
    });
    let event!: KeyboardEvent;
    await act(async () => {
      event = new KeyboardEvent("keydown", {
        key: letter,
        code: `Key${letter.toUpperCase()}`,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement!.dispatchEvent(event);
    });
    await flush();
    return event;
  };
  const click = async (label: string) => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.trim() === label);
    assert(button, label);
    await act(async () => button.click());
    await flush();
  };
  try {
    await act(async () => render());
    await flush();
    await focus("note.txt");
    assert((await shortcut("c", true)).defaultPrevented);
    assert.equal(text, "/fixture/project/note.txt");
    assert(!calls.some((c) => c.op === "folderImportPrepare"));
    await focus("target");
    await shortcut("v", true);
    assert.equal(prepared.destination, "target");
    assert.deepEqual(prepared.sources, ["/fixture/project/note.txt"]);
    assert.deepEqual(calls.find((c) => c.op === "folderImportApply").choices, [
      { index: 0, action: "keepBoth" },
    ]);
    assert(
      !document.querySelector('[aria-label="文件同名冲突"]'),
      "Copy makes a numbered duplicate without interrupting paste",
    );
    await focus("target");
    await shortcut("v");
    assert.equal(copies, 2, "Copy remains available for repeated pastes");

    await focus("source.circ");
    await shortcut("x");
    assert(row("source.circ").closest(".file-cut"));
    assert(
      !calls.some((c) => c.op === "folderRename"),
      "Cut is only a mark until pasted",
    );
    await focus("target");
    await shortcut("v");
    assert(document.querySelector('[aria-label="存在同名项目"]'));
    await click("取消");
    assert(entries.some((e) => e.path === "source.circ"));
    assert(
      row("source.circ").closest(".file-cut"),
      "Cancelling keeps the cut source",
    );
    await focus("target");
    await shortcut("v");
    await click("保留两者");
    assert(
      calls.some(
        (c) =>
          c.op === "folderRename" &&
          c.from === "source.circ" &&
          c.to === "target/source (2).circ",
      ),
    );
    assert(
      !node.querySelector(".file-cut"),
      "Successful paste consumes cut state",
    );
    assert(
      entries.some((e) => e.path === "target/source.circ"),
      "Existing destination is preserved",
    );
    const moves = calls.filter((c) => c.op === "folderRename").length;
    await shortcut("v");
    assert.equal(
      calls.filter((c) => c.op === "folderRename").length,
      moves,
      "Cut is consumed once",
    );

    await openMenu("note.txt 的操作", node);
    await clickMenuItem("剪切");
    await flush();
    assert(row("note.txt").closest(".file-cut"));
    failMove = true;
    await focus("target");
    await shortcut("v");
    assert.equal(errors.length, 1);
    assert(
      row("note.txt").closest(".file-cut"),
      "A failed move keeps its source and clipboard",
    );
    failMove = false;
    await act(async () =>
      row("note.txt").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      ),
    );
    await flush();
    assert(!node.querySelector(".file-cut"), "Escape clears cut state");

    await openMenu("note.txt 的操作", node);
    await clickMenuItem("复制");
    await flush();
    await openMenu("target 的操作", node);
    await clickMenuItem("粘贴");
    await flush();
    assert.equal(copies, 3, "Context-menu commands operate on their own row");
    text = "a new text selection";
    await focus("target");
    await shortcut("v");
    assert.equal(
      copies,
      3,
      "Copying text elsewhere supersedes the file clipboard",
    );

    // Browser clipboard events (macOS native Cut needs the menu bridge below).
    const nativeEvent = async (type: "copy" | "cut" | "paste") =>
      act(async () => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: {
            setData: (_type: string, value: string) => {
              text = value;
            },
            getData: () => text,
          },
        });
        document.activeElement!.dispatchEvent(event);
        assert(event.defaultPrevented);
      });
    await focus("note.txt");
    await nativeEvent("cut");
    const tree = node.querySelector<HTMLElement>('[role="tree"]')!;
    await act(async () => tree.focus());
    await nativeEvent("paste");
    await flush();
    assert(
      !node.querySelector(".file-cut"),
      "Pasting a cut file in its current folder is a no-op",
    );
    await focus("note.txt");
    await nativeEvent("copy");
    await focus("target");
    await nativeEvent("paste");
    await flush();
    assert.equal(copies, 4);

    await focus("note.txt");
    await shortcut("x", true);
    const input = document.createElement("textarea");
    node.append(input);
    input.focus();
    assert(
      !(await shortcut("c", true)).defaultPrevented,
      "Text inputs keep native copy shortcuts",
    );
    assert(
      !(await shortcut("v", true)).defaultPrevented,
      "Text inputs keep native paste shortcuts",
    );
    input.remove();
    await act(async () => render({ ...folder, id: "other-project" }));
    await flush();
    assert(!node.querySelector(".file-cut"));
    const count = calls.length;
    await focus("target");
    await shortcut("v", true);
    assert.equal(
      calls.length,
      count,
      "A folder switch cannot paste a stale cut selection",
    );
    const menuFocus: boolean[] = [];
    let nativeAction: ((event: { payload: string }) => void) | undefined;
    g.__nativeInvoke = async (name: string, args: { focused: boolean }) => {
      assert.equal(name, "file_clipboard_focus");
      menuFocus.push(args.focused);
    };
    g.__nativeListen = (name: string, handler: typeof nativeAction) => {
      assert.equal(name, "file-clipboard");
      nativeAction = handler;
      return () => {
        nativeAction = undefined;
      };
    };
    g.__desktop = true;
    await act(async () => render({ ...folder, id: "native-menu-project" }));
    await flush();
    await focus("note.txt");
    assert.equal(menuFocus.at(-1), true);
    await act(async () => nativeAction!({ payload: "cut" }));
    await flush();
    assert(row("note.txt").closest(".file-cut"));
    const editor = document.createElement("textarea");
    node.append(editor);
    await act(async () => editor.focus());
    assert.equal(
      menuFocus.at(-1),
      false,
      "Text editing restores the native menu",
    );
    await act(async () => nativeAction!({ payload: "paste" }));
    assert(entries.some((e) => e.path === "note.txt"));
    editor.remove();
    await focus("target");
    await act(async () => nativeAction!({ payload: "paste" }));
    await flush();
    assert(entries.some((e) => e.path === "target/note.txt"));
    assert(!entries.some((e) => e.path === "note.txt"));
    await focus(".env");
    await act(async () => nativeAction!({ payload: "cut" }));
    await focus("target");
    await act(async () => nativeAction!({ payload: "paste" }));
    await flush();
    await click("保留两者");
    assert(entries.some((e) => e.path === "target/.env (2)"));
    assert(entries.some((e) => e.path === "target/.env"));
    await focus("target");
    await act(async () => render({ ...folder, id: "after-native-menu" }));
    await flush();
    assert.equal(
      menuFocus.at(-1),
      false,
      "Leaving the tree restores native editing",
    );
    console.log(
      "PASS: file clipboard keyboard/context/native Edit commands, repeated copy, deferred cut, conflict/cancel/failure, root paste, text focus and folder isolation",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    g.__command = originalCommand;
    g.__desktop = originalDesktop;
    g.__nativeInvoke = originalInvoke;
    g.__nativeListen = originalListen;
    if (originalClipboard)
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as any).clipboard;
    if (originalPlatform)
      Object.defineProperty(navigator, "platform", originalPlatform);
    else delete (navigator as any).platform;
  }
}
