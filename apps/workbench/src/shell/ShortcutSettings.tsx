import { useState } from "react";
import { X, Search } from "lucide-react";
import {
  Button,
  Callout,
  Dialog,
  Flex,
  IconButton,
  TextField,
} from "@radix-ui/themes";
import {
  bindingLabel,
  bindingProblem,
  defaultBindings,
  eventBinding,
  shortcutCommands,
  type Bindings,
  type ShortcutId,
} from "../shared/shortcuts";
import { DialogClose, useDialogFocus } from "../shared/Dialog";

export function ShortcutSettings({
  bindings,
  onChange,
  onClose,
}: {
  bindings: Bindings;
  onChange: (value: Bindings) => void;
  onClose: () => void;
}) {
  const focus = useDialogFocus();
  const [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const needle = query.trim().toLowerCase();
  const groups = [...new Set(shortcutCommands.map((c) => c.group))]
    .map(
      (group) =>
        [
          group,
          shortcutCommands.filter(
            (c) =>
              c.group === group &&
              (c.label + bindingLabel(bindings[c.id]))
                .toLowerCase()
                .includes(needle),
          ),
        ] as const,
    )
    .filter(([, commands]) => commands.length);
  const change = (id: ShortcutId, value: string | null) => {
    const problem = bindingProblem(id, value, bindings);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      onChange({ ...bindings, [id]: value });
      setError("");
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content
        {...focus}
        className="shortcut-dialog-content"
        aria-label="快捷键"
        maxWidth="640px"
        maxHeight="85vh"
        aria-describedby={undefined}
      >
        <Flex align="center" justify="between" gap="4" flexShrink="0">
          <Dialog.Title mb="0">快捷键</Dialog.Title>
          <DialogClose onClick={onClose} />
        </Flex>
        <TextField.Root
          data-autofocus
          aria-label="查找快捷键"
          placeholder="查找命令或快捷键"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ flexShrink: 0 }}
        >
          <TextField.Slot>
            <Search size={16} />
          </TextField.Slot>
        </TextField.Root>
        <div className="shortcut-list">
          {groups.map(([group, commands]) => (
            <section key={group}>
              <h3>{group}</h3>
              {commands.map((command) => (
                <label key={command.id}>
                  <span>{command.label}</span>
                  <TextField.Root
                    readOnly
                    aria-label={command.label + " 快捷键"}
                    value={bindingLabel(bindings[command.id])}
                    onKeyDown={(event) => {
                      if (["Tab", "Escape"].includes(event.key)) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const binding = eventBinding(event.nativeEvent);
                      if (binding) change(command.id, binding);
                    }}
                  />
                  <IconButton
                    variant="soft"
                    color="gray"
                    size="1"
                    aria-label={`清除 ${command.label} 快捷键`}
                    onClick={() => change(command.id, null)}
                  >
                    <X size={16} />
                  </IconButton>
                </label>
              ))}
            </section>
          ))}
          {!groups.length && <p>没有匹配的命令</p>}
        </div>
        {error && (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Flex justify="end" flexShrink="0">
          <Button
            variant="soft"
            color="gray"
            onClick={() => {
              try {
                onChange({ ...defaultBindings });
                setError("");
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            恢复默认
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
