import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import {
  useFeedback,
  type FeedbackController,
} from "../../../apps/workbench/src/shell/Feedback";
import { UpdatePopover } from "../../../apps/workbench/src/shell/UpdatePopover";
import { releaseHighlights } from "../../../apps/workbench/src/shell/releaseHighlights";

export async function verifyUpdates() {
  const g = globalThis as any;
  const previous = g.__command;
  const previousOpen = window.open;
  const calls: any[] = [];
  const opened: string[] = [];
  const errors: unknown[] = [];
  let status = {
    enabled: true,
    forcedOff: false,
    current: "26.11.3",
    development: false,
    latest: "26.11.4",
    url: "https://github.com/FIY-pc/vibe-logisim/releases/tag/v26.11.4",
    releaseNotesHtml:
      "<ul><li>文件引用和图片附件</li><li>中断后保留内容</li><li>macOS 预览包</li><li>其他改进</li></ul>",
    lastCheckedAt: null,
    newer: true,
    available: true,
    error: null,
  };
  g.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "feedbackDismiss")
      status = { ...status, available: false };
    return { ...status };
  };
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof window.open;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let feedback!: FeedbackController;
  function Fixture() {
    feedback = useFeedback(
      () => {},
      (error) => errors.push(error),
    );
    return <UpdatePopover feedback={feedback} />;
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const trigger = () =>
    node.querySelector<HTMLButtonElement>(".update-trigger");
  const popover = () =>
    document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="版本更新"]',
    );
  const click = async (element: HTMLElement | null) => {
    assert(element);
    await act(async () => element.click());
    await settle();
  };
  try {
    assert.deepEqual(
      releaseHighlights(
        "<ul><li><b>A &amp; B</b><ul><li>nested detail</li></ul><script>bad()</script><img src='https://example.invalid/tracker' onerror='bad()'></li><li>C</li></ul>",
      ),
      ["A & B", "C"],
    );
    assert.deepEqual(releaseHighlights("<p>Paragraph-only release.</p>"), [
      "Paragraph-only release.",
    ]);
    assert.deepEqual(
      releaseHighlights(
        "<ul><li><strong>文件引用</strong>：粘贴文件。后续说明。</li><li>保留已生成的内容。更多说明。</li></ul>",
      ),
      ["文件引用", "保留已生成的内容。"],
    );
    assert.deepEqual(releaseHighlights(null), []);
    assert.deepEqual(releaseHighlights("x".repeat(65537)), []);
    await act(async () => root.render(<Fixture />));
    await settle();
    assert(trigger(), "automatic discovery exposes the toolbar entry");
    assert.equal(
      Boolean(popover()),
      false,
      "automatic discovery must not interrupt editing",
    );
    await click(trigger());
    assert(popover());
    assert.equal(popover()!.getAttribute("aria-modal"), null);
    assert.equal(
      popover()!.querySelectorAll(".update-highlights li").length,
      3,
    );
    assert.match(popover()!.textContent!, /26.11.3.*26.11.4/);
    assert.match(popover()!.textContent!, /手动安装/);
    const action = [...popover()!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("查看更新与下载"),
    )!;
    await click(action);
    assert.deepEqual(opened, [status.url]);
    await act(async () =>
      action.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await settle();
    assert.equal(Boolean(popover()), false);
    assert.equal(
      document.activeElement === trigger(),
      true,
      `Escape restores focus to the update entry (actual: ${document.activeElement?.outerHTML.slice(0, 180)})`,
    );
    assert(!calls.some((request) => request.op === "feedbackDismiss"));
    await click(trigger());
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
        }),
      );
      document.body.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
      );
      document.body.click();
    });
    await settle();
    assert.equal(
      Boolean(popover()),
      false,
      "outside pointer closes the nonmodal panel",
    );
    assert(trigger(), "closing the panel preserves the update entry");
    await click(trigger());
    await click(
      [...popover()!.querySelectorAll("button")].find(
        (button) => button.textContent === "忽略此版本",
      )!,
    );
    assert.equal(Boolean(trigger()), false);
    assert.equal(Boolean(popover()), false);
    assert.deepEqual(
      calls.filter((request) => request.op === "feedbackDismiss"),
      [{ op: "feedbackDismiss", version: "26.11.4" }],
    );
    await act(async () => root.render(null));
    await act(async () => root.render(<Fixture />));
    assert.equal(
      Boolean(trigger()),
      false,
      "ignored version stays hidden after remount",
    );
    await act(async () => feedback.checkNow());
    await settle();
    assert(popover(), "manual checks can reopen an ignored update");
    await act(async () => root.render(null));
    status = {
      ...status,
      latest: "26.11.5",
      available: true,
      releaseNotesHtml: "",
    };
    await act(async () => root.render(<Fixture />));
    await click(trigger());
    assert.match(popover()!.textContent!, /更新内容请查看发布说明/);
    assert.equal(errors.length, 0);
    console.log(
      "PASS: update popover preserves editing, closes without ignoring, opens allowlisted release links, persists ignores, allows manual rediscovery and extracts inert plain-text highlights",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    g.__command = previous;
    window.open = previousOpen;
  }
}
