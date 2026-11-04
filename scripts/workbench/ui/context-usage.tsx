import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import type { ContextUsage } from "../../../apps/workbench/src/conversation/ContextUsageRing";
import { Tooltips } from "../../../apps/workbench/src/shared/Tooltips";
import { Workbench } from "./workbench";

export async function verifyContextUsage() {
  const globals = globalThis as any;
  const old = { command: globals.__command, subscribe: globals.__subscribe };
  const listeners = new Set<(event: any) => void>();
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let sequence = 1000;
  let usage: ContextUsage | null | undefined;
  const state = () => ({
    eventCursor: sequence,
    status: "ready",
    available: true,
    busy: false,
    messages: [],
    model: "fixture",
    effort: "none",
    services: [],
    customProvider: null,
    conversationId: "context-fixture",
    contextUsage: usage,
  });
  globals.__subscribe = (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  globals.__command = async (request: any) =>
    request.method === "conversations" ? { conversations: [] } : state();
  const update = (next: typeof usage) =>
    act(async () => {
      usage = next;
      sequence++;
      for (const listener of listeners)
        listener({
          topic: "agent",
          data: { sequence, event: { type: "status", ...state() } },
        });
    });
  const ring = () => container.querySelector<HTMLElement>(".context-usage")!;
  const fill = () => ring().querySelector(".context-usage-fill");
  const tooltip = () => document.querySelector('[role="tooltip"]');
  const waitForHint = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
  const base: ContextUsage = {
    tokens: 32000,
    contextWindow: 128000,
    source: "estimate",
    compactAt: 100000,
    status: "ready",
    compactions: 0,
  };
  try {
    await act(async () =>
      root.render(
        <Workbench>
          <Tooltips />
          <Chat
            visible
            doc={null}
            folder={{ id: "global", path: "/fixture", name: "fixture" }}
            circuit={null}
            selection={[]}
            quotation={null}
            onQuoted={() => {}}
            onFilesChanged={async () => {}}
            onError={(error) => errors.push(error)}
          />
        </Workbench>,
      ),
    );
    assert(ring().classList.contains("is-unknown"));
    assert.equal(ring().getAttribute("aria-valuenow"), null);
    assert.equal(fill(), null);
    assert.equal(tooltip(), null);
    assert.equal(
      ring().previousElementSibling?.getAttribute("aria-label"),
      "思考深度",
    );

    await update(base);
    assert.equal(ring().getAttribute("role"), "meter");
    assert.equal(ring().getAttribute("aria-valuenow"), "25");
    assert.equal(fill()?.getAttribute("stroke-dasharray"), "25 100");
    assert(!ring().classList.contains("is-high"));
    assert.equal(
      ring().textContent,
      "",
      "Usage adds no permanent composer text",
    );
    assert.equal(tooltip(), null);
    await act(async () => {
      ring().dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    await waitForHint();
    assert.match(
      tooltip()?.textContent || "",
      /32,000 \/ 128,000 tokens（估算）/,
    );
    assert.match(tooltip()?.textContent || "", /自动压缩阈值：100,000 tokens/);
    await act(async () => {
      container
        .querySelector("textarea")!
        .dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    assert.equal(tooltip(), null, "Moving away hides usage details");

    await update({ ...base, tokens: 95999 });
    assert(!ring().classList.contains("is-high"), "Below 75% stays blue");
    await update({ ...base, tokens: 96000, source: "usage" });
    assert(ring().classList.contains("is-high"), "Exactly 75% turns yellow");
    assert.equal(fill()?.getAttribute("stroke-dasharray"), "75 100");
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      ring().focus();
    });
    await waitForHint();
    assert.equal(document.activeElement, ring());
    assert(tooltip(), "Keyboard focus shows the same usage details");
    assert.equal(ring().getAttribute("aria-describedby"), tooltip()!.id);
    assert(!tooltip()!.textContent!.includes("估算"));

    await update({
      ...base,
      tokens: 96000,
      status: "compacting",
      compactions: 2,
    });
    assert(ring().classList.contains("is-high"));
    assert(ring().querySelector(".context-usage-pulse"));
    assert.match(tooltip()?.textContent || "", /正在压缩/);
    assert.match(tooltip()?.textContent || "", /已压缩 2 次/);
    await update({ ...base, compactions: 3 });
    assert(!ring().classList.contains("is-high"));
    assert.equal(ring().querySelector(".context-usage-pulse"), null);
    assert.match(tooltip()?.textContent || "", /已压缩 3 次/);
    await act(async () => {
      ring().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(tooltip(), null);

    await update(null);
    assert(ring().classList.contains("is-unknown"));
    assert.equal(ring().getAttribute("aria-valuenow"), null);
    await update({ ...base, contextWindow: 0, status: "compacting" });
    assert(ring().classList.contains("is-unknown"));
    assert(ring().querySelector(".context-usage-pulse"));
    await update({ ...base, tokens: 0 });
    assert(!ring().classList.contains("is-unknown"), "Zero is known usage");
    assert.equal(fill()?.getAttribute("stroke-dasharray"), "0 100");
    await update({ ...base, tokens: 160000 });
    assert.equal(fill()?.getAttribute("stroke-dasharray"), "100 100");
    assert.match(ring().getAttribute("data-tip")!, /160,000 \/ 128,000/);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: context usage follows status snapshots, switches blue/yellow at 75%, handles unknown/compacting states, and reveals details only on hover or keyboard focus",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globals.__command = old.command;
    globals.__subscribe = old.subscribe;
  }
}
