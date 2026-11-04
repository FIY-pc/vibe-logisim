import { Select as Radix } from "@radix-ui/themes";
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
  /** `plain` drops the border and background, for toolbars and footers. */
  variant?: "plain";
  className?: string;
  title?: string;
}) {
  const [trigger, container] = usePortalContainer<HTMLButtonElement>();
  const classes = ["select-trigger", className].filter(Boolean).join(" ");
  return (
    <Radix.Root
      value={value}
      size="2"
      onValueChange={onChange}
      disabled={disabled}
    >
      <Radix.Trigger
        ref={trigger}
        className={classes}
        aria-label={label}
        data-tip={title}
        variant={variant === "plain" ? "ghost" : "surface"}
        placeholder={placeholder}
      />
      <Radix.Content
        container={container}
        position="popper"
        collisionPadding={8}
        style={{ maxWidth: "var(--radix-select-content-available-width)" }}
        onKeyDown={keepKeys}
      >
        {options.map((option) => (
          <Radix.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </Radix.Item>
        ))}
      </Radix.Content>
    </Radix.Root>
  );
}
