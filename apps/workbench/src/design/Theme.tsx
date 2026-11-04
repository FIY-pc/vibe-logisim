import { useLayoutEffect, type ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import { useFocusVisible } from "react-aria/useFocusVisible";

/** The product has one theme, including portalled menus and dialogs. */
export function WorkbenchTheme({ children }: { children: ReactNode }) {
  const { isFocusVisible } = useFocusVisible();
  useLayoutEffect(() => {
    // Include portals outside Theme. WebKit can otherwise show a keyboard ring
    // when a primitive calls focus() during the first pointer interaction.
    document.documentElement.dataset.keyboardFocus = String(isFocusVisible);
    return () => {
      delete document.documentElement.dataset.keyboardFocus;
    };
  }, [isFocusVisible]);
  return (
    <Theme
      appearance="light"
      accentColor="indigo"
      grayColor="slate"
      radius="medium"
      scaling="100%"
      className="workbench-theme"
    >
      {children}
    </Theme>
  );
}
