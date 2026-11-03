import type { ComponentProps } from "react";
import {
  Button as RadixButton,
  IconButton as RadixIconButton,
  TextField as RadixTextField,
  TextArea as RadixTextArea,
  Text as RadixText,
  Heading as RadixHeading,
} from "@radix-ui/themes";

/** Product controls share Themes' size 2 (32px / 14px). Business views choose
 * the action and emphasis, not a new density or palette for each control. */
type ControlProps<T> = Omit<T, "size" | "color" | "variant"> & {
  color?: "gray" | "red";
  variant?: "solid" | "soft" | "outline" | "ghost";
};
export function Button({
  className,
  ...props
}: ControlProps<ComponentProps<typeof RadixButton>>) {
  return (
    <RadixButton
      {...props}
      className={["ui-button", className].filter(Boolean).join(" ")}
      size="2"
    />
  );
}
export function IconButton({
  className,
  variant = "ghost",
  color = variant === "solid" ? undefined : "gray",
  ...props
}: ControlProps<ComponentProps<typeof RadixIconButton>>) {
  return (
    <RadixIconButton
      variant={variant}
      color={color}
      {...props}
      className={["ui-icon-button", className].filter(Boolean).join(" ")}
      size="2"
    />
  );
}
/** Collections may wrap names and descriptions. Their height follows content,
 * while ordinary toolbar actions stay on the fixed control grid. */
export function ActionRow({
  className,
  ...props
}: ControlProps<ComponentProps<typeof RadixButton>>) {
  return (
    <RadixButton
      variant="ghost"
      color="gray"
      {...props}
      className={["ui-action-row", className].filter(Boolean).join(" ")}
      size="2"
    />
  );
}
function TextFieldRoot(
  props: Omit<ComponentProps<typeof RadixTextField.Root>, "size">,
) {
  return <RadixTextField.Root {...props} size="2" />;
}
export const TextField = { Root: TextFieldRoot, Slot: RadixTextField.Slot };
export function TextArea(
  props: Omit<ComponentProps<typeof RadixTextArea>, "size">,
) {
  return <RadixTextArea {...props} size="2" />;
}

/** Only metadata is smaller than normal text. Headings get their scale from
 * their semantic role, so a field label cannot silently become a page title. */
type TextProps<T> = T extends unknown ? Omit<T, "size" | "color"> : never;
export function Text({
  kind = "body",
  ...props
}: TextProps<ComponentProps<typeof RadixText>> & {
  kind?: "body" | "meta";
  color?: "gray" | "red";
}) {
  return <RadixText {...props} size={kind === "meta" ? "1" : "2"} />;
}
export function Heading({
  kind = "section",
  ...props
}: Omit<ComponentProps<typeof RadixHeading>, "size" | "color"> & {
  kind?: "section" | "dialog";
}) {
  return <RadixHeading {...props} size={kind === "dialog" ? "5" : "3"} />;
}
