import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { InterfaceEditor } from "../../../apps/workbench/src/editor/InterfaceEditor";
import { SimulationMenu } from "../../../apps/workbench/src/simulation/SimulationControls";
import { FeedbackDialog } from "../../../apps/workbench/src/shell/Feedback";
import { openMenu, clickMenuItem } from "./workbench";

export async function verifyDialogControls() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const globals = globalThis as any;
  const previous = globals.__command;
  const oldBBox = (SVGElement.prototype as any).getBBox;
  // jsdom has no SVG layout; only field/action state is tested here.
  (SVGElement.prototype as any).getBBox = () => ({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const input = (label: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    )!;
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const calls: any[] = [];
  globals.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "interfaceRead")
      return {
        ports: [
          {
            id: "port",
            label: "IN",
            direction: "input",
            width: 1,
            x: 10,
            y: 20,
            internalX: 10,
            internalY: 20,
            disconnect: false,
          },
        ],
        shapes: [],
        uses: [],
        newPinLocation: { x: 20, y: 20 },
      };
    if (request.op === "interfacePreview")
      return {
        previewId: "preview",
        impacts: [],
        addedPorts: 0,
        removedPorts: 0,
        changed: true,
      };
    if (request.op === "diagnostics") return { version: "fixture", issues: [] };
    throw Error(`Unexpected request ${request.op}`);
  };
  try {
    await act(async () =>
      root.render(
        <InterfaceEditor
          doc={{ id: "doc", revision: "r1" } as any}
          circuit="main"
          onClose={() => {}}
          onDocument={() => {}}
        />,
      ),
    );
    const width = input("IN 位宽");
    await type(width, "invalid");
    await act(async () => width.blur());
    assert.equal(width.value, "1", "invalid numeric drafts reset on blur");
    await type(width, "8");
    await act(async () =>
      width.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const name = input("IN 名称");
    await type(name, "DATA");
    await act(async () => name.blur());
    assert.equal(calls.length, 1, "field commits only update the local draft");
    await act(async () => button("预览修改").click());
    assert.equal(calls.at(-1).draft.ports[0].width, 8);
    assert.equal(calls.at(-1).draft.ports[0].label, "DATA");
    assert.equal(button("应用").type, "button");

    let frequency = 0;
    await act(async () =>
      root.render(
        <SimulationMenu
          contextKey="doc:main"
          circuitName="main"
          status={{} as any}
          disabled={false}
          shortcuts={{}}
          run={() => {}}
          frequency={2}
          onFrequencyChange={async (value) => {
            frequency = value;
          }}
          capture={async () => {}}
          onObservations={() => {}}
          onError={() => {}}
        />,
      ),
    );
    await openMenu("仿真");
    await clickMenuItem("仿真设置…");
    const number = document.querySelector<HTMLInputElement>(
      ".simulation-settings input",
    )!;
    assert.equal(number.type, "number");
    assert.equal(number.min, "0.25");
    assert.equal(number.max, "4096");
    assert(number.required);
    await type(number, "4.5");
    assert.equal(button("应用").type, "submit");
    assert.equal(button("取消").type, "button");
    await act(async () => button("应用").click());
    assert.equal(frequency, 4.5);
    assert(!document.querySelector(".simulation-settings"));

    await act(async () => root.render(<FeedbackDialog onClose={() => {}} />));
    const diagnostic = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="诊断预览"]',
    )!;
    assert(diagnostic.readOnly);
    assert.match(diagnostic.value, /fixture/);
    assert(diagnostic.closest(".rt-TextAreaRoot"));
    assert(
      button("前往反馈页").disabled,
      "feedback submission still requires saving the diagnostic first",
    );
    console.log(
      "PASS: Themes dialog controls retain numeric validation, local field commits, explicit preview/submit and read-only diagnostics",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    globals.__command = previous;
    (SVGElement.prototype as any).getBBox = oldBBox;
  }
}
