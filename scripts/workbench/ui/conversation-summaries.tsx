import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { clickMenuItem, openMenu, Workbench } from "./workbench";

export async function verifyConversationSummaries() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    globals = globalThis as any;
  const old = { command: globals.__command, subscribe: globals.__subscribe };
  const listeners = new Set<any>(),
    errors: unknown[] = [];
  const records: Record<string, { title: string; custom: boolean }> = {
    "summary-A": { title: "新对话", custom: false },
    "summary-B": { title: "B 的对话", custom: false },
  };
  let bound = "summary-A",
    sequence = 0,
    holdList = false;
  let releaseList: (() => void) | undefined;
  let releaseBind: (() => void) | undefined;
  const summaries = (key: string) => ({
    workspaceKey: key,
    conversations: [
      { id: key + ":conversation", title: records[key].title, archived: false },
    ],
  });
  const state = () => ({
    eventCursor: sequence,
    runtime: "builtin",
    status: "idle",
    available: true,
    busy: false,
    messages: [],
    model: "fixture",
    effort: "none",
    services: [{ id: "fixture" }],
    conversationId: bound + ":conversation",
  });
  const emit = (event: any) => {
    const envelope = { topic: "agent", data: { sequence: ++sequence, event } };
    for (const listener of listeners) listener(envelope);
  };
  globals.__subscribe = (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  globals.__command = async (request: any) => {
    if (request.method === "bind") {
      if (request.args.documentId === "summary-B")
        await new Promise<void>((resolve) => {
          releaseBind = resolve;
        });
      bound = request.args.documentId;
    }
    if (request.method === "ask") {
      // The persisted title is authoritative; sending does not emit a list event.
      if (!records[bound].custom) records[bound].title = "服务端生成的首问标题";
      return {};
    }
    if (request.method === "conversations") {
      if (request.args?.action === "rename") {
        records[bound] = { title: request.args.title, custom: true };
        emit({ type: "conversations-changed", ...summaries(bound) });
      }
      const snapshot = summaries(bound);
      if (holdList && !request.args?.action) {
        holdList = false;
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
      }
      return snapshot;
    }
    return state();
  };
  const render = (id: string) =>
    act(async () =>
      root.render(
        <Workbench>
          <Chat
            visible
            doc={
              {
                id,
                path: null,
                revision: "r1",
                main: "main",
                circuits: [],
              } as any
            }
            folder={null}
            circuit="main"
            selection={[]}
            quotation={null}
            onQuoted={() => {}}
            onDocument={() => {}}
            onOpened={() => {}}
            onFilesChanged={async () => {}}
            onError={(error) => errors.push(error)}
          />
        </Workbench>,
      ),
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const title = () =>
    container.querySelector(".conversation-picker > span")?.textContent;
  const input = (
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) =>
    act(async () => {
      const prototype =
        element.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const send = async () => {
    await input(container.querySelector("textarea")!, "解释这个电路");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
        .click(),
    );
    await settle();
  };
  try {
    await render("summary-A");
    await settle();
    assert.equal(title(), "新对话");
    await send();
    assert.equal(
      title(),
      "服务端生成的首问标题",
      "The first ask refreshes the persisted summary without switching documents or restarting",
    );

    await openMenu("对话操作", container);
    await clickMenuItem("重命名…");
    await input(
      container.querySelector('input[aria-label="重命名对话"]')!,
      "我命名的对话",
    );
    await act(async () =>
      container
        .querySelector("dialog form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await settle();
    await send();
    assert.equal(
      title(),
      "我命名的对话",
      "Asking again must keep the server's custom title",
    );

    holdList = true;
    await send();
    assert(
      releaseList,
      "The ask must request summaries even when no conversation event is emitted",
    );
    await act(async () => {
      records[bound] = { title: "更新后的自定义标题", custom: true };
      emit({ type: "conversations-changed", ...summaries(bound) });
      releaseList!();
    });
    await settle();
    assert.equal(
      title(),
      "更新后的自定义标题",
      "A late list snapshot cannot undo a newer rename event",
    );

    records[bound].title = "等待回包的 A 摘要";
    holdList = true;
    await send();
    assert(releaseList);
    await render("summary-B");
    const beforeReply = title();
    await act(async () => {
      emit({
        type: "conversations-changed",
        workspaceKey: "summary-A",
        conversations: [
          {
            id: "summary-A:conversation",
            title: "迟到的 A 标题",
            archived: false,
          },
        ],
      });
    });
    assert.equal(
      title(),
      beforeReply,
      "An event from the previous workspace is ignored",
    );
    await act(async () => releaseList!());
    await settle();
    assert(
      releaseBind,
      "B binding waits until the queued A request has completed",
    );
    assert.equal(
      title(),
      beforeReply,
      "A delayed list cannot change summaries after switching workspace",
    );
    await act(async () => releaseBind!());
    await settle();
    assert.equal(title(), "B 的对话");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: first questions refresh persisted conversation titles; custom names and newer/workspace-scoped summaries are preserved",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globals.__command = old.command;
    globals.__subscribe = old.subscribe;
    for (const key of Object.keys(records))
      localStorage.removeItem(
        "vibe.draft:" + key + ":" + key + ":conversation",
      );
  }
}
