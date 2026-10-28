import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { Canvas } from "../../../apps/workbench/src/editor/Canvas";
import {
  WorkspaceRail,
  PanelResize,
  useWorkspaceLayout,
} from "../../../apps/workbench/src/shell/WorkspaceLayout";
import { Workbench } from "./workbench";

export async function verifyRestoredInteractions() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const oldCommand = (globalThis as any).__command;
  const oldSubscribe = (globalThis as any).__subscribe;
  const oldClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const callbacks = new Set<(event: any) => void>();
  let copied = "",
    sequence = 0;
  const calls: any[] = [],
    errors: unknown[] = [];
  const component = {
    id: "pin",
    name: "Pin",
    library: "0",
    location: { x: 100, y: 100 },
    attributes: {},
  };
  const circuit = {
    name: "main",
    components: [component],
    wires: [],
    attributes: {},
  };
  const doc: any = {
    id: "restored",
    revision: "r1",
    name: "restored.circ",
    main: "main",
    path: null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    circuits: [circuit],
  };
  const messages = [
    {
      id: "text",
      type: "assistant",
      text: "Example\n\n```js\nconst value = 1;\n```",
    },
  ];
  const conversations = [
    {
      id: "conversation",
      title: "当前对话",
      preview: "电路讨论",
      archived: false,
    },
    { id: "another", title: "另一会话", preview: "门电路", archived: false },
    { id: "archived", title: "旧对话", preview: "保留的内容", archived: true },
  ];
  let previewResolve: ((value: unknown) => void) | null = null;
  let delayedPreview = true;
  (globalThis as any).__subscribe = (callback: any) => {
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  };
  (globalThis as any).__command = async (request: any) => {
    calls.push(request);
    if (request.op === "agent") {
      if (request.method === "conversations") return { conversations };
      return {
        eventCursor: sequence,
        runtime: "builtin",
        status: "idle",
        available: true,
        busy: false,
        messages,
        model: "fixture",
        effort: "none",
        services: [{ id: "fixture" }],
        conversationId: "conversation",
      };
    }
    if (request.op === "observe" || request.op === "connections")
      return {
        focus: {
          components: [
            {
              componentId: "pin",
              factoryName: "Pin",
              location: component.location,
              bounds: { x: 90, y: 90, width: 20, height: 20 },
              ends: [],
            },
          ],
        },
      };
    if (request.op === "movePreview") {
      if (delayedPreview)
        return new Promise((resolve) => {
          previewResolve = resolve;
        });
      return {
        revision: null,
        delta: request.delta,
        removedWires: [],
        addedWires: [
          {
            from: { x: request.delta.x, y: 20 },
            to: { x: request.delta.x + 30, y: 20 },
          },
        ],
      };
    }
    return null;
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  const render = async (element: React.ReactNode) =>
    act(async () => {
      root.render(element);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  const click = async (selector: string) => {
    const button = container.querySelector<HTMLElement>(selector);
    assert(button, selector);
    await act(async () => button.click());
  };
  const input = async (selector: string, value: string) => {
    // Popovers mount on <body>, outside the rendered container.
    const element =
      container.querySelector<HTMLInputElement>(selector) ??
      document.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const emit = async (event: any) =>
    act(async () => {
      for (const callback of callbacks)
        callback({ topic: "agent", data: { sequence: ++sequence, event } });
    });
  try {
    await render(
      <Workbench>
        <Chat
          visible
          doc={doc}
          circuit="main"
          folder={null}
          selection={[]}
          quotation={null}
          onQuoted={() => {}}
          onDocument={() => {}}
          onOpened={() => {}}
          onFilesChanged={async () => {}}
          onError={(error) => errors.push(error)}
        />
      </Workbench>,
    );
    await click('[aria-label="复制代码"]');
    assert.equal(copied, "const value = 1;");
    await click('[aria-label="复制消息"]');
    assert.equal(copied, messages[0].text);
    await emit({
      id: "tool",
      type: "activity",
      label: "检查输出",
      status: "completed",
      resultStatus: "failed",
      toolOutput: {
        type: "command",
        target: "fixture-command",
        text: "expected 1, observed 0",
        exitCode: 3,
        truncated: true,
      },
    });
    await emit({
      id: "tool",
      type: "activity",
      label: "检查输出",
      status: "completed",
    });
    await emit({
      id: "unknown",
      type: "activity",
      label: "检查未知",
      status: "completed",
      resultStatus: "unknown",
      detail: "没有观测值",
    });
    // The finished steps fold into one summary line; each opens to its output.
    assert.equal(container.querySelectorAll(".turn-summary").length, 1);
    await click(".turn-summary");
    await click('.turn-tool[data-state="failed"] > summary');
    assert.equal(
      container.querySelector('.turn-tool[data-state="failed"] summary small')
        ?.textContent,
      "失败",
    );
    assert.match(
      container.querySelector(
        '.turn-tool[data-state="failed"] .turn-tool-detail',
      )!.textContent!,
      /expected 1, observed 0.*退出码 3.*输出已截断/,
    );
    await click('.turn-tool[data-state="unknown"] > summary');
    assert.equal(
      container.querySelector('.turn-tool[data-state="unknown"] summary small')
        ?.textContent,
      "结果未知",
    );
    assert.match(
      container.querySelector(
        '.turn-tool[data-state="unknown"] .turn-tool-detail',
      )!.textContent!,
      /没有观测值/,
    );
    await click(".conversation-picker");
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "查找会话",
      "Opening the conversation list puts the cursor in its search field",
    );
    await input('[aria-label="查找会话"]', "门电路");
    const options = () =>
      document.querySelectorAll('.conversation-list [role="option"]');
    assert.equal(options().length, 1);
    assert.match(options()[0].textContent!, /另一会话/);
    await input('[aria-label="查找会话"]', "");
    await act(async () =>
      document
        .querySelector<HTMLElement>('.conversation-archive [role="checkbox"]')!
        .click(),
    );
    assert.match(
      document.querySelector(".conversation-list")!.textContent!,
      /旧对话恢复/,
    );
    const scroller = container.querySelector<HTMLElement>(".messages")!;
    let height = 1000;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 200 },
    });
    scroller.scrollTop = 120;
    await act(async () =>
      scroller.dispatchEvent(new Event("scroll", { bubbles: true })),
    );
    await emit({ type: "assistant-delta", itemId: "text", delta: "more" });
    assert.equal(
      scroller.scrollTop,
      120,
      "Reading old content must not be interrupted by streaming",
    );
    await click(".follow-latest");
    assert.equal(scroller.scrollTop, 1000);
    height = 1300;
    await emit({ type: "assistant-delta", itemId: "text", delta: "newer" });
    assert.equal(
      scroller.scrollTop,
      1300,
      "Following tracks streamed content, not only message count",
    );
    console.log(
      "PASS: tool result/output survives terminal events; conversation/code copy, history search and deliberate scroll follow remain usable",
    );

    function LayoutHarness() {
      const layout = useWorkspaceLayout();
      const [tab, setTab] = useState<"files" | "components">("files");
      return (
        <div ref={layout.workspace} className="workspace">
          <button
            aria-label="项目开关"
            onClick={() => layout.setShowExplorer((old) => !old)}
          />
          <button
            aria-label="对话开关"
            onClick={() => layout.setShowRight((old) => !old)}
          />
          <WorkspaceRail
            layout={layout}
            hasCircuit
            title="项目"
            resourceTab={tab}
            onResourceTab={setTab}
            files={<div>资料内容</div>}
            palette={<div>元件内容</div>}
            navigation={<div>当前图</div>}
            inspector={<div>属性内容</div>}
            navigatorActions={null}
            inspectorActions={null}
          />
          <aside
            className="right-panel"
            style={{
              display: layout.showRight ? undefined : "none",
              width: layout.sizes.review,
            }}
          >
            持续对话
            <PanelResize side="review" layout={layout} />
          </aside>
        </div>
      );
    }
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });
    await render(
      <Workbench>
        <LayoutHarness />
      </Workbench>,
    );
    assert.match(
      container.querySelector(".rail-inspector")!.textContent!,
      /属性内容/,
    );
    assert.match(
      container.querySelector(".right-panel")!.textContent!,
      /持续对话/,
    );
    const separator = container.querySelector<HTMLElement>(
      '[aria-label="调整项目栏宽度"]',
    )!;
    const widthBefore = Number(separator.getAttribute("aria-valuenow"));
    await act(async () =>
      separator.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    assert.equal(
      Number(separator.getAttribute("aria-valuenow")),
      widthBefore + 16,
    );
    await click(".rail-inspector .section-toggle");
    assert(
      container.querySelector<HTMLElement>(
        ".rail-inspector .rail-section-content",
      )!.hidden,
    );
    await click(".rail-inspector .section-toggle");
    assert(
      !container.querySelector<HTMLElement>(
        ".rail-inspector .rail-section-content",
      )!.hidden,
    );
    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
    await act(async () =>
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    assert(
      !container.querySelector<HTMLElement>(".resource-pane:last-child")!
        .hidden,
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 720,
    });
    await act(async () => window.dispatchEvent(new Event("resize")));
    await click('[aria-label="项目开关"]');
    assert.notEqual(
      container.querySelector<HTMLElement>(".workspace-rail")!.style.display,
      "none",
    );
    assert.equal(
      container.querySelector<HTMLElement>(".right-panel")!.style.display,
      "none",
    );
    await click('[aria-label="对话开关"]');
    assert.equal(
      container.querySelector<HTMLElement>(".workspace-rail")!.style.display,
      "none",
    );
    assert.notEqual(
      container.querySelector<HTMLElement>(".right-panel")!.style.display,
      "none",
    );
    console.log(
      "PASS: simultaneous inspector/chat, keyboard resize, resource tabs, collapse and exclusive narrow drawers retain their work areas",
    );

    const noPlacement = {
      tool: null,
      template: null,
      attributes: {},
      loading: false,
      error: "",
      repeat: true,
      setRepeat: () => {},
      change: () => {},
      rotate: () => {},
    };
    const edits: any[] = [];
    function DragHarness() {
      const [selection, setSelection] = useState<string[]>([]);
      return (
        <Canvas
          doc={doc}
          circuit={circuit}
          tool="select"
          selection={selection}
          setSelection={setSelection}
          place={null}
          placement={noPlacement}
          onPlace={async () => doc}
          onCancelPlace={() => {}}
          edit={async (edit) => {
            edits.push(edit);
          }}
          run={null}
          live={null}
          pending={[]}
          pressed={null}
          onPoke={() => {}}
          onPress={() => {}}
          onRelease={() => {}}
          onError={(error) => errors.push(error)}
          fitToken={0}
          onOpenMemory={() => {}}
          onEnterCircuit={() => {}}
        />
      );
    }
    await render(<DragHarness />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
    });
    const canvas = container.querySelector(".canvas")!;
    const [x, y, width] = container
      .querySelector("svg[viewBox]")!
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    const px = ((100 - x) * 600) / width,
      py = ((100 - y) * 600) / width;
    const pointer = async (type: string, dx: number) =>
      act(async () =>
        canvas.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: px + dx,
            clientY: py,
          }),
        ),
      );
    const selected = () =>
      Number(
        container
          .querySelector('rect[fill="var(--selection-fill)"]')!
          .getAttribute("x"),
      );
    await pointer("pointerdown", 0);
    const before = selected();
    await pointer("pointermove", 30);
    assert(
      selected() > before,
      "The dragged selection follows the pointer before the host answers",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 125));
    });
    assert.equal(calls.filter((call) => call.op === "movePreview").length, 1);
    await pointer("pointermove", 70);
    assert.equal(edits.length, 0);
    delayedPreview = false;
    await act(async () => {
      previewResolve!({
        revision: null,
        delta: { x: 1, y: 0 },
        removedWires: [],
        addedWires: [{ from: { x: 1, y: 1 }, to: { x: 2, y: 1 } }],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const previews = calls.filter((call) => call.op === "movePreview");
    assert.equal(
      previews.length,
      2,
      "Pointer changes coalesce behind native planning",
    );
    assert.notEqual(
      container.querySelector(".move-wire-preview line")!.getAttribute("x1"),
      "1",
      "Stale route cannot be painted",
    );
    assert.equal(previews[1].revision, "r1");
    await pointer("pointerup", 70);
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].delta, previews[1].delta);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert(
      !container.querySelector(".move-wire-preview"),
      "The planned routing leaves once the move is answered",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: the selection and latest-only connected routing follow drag; geometry planning cannot write before pointer release",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).__command = oldCommand;
    (globalThis as any).__subscribe = oldSubscribe;
    if (oldClipboard)
      Object.defineProperty(navigator, "clipboard", oldClipboard);
    else delete (navigator as any).clipboard;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    localStorage.removeItem("vibe.workspace.layout");
  }
}
