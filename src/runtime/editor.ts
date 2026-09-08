/**
 * Interface 3 (ARCHITECTURE.md): Monaco editor factory. Monaco is loaded lazily from the npm
 * package through Vite on the first createEditor call. TypeScript syntax highlighting comes from
 * Monaco's Monarch tokenizer (basic-languages); Monaco's own TypeScript worker is NOT loaded:
 * semantic diagnostics arrive through setDiagnostics from the runtime (client.ts). Monaco's
 * stylesheet is the ESM modules' own CSS imports, bundled by Vite; no hand-written CSS here.
 */
import type { Diagnostic } from "./types.ts"

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
  const editor = monaco.editor.create(container, {
    model,
    theme: "playground",
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    minimap: { enabled: false },
    automaticLayout: true,
    readOnly: options.readOnly ?? false,
    scrollBeyondLastLine: false,
    tabSize: 2,
    lineNumbersMinChars: 3,
    renderLineHighlight: "line",
    padding: { top: 8, bottom: 8 },
    scrollbar: { alwaysConsumeMouseWheel: false }
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
