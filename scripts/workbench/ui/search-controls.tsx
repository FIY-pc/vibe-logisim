import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { createRoot } from "./themed-root";
import { FindDialog } from "../../../apps/workbench/src/editor/FindDialog";
import { ModelPicker } from "../../../apps/workbench/src/conversation/ModelPicker";
import { ConversationPicker } from "../../../apps/workbench/src/conversation/ConversationContent";

export async function verifySearchControls() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const render = async (node: ReactNode) => {
    await act(async () => root.render(node));
    await settle();
  };
  const input = () => document.querySelector<HTMLInputElement>("[cmdk-input]")!;
  const active = () =>
    document.getElementById(
      input().getAttribute("aria-activedescendant") || "",
    );
  const key = async (key: string, extra: KeyboardEventInit = {}) => {
    await act(async () =>
      input().dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...extra,
        }),
      ),
    );
    await settle();
  };
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  };
  const click = async (selector: string) => {
    const node = document.querySelector<HTMLElement>(selector);
    assert.ok(node, selector);
    await act(async () => node.click());
    await settle();
  };
  try {
    let chosen = "";
    const circuit = {
      name: "main",
      components: Array.from({ length: 250 }, (_, index) => ({
        id: `pin-${index}`,
        name: "Pin",
        attributes: { label: `信号 ${index}` },
        location: { x: index * 10, y: 100 },
      })),
    };
    const doc: any = { circuits: [circuit, { ...circuit, name: "control" }] };
    await render(
      <FindDialog
        mode="component"
        doc={doc}
        circuit={circuit as any}
        onChoose={(_, id) => {
          chosen = id!;
        }}
        onClose={() => {}}
      />,
    );
    await type("信号");
    assert.equal(
      document.querySelectorAll("[cmdk-item]").length,
      250,
      "matching results are not capped at 100",
    );
    assert.equal(
      active()?.hasAttribute("data-disabled"),
      false,
      "enabled command options must not acquire the theme's disabled appearance",
    );
    const first = active()?.id;
    await key("ArrowDown", { isComposing: true });
    assert.equal(
      active()?.id,
      first,
      "IME arrows belong to candidate selection",
    );
    await key("Enter", { isComposing: true });
    await key("Enter", { keyCode: 229 });
    assert.equal(
      chosen,
      "",
      "IME confirmation must not choose a circuit object",
    );
    await key("Escape", { isComposing: true });
    assert.ok(document.querySelector(".find-dialog"));
    await key("End");
    assert.match(active()?.textContent || "", /信号 249/);
    await key("Enter");
    assert.equal(chosen, "pin-249");
    await type("does-not-exist");
    assert.match(
      document.querySelector("[cmdk-empty]")?.textContent || "",
      /没有匹配/,
    );
    await type("信号 149");
    await key("Enter");
    assert.equal(chosen, "pin-149");
    await render(
      <FindDialog
        mode="circuit"
        doc={doc}
        circuit={circuit as any}
        onChoose={(name) => {
          chosen = name;
        }}
        onClose={() => {}}
      />,
    );
    await type("control");
    await key("Enter");
    assert.equal(chosen, "control");

    const selected: string[] = [];
    const modelProps = {
      scope: "api:first",
      model: "current-not-listed",
      disabled: false,
      busy: false,
      allowCustom: true,
      load: async () => ({ models: [{ model: "known" }] }),
      select: async (entry: { model: string }) => {
        selected.push(entry.model);
      },
    };
    await render(<ModelPicker {...modelProps} />);
    await click(".ai-model-trigger");
    assert.match(
      document.querySelector(".ai-model-list")!.textContent!,
      /current-not-listed/,
      "retain the selected ID when discovery is incomplete",
    );
    await type("New/Exact-ID");
    assert.match(active()?.textContent || "", /使用模型 ID：New\/Exact-ID/);
    await key("Enter", { isComposing: true });
    assert.equal(selected.length, 0);
    await key("Enter");
    assert.deepEqual(selected, ["New/Exact-ID"]);
    assert.equal(document.querySelector(".ai-model-popover"), null);
    await render(
      <ModelPicker {...modelProps} scope="subscription" allowCustom={false} />,
    );
    await click(".ai-model-trigger");
    await type("missing");
    assert.equal(
      document.querySelectorAll("[cmdk-item]").length,
      0,
      "subscription choices remain catalog controlled",
    );
    await key("Enter");
    assert.equal(selected.length, 1);
    await key("Escape");
    let resolveOld: ((value: any) => void) | undefined;
    await render(
      <ModelPicker
        {...modelProps}
        scope="old"
        load={() =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
        }
      />,
    );
    await click(".ai-model-trigger");
    assert.match(
      document.querySelector('[role="status"]')?.textContent || "",
      /正在更新/,
    );
    await render(
      <ModelPicker
        {...modelProps}
        scope="new"
        load={async () => ({ models: [{ model: "new-scope" }] })}
      />,
    );
    assert.equal(document.querySelector(".ai-model-popover"), null);
    await click(".ai-model-trigger");
    await act(async () => resolveOld!({ models: [{ model: "stale-scope" }] }));
    assert.match(
      document.querySelector(".ai-model-list")!.textContent!,
      /new-scope/,
    );
    assert.doesNotMatch(
      document.querySelector(".ai-model-list")!.textContent!,
      /stale-scope/,
    );
    await key("Escape");
    await render(
      <ModelPicker
        {...modelProps}
        scope="error"
        select={async () => {
          throw new Error("selection refused");
        }}
      />,
    );
    await click(".ai-model-trigger");
    await key("Enter");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /selection refused/,
    );
    assert.ok(document.querySelector(".ai-model-popover"));
    await key("Escape");

    const restored: string[] = [];
    const conversations = Array.from({ length: 180 }, (_, index) => ({
      id: `chat-${index}`,
      title: `对话 ${index}`,
      preview: `内容 ${index}`,
      archived: false,
    }));
    conversations.push({
      id: "archived",
      title: "旧会话",
      preview: "旧记录",
      archived: true,
    });
    const conversationProps = {
      conversations,
      active: "chat-0",
      disabled: false,
      onSelect: (id: string) => {
        selected.push(id);
      },
      onRestore: (id: string) => {
        restored.push(id);
      },
    };
    await render(<ConversationPicker {...conversationProps} />);
    await click(".conversation-picker");
    await type("对话");
    await key("End");
    assert.match(active()?.textContent || "", /对话 179/);
    await key("Enter", { isComposing: true });
    assert.equal(selected.length, 1);
    await key("Enter");
    assert.equal(selected.at(-1), "chat-179");
    await click(".conversation-picker");
    await click('.conversation-archive [role="checkbox"]');
    await type("旧记录");
    await key("Enter");
    assert.deepEqual(restored, ["archived"]);
    await render(<ConversationPicker {...conversationProps} disabled />);
    await click(".conversation-picker");
    await key("Enter");
    assert.equal(selected.at(-1), "chat-179");
    assert.ok(
      Array.from(document.querySelectorAll("[cmdk-item]")).every(
        (node) => node.getAttribute("aria-disabled") === "true",
      ),
    );
    await key("Escape");
    let finish: (() => void) | undefined;
    await render(
      <ConversationPicker
        {...conversationProps}
        onSelect={() =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    await click(".conversation-picker");
    await key("Enter");
    await key("Escape");
    assert.equal(
      document
        .querySelector(".conversation-popover")
        ?.getAttribute("aria-busy"),
      "true",
    );
    await act(async () => finish!());
    await settle();
    assert.equal(document.querySelector(".conversation-popover"), null);
    await render(
      <ConversationPicker
        {...conversationProps}
        onSelect={async () => {
          throw new Error("switch refused");
        }}
      />,
    );
    await click(".conversation-picker");
    await key("Enter");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /switch refused/,
    );
    assert.ok(document.querySelector(".conversation-popover"));
    console.log(
      "PASS: command pickers navigate long matches, preserve exact model IDs and service scope, respect IME/disabled input, and keep async failures open",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
