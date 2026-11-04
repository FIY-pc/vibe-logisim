import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot } from "./themed-root";
import {
  DialogBody,
  DialogFrame,
} from "../../../apps/workbench/src/shared/Dialog";
import { DecisionDialog } from "../../../apps/workbench/src/shared/DecisionDialog";
import { Select } from "../../../apps/workbench/src/shared/Select";
import { pickOption } from "./workbench";

export async function verifyDialogFoundation() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  function Harness() {
    const [open, setOpen] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [choice, setChoice] = useState("one");
    return (
      <>
        <button onClick={() => setOpen(true)}>Open first</button>
        <button onClick={() => setOpen(true)}>Open again</button>
        <DialogFrame
          open={open}
          title="Test dialog"
          onClose={() => setOpen(false)}
          closeDisabled={busy}
          footer={<button onClick={() => setConfirm(true)}>Confirm</button>}
        >
          <DialogBody>
            <input aria-label="Draft" data-autofocus defaultValue="retained" />
            <Select
              label="Nested choice"
              value={choice}
              onChange={setChoice}
              options={[
                { value: "one", label: "One" },
                { value: "two", label: "Two" },
              ]}
            />
            <button onClick={() => setBusy(!busy)}>Toggle busy</button>
          </DialogBody>
          {confirm && (
            <DecisionDialog
              decision={{
                title: "Confirm child",
                message: "Keep the parent draft",
                actions: [],
              }}
              onClose={() => setConfirm(false)}
            />
          )}
        </DialogFrame>
      </>
    );
  }
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    )!;
  const click = async (target: HTMLElement) => {
    await act(async () => {
      target.focus();
      target.click();
    });
    await settle();
  };
  const escape = async () => {
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await settle();
  };
  try {
    await act(async () => root.render(<Harness />));
    const first = button("Open first"),
      again = button("Open again");
    await click(first);
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Draft"]',
    )!;
    assert.equal(document.activeElement, input);
    await pickOption("Nested choice", "Two");
    assert(
      document.querySelector('[role="dialog"]'),
      "select interaction keeps its parent",
    );
    const confirm = button("Confirm");
    await click(confirm);
    assert(document.querySelector('[role="alertdialog"]'));
    await escape();
    assert(!document.querySelector('[role="alertdialog"]'));
    assert.equal(
      document.activeElement,
      confirm,
      "nested cancellation restores parent control focus",
    );
    assert.equal(
      document.querySelector('[aria-label="Draft"]'),
      input,
      "nested dialog preserves the parent's draft element",
    );
    await click(button("Toggle busy"));
    await escape();
    assert(
      document.querySelector('[role="dialog"]'),
      "busy dialog rejects Escape",
    );
    await click(button("Toggle busy"));
    await escape();
    assert(!document.querySelector('[role="dialog"]'));
    assert.equal(document.activeElement, first);
    await click(again);
    await escape();
    assert.equal(
      document.activeElement,
      again,
      "controlled reopen captures the current opener",
    );
    console.log(
      "PASS: shared Themes dialogs preserve nested select/confirmation, busy Escape, focus return and controlled reopen",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
}
