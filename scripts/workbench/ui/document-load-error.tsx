import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { App } from "../../../apps/workbench/src/App";
import { HostError } from "../../../apps/workbench/src/shared/host-error";

/**
 * A file changed on disk into content Logisim cannot load (an AI's script
 * wrote a broken revision) and then fixed again: the host takes both
 * revisions, and the canvas's picture read of the broken one fails. That
 * failure is about that revision; once the document moves on, the error bar
 * must not keep it.
 */
export async function verifyDocumentLoadError() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    globals = globalThis as any;
  const previousCommand = globals.__command,
    previousSubscribe = globals.__subscribe;
  const handlers = new Set<(event: any) => void>();
  const emit = (event: any) => {
    for (const handler of handlers) handler(event);
  };
  const failure =
    "Logisim 无法载入这个文件：加载封装元素 circ-port 时出错 [LoopControl.appear.circ-port]（共 4 处）";
  const circuitAt = (x: number) => ({
    name: "main",
    attributes: {},
    wires: [],
    components: [
      {
        id: "pin",
        name: "Pin",
        library: "0",
        location: { x, y: 100 },
        attributes: { label: "In" },
      },
    ],
  });
  const view = (revision: string, x: number) => ({
    id: "A",
    name: "cpu.circ",
    path: "/fixture/cpu.circ",
    revision,
    main: "main",
    dirty: false,
    canUndo: true,
    canRedo: false,
    circuits: [circuitAt(x)],
  });
  /** A reload from disk as the host broadcasts it. */
  const reloaded = (base: string, revision: string, x: number) => ({
    ...view(revision, x),
    base,
    order: ["main"],
  });
  const symbols: string[] = [];
  globals.__subscribe = (handler: (event: any) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };
  globals.__command = async (request: any) => {
    if (request.op === "status")
      return {
        documents: [view("r1", 100)],
        active: "A",
        folder: null,
        recoveryError: null,
      };
    if (request.op === "symbols") {
      symbols.push(request.revision);
      if (request.revision === "broken")
        throw new HostError({
          code: "UNKNOWN",
          message: failure,
          retryable: false,
        });
      return { symbols: [], widthErrors: [] };
    }
    return previousCommand(request);
  };
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const errorBar = () =>
    container.querySelector(".error-bar")?.textContent ?? null;
  try {
    await act(async () => root.render(<App />));
    await settle();
    assert.equal(errorBar(), null);
    await act(async () =>
      emit({ topic: "change", data: reloaded("r1", "broken", 120) }),
    );
    await settle();
    assert.ok(symbols.includes("broken"));
    assert.match(errorBar() ?? "", /无法载入这个文件/);
    await act(async () =>
      emit({ topic: "change", data: reloaded("broken", "fixed", 140) }),
    );
    await settle();
    assert.ok(symbols.includes("fixed"));
    assert.equal(
      errorBar(),
      null,
      "the failed read of an earlier revision must not outlive it",
    );
    // An error about something else stays until the user closes it.
    await act(async () =>
      emit({ topic: "connection", data: "连接中断，正在重新连接…" }),
    );
    await act(async () =>
      emit({ topic: "change", data: reloaded("fixed", "again", 160) }),
    );
    await settle();
    assert.match(errorBar() ?? "", /连接中断/);
    console.log(
      "PASS: a revision that fails to load shows in the error bar and goes when the document moves to a later revision",
    );
  } finally {
    await act(async () => root.unmount());
    globals.__command = previousCommand;
    globals.__subscribe = previousSubscribe;
    container.remove();
  }
}
