import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../../../apps/workbench/src/style.css";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import type { Message } from "../../../apps/workbench/src/conversation/ConversationContent";
import {
  WorkbenchProvider,
  useOwnWorkbench,
} from "../../../apps/workbench/src/app/provider";

// Synthetic history exercises the actual Chat event path without a model or host.
const listeners = new Set<(event: unknown) => void>();
const histories: Record<string, Message[]> = {
  long: Array.from({ length: 600 }, (_, i) => [
    {
      id: `q-${i}`,
      type: "user",
      text: `Question ${i}`,
      canEdit: true,
      context: {
        documentId: "fixture-document",
        circuit: `circuit-${i}`,
        selection: [],
      },
    },
    { id: `turn-${i}`, type: "turn", status: "completed", elapsedMs: 1200 },
    { id: `thought-${i}`, type: "reasoning", text: `Reasoning ${i}` },
    {
      id: `tool-${i}`,
      type: "activity",
      status: "completed",
      label: `Read ${i}`,
      activityKey: "tool:read_file",
      toolOutput: {
        type: "file",
        target: "notes.txt",
        text: `Tool output ${i}`,
      },
    },
    {
      id: `answer-${i}`,
      type: "assistant",
      text: `Answer ${i}\n\n${"A variable length explanation. ".repeat(2 + (i % 8))}\n\n[Open notes](./notes.txt)`,
    },
  ]).flat(),
  other: [
    { id: "other-question", type: "user", text: "Another conversation" },
    { id: "other-answer", type: "assistant", text: "Another answer" },
  ],
  empty: [],
};
let active = "long",
  busy = false,
  sequence = 0,
  liveId = 0;
const emit = (event: unknown) => {
  sequence++;
  for (const listener of listeners)
    listener({ topic: "agent", data: { sequence, event } });
};
const state = () => ({
  eventCursor: sequence,
  status: "ready",
  available: true,
  busy,
  conversationId: active,
  services: [{ id: "fixture", name: "Fixture" }],
  model: "fixture",
  messages: histories[active],
});
const status = () => emit({ type: "status", ...state() });
const start = () => {
  liveId++;
  busy = true;
  histories[active] = [
    ...histories[active],
    { id: `live-user-${liveId}`, type: "user", text: "Stream a long answer" },
    {
      id: `live-turn-${liveId}`,
      type: "turn",
      status: "running",
      startedAt: Date.now(),
    },
    {
      id: `live-answer-${liveId}`,
      type: "assistant",
      text: "Streaming answer",
    },
  ];
  emit({ type: "history", messages: histories[active] });
  status();
};
const stream = async (count: number) => {
  for (let i = 0; i < count; i++) {
    const id = `live-answer-${liveId}`,
      delta = `\n\nStream paragraph ${i}. ${"Text grows while the reader can look back. ".repeat(3)}`;
    histories[active] = histories[active].map((m) =>
      m.id === id ? { ...m, text: m.text + delta } : m,
    );
    emit({ type: "assistant-delta", itemId: id, delta });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};
const finish = () => {
  busy = false;
  const turn = {
    ...histories[active].find((m) => m.id === `live-turn-${liveId}`)!,
    status: "completed",
  };
  histories[active] = histories[active].map((m) =>
    m.id === turn.id ? turn : m,
  );
  emit({ type: "message", message: turn });
  status();
};
let releaseBind: (() => void) | undefined;
const globals = globalThis as any;
globals.__subscribe = (listener: (event: unknown) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
globals.__command = async (request: any) => {
  if (request.method === "bind")
    await new Promise<void>((resolve) => {
      releaseBind = resolve;
      setTimeout(resolve, 150);
    });
  if (request.method === "models") return { models: [] };
  if (request.method === "conversations") {
    if (request.args?.action === "select") active = request.args.id;
    return {
      conversations: Object.keys(histories).map((id) => ({
        id,
        title: id,
        archived: false,
      })),
    };
  }
  if (request.method === "ask") start();
  return state();
};
function Fixture() {
  const workbench = useOwnWorkbench();
  const [visible, setVisible] = useState(true),
    [generation, setGeneration] = useState(0);
  const errors: string[] = globals.fixture?.errors ?? [];
  globals.fixture = {
    errors,
    start,
    stream,
    finish,
    setVisible,
    remount: () => setGeneration((n) => n + 1),
    release: () => releaseBind?.(),
    followed: globals.fixture?.followed,
  };
  return (
    <Theme
      style={{ height: "100vh", display: "flex", justifyContent: "center" }}
    >
      <WorkbenchProvider value={workbench}>
        <div
          style={{
            width: 440,
            height: "100%",
            display: "flex",
            background: "white",
          }}
        >
          <Chat
            key={generation}
            visible={visible}
            doc={null}
            folder={{ id: "fixture-folder", path: "/project", name: "project" }}
            circuit={null}
            selection={[]}
            quotation={null}
            onQuoted={() => {}}
            onFilesChanged={async () => {}}
            onError={(error) => errors.push(String(error))}
            onFollowReference={(href, message) => {
              globals.fixture.followed = { href, message };
            }}
          />
        </div>
      </WorkbenchProvider>
    </Theme>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
