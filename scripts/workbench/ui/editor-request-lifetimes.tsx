import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../apps/workbench/src/App";

/** A field commit and source read retain the document/object identity they started with. */
export async function verifyEditorRequestLifetimes() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    globals = globalThis as any;
  const previous = globals.__command;
  const calls: any[] = [];
  const makeDocument = (id: string) => ({
    id,
    name: `${id}.circ`,
    path: null,
    revision: "r1",
    main: "main",
    dirty: false,
    canUndo: false,
    canRedo: false,
    circuits: [
      {
        name: "main",
        attributes: {},
        wires: [],
        components: [
          {
            id: "first",
            name: "Pin",
            library: "0",
            location: { x: 100, y: 100 },
            attributes: { label: "First" },
          },
          {
            id: "second",
            name: "Pin",
            library: "0",
            location: { x: 300, y: 100 },
            attributes: { label: "Second" },
          },
        ],
      },
    ],
  });
  const records: Record<string, ReturnType<typeof makeDocument>> = {
    A: makeDocument("A"),
    B: makeDocument("B"),
  };
  let active = "A",
    revision = 1;
  const deferred = () => {
    let resolve!: (value: any) => void, reject!: (reason: Error) => void;
    const promise = new Promise<any>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  let editGate: ReturnType<typeof deferred> | null = null,
    sourceGate: ReturnType<typeof deferred> | null = null;
  globals.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "status")
      return {
        documents: Object.values(records),
        active,
        folder: null,
        recoveryError: null,
      };
    if (request.op === "activate") {
      active = request.id;
      return null;
    }
    if (request.op === "properties") {
      const selected = records[request.id].circuits[0].components.find(
        (component) => component.id === request.component,
      )!;
      return {
        tag: "properties",
        attributes: {},
        text: null,
        children: [
          {
            tag: "attribute",
            attributes: {
              name: "label",
              value: selected.attributes.label,
              editable: "true",
            },
            text: null,
            children: [],
          },
        ],
      };
    }
    if (request.op === "observe")
      return {
        focus: {
          components: records[request.id].circuits[0].components.map(
            (component) => ({
              componentId: component.id,
              factoryName: component.name,
              selector: { label: component.attributes.label },
              location: component.location,
              bounds: {
                x: component.location.x - 10,
                y: component.location.y - 10,
                width: 20,
                height: 20,
              },
              ends: [],
            }),
          ),
        },
      };
    if (request.op === "edit") {
      assert.equal(request.edit.kind, "attributes");
      if (editGate) await editGate.promise;
      const document = records[request.id];
      const next = {
        ...document,
        revision: `r${++revision}`,
        dirty: true,
        circuits: [
          {
            ...document.circuits[0],
            components: document.circuits[0].components.map((component) =>
              component.id === request.edit.id
                ? {
                    ...component,
                    attributes: {
                      ...component.attributes,
                      ...request.edit.values,
                    },
                  }
                : component,
            ),
          },
        ],
      };
      records[request.id] = next;
      return {
        change: {
          ...next,
          base: document.revision,
          order: next.circuits.map((circuit) => circuit.name),
        },
        revision: next.revision,
        noop: false,
        title: "修改属性",
        circuit: request.circuit,
        changedCircuits: [request.circuit],
        selection: { components: [request.edit.id], wires: [] },
      };
    }
    if (request.op === "source")
      return sourceGate
        ? sourceGate.promise
        : { xml: `<project name="${request.id}"/>` };
    return previous(request);
  };
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const click = async (element: Element | undefined | null) => {
    assert.ok(element);
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
  };
  const menuButton = (text: string) =>
    Array.from(container.querySelectorAll(".menu-content button")).find(
      (button) => button.textContent?.startsWith(text),
    );
  const selectObject = async (label: string) => {
    await click(menuButton("查找元件"));
    await click(
      Array.from(
        container.querySelectorAll('.find-dialog [role="option"]'),
      ).find((button) => button.querySelector("span")?.textContent === label),
    );
  };
  const selectDocument = (id: string) =>
    click(
      Array.from(container.querySelectorAll(".document-item")).find((button) =>
        button.textContent?.includes(`${id}.circ`),
      ),
    );
  const commitLabel = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>(
      '.inspector input[aria-label="标签"]',
    )!;
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await settle();
  };
  try {
    await act(async () => root.render(<App />));
    await settle();
    await selectObject("First");
    await commitLabel("First edited");
    assert.equal(
      container.querySelector(".inspector .panel-heading")?.textContent,
      "First edited",
      "the committed component remains selected after its revision changes",
    );
    assert.equal(
      container.querySelector<HTMLInputElement>(
        '.inspector input[aria-label="标签"]',
      )?.value,
      "First edited",
    );

    editGate = deferred();
    await commitLabel("First late");
    // Select on the canvas without navigating circuits, so the selection guard
    // itself is exercised independently of the navigation counter.
    const canvas = container.querySelector(".canvas")!;
    const [viewX, viewY, viewWidth] = container
      .querySelector(".canvas svg")!
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    const scale = 600 / viewWidth; // the focused UI harness reports a 600px canvas
    for (const type of ["pointerdown", "pointerup"])
      await act(async () => {
        canvas.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: (300 - viewX) * scale,
            clientY: (100 - viewY) * scale,
          }),
        );
      });
    await settle();
    assert.equal(
      container.querySelector(".inspector .panel-heading")?.textContent,
      "Second",
    );
    await act(async () => {
      editGate!.resolve(undefined);
      await editGate!.promise;
    });
    await settle();
    editGate = null;
    assert.notEqual(
      container.querySelector(".inspector .panel-heading")?.textContent,
      "First late",
      "the late response must not reselect the object the user left",
    );
    assert.equal(
      calls.filter((call) => call.op === "edit").at(-1).edit.id,
      "first",
    );
    console.log(
      "PASS: App retains a committed attribute selection; a late field response cannot take selection back from the user's later choice",
    );

    sourceGate = deferred();
    await click(menuButton("编辑源文件"));
    assert.equal(calls.filter((call) => call.op === "source").at(-1).id, "A");
    await selectDocument("B");
    await act(async () => {
      sourceGate!.resolve({ xml: '<project name="stale-A"/>' });
      await sourceGate!.promise;
    });
    await settle();
    sourceGate = null;
    assert.equal(
      container.querySelector('[role="dialog"][aria-label="编辑源文件"]'),
      null,
    );
    assert.match(
      container.querySelector(".file-title")!.textContent!,
      /B.circ/,
    );
    assert.equal(container.querySelector(".error-bar"), null);
    await click(menuButton("编辑源文件"));
    const dialog = container.querySelector(
      '[role="dialog"][aria-label="编辑源文件"]',
    )!;
    assert.ok(dialog);
    assert.match(dialog.querySelector("header")!.textContent!, /B.circ/);
    assert.equal(
      dialog.querySelector("textarea")!.value,
      '<project name="B"/>',
    );
    await click(dialog.querySelector('button[aria-label="关闭"]'));

    await selectDocument("A");
    sourceGate = deferred();
    await click(menuButton("编辑源文件"));
    await selectDocument("B");
    await act(async () => {
      sourceGate!.reject(new Error("stale A read failure"));
      await sourceGate!.promise.catch(() => {});
    });
    await settle();
    sourceGate = null;
    assert.equal(
      container.querySelector('[role="dialog"][aria-label="编辑源文件"]'),
      null,
    );
    assert.equal(
      container.querySelector(".error-bar"),
      null,
      "a read failure for the document left behind must not be attributed to B",
    );
    console.log(
      "PASS: source reads and failures arriving after document navigation are discarded; current reads retain their file name and XML",
    );
  } finally {
    await act(async () => root.unmount());
    globals.__command = previous;
    container.remove();
  }
}
