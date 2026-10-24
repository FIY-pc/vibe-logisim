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

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Opens the shared Menu whose button is named `label` (within `scope`), as
 * Enter on the focused button does. */
export async function openMenu(label: string, scope: ParentNode = document) {
  const trigger = scope.querySelector<HTMLButtonElement>(
    `[aria-haspopup="menu"][aria-label="${label}"]`,
  );
  assert(trigger, `menu ${label}`);
  assert(!trigger.disabled, `menu ${label} is enabled`);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}

/** The command reading `text` in the open menus (shortcut aside), or the
 * first one starting with it. */
export function menuItem(text: string) {
  const items = [
    ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ];
  const item =
    items.find(
      (node) => node.querySelector(".menu-label")?.textContent === text,
    ) ?? items.find((node) => node.textContent?.trim().startsWith(text));
  assert(item, `menu item ${text}`);
  return item;
}

/** Chooses the command reading `text` in the open menus, or opens the
 * sub-menu it names. */
export async function clickMenuItem(text: string) {
  const item = menuItem(text);
  await act(async () => item.click());
  await settle();
}

/** Provides a workbench that is never started, for components rendered outside App. */
export function Workbench({ children }: { children: ReactNode }) {
  return (
    <WorkbenchProvider value={useOwnWorkbench()}>{children}</WorkbenchProvider>
  );
}
