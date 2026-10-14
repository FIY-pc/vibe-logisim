import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProviderSettings } from "../../../apps/workbench/src/components/ProviderSettings";
import { ModelPicker } from "../../../apps/workbench/src/components/ModelPicker";

export async function verifyAISettings() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: { method: string; args: any }[] = [];
  const services = ["first", "second"].map((id) => ({
    id,
    name: id,
    baseUrl: `https://${id}.invalid/v1`,
    api: "openai-completions",
    model: "fixture",
    effort: "none",
    contextWindow: 256000,
    vision: false,
    apiKeyHint: "saved",
  }));
  const request = async (method: string, args: any) => {
    calls.push({ method, args });
    return { ok: true };
  };
  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === text,
    )!;
  const click = (element: Element) =>
    act(async () => {
      assert.ok(element);
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const change = (
    element: HTMLInputElement | HTMLSelectElement,
    value: string,
  ) =>
    act(async () => {
      const prototype =
        element.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(
        new Event(element.tagName === "SELECT" ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  try {
    const props = {
      runtime: "builtin" as const,
      services,
      provider: services[0],
      defaultServiceId: "first",
      defaultRuntime: "builtin" as const,
      conversationId: "history-A",
      hasHistory: true,
      busy: false,
      canImport: true,
      request: request as any,
      onRuntime: async (runtime: string) => {
        calls.push({ method: "runtime", args: { runtime } });
      },
      onLogin: () => {},
      onImport: () => {},
      onSaved: async () => {},
      onClose: () => {},
    };
    await act(async () => root.render(<ProviderSettings {...props} />));
    assert.equal(container.querySelector("dialog")?.open, true);
    await change(
      container.querySelector('select[aria-label="新对话默认服务"]')!,
      "second",
    );
    assert.deepEqual(calls.at(-1), {
      method: "defaultProvider",
      args: { id: "second" },
    });
    assert.equal(
      calls.some((call) => call.method === "bindProvider"),
      false,
    );
    await click(button("用于此对话"));
    assert.match(
      container.textContent!,
      /已有历史将随下一次提问发送给这个服务/,
    );
    assert.equal(
      calls.some((call) => call.method === "bindProvider"),
      false,
    );
    await click(button("更换服务"));
    assert.deepEqual(calls.at(-1), {
      method: "bindProvider",
      args: {
        id: "second",
        baseUrl: "https://second.invalid/v1",
        api: "openai-completions",
        conversationId: "history-A",
      },
    });
    await click(button("运行时"));
    await change(
      container.querySelector('select[aria-label="新对话默认运行时"]')!,
      "codex",
    );
    assert.equal(calls.at(-1)?.method, "defaultRuntime");
    assert.equal(
      calls.some((call) => call.method === "runtime"),
      false,
    );
    await click(button("用 Codex 新建对话"));
    assert.deepEqual(calls.at(-1), {
      method: "runtime",
      args: { runtime: "codex" },
    });
    await click(button("模型服务"));
    await click(container.querySelector('button[aria-label="编辑 first"]')!);
    const key = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    assert.equal(key.value, "");
    assert.equal(key.placeholder, "留空保留现有密钥");
    const endpoint = Array.from(container.querySelectorAll("label"))
      .find((label) => label.firstChild?.textContent === "接口地址")!
      .querySelector("input")!;
    await change(endpoint, "https://third.invalid/v1");
    assert.equal(key.placeholder, "");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    assert.equal(calls.at(-1)?.method, "configure");
    assert.equal(calls.at(-1)?.args.apiKey, "");
    assert.equal(
      calls.filter((call) => call.method === "bindProvider").length,
      1,
      "saving service settings must not rebind history",
    );

    const listed: boolean[] = [],
      selected: any[] = [];
    const entries = [
      {
        model: "alpha",
        name: "Alpha",
        metadata: { contextWindow: 128000, vision: true, source: "fixture" },
      },
      { model: "beta", name: "Beta", description: "Other model" },
    ];
    const modelProps = {
      scope: "service:first",
      model: "alpha",
      disabled: false,
      busy: false,
      load: async (refresh: boolean) => {
        listed.push(refresh);
        return {
          models: entries,
          warning: refresh ? "服务列表刷新失败，保留已有列表。" : null,
        };
      },
      select: async (model: any) => {
        selected.push(model);
      },
    };
    await act(async () => root.render(<ModelPicker {...modelProps} />));
    await click(container.querySelector('button[aria-haspopup="dialog"]')!);
    assert.deepEqual(listed, [false]);
    assert.match(container.textContent!, /128K 上下文 · 图片输入/);
    await change(
      container.querySelector('input[aria-label="搜索模型"]')!,
      "beta",
    );
    assert.equal(container.querySelectorAll('[role="option"]').length, 1);
    await act(async () => {
      container
        .querySelector('input[aria-label="搜索模型"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    assert.equal(document.activeElement?.getAttribute("role"), "option");
    await click(document.activeElement!);
    assert.equal(selected[0].model, "beta");
    assert.equal(container.querySelector("dialog"), null);
    assert.equal(
      document.activeElement,
      container.querySelector('button[aria-haspopup="dialog"]'),
    );
    await click(container.querySelector('button[aria-haspopup="dialog"]')!);
    await click(button("刷新列表"));
    assert.equal(listed.at(-1), true);
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /刷新失败/,
    );
    await act(async () => root.render(<ModelPicker {...modelProps} busy />));
    assert.ok(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ).every((option) => option.disabled),
    );
    assert.match(container.textContent!, /回答进行中/);
    await act(async () => {
      container
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    assert.equal(container.querySelector("dialog"), null);
    console.log(
      "PASS: settings keep defaults separate from conversation bindings; model picker preserves search, refresh warnings, keyboard navigation and busy state",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
