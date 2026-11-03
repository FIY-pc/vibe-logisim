import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { Command, useCommandState } from "cmdk";
import { TextField } from "@radix-ui/themes";

// cmdk 1.1.1 can publish the previous item's ID after search reorders results.
// Keep its selection controller; resolve the input's ARIA target after commit.
export function CommandSearch({
  inputRef,
  value,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof TextField.Root>, "value" | "onChange" | "ref"> & {
  inputRef?: RefObject<HTMLInputElement | null>;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const fallback = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? fallback;
  const selected = useCommandState((state) => state.value);
  const reportedId = useCommandState((state) => state.selectedItemId);
  const [activeId, setActiveId] = useState<string>();
  useLayoutEffect(() => {
    const items = ref.current
      ?.closest("[cmdk-root]")
      ?.querySelectorAll<HTMLElement>("[cmdk-item]");
    setActiveId(
      Array.from(items ?? []).find((item) => item.dataset.value === selected)
        ?.id,
    );
  }, [selected, reportedId, ref]);
  return (
    <Command.Input asChild value={value} onValueChange={onValueChange}>
      <TextField.Root {...props} ref={ref} aria-activedescendant={activeId} />
    </Command.Input>
  );
}

// Radix handles Escape in document capture, before the command root sees it.
export function preventComposingDismiss(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) event.preventDefault();
}
