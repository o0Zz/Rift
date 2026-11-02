// Text editor of a document tab (CodeMirror 6). Loaded on first use: it never weighs on Rift's startup.
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

// Colors are CSS variables (App.css), so the editor follows the light/dark theme like the rest of the UI.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
  { tag: [t.comment, t.meta], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.tagName, t.heading], color: "var(--syn-keyword)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  ".cm-scroller": { fontFamily: "var(--doc-mono)", fontSize: "calc(var(--doc-mono-size) * var(--scale-docs, 1))", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--fg-strong)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--fg-strong)" },
  ".cm-searchMatch": { backgroundColor: "var(--on-bg)", outline: "1px solid var(--accent)" },
  ".cm-panels": { backgroundColor: "var(--side)", color: "var(--fg)" },
});

export type Editor = { text(): string; focus(): void; destroy(): void };

export function createEditor(
  parent: HTMLElement,
  text: string,
  opts: { name: string; wrap: boolean; onChange(): void; onSave(): void },
): Editor {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        // Saved with the file's own line endings.
        text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
        opts.wrap ? EditorView.lineWrapping : [],
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        language.of([]),
        keymap.of([
          { key: "Mod-s", run: () => (opts.onSave(), true) },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => u.docChanged && opts.onChange()),
        theme,
      ],
    }),
  });
  // The language's parser is loaded on demand too (by file name): plain text until then.
  LanguageDescription.matchFilename(languages, opts.name)
    ?.load()
    .then((support) => view.dispatch({ effects: language.reconfigure(support) }));
  return {
    text: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
