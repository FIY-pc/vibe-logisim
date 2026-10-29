/**
 * Edits, undo and redo answer with what they changed (`change`, only the
 * circuits they touched) and `read` answers with a `DocumentChange` too;
 * scripts work with whole views. `documentViews()` returns a function that
 * remembers every document view it is shown and turns either shape into the
 * next view; anything else passes through.
 */
import { applyDocumentChange } from "../../apps/workbench/src/shared/document-change.ts";

export function documentViews() {
  const views = new Map<string, any>();
  /** The view at `change`, when the script has been shown its base. */
  const next = (change: any) => {
    const view = applyDocumentChange(views.get(change.id), change);
    if (view) views.set(view.id, view);
    return view;
  };
  return (result: any): any => {
    if (result?.change) {
      const view = next(result.change);
      if (!view)
        throw new Error(
          `Edit result for ${result.change.id} does not follow the view this script last saw`,
        );
      return view;
    }
    // A read is the whole view at its revision: it seeds or replaces what
    // the script knows, so the next edit's change applies to it.
    if (typeof result?.id === "string" && typeof result.base === "string") {
      const { base, order, widthErrors, ...view } = result;
      views.set(view.id, view);
      return view;
    }
    if (typeof result?.id === "string" && Array.isArray(result.circuits))
      views.set(result.id, result);
    return result;
  };
}
