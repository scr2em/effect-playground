/**
 * Interface 3 (ARCHITECTURE.md): Monaco editor factory. Monaco is loaded lazily from the npm
 * package through Vite on the first createEditor call. TypeScript syntax highlighting comes from
 * Monaco's Monarch tokenizer (basic-languages); Monaco's own TypeScript worker is NOT loaded:
 * semantic diagnostics arrive through setDiagnostics from the runtime (client.ts). Monaco's
 * stylesheet is the ESM modules' own CSS imports, bundled by Vite; no hand-written CSS here.
 * Theme: "playground" (dark) / "playground-light", following html[data-theme] and the
 * `effect-playground:theme` event dispatched by src/client/theme.ts (setEditorTheme switches all editors).
 */
import type { Diagnostic } from "./types.ts"

export type EditorTheme = "light" | "dark"
const THEME_EVENT = "effect-playground:theme"
const themeName = (t: EditorTheme) => (t === "light" ? "playground-light" : "playground")
let currentTheme: EditorTheme = typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark"
let loaded: Monaco | undefined

/** Switches every editor on the page (Monaco themes are global). */
export function setEditorTheme(theme: EditorTheme): void {
  currentTheme = theme
  loaded?.editor.setTheme(themeName(theme))
}

if (typeof document !== "undefined") {
  document.addEventListener(THEME_EVENT, (e) => setEditorTheme((e as CustomEvent<string>).detail === "light" ? "light" : "dark"))
}

export interface EditorHandle {
  getValue(): string
  setValue(code: string): void
  setDiagnostics(d: Array<Diagnostic>): void   // shows markers in the gutter/squiggles
  onChange(cb: (code: string) => void): void
  focus(): void
  layout(): void
  dispose(): void
}

type Monaco = typeof import("monaco-editor/esm/vs/editor/editor.api")

let monacoPromise: Promise<Monaco> | undefined
let counter = 0

function loadMonaco(): Promise<Monaco> {
  monacoPromise ??= (async () => {
    const [{ default: EditorWorker }, monaco] = await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      import("monaco-editor/esm/vs/editor/editor.api"),
      import("monaco-editor/esm/vs/editor/editor.all"),
      import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution")
    ])
    ;(self as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() }
    monaco.editor.defineTheme("playground", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6b7280", fontStyle: "italic" },
        { token: "keyword", foreground: "c792ea" },
        { token: "string", foreground: "9ece6a" },
        { token: "number", foreground: "ff9e64" },
        { token: "type", foreground: "7dcfff" },
        { token: "identifier", foreground: "d4d4d8" }
      ],
      colors: {
        "editor.background": "#0b0d12",
        "editor.foreground": "#d4d4d8",
        "editor.lineHighlightBackground": "#12151c",
        "editorLineNumber.foreground": "#3f4552",
        "editorGutter.background": "#0b0d12",
        "editor.selectionBackground": "#264f78",
        "editorIndentGuide.background": "#1c2029",
        "scrollbarSlider.background": "#2a2f3a80"
      }
    })
    // Light counterpart; background = the light `codeBg` token (src/styles/themes.stylex.ts).
    monaco.editor.defineTheme("playground-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6b7280", fontStyle: "italic" },
        { token: "keyword", foreground: "7c3aed" },
        { token: "string", foreground: "15803d" },
        { token: "number", foreground: "c2410c" },
        { token: "type", foreground: "0e7490" },
        { token: "identifier", foreground: "1b1f27" }
      ],
      colors: {
        "editor.background": "#f4f5f8",
        "editor.foreground": "#1b1f27",
        "editor.lineHighlightBackground": "#e9ebf0",
        "editorLineNumber.foreground": "#9aa1b1",
        "editorGutter.background": "#f4f5f8",
        "editor.selectionBackground": "#c7d2fe",
        "editorIndentGuide.background": "#dfe2e8",
        "scrollbarSlider.background": "#dcdfe6b0"
      }
    })
    loaded = monaco
    return monaco
  })()
  return monacoPromise
}

export async function createEditor(container: HTMLElement, options: {
  code: string
  onRun?: () => void          // bound to Cmd/Ctrl+Enter
  readOnly?: boolean
}): Promise<EditorHandle> {
  const monaco = await loadMonaco()
  const model = monaco.editor.createModel(options.code, "typescript", monaco.Uri.parse(`inmemory://playground/${++counter}.ts`))
  if (typeof document !== "undefined" && document.fonts?.ready) {
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts())
  }
  const editor = monaco.editor.create(container, {
    model,
    theme: themeName(currentTheme),
    fontSize: 13,
    // Monaco's default stack: Safari mis-measures some `ui-monospace` faces, which puts the caret
    // in the wrong column on click. Menlo/Monaco are measured correctly in every browser.
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    fontLigatures: false,
    minimap: { enabled: false },
    automaticLayout: true,
    readOnly: options.readOnly ?? false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    tabSize: 2,
    lineNumbersMinChars: 3,
    renderLineHighlight: "line",
    padding: { top: 8, bottom: 8 },
    // Let the wheel reach the page once the editor is scrolled to its start/end.
    scrollbar: { alwaysConsumeMouseWheel: false, vertical: "auto", horizontal: "auto" }
  })
  if (options.onRun) {
    const onRun = options.onRun
    editor.addAction({
      id: "playground.run",
      label: "Run",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRun()
    })
  }
  return {
    getValue: () => model.getValue(),
    setValue: (code) => model.setValue(code),
    setDiagnostics: (diagnostics) =>
      monaco.editor.setModelMarkers(
        model,
        "typecheck",
        diagnostics.map((d) => ({
          severity: monaco.MarkerSeverity.Error,
          message: d.message,
          startLineNumber: d.line,
          startColumn: d.col,
          endLineNumber: d.endLine,
          endColumn: d.endCol
        }))
      ),
    onChange: (cb) => {
      model.onDidChangeContent(() => cb(model.getValue()))
    },
    focus: () => editor.focus(),
    layout: () => editor.layout(),
    dispose: () => {
      editor.dispose()
      model.dispose()
    }
  }
}
