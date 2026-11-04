import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import {
  FilePreview,
  type PreviewFile,
} from "../../../apps/workbench/src/workspace/FilePreview";
import type { ReferenceInput } from "../../../apps/workbench/src/conversation/references";

export async function verifyFilePreview() {
  const node = document.createElement("div"),
    outside = document.createElement("p");
  outside.textContent = "Outside the document";
  document.body.append(node, outside);
  const root = createRoot(node),
    globals = globalThis as any,
    nativeWindow = window as any,
    previousDesktop = globals.__desktop,
    previousInternals = nativeWindow.__TAURI_INTERNALS__;
  const quotes: Extract<ReferenceInput, { kind: "material" }>[] = [],
    errors: unknown[] = [];
  const source =
    "# Reading notes\n\nSelected passage\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[Link](https://example.com/notes)";
  const file: PreviewFile = {
    name: "notes.MARKDOWN",
    text: source,
    path: "docs/notes.MARKDOWN",
    folderId: "preview-folder",
    revision: "r1",
    pathVersion: 2,
  };
  const render = (file: PreviewFile, canQuote = true) =>
    act(async () => {
      root.render(
        <FilePreview
          file={file}
          canQuote={canQuote}
          onQuote={(quote) => {
            assert(quote.kind === "material");
            quotes.push(quote);
          }}
          onError={(error) => errors.push(error)}
        />,
      );
    });
  const button = (text: string) => {
    const target = [...node.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    assert(target, `button ${text}`);
    return target;
  };
  const click = (text: string) => act(async () => button(text).click());
  const select = (start: Node, end: Node) =>
    act(async () => {
      window
        .getSelection()!
        .setBaseAndExtent(start, 0, end, end.textContent!.length);
      node
        .querySelector(".reader-scroll")!
        .dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
  try {
    globals.__desktop = false;
    await render(file);
    assert.equal(node.querySelector("h1")?.textContent, "Reading notes");
    assert(node.querySelector("table"), "GFM tables remain rendered");
    assert.equal(button("查看源码").getAttribute("aria-pressed"), "false");
    const link = node.querySelector("a")!;
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");

    const passage = node.querySelector(".material-markdown p")!.firstChild!;
    await select(passage, passage);
    await click("引用选中文字");
    assert.deepEqual(quotes.at(-1), {
      kind: "material",
      label: file.name,
      path: file.path,
      folderId: file.folderId,
      revision: file.revision,
      pathVersion: file.pathVersion,
      text: "Selected passage",
    });
    await select(passage, outside.firstChild!);
    await click("引用文件");
    assert.equal(
      quotes.at(-1)?.text,
      source,
      "Cross-document selections must not leak into a quote",
    );
    await select(passage, passage);
    await click("查看源码");
    assert.equal(node.querySelector("pre")?.textContent, source);
    assert.equal(button("查看预览").getAttribute("aria-pressed"), "true");
    assert.equal(window.getSelection()!.rangeCount, 0);
    await click("引用文件");
    assert.equal(
      quotes.at(-1)?.text,
      source,
      "Switching mode clears the old quotation selection",
    );
    await click("查看预览");
    assert(node.querySelector("h1"));

    await click("查看源码");
    for (const detected of [
      { name: "notes.md" },
      { name: "notes.txt", mime: "text/markdown; charset=utf-8" },
      { name: "notes.txt", mime: "text/x-markdown" },
    ]) {
      await render({ ...file, ...detected });
      assert(
        node.querySelector("h1"),
        "A new file resets to its Markdown preview",
      );
      assert.equal(button("查看源码").getAttribute("aria-pressed"), "false");
    }
    await render({ ...file, name: "notes.txt", mime: "text/plain" }, false);
    assert.equal(node.querySelector("pre")?.textContent, source);
    assert.equal(node.querySelector("button[aria-pressed]"), null);
    assert(button("引用文件").disabled);
    await render({ ...file, text: "" });
    assert.match(node.textContent!, /此 Markdown 文件为空/);
    await click("查看源码");
    assert.match(node.textContent!, /此 Markdown 文件为空/);

    globals.__desktop = true;
    const opened: unknown[] = [];
    let failure: Error | undefined;
    nativeWindow.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: unknown) => {
        opened.push({ command, args });
        if (failure) throw failure;
      },
    };
    await render(file);
    await act(async () => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      node.querySelector("a")!.dispatchEvent(event);
      assert(
        event.defaultPrevented,
        "Desktop links go through the system opener",
      );
    });
    assert.deepEqual(opened, [
      {
        command: "plugin:opener|open_url",
        args: { url: "https://example.com/notes", with: undefined },
      },
    ]);
    assert.deepEqual(errors, []);
    failure = new Error("Link opener unavailable");
    await act(async () => node.querySelector("a")!.click());
    assert.deepEqual(
      errors,
      [failure],
      "Opener failures reach the existing error handler",
    );
    console.log(
      "PASS: Markdown detection, preview/source toggle, empty files, quote boundaries and desktop links",
    );
  } finally {
    await act(async () => root.unmount());
    window.getSelection()?.removeAllRanges();
    globals.__desktop = previousDesktop;
    if (previousInternals === undefined)
      delete nativeWindow.__TAURI_INTERNALS__;
    else nativeWindow.__TAURI_INTERNALS__ = previousInternals;
    node.remove();
    outside.remove();
  }
}
