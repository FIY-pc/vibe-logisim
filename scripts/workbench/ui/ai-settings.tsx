import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot } from "./themed-root";
import { ProviderSettings } from "../../../apps/workbench/src/conversation/ProviderSettings";
import { ChatGPTLogin } from "../../../apps/workbench/src/conversation/ChatGPTLogin";
import { ModelPicker } from "../../../apps/workbench/src/conversation/ModelPicker";
import { pickOption } from "./workbench";

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
    Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === text,
    )!;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const click = async (element: Element) => {
    await act(async () => {
      assert.ok(element);
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };
  const escape = async (element: Element) => {
    await act(async () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await settle();
  };
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
      services,
      provider: services[0],
      defaultServiceId: "first",
      conversationId: "history-A",
      hasHistory: true,
      busy: false,
      request: request as any,
      onSaved: async () => {},
      onClose: () => {},
    };
    await act(async () => root.render(<ProviderSettings {...props} />));
    assert.ok(
      document.querySelector(
        '.ai-settings-panel[role="dialog"][data-state="open"]',
      ),
    );
    assert.equal(
      container.contains(document.querySelector(".ai-settings-panel")),
      false,
      "Settings remain independent of a collapsed chat sidebar",
    );
    await pickOption("新对话默认服务", "second");
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
      document.body.textContent!,
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
    await click(document.querySelector('button[aria-label="编辑 first"]')!);
    const key = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    assert.equal(key.value, "");
    assert.equal(key.placeholder, "留空保留现有密钥");
    await pickOption("协议", "Responses");
    assert.equal(
      key.placeholder,
      "",
      "a new protocol cannot silently reuse the stored key",
    );
    await pickOption("协议", "Chat Completions");
    assert.equal(key.placeholder, "留空保留现有密钥");
    const endpoint = Array.from(document.querySelectorAll("label"))
      .find((label) => label.firstChild?.textContent === "接口地址")!
      .querySelector("input")!;
    await change(endpoint, "https://third.invalid/v1");
    assert.equal(key.placeholder, "");
    await act(async () => {
      document
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

    await act(async () =>
      root.render(<ProviderSettings {...props} conversationId={null} />),
    );
    assert.equal(
      button("用于此对话").disabled,
      true,
      "Without a conversation a service can only become the default",
    );

    const subscription = {
      ...services[0],
      id: "subscription",
      name: "Subscription",
      auth: "chatgpt" as const,
      account: {
        email: "tester@example.com",
        connected: false,
        planEnabled: false,
      },
    };
    await act(async () =>
      root.render(
        <ProviderSettings {...props} services={[...services, subscription]} />,
      ),
    );
    const serviceList = document.querySelector(".ai-service-options")!;
    assert.ok(
      serviceList.firstElementChild?.querySelector(".ai-chatgpt"),
      "subscription and API services share a list with subscription first",
    );
    assert.match(
      serviceList.lastElementChild?.textContent || "",
      /添加自定义 API/,
    );
    const defaultTrigger = document.querySelector<HTMLElement>(
      '[aria-label="新对话默认服务"]',
    )!;
    await act(async () => {
      defaultTrigger.focus();
      defaultTrigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    assert.equal(
      document.querySelector('[role="option"]')?.textContent,
      "Subscription",
      "default service menu also puts subscription first",
    );
    await escape(document.querySelector('[role="listbox"]')!);
    assert.ok(
      document.querySelector(".ai-settings-panel"),
      "Escape in a select keeps settings open",
    );
    assert.equal(document.activeElement, defaultTrigger);
    await act(async () => root.render(<div />));
    await settle();

    let finishDiscovery: ((result: any) => void) | undefined;
    const delayedRequest = async (method: string, args: any) =>
      method === "discover"
        ? new Promise((resolve) => {
            finishDiscovery = resolve;
          })
        : request(method, args);
    function SettingsLauncher() {
      const [open, setOpen] = useState(false);
      return (
        <dialog open aria-label="课堂设置">
          <button onClick={() => setOpen(true)}>打开设置</button>
          {open && (
            <ProviderSettings
              {...props}
              request={delayedRequest as any}
              onClose={() => setOpen(false)}
            />
          )}
        </dialog>
      );
    }
    await act(async () => root.render(<SettingsLauncher />));
    const opener = button("打开设置");
    await act(async () => opener.focus());
    await click(opener);
    assert.ok(
      document
        .querySelector("dialog[open]")!
        .contains(document.querySelector(".ai-settings-panel")),
      "nested settings stay in the native top layer",
    );
    await click(document.querySelector('[aria-label="编辑 first"]')!);
    await click(button("读取模型列表"));
    assert.ok(button("保存").disabled);
    assert.ok(
      document.querySelector<HTMLButtonElement>('[aria-label="关闭 AI 设置"]')!
        .disabled,
    );
    await escape(document.querySelector(".ai-settings-panel")!);
    assert.ok(
      document.querySelector(".ai-provider-form"),
      "Escape cannot discard a pending configuration operation",
    );
    await act(async () =>
      finishDiscovery!({ ok: true, models: ["alpha", "beta"] }),
    );
    await click(document.querySelector('[aria-label="展开接口模型"]')!);
    assert.ok(
      document
        .querySelector("dialog[open]")!
        .contains(document.querySelector(".ai-provider-model-popover")),
      "nested model popover stays in the native top layer",
    );
    await change(
      document.querySelector('input[aria-label="搜索接口模型"]')!,
      "beta",
    );
    assert.equal(document.querySelectorAll('[role="option"]').length, 1);
    await escape(document.querySelector(".ai-provider-model-popover")!);
    assert.ok(document.querySelector(".ai-provider-form"));
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "展开接口模型",
    );
    await escape(document.querySelector(".ai-settings-panel")!);
    assert.equal(
      document.activeElement?.textContent,
      "模型服务",
      "Escape from edit returns to the service heading",
    );
    await click(document.querySelector('[aria-label="关闭 AI 设置"]')!);
    assert.equal(document.querySelector(".ai-settings-panel"), null);
    assert.equal(
      document.activeElement,
      opener,
      "closing settings restores its opening control",
    );
    await click(opener);
    await escape(document.querySelector(".ai-settings-panel")!);
    assert.equal(document.querySelector(".ai-settings-panel"), null);
    assert.equal(document.activeElement, opener);

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
    await click(document.querySelector('button[aria-haspopup="dialog"]')!);
    assert.deepEqual(listed, [false]);
    assert.match(document.body.textContent!, /128K 上下文 · 图片输入/);
    await change(
      document.querySelector('input[aria-label="搜索模型"]')!,
      "beta",
    );
    assert.equal(document.querySelectorAll('[role="option"]').length, 1);
    await act(async () => {
      document
        .querySelector('input[aria-label="搜索模型"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    assert.equal(document.activeElement?.getAttribute("role"), "option");
    await click(document.activeElement!);
    assert.equal(selected[0].model, "beta");
    assert.equal(
      document.querySelector('.ai-model-popover[role="dialog"]')?.textContent ??
        null,
      null,
    );
    assert.ok(
      document.activeElement ===
        document.querySelector('button[aria-haspopup="dialog"]'),
      `focus is on ${document.activeElement?.outerHTML.slice(0, 120)}`,
    );
    await click(document.querySelector('button[aria-haspopup="dialog"]')!);
    await click(button("刷新列表"));
    assert.equal(listed.at(-1), true);
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /刷新失败/,
    );
    await act(async () => root.render(<ModelPicker {...modelProps} busy />));
    assert.ok(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ).every((option) => option.disabled),
    );
    assert.match(document.body.textContent!, /回答进行中/);
    await act(async () => {
      document.querySelector('.ai-model-popover[role="dialog"]')!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.equal(
      document.querySelector('.ai-model-popover[role="dialog"]')?.textContent ??
        null,
      null,
    );
    await settle();
    let finishSelection: (() => void) | undefined;
    await act(async () =>
      root.render(
        <ModelPicker
          {...modelProps}
          select={async () =>
            new Promise<void>((resolve) => {
              finishSelection = resolve;
            })
          }
        />,
      ),
    );
    await click(document.querySelector('button[aria-haspopup="dialog"]')!);
    await click(document.querySelector('[role="option"]')!);
    assert.ok(
      document.querySelector<HTMLButtonElement>('[aria-label="关闭模型设置"]')!
        .disabled,
    );
    await escape(document.querySelector(".ai-model-popover")!);
    assert.ok(
      document.querySelector(".ai-model-popover"),
      "a pending selection must finish before closing",
    );
    await act(async () => finishSelection!());
    await settle();
    assert.equal(document.querySelector(".ai-model-popover"), null);
    assert.equal(
      document.activeElement,
      document.querySelector('button[aria-haspopup="dialog"]'),
    );
    const oldOpen = window.open;
    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    let loginStatus = "pending",
      saved = 0;
    const loginCalls: { method: string; args: any }[] = [];
    const chatgptRequest = async (method: string, args: any) => {
      loginCalls.push({ method, args });
      if (method === "loginChatGPT")
        return {
          attemptId: "attempt-local",
          url: "https://auth.openai.com/api/accounts/authorize?state=local",
        };
      if (method === "chatGPTLoginStatus")
        return {
          status: loginStatus,
          serviceId: "local-account",
        };
      if (method === "logoutChatGPT")
        return { warning: "已退出本机账号，但未确认远端撤销" };
      return {};
    };
    const loginProps = {
      services: [],
      busy: false,
      request: chatgptRequest as any,
      onSaved: async () => {
        saved++;
      },
    };
    try {
      await act(async () => root.render(<ChatGPTLogin {...loginProps} />));
      await click(button("使用 ChatGPT 订阅"));
      assert.equal(opened.length, 1);
      assert.match(document.body.textContent!, /浏览器中完成登录/);
      await click(button("取消登录"));
      assert.equal(loginCalls.at(-1)?.method, "cancelChatGPTLogin");
      assert.equal(saved, 0);
      loginStatus = "complete";
      await click(button("使用 ChatGPT 订阅"));
      assert.equal(saved, 1);
      const signedIn = {
        ...services[0],
        id: "local-account",
        auth: "chatgpt" as const,
        account: {
          email: "tester@example.com",
          connected: true,
          planEnabled: true,
        },
      };
      await act(async () =>
        root.render(<ChatGPTLogin {...loginProps} services={[signedIn]} />),
      );
      await click(button("退出登录"));
      assert.equal(loginCalls.at(-1)?.method, "logoutChatGPT");
      assert.match(document.body.textContent!, /未确认远端撤销/);
      loginStatus = "pending";
      await click(button("使用 ChatGPT 订阅"));
      await act(async () => root.render(<div />));
      assert.equal(
        loginCalls.at(-1)?.method,
        "cancelChatGPTLogin",
        "closing settings cancels the pending callback",
      );
    } finally {
      window.open = oldOpen;
    }
    console.log(
      "PASS: settings keep defaults separate from conversation bindings; model picker preserves search, refresh warnings, keyboard navigation and busy state",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
