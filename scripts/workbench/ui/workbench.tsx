import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import {
  useOwnWorkbench,
  WorkbenchProvider,
} from "../../../apps/workbench/src/app/provider";

/** Picks the option reading `optionText` in the shared Select named `label`:
 * opens the list from the keyboard, then activates the option as a pointer would. */
export async function pickOption(label: string, optionText: string) {
  const trigger = document.querySelector<HTMLButtonElement>(
    `[role="combobox"][aria-label="${label}"]`,
  );
  assert(trigger, `select ${label}`);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((node) => node.textContent?.trim() === optionText);
  assert(option, `option ${optionText} of ${label}`);
  await act(async () => {
    option.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
    );
    option.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Provides a workbench that is never started, for components rendered outside App. */
export function Workbench({ children }: { children: ReactNode }) {
  return (
    <WorkbenchProvider value={useOwnWorkbench()}>{children}</WorkbenchProvider>
  );
}
