import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { Workbench } from "./workbench";

/** A conversation driven the way the runtime drives it: a turn's steps show
 * as they happen, fold into one summary line when it ends, and a window opened
 * from the status snapshot shows exactly what the live one shows. */
export async function verifyConversationTurns() {
  const globals = globalThis as any;
  const old = { command: globals.__command, subscribe: globals.__subscribe };
  const listeners = new Set<(event: any) => void>();
  const calls: any[] = [],
    errors: any[] = [];
  const folder = { id: "turns-folder", path: "/project", name: "project" };
  const doc: any = {
    id: "turns",
    name: "adder.circ",
    path: "/project/adder.circ",
    revision: "r1",
    main: "main",
    circuits: [],
  };
  const draftKey = "vibe.draft:" + folder.id + ":turns";
  let sequence = 1000,
    busy = false,
    history: any[] = [],
    transmission: { phase: string; message: string } | null = null,
    turns = 0,
    turnId = "",
    filesChanged = 0,
    refuseAsk = "",
    releaseStop: (() => void) | null = null;

  // ---- the runtime side --------------------------------------------------
  const snapshot = () => ({
    status: busy ? "busy" : "ready",
    available: true,
    busy,
    conversationId: "turns",
    model: "fixture",
    effort: null,
    services: [{ id: "fixture" }],
    messages: history.map((m) => ({
      ...JSON.parse(JSON.stringify(m)),
      canEdit: m.type === "user",
    })),
    transmission,
  });
  // A lost event advances the sequence without reaching the window.
  const emit = (event: any, lost = false) => {
    sequence += 1;
    if (lost) return;
    const data = { sequence, event: JSON.parse(JSON.stringify(event)) };
    for (const listener of [...listeners]) listener({ topic: "agent", data });
  };
  const emitStatus = () => emit({ type: "status", ...snapshot() });
  const startTurn = (question: string) => {
    turns += 1;
    turnId = "turn-" + turns;
    const id = "user-" + turns,
      context = { documentId: doc.id, circuit: "main", selection: [] };
    history.push({ type: "user", id, text: question, context });
    emit({ type: "user-message", id, text: question, context, canEdit: true });
    history.push({
      type: "turn",
      id: turnId,
      status: "running",
      startedAt: Date.now(),
    });
    busy = true;
    emitStatus();
    emit({ type: "turn-started", turnId });
  };
  const say = (
    id: string,
    delta: string,
    kind: "assistant" | "reasoning" = "assistant",
    lost = false,
  ) => {
    const itemId = kind === "reasoning" ? id + ":reasoning" : id;
    let item = history.find((m) => m.id === itemId);
    if (!item) {
      item = { type: kind, id: itemId, text: "" };
      history.push(item);
    }
    item.text += delta;
    emit({ type: kind + "-delta", itemId, turnId, delta }, lost);
  };
  const finish = (id: string, phase: "commentary" | "final") => {
    const thought = history.find((m) => m.id === id + ":reasoning");
    if (thought)
      emit({
        type: "assistant-completed",
        itemId: thought.id,
        turnId,
        text: thought.text,
        phase: "commentary",
      });
    const item = history.find((m) => m.id === id);
    if (item) item.phase = phase;
    emit({
      type: "assistant-completed",
      itemId: id,
      turnId,
      text: item?.text ?? "",
      phase,
    });
  };
  const tool = (
    callId: string,
    name: string,
    label: string,
    input: any,
    result?: string,
  ) => {
    const id = turnId + ":" + callId;
    let item = history.find((m) => m.id === id);
    if (!item) {
      item = {
        type: "activity",
        id,
        itemId: callId,
        turnId,
        kind: "tool",
        label,
        activityKey: "tool:" + name,
      };
      history.push(item);
    }
    Object.assign(item, {
      status: result === undefined ? "running" : "completed",
      input: JSON.stringify(input),
      detail: JSON.stringify(input),
      toolOutput: {
        type: "tool",
        target: "",
        input,
        text: result ?? "",
        exitCode: null,
        truncated: false,
      },
    });
    emit(item);
  };
  const endTurn = (status: string, error: string | null, change?: any) => {
    if (change)
      emit({
        type: "files-changed",
        folderId: folder.id,
        conversationId: "turns",
        change,
      });
    busy = false;
    const turn = history.find((m) => m.id === turnId);
    Object.assign(turn, {
      status,
      error,
      elapsedMs: 47_000,
      ...(change ? { change } : {}),
    });
    emit({ type: "message", message: turn });
    for (const m of history)
      if (
        m.type === "activity" &&
        m.turnId === turnId &&
        m.status === "running"
      ) {
        Object.assign(m, { status: "warning", resultStatus: "unknown" });
        emit(m);
      }
    transmission = null;
    emitStatus();
    emit({ type: "turn-completed", turnId, status, error });
  };
  globals.__subscribe = (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  globals.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "folderHistoryUndo") return { restored: [] };
    const args = request.args || {};
    switch (request.method) {
      case "conversations":
        return {
          conversations: [{ id: "turns", title: "改名", archived: false }],
        };
      case "models":
        return { models: [] };
      case "ask":
        if (refuseAsk) {
          const message = refuseAsk;
          refuseAsk = "";
          throw new Error(message);
        }
        if (args.editMessageId) {
          history = history.slice(
            0,
            history.findIndex((m) => m.id === args.editMessageId),
          );
          emit({ type: "history", messages: history });
        }
        startTurn(args.question);
        return { turnId };
      case "stop":
        await new Promise<void>((resolve) => (releaseStop = resolve));
        return { interrupted: true };
      case "markUndone": {
        const turn = history.find((m) => m.change?.id === args.changeId);
        turn.change = { ...turn.change, undone: true };
        emit({ type: "message", message: turn });
        return { undone: true };
      }
    }
    return { ...snapshot(), eventCursor: sequence };
  };

  // ---- the window side ---------------------------------------------------
  const settle = async () => {
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
  };
  const mount = async (container: HTMLElement) => {
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <Workbench>
          <Chat
            visible
            doc={doc}
            folder={folder}
            circuit="main"
            selection={[]}
            quotation={null}
            onQuoted={() => {}}
            onFilesChanged={async () => {
              filesChanged += 1;
            }}
            onError={(error) => errors.push(error)}
          />
        </Workbench>,
      ),
    );
    await settle();
    return root;
  };
  const view = document.createElement("div");
  document.body.append(view);
  const $ = (selector: string, node: ParentNode = view) =>
    node.querySelector<HTMLElement>(selector);
  const $$ = (selector: string, node: ParentNode = view) => [
    ...node.querySelectorAll<HTMLElement>(selector),
  ];
  const box = () => $('textarea[aria-label="消息"]') as HTMLTextAreaElement;
  const occurrences = (text: string) =>
    view.textContent!.split(text).length - 1;
  const asks = () => calls.filter((call) => call.method === "ask");
  // The conversation as shown, without the running turn's clock.
  const shown = (container: HTMLElement) => {
    const copy = $(".messages-content", container)!.cloneNode(
      true,
    ) as HTMLElement;
    for (const node of copy.querySelectorAll(".turn-live")) node.remove();
    return copy.innerHTML;
  };
  const step = async (work: () => void) => {
    await act(async () => work());
    await settle();
  };
  const click = async (target: string | HTMLElement) => {
    const node = typeof target === "string" ? $(target) : target;
    assert(node, String(target));
    await act(async () => node.click());
    await settle();
  };
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(box(), value);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const enter = async (shiftKey = false) => {
    await act(async () => {
      box().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
  };
  let root = await mount(view);
  try {
    // ---- a running turn shows every step as it happens -------------------
    assert.equal($$(".turn").length, 0);
    await type("把输出引脚改名为 sum");
    await enter(true);
    assert.equal(asks().length, 0, "Shift+Enter starts a new line");
    await enter();
    assert.equal(asks().length, 1, "Enter sends");
    assert.match($(".message.user")!.textContent!, /把输出引脚改名为 sum/);
    assert.equal(box().value, "", "The sent draft is consumed");
    assert($('button[aria-label="停止回答"]'), "A running turn can be stopped");
    assert.equal($('button[aria-label="发送"]'), null);
    assert.match($(".turn-live")!.textContent!, /正在处理/);
    assert.equal($(".turn-summary"), null, "Steps stay open while running");

    await step(() => {
      say("m1", "先确认", "reasoning");
      say("m1", "输出引脚。", "reasoning");
      say("m1", "我先看");
      say("m1", "一下电路。");
    });
    assert.match(
      $(".turn-thought[open] .turn-thought-text")!.textContent!,
      /先确认输出引脚。/,
    );
    const commentary = $(".turn .message.assistant")!;
    assert.match(commentary.textContent!, /我先看一下电路。/);
    assert.equal(
      $(".message-actions", commentary),
      null,
      "Notes between steps have no actions",
    );
    await step(() => {
      finish("m1", "commentary");
      tool("c1", "inspect_circuit", "查看电路", { circuit: "main" });
    });
    const running = $('.turn-tool[data-state="running"]')!;
    assert(running, "A running tool is one line");
    assert.equal(running.querySelector("summary small")?.textContent, "进行中");
    assert(running.querySelector(".spinner"));
    assert.equal(
      running.querySelector(".turn-tool-target")?.textContent,
      "main",
    );
    await step(() =>
      tool(
        "c1",
        "inspect_circuit",
        "查看电路",
        { circuit: "main" },
        '{"pins":3}',
      ),
    );
    assert.equal(
      $(".turn-tool")!.dataset.state,
      "done",
      "A finished tool keeps its line",
    );
    // A reply that only calls tools completes without text.
    await step(() => {
      finish("m2", "commentary");
      tool("c2", "set_attributes", "修改元件属性", {
        circuit: "main",
        edits: [
          {
            componentId: "pin-1",
            attributes: { label: "sum", facing: "east" },
          },
        ],
      });
    });
    assert.equal(
      $$(".turn .message.assistant").length,
      1,
      "No empty bubble for a tool-only reply",
    );
    assert.equal(
      $(".turn .message.assistant"),
      commentary,
      "Later events do not re-create earlier items",
    );
    await step(() =>
      tool(
        "c2",
        "set_attributes",
        "修改元件属性",
        {
          circuit: "main",
          edits: [
            {
              componentId: "pin-1",
              attributes: { label: "sum", facing: "east" },
            },
          ],
        },
        '{"changed":2}',
      ),
    );

    // ---- the retry notice, and a window opened mid-turn -------------------
    const row = $(".turn-tool")!;
    await step(() => {
      transmission = {
        phase: "retrying",
        message: "模型服务繁忙，2 秒后重试（1/6）",
      };
      emitStatus();
    });
    assert.equal(
      $(".turn-live[data-notice]")?.textContent,
      "模型服务繁忙，2 秒后重试（1/6）",
    );
    assert.equal(occurrences("模型服务繁忙"), 1, "The retry notice shows once");
    assert.equal(
      $(".turn-tool"),
      row,
      "A status snapshot re-renders only what changed",
    );
    const reloaded = document.createElement("div");
    document.body.append(reloaded);
    const second = await mount(reloaded);
    assert.equal(
      shown(reloaded),
      shown(view),
      "A window opened mid-turn shows the live view",
    );
    assert.equal(
      $(".turn-live[data-notice]", reloaded)?.textContent,
      "模型服务繁忙，2 秒后重试（1/6）",
    );
    await act(async () => second.unmount());
    reloaded.remove();
    await step(() => {
      transmission = null;
      emitStatus();
    });
    assert.equal(
      $(".turn-live[data-notice]"),
      null,
      "The notice goes when the retry starts",
    );
    assert.match($(".turn-live")!.textContent!, /正在处理/);

    // ---- a missed event: the conversation is loaded again -----------------
    const historyCalls = () =>
      calls.filter((call) => call.method === "history").length;
    const before = historyCalls();
    await step(() => {
      say("m3", "已把输出");
      say("m3", "引脚改名为", "assistant", true);
      say("m3", " sum。");
    });
    assert(
      historyCalls() > before,
      "A gap in the sequence loads the conversation again",
    );
    const answer = $$(".turn .message.assistant").at(-1)!;
    assert.match(answer.textContent!, /已把输出引脚改名为 sum。/);
    await step(() => finish("m3", "final"));

    // ---- the finished turn folds into one line ----------------------------
    const change = {
      id: "change-1",
      title: "把输出引脚改名为 sum",
      at: Date.now(),
      undoable: true,
      files: [{ path: "adder.circ", kind: "modified" }],
    };
    await step(() => endTurn("completed", null, change));
    assert.equal($$(".turn-summary").length, 1);
    assert.equal(
      $(".turn-summary")!.textContent,
      "查看了电路、修改了 2 个属性 · 47 秒",
    );
    assert.equal($(".turn-summary")!.getAttribute("aria-expanded"), "false");
    assert.equal(
      $$(".turn-tool, .turn-thought").length,
      0,
      "The steps fold away",
    );
    assert.equal(
      $$(".turn .message.assistant").length,
      1,
      "Only the answer stays",
    );
    assert.equal(
      $(".turn .message.assistant"),
      answer,
      "The answer is not re-created at the end",
    );
    assert($('[aria-label="复制消息"]', answer), "The answer can be copied");
    assert.match(
      $(".turn-files")!.textContent!,
      /AI 改动了 1 个文件.*修改.*adder\.circ/,
    );
    assert.equal($(".turn-live"), null);
    assert($('button[aria-label="发送"]'));
    await click(".turn-summary");
    assert.equal($(".turn-summary")!.getAttribute("aria-expanded"), "true");
    assert.equal($$(".turn-tool").length, 2);
    assert.equal(
      $(".turn-thought-text"),
      null,
      "A finished thought opens on demand",
    );
    assert.match(
      $(".turn .message.assistant")!.textContent!,
      /我先看一下电路。/,
    );
    await click(".turn-tool > summary");
    assert.match(
      $(".turn-tool-detail")!.textContent!,
      /"circuit": "main"[\s\S]*\{"pins":3\}/,
    );
    await click(".turn-summary");
    assert.equal($$(".turn-tool").length, 0);

    // ---- a reload replays the same view -----------------------------------
    const finished = shown(view);
    await act(async () => root.unmount());
    root = await mount(view);
    assert.equal(
      shown(view),
      finished,
      "A reloaded window shows what the live one showed",
    );

    // ---- undo stays undone ------------------------------------------------
    await click(".turn-files button");
    assert.deepEqual(
      calls
        .filter((call) => call.op === "folderHistoryUndo")
        .map((call) => [call.folder_id, call.id]),
      [[folder.id, "change-1"]],
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === "markUndone")
        .map((call) => call.args.changeId),
      ["change-1"],
    );
    assert.equal(filesChanged, 1);
    assert.equal($(".turn-files > small")?.textContent, "已撤销");
    assert.equal($(".turn-files button"), null);

    // ---- a refused question keeps its draft; a failed turn says why once --
    refuseAsk = "请先打开工作文件夹";
    await type("再检查一下进位");
    await enter();
    assert.equal(
      box().value,
      "再检查一下进位",
      "A refused question keeps its draft",
    );
    assert.deepEqual(
      errors.map((error) => error.message),
      ["请先打开工作文件夹"],
    );
    await enter();
    assert.equal(asks().length, 3);
    await step(() => {
      say("m4", "检查进位", "reasoning");
      endTurn("failed", "模型服务拒绝了 API 密钥（401 invalid api key）");
    });
    const [first, failed] = $$(".turn");
    assert.equal($$(".turn").length, 2, "Each question keeps its own turn");
    assert.match(
      $('.turn-end[data-status="failed"]', failed)!.textContent!,
      /模型服务拒绝了 API 密钥（401 invalid api key）/,
    );
    assert.equal(occurrences("invalid api key"), 1, "The failure shows once");
    assert($(".turn-thought", failed), "A failed turn keeps its steps open");
    assert.equal(
      $(".turn-thought-text", failed),
      null,
      "and its thought closes",
    );
    assert.equal($(".turn-files > small", first)?.textContent, "已撤销");
    assert.equal($(".turn-files", failed), null);
    const retry = $$("button", failed).find((b) => b.textContent === "重试")!;
    await click(retry);
    assert.equal(asks().at(-1).args.question, "再检查一下进位");
    assert.equal(asks().at(-1).args.editMessageId, "user-2");
    await step(() => {
      say("m5", "进位链没有问题。");
      finish("m5", "final");
      endTurn("completed", null);
    });
    const retried = $$(".turn")[1];
    assert.equal(
      $$(".turn").length,
      2,
      "The retried question replaces the failed turn",
    );
    assert.equal(
      $(".turn-summary", retried),
      null,
      "An answer alone needs no summary",
    );
    assert.equal($(".turn-end", retried), null);
    assert.match(retried.textContent!, /进位链没有问题。/);

    // ---- stop: Enter waits, the stop shows once ---------------------------
    await type("把进位也改名");
    await enter();
    await step(() => {
      say("m6", "先找进位输出。");
      finish("m6", "commentary");
      tool("c6", "inspect_circuit", "查看电路", { circuit: "main" });
    });
    await type("等会再问");
    await enter();
    assert.equal(asks().length, 5, "Enter sends nothing while the AI answers");
    assert.equal(box().value, "等会再问", "and keeps the draft");
    await click('button[aria-label="停止回答"]');
    const stop = $('button[aria-label="停止回答"]') as HTMLButtonElement;
    assert.equal(stop.disabled, true);
    assert.equal(stop.dataset.tip, "正在停止…");
    await step(() => {
      endTurn("interrupted", "已停止");
      releaseStop!();
    });
    const stopped = $$(".turn").at(-1)!;
    assert.equal(
      $('.turn-end[data-status="interrupted"]', stopped)?.textContent,
      "已停止",
    );
    assert.equal(occurrences("已停止"), 1, "The stop shows once");
    assert.equal(
      $('.turn-tool[data-state="unknown"] summary small', stopped)?.textContent,
      "结果未知",
    );
    assert.equal(
      $(".turn-summary", stopped)?.getAttribute("aria-expanded"),
      "true",
      "A stopped turn keeps its steps open",
    );
    assert($('button[aria-label="发送"]'));
    assert.equal(box().value, "等会再问");
    assert.equal(errors.length, 1);
    console.log(
      "PASS: a turn streams its text and tool lines, folds into one summary with the answer and files kept, and a reload replays the same view; retry notice, failure and stop each show once",
    );
  } finally {
    await act(async () => root.unmount());
    view.remove();
    globals.__command = old.command;
    globals.__subscribe = old.subscribe;
    localStorage.removeItem(draftKey);
    localStorage.removeItem(draftKey + ":references");
  }
}
