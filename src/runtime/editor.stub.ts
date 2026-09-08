/**
 * UI-owned STUB of Interface 3 (src/runtime/editor.ts): a <textarea> instead of CodeMirror.
 */
import * as stylex from "@stylexjs/stylex"
import type { Diagnostic } from "./client.stub"
import { runner } from "../styles/runner.stylex"

export interface EditorHandle {
  getValue(): string
  setValue(code: string): void
  setDiagnostics(d: Array<Diagnostic>): void
  onChange(cb: (code: string) => void): void
  focus(): void
  layout(): void
  dispose(): void
}

export async function createEditor(
  container: HTMLElement,
  options: { code: string; onRun?: () => void; readOnly?: boolean }
): Promise<EditorHandle> {
  const ta = document.createElement("textarea")
  ta.className = stylex.props(runner.stubEditor).className ?? ""
  ta.spellcheck = false
  ta.value = options.code
  ta.readOnly = options.readOnly ?? false
  const diags = document.createElement("div")
  diags.className = stylex.props(runner.stubDiags).className ?? ""
  diags.hidden = true
  container.append(ta, diags)
  const listeners: Array<(code: string) => void> = []
  ta.addEventListener("input", () => listeners.forEach((cb) => cb(ta.value)))
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); options.onRun?.() }
  })
  return {
    getValue: () => ta.value,
    setValue: (code) => { ta.value = code; listeners.forEach((cb) => cb(code)) },
    setDiagnostics: (d) => {
      diags.textContent = d.map((x) => `L${x.line}:${x.col} ${x.message}`).join("\n")
      diags.hidden = d.length === 0
    },
    onChange: (cb) => { listeners.push(cb) },
    focus: () => ta.focus(),
    layout: () => {},
    dispose: () => { ta.remove(); diags.remove() }
  }
}
