import assert from "node:assert/strict";
import { act, useRef, useState, type ReactNode } from "react";
import { Dialog as ThemesDialog, Theme } from "@radix-ui/themes";
import { createRoot } from "./themed-root";
import { clickMenuItem, menuItem, openMenu, pickOption } from "./workbench";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
} from "../../../apps/workbench/src/shared/Menu";
import { ContextMenu } from "../../../apps/workbench/src/shared/ContextMenu";
import { Select } from "../../../apps/workbench/src/shared/Select";
import { Checkbox } from "../../../apps/workbench/src/shared/Checkbox";
import { IconButton } from "../../../apps/workbench/src/shared/IconButton";
import {
  useDialogFocus,
  useModal,
} from "../../../apps/workbench/src/shared/Dialog";

/** Interaction and portal regressions only: jsdom does not prove layout,
 * collision handling or native dialog top-layer hit testing. */
export async function verifyMenusUI() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const key = async (key: string, target = document.activeElement!) => {
    await act(async () =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await settle();
  };
  const click = async (node: Element) => {
    await act(async () => (node as HTMLElement).click());
    await settle();
  };
  const button = (label: string) => {
    const node = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    assert(node, `button ${label}`);
    return node;
  };
  const menu = () => {
    const node = document.querySelector<HTMLElement>('[role="menu"]');
    assert(node, "menu is open");
    return node;
  };
  let escapedKeys = 0;
  const outsideKey = () => escapedKeys++;
  window.addEventListener("keydown", outsideKey);

  function Commands({
    checked = false,
    onCheckedChange = () => {},
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) {
    return (
      <>
        <MenuLabel>
          <strong>Commands</strong>
          <span>Ready</span>
        </MenuLabel>
        <MenuItem
          icon={<span data-menu-icon="">+</span>}
          shortcut="Ctrl+A"
          onSelect={() => calls.push("alpha")}
        >
          Alpha
        </MenuItem>
        <MenuItem disabled onSelect={() => calls.push("disabled")}>
          Unavailable
        </MenuItem>
        <MenuSub label="Branch" icon={<span aria-hidden="true">→</span>}>
          <MenuItem onSelect={() => calls.push("child")}>Child action</MenuItem>
        </MenuSub>
        <MenuCheckboxItem
          checked={checked}
          onCheckedChange={onCheckedChange}
          shortcut="Ctrl+T"
        >
          Toggle
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem
          danger
          trailing={<span data-trailing="">↗</span>}
          onSelect={() => calls.push("delete")}
        >
          Delete
        </MenuItem>
      </>
    );
  }
  function NativeDialog({
    children,
    close,
  }: {
    children: ReactNode;
    close: () => void;
  }) {
    const ref = useModal();
    return (
      <dialog ref={ref} aria-label="Native dialog">
        <input aria-label="Native input" data-autofocus="" />
        {children}
        <button aria-label="Close native" onClick={close}>
          Close
        </button>
      </dialog>
    );
  }
  function DialogControls() {
    const [value, setValue] = useState("a");
    const [checked, setChecked] = useState(false);
    return (
      <>
        <Menu label="Dialog commands">
          <Commands />
        </Menu>
        <ContextMenu content={<Commands />}>
          <button aria-label="Dialog context">Context</button>
        </ContextMenu>
        <Select
          label="Choice"
          value={value}
          onChange={setValue}
          placeholder="Choose"
          size="small"
          variant="plain"
          options={[
            { value: "a", label: "First" },
            { value: "disabled", label: "Unavailable", disabled: true },
            { value: "b", label: "Second" },
          ]}
        />
        <button aria-label="Clear choice" onClick={() => setValue("")}>
          Clear
        </button>
        <Checkbox
          label="Enabled"
          checked={checked}
          onCheckedChange={setChecked}
        />
        <Checkbox
          label="Locked"
          checked
          disabled
          onCheckedChange={() => calls.push("locked")}
        />
        <IconButton
          title="Tool action"
          shortcut="Ctrl+K"
          icon={<span>+</span>}
          onClick={() => calls.push("icon")}
        />
      </>
    );
  }
  function Fixture() {
    const themeFocus = useDialogFocus();
    const [native, setNative] = useState(false);
    const [themes, setThemes] = useState(false);
    const [open, setOpen] = useState(false);
    const [menuChecked, setMenuChecked] = useState(false);
    const [blockContext, setBlockContext] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    return (
      <Theme appearance="dark" accentColor="teal" radius="large" scaling="90%">
        <Menu
          label="Commands"
          triggerRef={opener}
          open={open}
          onOpenChange={setOpen}
        >
          <Commands checked={menuChecked} onCheckedChange={setMenuChecked} />
          <MenuItem onSelect={() => setThemes(true)}>Themes dialog…</MenuItem>
        </Menu>
        <button aria-label="Open native" onClick={() => setNative(true)}>
          Native dialog…
        </button>
        <Menu label="Disabled menu" disabled>
          <MenuItem>Never</MenuItem>
        </Menu>
        <ContextMenu content={<Commands />}>
          <button
            aria-label="Context zone"
            onContextMenu={(event) => {
              if (blockContext) event.preventDefault();
            }}
          >
            Right click
          </button>
        </ContextMenu>
        <button
          aria-label="Block context"
          onClick={() => setBlockContext(true)}
        >
          Block
        </button>
        {native && (
          <NativeDialog close={() => setNative(false)}>
            <DialogControls />
          </NativeDialog>
        )}
        <ThemesDialog.Root open={themes} onOpenChange={setThemes}>
          <ThemesDialog.Content {...themeFocus} aria-describedby={undefined}>
            <ThemesDialog.Title>Themes dialog</ThemesDialog.Title>
            <input aria-label="Themes input" data-autofocus="" />
            <DialogControls />
            <ThemesDialog.Close>
              <button aria-label="Close themes">Close</button>
            </ThemesDialog.Close>
          </ThemesDialog.Content>
        </ThemesDialog.Root>
      </Theme>
    );
  }

  try {
    await act(async () => root.render(<Fixture />));
    assert(button("Disabled menu").disabled);
    await openMenu("Commands");
    assert.equal(menu().getAttribute("data-accent-color"), "teal");
    assert.equal(menu().getAttribute("data-radius"), "large");
    assert(menu().classList.contains("dark"));
    assert(menuItem("Alpha").querySelector("[data-menu-icon]"));
    assert.match(menuItem("Alpha").textContent!, /Ctrl\+A/);
    assert.equal(menuItem("Delete").getAttribute("data-accent-color"), "red");
    assert(menuItem("Delete").querySelector("[data-trailing]"));
    assert.equal(menuItem("Unavailable").getAttribute("aria-disabled"), "true");
    escapedKeys = 0;
    await key("Home");
    assert.equal(document.activeElement, menuItem("Alpha"));
    await key("ArrowDown");
    assert.equal(
      document.activeElement,
      menuItem("Branch"),
      "disabled item is skipped",
    );
    await key("ArrowRight");
    assert.equal(document.querySelectorAll('[role="menu"]').length, 2);
    assert.equal(document.activeElement, menuItem("Child action"));
    await key("ArrowLeft");
    assert.equal(document.activeElement, menuItem("Branch"));
    await key("ArrowRight");
    await key("Enter");
    assert.deepEqual(calls, ["child"]);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, button("Commands"));
    assert.equal(escapedKeys, 0, "menu keys do not reach workspace shortcuts");
    await openMenu("Commands");
    await clickMenuItem("Toggle");
    await openMenu("Commands");
    assert.equal(
      menuItem("Toggle").getAttribute("aria-checked"),
      "true",
      "checkbox callback updates caller state",
    );
    await key("End");
    assert.equal(document.activeElement, menuItem("Themes dialog…"));
    await key("ArrowDown");
    assert.equal(document.activeElement, menuItem("Alpha"), "navigation loops");
    await key("d");
    assert.equal(
      document.activeElement,
      menuItem("Delete"),
      "typeahead follows labels",
    );
    await key("Escape");
    assert.equal(document.activeElement, button("Commands"));

    const openContext = async (label: string) => {
      await act(async () => {
        const zone = button(label);
        zone.focus();
        zone.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 30,
            clientY: 40,
          }),
        );
      });
      await settle();
    };
    await openContext("Context zone");
    assert.equal(menu().getAttribute("data-accent-color"), "teal");
    await clickMenuItem("Branch");
    await clickMenuItem("Child action");
    assert.equal(calls.at(-1), "child");
    await openContext("Context zone");
    await key("Escape");
    assert.equal(document.activeElement, button("Context zone"));
    await click(button("Block context"));
    await openContext("Context zone");
    assert.equal(
      document.querySelector('[role="menu"]'),
      null,
      "caller can cancel context menu",
    );

    for (const kind of ["Native", "Themes"] as const) {
      if (kind === "Native") {
        // jsdom's showModal shim cannot pause an already mounted menu focus
        // trap. Native menu-to-dialog handoff needs desktop verification.
        await act(async () => button("Open native").focus());
        await click(button("Open native"));
      } else {
        await openMenu("Commands");
        await clickMenuItem("Themes dialog…");
      }
      assert.equal(
        document.activeElement?.getAttribute("aria-label"),
        `${kind} input`,
        "dialog receives focus",
      );
      const native =
        kind === "Native" ? document.querySelector("dialog")! : null;
      await openMenu("Dialog commands");
      assert.equal(Boolean(menu().closest("dialog")), kind === "Native");
      assert.equal(menu().getAttribute("data-accent-color"), "teal");
      await clickMenuItem("Branch");
      if (native)
        assert(
          [...document.querySelectorAll('[role="menu"]')].every((node) =>
            native.contains(node),
          ),
          "submenus stay in the native dialog",
        );
      await clickMenuItem("Child action");
      assert.equal(document.activeElement, button("Dialog commands"));
      await openContext("Dialog context");
      if (native) assert(native.contains(menu()));
      await clickMenuItem("Toggle");
      await pickOption("Choice", "Second");
      const select = document.querySelector<HTMLButtonElement>(
        '[role="combobox"][aria-label="Choice"]',
      )!;
      assert.match(select.textContent!, /Second/);
      assert.equal(document.activeElement, select);
      await key("ArrowDown", select);
      const list = document.querySelector('[role="listbox"]')!;
      assert(list);
      assert.equal(Boolean(list.closest("dialog")), kind === "Native");
      assert.equal(list.getAttribute("data-accent-color"), "teal");
      await key("Escape");
      await click(button("Clear choice"));
      assert.match(
        select.textContent!,
        /Choose/,
        "clearing a controlled value restores placeholder",
      );
      const checkbox = document.querySelector<HTMLElement>(
        '[role="checkbox"][aria-label="Enabled"]',
      )!;
      await click(checkbox);
      assert.equal(checkbox.getAttribute("aria-checked"), "true");
      await click(
        document.querySelector('[role="checkbox"][aria-label="Locked"]')!,
      );
      assert(!calls.includes("locked"));
      const icon = button("Tool action");
      assert(
        !icon.hasAttribute("data-tip"),
        "Themes Tooltip does not activate the legacy bridge",
      );
      await act(async () => icon.focus());
      await settle();
      const tooltip = document.querySelector('[role="tooltip"]')!;
      assert(tooltip);
      assert.match(tooltip.textContent!, /Tool action.*Ctrl\+K/);
      if (native) assert(native.contains(tooltip));
      await click(icon);
      assert.equal(calls.at(-1), "icon");
      await click(button(kind === "Native" ? "Close native" : "Close themes"));
      assert.equal(
        document.activeElement,
        button(kind === "Native" ? "Open native" : "Commands"),
        "dialog close returns to opener",
      );
    }
    console.log(
      "PASS: Themes menus, select, checkbox and tooltip preserve keyboard, portal, theme and focus behavior",
    );
  } finally {
    window.removeEventListener("keydown", outsideKey);
    await act(async () => root.unmount());
    container.remove();
  }
}
