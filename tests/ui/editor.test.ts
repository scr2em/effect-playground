// @vitest-environment happy-dom
/**
 * src/runtime/editor.ts: the CodeMirror 6 editor behind Interface 3, mounted into a real
 * (happy-dom) div. happy-dom has no layout, so CodeMirror's measurement code sees zero-sized
 * rects; everything asserted here is state / DOM structure, not pixel positions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createEditor, setEditorTheme, type EditorHandle } from "../../src/runtime/editor"

// CodeMirror measures the view with Range.getClientRects, which happy-dom does not implement.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
const rects = () => Object.assign([rect], { item: () => rect }) as unknown as DOMRectList
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= rects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
}
if (!("getClientRects" in Element.prototype) || typeof Element.prototype.getClientRects !== "function") {
  Element.prototype.getClientRects = rects
}
if (typeof document.createRange !== "function") {
  document.createRange = () => new Range()
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("createEditor (CodeMirror 6)", () => {
  let container: HTMLDivElement
  let editors: Array<EditorHandle>

  beforeEach(() => {
    document.documentElement.dataset.theme = "dark"
    container = document.createElement("div")
    document.body.append(container)
    editors = []
  })
  afterEach(() => {
    editors.forEach((e) => e.dispose())
    container.remove()
  })

  async function make(options: Parameters<typeof createEditor>[1]): Promise<EditorHandle> {
    const editor = await createEditor(container, options)
    editors.push(editor)
    return editor
  }

  it("mounts a .cm-editor with the initial code and reads it back", async () => {
    const editor = await make({ code: "const a = 1\nconst b = 2" })
    expect(container.querySelector(".cm-editor")).not.toBeNull()
    expect(container.querySelector(".cm-content")).not.toBeNull()
    expect(container.querySelectorAll(".cm-line").length).toBe(2)
    expect(editor.getValue()).toBe("const a = 1\nconst b = 2")
  })

  it("setValue replaces the whole document and notifies onChange", async () => {
    const editor = await make({ code: "old" })
    const onChange = vi.fn()
    editor.onChange(onChange)
    editor.setValue("brand new\nsecond")
    expect(editor.getValue()).toBe("brand new\nsecond")
    expect(onChange).toHaveBeenCalledWith("brand new\nsecond")
    expect(container.querySelectorAll(".cm-line").length).toBe(2)
  })

  it("setDiagnostics maps 1-based line/col to lint marks (and clamps out-of-range positions)", async () => {
    const editor = await make({ code: 'const x: number = "no"\nconsole.log(x)' })
    editor.setDiagnostics([
      { line: 1, col: 7, endLine: 1, endCol: 8, message: "Type 'string' is not assignable to type 'number'." },
      { line: 99, col: 999, endLine: 99, endCol: 999, message: "past the end" }
    ])
    await flush()
    const marks = container.querySelectorAll(".cm-lintRange-error")
    expect(marks.length).toBeGreaterThanOrEqual(1)
    expect(marks[0]!.textContent).toBe("x")
    // The out-of-range diagnostic is clamped to the doc end instead of throwing; it shows in the gutter.
    expect(container.querySelector(".cm-lint-marker-error")).not.toBeNull()

    editor.setDiagnostics([])
    await flush()
    expect(container.querySelectorAll(".cm-lintRange-error").length).toBe(0)
  })

  it("Mod-Enter on the content DOM triggers onRun and is consumed", async () => {
    // CodeMirror resolves "Mod" from navigator.platform: Meta on Mac/iOS, Ctrl elsewhere
    // (happy-dom reports "X11; Darwin arm64", so Ctrl).
    const mod = /Mac|iP/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    const onRun = vi.fn()
    const editor = await make({ code: "1", onRun })
    const content = container.querySelector<HTMLElement>(".cm-content")!
    const run = new KeyboardEvent("keydown", { key: "Enter", ...mod, bubbles: true, cancelable: true })
    content.dispatchEvent(run)
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(run.defaultPrevented).toBe(true)
    expect(editor.getValue()).toBe("1")   // no newline inserted
    // A plain Enter is a newline, not a run.
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(editor.getValue()).toBe("\n1")
  })

  it("switches themes live: dark is one-dark, light is the custom palette", async () => {
    await make({ code: "x" })
    const cm = container.querySelector<HTMLElement>(".cm-editor")!
    const darkClasses = cm.className
    expect(darkClasses).toMatch(/\bcm-editor\b/)

    setEditorTheme("light")
    expect(cm.className).not.toBe(darkClasses)
    expect(cm.className).toMatch(/\bcm-editor\b/)
    const lightClasses = cm.className

    // The site theme event (src/client/theme.ts) drives the same switch.
    document.dispatchEvent(new CustomEvent("effect-playground:theme", { detail: "dark" }))
    expect(cm.className).toBe(darkClasses)
    expect(cm.className).not.toBe(lightClasses)
  })

  it("newly created editors pick up the current theme", async () => {
    await make({ code: "a" })
    const first = container.querySelector<HTMLElement>(".cm-editor")!
    setEditorTheme("light")
    const lightClasses = first.className
    const second = document.createElement("div")
    container.append(second)
    const e = await createEditor(second, { code: "b" })
    editors.push(e)
    expect(second.querySelector<HTMLElement>(".cm-editor")!.className).toBe(lightClasses)
    setEditorTheme("dark")
  })

  it("readOnly editors do not accept edits", async () => {
    const editor = await make({ code: "locked", readOnly: true })
    expect(container.querySelector<HTMLElement>(".cm-content")!.getAttribute("contenteditable")).toBe("false")
    expect(editor.getValue()).toBe("locked")
  })

  it("dispose removes the editor DOM and layout is a harmless no-op", async () => {
    const editor = await make({ code: "bye" })
    editor.layout()
    expect(container.querySelector(".cm-editor")).not.toBeNull()
    editor.dispose()
    editors = []
    expect(container.querySelector(".cm-editor")).toBeNull()
  })
})
