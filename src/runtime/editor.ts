/**
 * Interface 3 (ARCHITECTURE.md): CodeMirror 6 editor factory. CodeMirror renders the document as
 * real DOM text in a contenteditable, so mouse clicks land where the browser puts the caret
 * (native hit-testing) instead of relying on font measurement. Syntax highlighting comes from
 * `@codemirror/lang-javascript` (TypeScript dialect); semantic diagnostics arrive through
 * setDiagnostics from the runtime (client.ts) and are shown as lint marks + gutter markers.
 * Theme: dark (one-dark based) / light (custom), following html[data-theme] and the
 * `effect-playground:theme` event dispatched by src/client/theme.ts (setEditorTheme switches all editors).
 */
import { Compartment, EditorState, Prec } from "@codemirror/state"
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  highlightSpecialChars, rectangularSelection, crosshairCursor
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from "@codemirror/language"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import { javascript } from "@codemirror/lang-javascript"
import { lintGutter, setDiagnostics as setLintDiagnostics, type Diagnostic as LintDiagnostic } from "@codemirror/lint"
import { oneDark } from "@codemirror/theme-one-dark"
import { tags } from "@lezer/highlight"
import type { Diagnostic } from "./types.ts"

export type EditorTheme = "light" | "dark"
const THEME_EVENT = "effect-playground:theme"
let currentTheme: EditorTheme = typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark"
const editors = new Set<{ view: EditorView; theme: Compartment }>()

export interface EditorHandle {
  getValue(): string
  setValue(code: string): void
  setDiagnostics(d: Array<Diagnostic>): void   // shows markers in the gutter/squiggles
  onChange(cb: (code: string) => void): void
  focus(): void
  layout(): void
  dispose(): void
}

// Shared chrome (both themes): font, fill the mount, scroll inside the editor. CodeMirror lets the
// wheel through to the page once the scroller is at its start/end, so no overscroll rules.
const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "Menlo, Monaco, 'Courier New', monospace", lineHeight: "1.5" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { borderRight: "none" },
  ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "12px", paddingRight: "8px", minWidth: "36px" },
  "&.cm-focused": { outline: "none" }
})

// Dark: one-dark with the site's `codeBg` token (src/styles/tokens.stylex.ts) as background.
// The override is listed first: CodeMirror gives earlier (higher-precedence) theme extensions the
// later position in the style sheet, so listed after oneDark it would lose to one-dark's `#282c34`.
const darkTheme = [
  EditorView.theme({
    "&": { backgroundColor: "#0b0d12" },
    ".cm-gutters": { backgroundColor: "#0b0d12" },
    ".cm-activeLine": { backgroundColor: "#12151c" },
    ".cm-activeLineGutter": { backgroundColor: "#12151c" }
  }, { dark: true }),
  oneDark
]

// Light counterpart; background = the light `codeBg` token (src/styles/themes.stylex.ts).
const lightHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "#7c3aed" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#15803d" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6b7280", fontStyle: "italic" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: "#b45309" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#1d4ed8" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#0e7490" }
])
const lightTheme = [
  EditorView.theme({
    "&": { backgroundColor: "#f4f5f8", color: "#1b1f27" },
    ".cm-content": { caretColor: "#1b1f27" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#1b1f27" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#c7d2fe" },
    ".cm-gutters": { backgroundColor: "#f4f5f8", color: "#9aa1b1" },
    ".cm-activeLine": { backgroundColor: "#e9ebf0" },
    ".cm-activeLineGutter": { backgroundColor: "#e9ebf0" },
    ".cm-matchingBracket": { backgroundColor: "#dbe4ff", outline: "1px solid #b4c2ff" },
    ".cm-selectionMatch": { backgroundColor: "#e0e7ff" }
  }, { dark: false }),
  syntaxHighlighting(lightHighlight)
]
const themeFor = (t: EditorTheme) => (t === "light" ? lightTheme : darkTheme)

/** Switches every editor on the page. */
export function setEditorTheme(theme: EditorTheme): void {
  currentTheme = theme
  for (const { view, theme: compartment } of editors) view.dispatch({ effects: compartment.reconfigure(themeFor(theme)) })
}

if (typeof document !== "undefined") {
  document.addEventListener(THEME_EVENT, (e) => setEditorTheme((e as CustomEvent<string>).detail === "light" ? "light" : "dark"))
}

/** Our diagnostics are 1-based line/col; CodeMirror wants document offsets, clamped to the doc. */
function toLintDiagnostics(state: EditorState, diagnostics: Array<Diagnostic>): Array<LintDiagnostic> {
  const doc = state.doc
  const offset = (line: number, col: number) => {
    const l = doc.line(Math.min(Math.max(line, 1), doc.lines))
    return Math.min(l.from + Math.max(col - 1, 0), l.to)
  }
  return diagnostics.map((d) => {
    const from = offset(d.line, d.col)
    const to = Math.max(from, offset(d.endLine, d.endCol))
    return { from, to, severity: "error", message: d.message }
  })
}

export async function createEditor(container: HTMLElement, options: {
  code: string
  onRun?: () => void          // bound to Cmd/Ctrl+Enter
  readOnly?: boolean
}): Promise<EditorHandle> {
  const theme = new Compartment()
  const changeListeners: Array<(code: string) => void> = []
  const onRun = options.onRun
  const extensions = [
    // Mod-Enter must win over every other binding (e.g. insertNewline / closeBrackets).
    onRun ? Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { onRun(); return true } }])) : [],
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorState.tabSize.of(2),
    indentUnit.of("  "),
    javascript({ typescript: true }),
    lintGutter(),
    baseTheme,
    theme.of(themeFor(currentTheme)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const code = update.state.doc.toString()
        for (const cb of changeListeners) cb(code)
      }
    }),
    options.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
  ]
  const view = new EditorView({ state: EditorState.create({ doc: options.code, extensions }), parent: container })
  const entry = { view, theme }
  editors.add(entry)
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (code) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } }),
    setDiagnostics: (diagnostics) => view.dispatch(setLintDiagnostics(view.state, toLintDiagnostics(view.state, diagnostics))),
    onChange: (cb) => { changeListeners.push(cb) },
    focus: () => view.focus(),
    layout: () => {},   // CodeMirror sizes itself from the DOM; the resizable box drives the height.
    dispose: () => {
      editors.delete(entry)
      view.destroy()
    }
  }
}
