import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "../../../apps/workbench/src/design/foundations.css";
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
  review: [
    {
      id: "review-user",
      type: "user",
      text: "把非门和输入、输出一起改成 8 位。",
    },
    { id: "review-turn", type: "turn", status: "completed", elapsedMs: 21000 },
    {
      id: "review-note",
      type: "assistant",
      phase: "commentary",
      text: "我先看看电路，把非门和输入、输出一起改成 8 位。",
    },
    ...["查看电路", "修改元件属性", "检查输入输出"].map((label, index) => ({
      id: "review-tool-" + index,
      type: "activity",
      label,
      status: "completed",
      resultStatus: "completed",
      activityKey:
        "tool:" +
        ["inspect_circuit", "set_attributes", "simulate_circuit"][index],
      toolOutput: {
        type: "tool",
        target: "main",
        text: [
          "输入 A → 非门 → 输出 Y",
          "A、非门、Y 的位宽已设为 8",
          "4 组输入输出全部通过",
        ][index],
      },
    })),
    {
      id: "review-answer",
      type: "assistant",
      phase: "final",
      text: "已改成 **8 位非门电路**并保存，输入 A、非门和输出 Y 均为 8 位，原有连线保持不变，无位宽冲突。\n\n已通过 4 组仿真测试，例如：\n\n- `00000000` → `11111111`\n- `01010101` → `10101010`\n\n实现的是 **8 位逐位取反**。",
    },
  ],
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
            minWidth: 0,
            maxWidth: "100%",
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
