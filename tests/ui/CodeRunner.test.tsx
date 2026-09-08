// @vitest-environment happy-dom
/**
 * src/client/CodeRunner.tsx: the playground widget against a fake runtime bridge.
 * The bridge module is mocked so no Monaco / worker code loads; the fake editor keeps its value
 * in memory and records setValue / setDiagnostics / dispose calls.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Diagnostic, EditorHandle, FullResult } from "../../src/client/runtime-bridge"

interface FakeEditor extends EditorHandle {
  value: string
  options: { code: string; onRun?: () => void; readOnly?: boolean }
  /** Simulates the learner typing: updates the value and notifies onChange listeners. */
  change(value: string): void
  setValue: ReturnType<typeof vi.fn<(code: string) => void>>
  setDiagnostics: ReturnType<typeof vi.fn<(d: Array<Diagnostic>) => void>>
  dispose: ReturnType<typeof vi.fn<() => void>>
  focus: ReturnType<typeof vi.fn<() => void>>
}

const fake = vi.hoisted(() => {
  const state = {
    editors: [] as Array<FakeEditor>,
    runner: {
      ready: Promise.resolve(),
      typecheck: vi.fn(async () => [] as Array<Diagnostic>),
      execute: vi.fn(),
      check: vi.fn<(code: string) => Promise<FullResult>>()
    },
    createEditor: vi.fn(async (_container: HTMLElement, options: FakeEditor["options"]): Promise<EditorHandle> => {
      const listeners: Array<(code: string) => void> = []
      const editor: FakeEditor = {
        value: options.code,
        options,
        change: (v) => { editor.value = v; listeners.forEach((cb) => cb(v)) },
        getValue: () => editor.value,
        // Mirrors Monaco/the stub: programmatic setValue also fires change listeners.
        setValue: vi.fn((code: string) => { editor.value = code; listeners.forEach((cb) => cb(code)) }),
        setDiagnostics: vi.fn(),
        onChange: (cb) => { listeners.push(cb) },
        focus: vi.fn(),
        layout: () => {},
        dispose: vi.fn()
      }
      state.editors.push(editor)
      return editor
    })
  }
  return state
})

vi.mock("../../src/client/runtime-bridge", () => ({
  getRunner: () => fake.runner,
  createEditor: fake.createEditor
}))

// Imported after the mock so the dynamic `import("./runtime-bridge")` inside the component resolves to the fake.
import CodeRunner, { type CodeRunnerProps } from "../../src/client/CodeRunner"
import { PROGRESS_EVENT } from "../../src/client/progress"

const DONE_KEY = "effect-playground:done"
const draftKey = (id: string) => `effect-playground:draft:${id}`

const okResult = (over: Partial<FullResult> = {}): FullResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 12,
  diagnostics: [],
  ...over
})

const baseProps: CodeRunnerProps = {
  id: "item-1",
  kind: "lesson",
  code: 'console.log("hello")',
  fallbackHtml: '<pre class="shiki"><code>console.log("hello")</code></pre>'
}

function renderRunner(over: Partial<CodeRunnerProps> = {}) {
  const utils = render(<CodeRunner {...baseProps} {...over} />)
  return utils
}

/** Waits for the editor to be created and the fallback to be removed. */
async function editorMounted(): Promise<FakeEditor> {
  await waitFor(() => expect(fake.editors.length).toBeGreaterThan(0))
  await waitFor(() => expect(document.querySelector("[data-fallback]")).not.toBeInTheDocument())
  return fake.editors[fake.editors.length - 1]!
}

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  fake.editors.length = 0
  fake.runner.ready = Promise.resolve()
  fake.runner.check.mockResolvedValue(okResult())
})

afterEach(() => {
  cleanup()
})

describe("CodeRunner", () => {
  it("renders the server fallback <pre> from fallbackHtml until the editor mounts", async () => {
    const { container } = renderRunner()
    const fallback = container.querySelector("[data-fallback]")
    expect(fallback).toBeInTheDocument()
    expect(fallback!.querySelector("pre.shiki")).toHaveTextContent('console.log("hello")')

    await editorMounted()
    expect(container.querySelector("[data-fallback]")).not.toBeInTheDocument()
  })

  it("creates the editor with the initial code and wires onRun", async () => {
    renderRunner()
    const editor = await editorMounted()
    expect(fake.createEditor).toHaveBeenCalledTimes(1)
    expect(fake.createEditor.mock.calls[0]![0]).toBeInstanceOf(HTMLElement)
    expect(editor.options.code).toBe(baseProps.code)
    expect(editor.options.onRun).toBeTypeOf("function")
  })

  it("creates the editor with a saved draft from localStorage instead of the initial code", async () => {
    localStorage.setItem(draftKey("item-1"), JSON.stringify("// my draft"))
    renderRunner()
    const editor = await editorMounted()
    expect(editor.options.code).toBe("// my draft")
    expect(editor.getValue()).toBe("// my draft")
  })

  it("shows the empty output prompt before any run", () => {
    renderRunner()
    expect(screen.getByText(/Press Run/)).toBeInTheDocument()
  })

  it("shows 'Loading runtime…' and disables Run until the runner is ready", async () => {
    const gate = deferred()
    fake.runner.ready = gate.promise
    fake.runner.check.mockResolvedValue(okResult({ stdout: "hello\n" }))
    const user = userEvent.setup()
    renderRunner()
    await editorMounted()

    await user.click(screen.getByRole("button", { name: "Run" }))
    const loading = await screen.findByRole("button", { name: "Loading runtime…" })
    expect(loading).toBeDisabled()
    expect(fake.runner.check).not.toHaveBeenCalled()

    await act(async () => { gate.resolve() })
    expect(await screen.findByText("hello")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled()
  })

  it("Run for a lesson shows stdout and the exit/duration line", async () => {
    fake.runner.check.mockResolvedValue(okResult({ stdout: "hello\nworld\n", durationMs: 42 }))
    const user = userEvent.setup()
    renderRunner({ kind: "lesson" })
    const editor = await editorMounted()

    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText(/hello\s*world/)).toBeInTheDocument()
    expect(fake.runner.check).toHaveBeenCalledWith(editor.getValue())
    expect(screen.getByText(/exit 0 · 42ms/)).toBeInTheDocument()
    // Lessons have no expected output, so no pass/fail verdict.
    expect(screen.queryByText(/Correct|Not yet/)).not.toBeInTheDocument()
  })

  it("Run & check with matching stdout marks the challenge done and reveals the explanation", async () => {
    fake.runner.check.mockResolvedValue(okResult({ stdout: "42\n" }))
    const onProgress = vi.fn()
    document.addEventListener(PROGRESS_EVENT, onProgress)
    const user = userEvent.setup()
    renderRunner({
      id: "ch-1",
      kind: "challenge",
      expected: "42",
      explanationHtml: "<p>Because <code>succeed</code> wraps the value.</p>"
    })
    await editorMounted()
    expect(screen.queryByText("Why this works")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Run & check" }))
    expect(await screen.findByText("✓ Correct")).toBeInTheDocument()

    const done = JSON.parse(localStorage.getItem(DONE_KEY)!) as Record<string, number>
    expect(done["ch-1"]).toBeTypeOf("number")
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Why this works")).toBeInTheDocument()
    expect(screen.getByText(/wraps the value/)).toBeInTheDocument()
    document.removeEventListener(PROGRESS_EVENT, onProgress)
  })

  it("accepts stdout that differs only by trailing whitespace / CRLF", async () => {
    fake.runner.check.mockResolvedValue(okResult({ stdout: "a\r\nb\r\n\r\n" }))
    const user = userEvent.setup()
    renderRunner({ id: "ch-crlf", kind: "challenge", expected: "a\nb" })
    await editorMounted()
    await user.click(screen.getByRole("button", { name: "Run & check" }))
    expect(await screen.findByText("✓ Correct")).toBeInTheDocument()
  })

  it("Run & check with mismatching stdout shows 'Not yet' and the expected output", async () => {
    fake.runner.check.mockResolvedValue(okResult({ stdout: "41\n" }))
    const user = userEvent.setup()
    renderRunner({ id: "ch-2", kind: "challenge", expected: "42", explanationHtml: "<p>explain</p>" })
    await editorMounted()

    await user.click(screen.getByRole("button", { name: "Run & check" }))
    expect(await screen.findByText("✗ Not yet")).toBeInTheDocument()
    expect(screen.getByText(/expected output:\s*42/)).toBeInTheDocument()
    expect(screen.queryByText("✓ Correct")).not.toBeInTheDocument()
    expect(localStorage.getItem(DONE_KEY)).toBeNull()
    expect(screen.queryByText("Why this works")).not.toBeInTheDocument()
  })

  it("does not pass when stdout matches but there are diagnostics or a non-zero exit", async () => {
    const user = userEvent.setup()
    fake.runner.check.mockResolvedValue(okResult({
      stdout: "42\n",
      diagnostics: [{ line: 1, col: 1, endLine: 1, endCol: 2, message: "nope" }]
    }))
    renderRunner({ id: "ch-3", kind: "challenge", expected: "42" })
    await editorMounted()
    await user.click(screen.getByRole("button", { name: "Run & check" }))
    expect(await screen.findByText("✗ Not yet")).toBeInTheDocument()

    fake.runner.check.mockResolvedValue(okResult({ stdout: "42\n", stderr: "Error: boom\n", exitCode: 1 }))
    await user.click(screen.getByRole("button", { name: "Run & check" }))
    await waitFor(() => expect(fake.runner.check).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("Error: boom")).toBeInTheDocument()
    expect(screen.getByText("✗ Not yet")).toBeInTheDocument()
    expect(localStorage.getItem(DONE_KEY)).toBeNull()
  })

  it("renders diagnostics in the output and passes them to editor.setDiagnostics", async () => {
    const diagnostics: Array<Diagnostic> = [
      { line: 3, col: 5, endLine: 3, endCol: 9, message: "Type 'string' is not assignable to type 'number'." },
      { line: 7, col: 1, endLine: 7, endCol: 4, message: "Cannot find name 'foo'." }
    ]
    fake.runner.check.mockResolvedValue(okResult({ diagnostics }))
    const user = userEvent.setup()
    renderRunner()
    const editor = await editorMounted()

    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText(/Type errors \(fix these first/)).toBeInTheDocument()
    expect(screen.getByText(/line 3: Type 'string' is not assignable/)).toBeInTheDocument()
    expect(screen.getByText(/line 7: Cannot find name 'foo'/)).toBeInTheDocument()
    expect(editor.setDiagnostics).toHaveBeenCalledWith(diagnostics)
  })

  it("shows the timeout message for a timedOut result", async () => {
    fake.runner.check.mockResolvedValue(okResult({ timedOut: true, exitCode: null, durationMs: 10_000 }))
    const user = userEvent.setup()
    renderRunner()
    await editorMounted()

    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText(/Timed out after 10s/)).toBeInTheDocument()
    expect(screen.getByText(/exit null \(killed\)/)).toBeInTheDocument()
  })

  it("shows '(no output)' when the run printed nothing", async () => {
    const user = userEvent.setup()
    renderRunner()
    await editorMounted()
    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText("(no output)")).toBeInTheDocument()
  })

  it("shows 'Run failed' when the runner rejects", async () => {
    fake.runner.check.mockRejectedValue(new Error("worker crashed"))
    const user = userEvent.setup()
    renderRunner()
    await editorMounted()
    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText(/Run failed: Error: worker crashed/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled()
  })

  it("Hint cycles through hints 1..n and stops at the last one", async () => {
    const user = userEvent.setup()
    renderRunner({ hints: ["first", "second", "third"] })
    expect(screen.queryByText(/^Hint \d/)).not.toBeInTheDocument()

    const hintBtn = screen.getByRole("button", { name: "Hint" })
    await user.click(hintBtn)
    expect(screen.getByText("Hint 1/3: first")).toBeInTheDocument()
    await user.click(hintBtn)
    expect(screen.getByText("Hint 2/3: second")).toBeInTheDocument()
    await user.click(hintBtn)
    expect(screen.getByText("Hint 3/3: third")).toBeInTheDocument()
    await user.click(hintBtn)
    await user.click(hintBtn)
    expect(screen.getByText("Hint 3/3: third")).toBeInTheDocument()
    expect(screen.queryByText(/Hint 4/)).not.toBeInTheDocument()
  })

  it("hides the Hint and Show solution buttons when there is nothing to show", () => {
    renderRunner({ hints: [], solution: undefined })
    expect(screen.queryByRole("button", { name: "Hint" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Show solution" })).not.toBeInTheDocument()
  })

  it("Show solution reveals solutionHtml and Load solution puts the solution into the editor", async () => {
    const user = userEvent.setup()
    renderRunner({
      kind: "challenge",
      expected: "ok",
      solution: 'console.log("ok")',
      solutionHtml: '<pre class="shiki"><code>SOLUTION HTML</code></pre>'
    })
    const editor = await editorMounted()
    expect(screen.queryByText("Solution")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Show solution" }))
    expect(screen.getByText("Solution")).toBeInTheDocument()
    expect(screen.getByText("SOLUTION HTML")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Load solution into editor" }))
    await waitFor(() => expect(editor.setValue).toHaveBeenCalledWith('console.log("ok")'))
    expect(editor.getValue()).toBe('console.log("ok")')
    expect(editor.focus).toHaveBeenCalled()
  })

  it("Show solution falls back to a plain <pre> when solutionHtml is missing", async () => {
    const user = userEvent.setup()
    const { container } = renderRunner({ solution: "const x = 1" })
    await user.click(screen.getByRole("button", { name: "Show solution" }))
    expect(container.querySelector("pre code")).toHaveTextContent("const x = 1")
  })

  it("editing writes a draft key to localStorage", async () => {
    renderRunner({ id: "draft-1" })
    const editor = await editorMounted()
    expect(localStorage.getItem(draftKey("draft-1"))).toBeNull()

    act(() => { editor.change("// edited") })
    expect(localStorage.getItem(draftKey("draft-1"))).toBe(JSON.stringify("// edited"))

    act(() => { editor.change("// edited again") })
    expect(localStorage.getItem(draftKey("draft-1"))).toBe(JSON.stringify("// edited again"))
  })

  it("Reset restores the original code, clears diagnostics and removes the draft", async () => {
    fake.runner.check.mockResolvedValue(okResult({
      diagnostics: [{ line: 1, col: 1, endLine: 1, endCol: 2, message: "err" }]
    }))
    const user = userEvent.setup()
    renderRunner({ id: "reset-1" })
    const editor = await editorMounted()

    act(() => { editor.change("// broken") })
    expect(localStorage.getItem(draftKey("reset-1"))).toBe(JSON.stringify("// broken"))
    await user.click(screen.getByRole("button", { name: "Run" }))
    await waitFor(() => expect(editor.setDiagnostics).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole("button", { name: "Reset" }))
    expect(editor.setValue).toHaveBeenCalledWith(baseProps.code)
    expect(editor.getValue()).toBe(baseProps.code)
    expect(editor.setDiagnostics).toHaveBeenLastCalledWith([])
    expect(localStorage.getItem(draftKey("reset-1"))).toBeNull()
  })

  it("unmount disposes the editor", async () => {
    const { unmount } = renderRunner()
    const editor = await editorMounted()
    expect(editor.dispose).not.toHaveBeenCalled()
    unmount()
    expect(editor.dispose).toHaveBeenCalledTimes(1)
  })

  it("Cmd/Ctrl+Enter (the editor's onRun callback) triggers a run", async () => {
    fake.runner.check.mockResolvedValue(okResult({ stdout: "from keyboard\n" }))
    renderRunner()
    const editor = await editorMounted()
    act(() => { editor.change("// changed before running") })

    await act(async () => { editor.options.onRun!() })
    await waitFor(() => expect(fake.runner.check).toHaveBeenCalledWith("// changed before running"))
    expect(await screen.findByText("from keyboard")).toBeInTheDocument()
  })

  // KNOWN BUG (CodeRunner.tsx): `onRun: () => void run()` is captured by the first ensureEditor()
  // call, so the keyboard path always sees the first render's `busy === false` and starts a second
  // check while one is running. The Run button is disabled, so only Cmd/Ctrl+Enter is affected.
  // `it.fails` documents it; flip to `it` once fixed.
  it("ignores Cmd/Ctrl+Enter while a run is already in progress", async () => {
    const gate = deferred()
    fake.runner.check.mockImplementation(async () => { await gate.promise; return okResult({ stdout: "once\n" }) })
    renderRunner()
    const editor = await editorMounted()

    await act(async () => { editor.options.onRun!() })
    await waitFor(() => expect(fake.runner.check).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled()
    await act(async () => { editor.options.onRun!() })
    await act(async () => { gate.resolve() })
    expect(await screen.findByText("once")).toBeInTheDocument()
    expect(fake.runner.check).toHaveBeenCalledTimes(1)
  })

  // KNOWN BUG (CodeRunner.tsx): the effect cleanup only disposes editorRef.current; when the widget
  // unmounts before createEditor() resolves, the editor is created into a detached node and leaked.
  it("disposes an editor whose creation finishes after the widget unmounted", async () => {
    const gate = deferred()
    const original = fake.createEditor.getMockImplementation()!
    fake.createEditor.mockImplementationOnce(async (container, options) => { await gate.promise; return original(container, options) })
    const { unmount } = renderRunner()
    await waitFor(() => expect(fake.createEditor).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => { gate.resolve() })
    await waitFor(() => expect(fake.editors.length).toBe(1))
    expect(fake.editors[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it("only mounts one editor per widget even though the effect and run() both ask for it", async () => {
    const user = userEvent.setup()
    renderRunner()
    await editorMounted()
    await user.click(screen.getByRole("button", { name: "Run" }))
    await waitFor(() => expect(fake.runner.check).toHaveBeenCalledTimes(1))
    expect(fake.createEditor).toHaveBeenCalledTimes(1)
  })
})
