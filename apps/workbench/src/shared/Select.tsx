import * as Radix from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { keepKeys, usePortalContainer } from "./layer";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A drop-down list drawn by the app, not by the platform: the native
 * `<select>` popup follows the system theme and cannot be styled, which made
 * it look foreign next to everything else. The trigger is a `combobox` button
 * named by `label`; the list opens on click, Space/Enter or the arrow keys. */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  size,
  variant,
  className,
  title,
}: {
  label: string;
  /** The chosen option's value; an empty string shows the placeholder. */
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** `small` for dense rows (tables, footers). */
  size?: "small";
  /** `plain` drops the border and background, for toolbars and footers. */
  variant?: "plain";
  className?: string;
  title?: string;
}) {
  const [trigger, container] = usePortalContainer<HTMLButtonElement>();
  const classes = [
    "select-trigger",
    size && `select-${size}`,
    variant && `select-${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Radix.Root
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <Radix.Trigger
        ref={trigger}
        className={classes}
        aria-label={label}
        data-tip={title}
      >
        <Radix.Value placeholder={placeholder} />
        <Radix.Icon asChild>
          <ChevronDown size={size === "small" ? 12 : 14} aria-hidden="true" />
        </Radix.Icon>
      </Radix.Trigger>
      <Radix.Portal container={container}>
        <Radix.Content
          className="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          onKeyDown={keepKeys}
        >
          <Radix.Viewport>
            {options.map((option) => (
              <Radix.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="select-item"
              >
                <Radix.ItemText>{option.label}</Radix.ItemText>
                <Radix.ItemIndicator asChild>
                  <Check size={13} aria-hidden="true" />
                </Radix.ItemIndicator>
              </Radix.Item>
            ))}
          </Radix.Viewport>
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
