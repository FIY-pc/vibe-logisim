import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { Workbench } from "./workbench";
import { useWorkbench } from "../../../apps/workbench/src/app/provider";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { Files } from "../../../apps/workbench/src/workspace/Files";

export async function verifyChatAttachments() {
  const globals = globalThis as any;
  const previous = {
    command: globals.__command,
    subscribe: globals.__subscribe,
    desktop: globals.__desktop,
    invoke: globals.__nativeInvoke,
    point: document.elementFromPoint,
    clipboard: Object.getOwnPropertyDescriptor(navigator, "clipboard"),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const folder = {
    id: "chat-attachments",
    path: "/fixture/attachments",
    name: "attachments",
  };
  const doc = {
    id: "attachments-doc",
    name: "main.circ",
    path: folder.path + "/main.circ",
    revision: "r1",
    main: "main",
    circuits: [],
  };
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=";
  const refs = new Map<string, any>();
  const calls: any[] = [],
    errors: unknown[] = [],
    messages: any[] = [];
  let clipboard = "",
    rejectSend: ((reason: unknown) => void) | undefined;
  let failNext = false;
  const state = () => ({
    eventCursor: 0,
    available: true,
    busy: false,
    status: "idle",
    messages,
    conversationId: "attachments-conversation",
    model: "fixture",
    services: [{ id: "fixture" }],
  });
  globals.__desktop = true;
  globals.__subscribe = () => () => {};
  globals.__nativeInvoke = async (name: string) => {
    if (name === "read_chat_image")
      return { name: "native.png", mime: "image/png", data: png };
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboard = value;
      },
      readText: async () => clipboard,
    },
  });
  globals.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "folderList")
      return {
        folder,
        entries: [
          { name: "notes.txt", path: "notes.txt", directory: false, size: 4 },
        ],
      };
    if (request.op === "folderRead")
      return { text: "file evidence", revision: "r1" };
    if (request.method === "conversations") return { conversations: [] };
    if (request.method === "stageReferences")
      return request.args.references.map((input: any) => {
        const id = crypto.randomUUID();
        const record = { ...input, id, hasImage: !!input.image };
        refs.set(id, record);
        const { image: _image, text: _text, ...summary } = record;
        return summary;
      });
    if (request.method === "readReferences")
      return request.args.ids.map((id: string) => refs.get(id));
    if (request.method === "ask") {
      if (failNext) {
        failNext = false;
        await new Promise((_, reject) => {
          rejectSend = reject;
        });
      }
      messages.push({
        id: crypto.randomUUID(),
        type: "user",
        text: request.args.question,
        canEdit: true,
        context: {
          references: request.args.references.map((id: string) => {
            const { image: _image, text: _text, ...summary } = refs.get(id);
            return summary;
          }),
        },
      });
    }
    return state();
  };
  function Fixture({ generation = 0 }: { generation?: number }) {
    const workbench = useWorkbench();
    return (
      <>
        <Files
          folder={folder}
          onFolder={() => {}}
          onOpen={() => {}}
          onPreview={() => {}}
          onError={(error) => errors.push(error)}
          onRename={async () => {}}
          onCopyFile={workbench.stores.files.getState().setCopiedFile}
        />
        <Chat
          key={generation}
          visible
          doc={doc as any}
          folder={folder}
          circuit="main"
          selection={[]}
          quotation={null}
          onQuoted={() => {}}
          onError={(error) => errors.push(error)}
          onFilesChanged={async () => {}}
        />
      </>
    );
  }
  const render = (generation = 0) =>
    act(async () =>
      root.render(
        <Workbench>
          <Fixture generation={generation} />
        </Workbench>,
      ),
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  const input = () =>
    container.querySelector<HTMLTextAreaElement>('[aria-label="消息"]')!;
  const send = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
  const paste = async (text: string, files: File[] = []) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files, getData: () => text },
    });
    await act(async () => {
      input().dispatchEvent(event);
    });
    await settle();
    return event.defaultPrevented;
  };
  const type = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await render();
    await settle();
    const row = container.querySelector<HTMLElement>(
      '[data-file-path="notes.txt"] button',
    )!;
    assert(row);
    await act(async () => {
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "c",
          ctrlKey: !/Mac/.test(navigator.platform),
          metaKey: /Mac/.test(navigator.platform),
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Platform shortcuts use one modifier; dispatch the platform's form.
    if (!clipboard)
      await act(async () =>
        row.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "c",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    assert.equal(clipboard, folder.path + "/notes.txt");
    assert(
      await paste(clipboard),
      "A copied project resource is handled as a reference",
    );
    assert.equal(input().value, "");
    assert(container.querySelector('[aria-label="取消引用 notes.txt"]'));
    assert.equal(
      await paste("ordinary text"),
      false,
      "Ordinary text stays on the browser's normal paste path",
    );
    const screenshot = new File(
      [Buffer.from(png, "base64")],
      "screenshot.png",
      { type: "image/png" },
    );
    assert(await paste("", [screenshot]));
    assert.equal(
      container.querySelectorAll(".is-draft .reference-thumbnail").length,
      1,
    );
    assert.equal(
      send().disabled,
      false,
      "Attachments can be sent without text",
    );
    failNext = true;
    await act(async () => send().click());
    assert(rejectSend);
    await type("next draft");
    await act(async () => rejectSend!(new Error("fixture: send refused")));
    await settle();
    assert.equal(
      input().value,
      "next draft",
      "A failed image send preserves subsequently typed text",
    );
    assert(container.querySelector('[aria-label="取消引用 screenshot.png"]'));
    assert(container.querySelector('[aria-label="取消引用 notes.txt"]'));
    assert(errors.some((error) => String(error).includes("send refused")));
    await type("");
    await act(async () => send().click());
    await settle();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "");
    assert.equal(messages[0].context.references.length, 2);
    assert.equal(
      container.querySelectorAll(".is-draft .reference-thumbnail").length,
      0,
    );
    await render(1);
    await settle();
    assert.equal(
      container.querySelectorAll(".message.user .reference-thumbnail").length,
      1,
      "Reopened history resolves the saved image from its reference ID",
    );
    // Native drop and DOM paste must use the same staging path, without importing to the project.
    document.elementFromPoint = () => input();
    await act(async () =>
      globals.__fileDropHandler({
        payload: {
          type: "drop",
          paths: ["/outside/native.png"],
          position: { x: 10, y: 10 },
        },
      }),
    );
    await settle();
    assert(container.querySelector('[aria-label="取消引用 native.png"]'));
    assert(
      !calls.some((call) => call.op === "folderImportPrepare"),
      "Chat image drops do not write project files",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="取消引用 native.png"]')!
        .click(),
    );
    await settle();
    assert.equal(send().disabled, true);
    console.log(
      "PASS: file-tree copy becomes a chat reference; screenshot and native image drop share attachments, image-only sends recover on failure and survive history reload without project writes",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globals.__command = previous.command;
    globals.__subscribe = previous.subscribe;
    globals.__desktop = previous.desktop;
    globals.__nativeInvoke = previous.invoke;
    document.elementFromPoint = previous.point;
    if (previous.clipboard)
      Object.defineProperty(navigator, "clipboard", previous.clipboard);
    else delete (navigator as any).clipboard;
    localStorage.removeItem(
      "vibe.draft:chat-attachments:attachments-conversation",
    );
    localStorage.removeItem(
      "vibe.draft:chat-attachments:attachments-conversation:references",
    );
  }
}
