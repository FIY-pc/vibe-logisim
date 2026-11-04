import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { xml } from "@codemirror/lang-xml";
import { tags } from "@lezer/highlight";

// CSS variables follow the surrounding Radix Theme without rebuilding editor state.
const theme = EditorView.theme({
  "&": {
    color: "var(--gray-12)",
    backgroundColor: "var(--color-background)",
    fontSize: "var(--font-size-2)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--code-font-family)",
    lineHeight: "var(--line-height-2)",
  },
  ".cm-content": {
    caretColor: "var(--accent-11)",
    padding: "var(--space-3) 0",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-11)" },
  ".cm-gutters": {
    backgroundColor: "var(--gray-2)",
    color: "var(--gray-11)",
    borderColor: "var(--gray-6)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--accent-a5)" },
  ".cm-panels": { color: "var(--gray-12)", backgroundColor: "var(--gray-2)" },
  ".cm-panels-top": { borderBottomColor: "var(--gray-6)" },
  ".cm-textfield": {
    color: "var(--gray-12)",
    background: "var(--color-background)",
    border: "1px solid var(--gray-7)",
    borderRadius: "var(--radius-2)",
  },
  ".cm-button": {
    color: "var(--gray-12)",
    background: "var(--gray-3)",
    border: "1px solid var(--gray-7)",
    borderRadius: "var(--radius-2)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--yellow-a5)",
    outline: "1px solid var(--yellow-8)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--accent-a5)",
  },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-a4)" },
  "&.cm-merge-a .cm-changedLine": { backgroundColor: "var(--red-a3)" },
  "&.cm-merge-b .cm-changedLine": { backgroundColor: "var(--green-a3)" },
  "&.cm-merge-a .cm-changedText": { background: "var(--red-a5)" },
  "&.cm-merge-b .cm-changedText": { background: "var(--green-a5)" },
  "&.cm-merge-a .cm-changedLineGutter": { backgroundColor: "var(--red-9)" },
  "&.cm-merge-b .cm-changedLineGutter": { backgroundColor: "var(--green-9)" },
  ".cm-collapsedLines": {
    color: "var(--gray-11)",
    background: "var(--gray-3)",
  },
});
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.tagName, tags.angleBracket], color: "var(--indigo-11)" },
    { tag: tags.attributeName, color: "var(--violet-11)" },
    { tag: tags.attributeValue, color: "var(--green-11)" },
    { tag: [tags.comment, tags.meta], color: "var(--gray-11)" },
    { tag: tags.invalid, color: "var(--red-11)" },
  ]),
);
const phrases = EditorState.phrases.of({
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "Go to line": "跳转到行",
  go: "跳转",
  "Fold line": "折叠",
  "Unfold line": "展开",
  unfold: "展开",
  "folded code": "已折叠代码",
  "$ unchanged lines": "$ 行未改动",
});

/** Shared XML reading/editing tools. Host commands remain responsible for circuit validation. */
export function xmlExtensions(label: string): Extension[] {
  return [
    theme,
    highlight,
    phrases,
    xml({ autoCloseTags: false }),
    lineNumbers(),
    foldGutter(),
    bracketMatching(),
    drawSelection(),
    search({ top: true }),
    keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
    EditorView.contentAttributes.of({
      "aria-label": label,
      "aria-multiline": "true",
      tabindex: "0",
      spellcheck: "false",
    }),
  ];
}

/** Keep CRLF and the final newline when serializing the draft; never format XML. */
export const lineEnding = (text: string) =>
  EditorState.lineSeparator.of(text.match(/\r\n|\r|\n/)?.[0] ?? "\n");
