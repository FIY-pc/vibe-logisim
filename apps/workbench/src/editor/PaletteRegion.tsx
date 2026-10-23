import { ComponentPalette } from "../shell/WorkspaceLayout";
import { useEditor, useSettings, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The component palette in the rail; choosing a component starts placing it. */
export function PaletteRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const catalog = useEditor((state) => state.catalog);
  const search = useEditor((state) => state.search);
  const place = useEditor((state) => state.place);
  const shortcuts = useSettings((state) => state.labels);
  const { setSearch, searchInput } = stores.editor.getState();
  return (
    <ComponentPalette
      catalog={catalog}
      search={search}
      onSearch={setSearch}
      inputRef={searchInput}
      shortcut={shortcuts.palette}
      place={place}
      onSelect={(t) => actions.editor.startPlacing(view, t)}
    />
  );
}
