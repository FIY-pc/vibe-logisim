import { useLayoutEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { MergeView } from "@codemirror/merge";
import { keepKeys } from "./layer";
import { lineEnding, xmlExtensions } from "./codeEditorTheme";
import "./CodeEditor.css";

const externalValue = Annotation.define<boolean>();
const editable = (readOnly: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
  EditorView.contentAttributes.of({ "aria-readonly": String(readOnly) }),
];

/** React owns the draft and apply boundary; CodeMirror owns input, selection and undo. */
export function XmlEditor({
  value,
  onChange,
  readOnly = false,
  autoFocus = false,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  autoFocus?: boolean;
  label: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef({ value, readOnly, autoFocus, label }).current;
  const callback = useRef(onChange);
  const access = useRef(new Compartment()).current;
  useLayoutEffect(() => {
    callback.current = onChange;
  });
  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      doc: initial.value,
      extensions: [
        xmlExtensions(initial.label),
        lineEnding(initial.value),
        history(),
        keymap.of(historyKeymap),
        access.of(editable(initial.readOnly)),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.transactions.some((tr) => tr.annotation(externalValue))
          )
            callback.current(update.state.sliceDoc());
        }),
      ],
    });
    view.current = editor;
    if (initial.autoFocus) editor.focus();
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [initial, access]);
  useLayoutEffect(() => {
    const editor = view.current!;
    if (editor.state.sliceDoc() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: [
          externalValue.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
  }, [value]);
  useLayoutEffect(() => {
    const editor = view.current!;
    if (editor.state.readOnly !== readOnly)
      editor.dispatch({ effects: access.reconfigure(editable(readOnly)) });
  }, [readOnly, access]);
  return <div ref={parent} className="code-editor" onKeyDown={keepKeys} />;
}

/** History is immutable: both sides are read-only and no revert controls are installed. */
export function XmlDiff({
  original,
  revised,
  beforeLabel,
  afterLabel,
  allLines = false,
}: {
  original: string;
  revised: string;
  beforeLabel: string;
  afterLabel: string;
  allLines?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<MergeView | null>(null);
  useLayoutEffect(() => {
    const merge = new MergeView({
      parent: parent.current!,
      a: {
        doc: original,
        extensions: [
          xmlExtensions(beforeLabel),
          lineEnding(original),
          editable(true),
        ],
      },
      b: {
        doc: revised,
        extensions: [
          xmlExtensions(afterLabel),
          lineEnding(revised),
          editable(true),
        ],
      },
      // Bounded detailed diff work for unrelated or minified generated files.
      diffConfig: { scanLimit: 2000, timeout: 100 },
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    view.current = merge;
    return () => {
      view.current = null;
      merge.destroy();
    };
  }, [original, revised, beforeLabel, afterLabel]);
  useLayoutEffect(() => {
    view.current!.reconfigure({
      collapseUnchanged: allLines ? undefined : { margin: 3, minSize: 4 },
    });
  }, [allLines, original, revised, beforeLabel, afterLabel]);
  return (
    <div
      ref={parent}
      className="code-diff"
      role="group"
      aria-label="源码对照"
      onKeyDown={keepKeys}
    />
  );
}
