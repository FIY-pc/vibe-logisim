/**
 * Edits, undo and redo answer with what they changed (`change`, only the
 * circuits they touched); scripts work with whole views. `documentViews()`
 * returns a function that remembers every document view it is shown and
 * turns an edit result into the next view; anything else passes through.
 */
import { applyDocumentChange } from "../../packages/agent-runtime/src/protocol/document-change.ts";

export function documentViews() {
  const views = new Map<string, any>();
  return (result: any): any => {
    if (result?.change) {
      const next = applyDocumentChange(
        views.get(result.change.id),
        result.change,
      );
      if (!next)
        throw new Error(
          `Edit result for ${result.change.id} does not follow the view this script last saw`,
        );
      views.set(next.id, next);
      return next;
    }
    if (typeof result?.id === "string" && Array.isArray(result.circuits))
      views.set(result.id, result);
    return result;
  };
}
