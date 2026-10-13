import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/components/Chat";
const { backend, nativeWrites, dispatch, notify } = (globalThis as any)
  .__questionFixture;
const subscribers = new Set<any>();
let sequence = 0;
const errors: Error[] = [];
const state = () => ({
  ...backend.snapshot(),
  runtime: "codex",
  eventCursor: sequence,
  messages: [],
  services: [],
  conversationId: "conversation",
});
(globalThis as any).__subscribe = (fn: any) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
(globalThis as any).__command = async (request: any) => {
  if (request.method === "answer")
    return dispatch(request.method, request.args);
  if (request.method === "conversations") return { conversations: [] };
  return state();
};
backend.on("event", (event: any) => {
  const data = {
    sequence: ++sequence,
    event: event.type === "status" ? { ...event, ...state() } : event,
  };
  for (const fn of subscribers) fn({ topic: "agent", data });
});
const begin = () => {
  backend.threadId = "synthetic-thread";
  backend.workspaceKey = "document";
  backend.activeTurnId = "synthetic-turn";
  backend.activeTurnEpoch = backend.workspaceEpoch;
  backend.pendingTurn = {
    threadId: backend.threadId,
    turnId: backend.activeTurnId,
    epoch: backend.workspaceEpoch,
    childEpoch: backend.childEpoch,
  };
};
const question = async (id: string) =>
  act(async () => {
    notify({
      id,
      method: "item/tool/requestUserInput",
      params: {
        threadId: backend.threadId,
        turnId: backend.activeTurnId,
        questions: [
          {
            id: "choice",
            question: "Which synthetic circuit?",
            options: [{ label: "Counter" }, { label: "Adder" }],
          },
        ],
      },
    });
  });
const root = createRoot(document.getElementById("root")!);
const doc: any = {
  id: "document",
  name: "synthetic.circ",
  main: "main",
  revision: "synthetic-revision",
  path: null,
  circuits: [],
};
await act(async () => {
  root.render(
    <Chat
      visible
      doc={doc}
      circuit="main"
      folder={null}
      selection={[]}
      quotation={null}
      onQuoted={() => {}}
      onDocument={() => {}}
      onError={(e) => errors.push(e as Error)}
    />,
  );
});
await act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});
begin();
await question("request-1");
assert.match(
  document.querySelector(".agent-questions")!.textContent!,
  /Which synthetic circuit/,
);
assert.equal(
  document.querySelector("datalist option")!.getAttribute("value"),
  "Counter",
);
const submit = async (value: string) =>
  act(async () => {
    const form = document.querySelector<HTMLFormElement>(".agent-questions")!;
    form.querySelector("input")!.value = value;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
await submit("Adder");
assert.deepEqual(
  nativeWrites.find((m: any) => m.id === "request-1"),
  { id: "request-1", result: { answers: { choice: { answers: ["Adder"] } } } },
);
assert.equal(document.querySelector(".agent-questions"), null);
await assert.rejects(
  dispatch("answer", {
    requestId: "request-1",
    answers: { choice: "Counter" },
  }),
  /已经过期/,
);
assert.equal(nativeWrites.filter((m: any) => m.id === "request-1").length, 1);

await question("request-stopped");
await act(async () => {
  await backend.interrupt();
});
const beforeStale = nativeWrites.length;
await submit("Counter");
assert.match(errors.at(-1)!.message, /已经过期/);
assert.equal(
  nativeWrites.length,
  beforeStale,
  "A response cannot pass after stop, even before the completion event",
);
await act(async () => {
  notify({
    method: "turn/completed",
    params: {
      threadId: backend.threadId,
      turn: { id: backend.activeTurnId, status: "interrupted" },
    },
  });
});
assert.equal(
  document.querySelector(".agent-questions"),
  null,
  "Completion removes its obsolete form",
);

begin();
await question("request-switched");
backend.workspaceEpoch++;
const beforeSwitch = nativeWrites.length;
await assert.rejects(
  dispatch("answer", {
    requestId: "request-switched",
    answers: { choice: "Adder" },
  }),
  /已经过期/,
);
assert.equal(nativeWrites.length, beforeSwitch);
await act(async () => root.unmount());
console.log(
  "Question replay: native event → Chat form → worker dispatch → correctly shaped native answer; duplicate, stopped and switched requests rejected; model calls: 0",
);
