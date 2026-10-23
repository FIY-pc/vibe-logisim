import { ShortcutSettings } from "./ShortcutSettings";
import { useSettings } from "../app/hooks";

/** The shortcut settings dialog. */
export function ShortcutSettingsRegion() {
  const open = useSettings((state) => state.open);
  const bindings = useSettings((state) => state.bindings);
  const setOpen = useSettings((state) => state.setOpen);
  const saveBindings = useSettings((state) => state.saveBindings);
  if (!open) return null;
  return (
    <ShortcutSettings
      bindings={bindings}
      onChange={saveBindings}
      onClose={() => setOpen(false)}
    />
  );
}
