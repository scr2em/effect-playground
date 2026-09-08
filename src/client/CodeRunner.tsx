/**
 * The interactive playground widget (React island, hydrated with client:visible).
 * Editor + Run / Run & check / Reset / Hint / Show solution / Load solution, output panel,
 * pass/fail against the expected output, drafts, remembered height and completion (progress.ts).
 * The runtime bridge is imported lazily so server rendering never loads Monaco.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import type { EditorHandle, FullResult } from "./runtime-bridge"
import { clearDraft, getDraft, getHeight, markDone, setDraft, setHeight } from "./progress"
import { runner as s } from "../styles/runner.stylex"
import { card } from "../styles/card.stylex"

export interface CodeRunnerProps {
  id: string
  kind: "lesson" | "challenge" | "problem" | "scratch"
  code: string
  /** shiki-rendered <pre> for the no-JS / pre-hydration fallback */
  fallbackHtml: string
  solution?: string | undefined
  solutionHtml?: string | undefined
  expected?: string | undefined
  hints?: Array<string> | undefined
  explanationHtml?: string | undefined
  tall?: boolean | undefined
}

const norm = (v: string | null | undefined) => (v ?? "").replace(/\r\n/g, "\n").trim()
const bridge = () => import("./runtime-bridge")

export default function CodeRunner(props: CodeRunnerProps) {
  const { id, code, fallbackHtml, solution, solutionHtml, expected, hints = [], explanationHtml, tall = false } = props
  const boxRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorHandle | null>(null)
  const editorPromise = useRef<Promise<EditorHandle> | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [phase, setPhase] = useState<"idle" | "loading" | "running">("idle")
  // Refs so callbacks captured once (Monaco's onRun, the editor promise) always see the latest state.
  const busyRef = useRef(false)
  const runRef = useRef<() => Promise<void>>(async () => {})
  const [result, setResult] = useState<FullResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hintIdx, setHintIdx] = useState(0)
  const [solutionShown, setSolutionShown] = useState(false)
  const [whyShown, setWhyShown] = useState(false)

  const ensureEditor = useCallback((): Promise<EditorHandle> => {
    if (editorPromise.current) return editorPromise.current
    const promise = bridge()
      .then(({ createEditor }) => createEditor(mountRef.current!, { code: getDraft(id) ?? code, onRun: () => void runRef.current() }))
      .then((editor) => {
        // The component unmounted (or reset) while the editor was being created: do not leak it.
        if (editorPromise.current !== promise) {
          editor.dispose()
          return editor
        }
        editorRef.current = editor
        editor.onChange((value) => setDraft(id, value))
        setEditorReady(true)
        return editor
      })
    editorPromise.current = promise
    return promise
  }, [id, code])

  // Mount the editor, restore the remembered height, and persist resizes.
  useEffect(() => {
    const box = boxRef.current!
    const saved = getHeight(id)
    if (saved) box.style.height = `${saved}px`
    const ro = new ResizeObserver(() => {
      if (box.offsetHeight) { setHeight(id, box.offsetHeight); editorRef.current?.layout() }
    })
    ro.observe(box)
    void ensureEditor()
    return () => {
      ro.disconnect()
      editorRef.current?.dispose()
      editorRef.current = null
      editorPromise.current = null
    }
  }, [id, ensureEditor])

  const runLabel = expected != null ? "Run & check" : "Run"
  const busy = phase !== "idle"

  async function run(): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    setPhase("loading")
    try {
      const editor = await ensureEditor()
      const { getRunner } = await bridge()
      const runtime = getRunner()
      await runtime.ready
      setPhase("running")
      const r = await runtime.check(editor.getValue())
      editor.setDiagnostics(r.diagnostics)
      setResult(r)
      if (passes(r, expected)) {
        markDone(id)
        if (explanationHtml) setWhyShown(true)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      busyRef.current = false
      setPhase("idle")
    }
  }
  runRef.current = run

  function reset(): void {
    editorRef.current?.setValue(code)
    editorRef.current?.setDiagnostics([])
    clearDraft(id)
  }

  function loadSolution(): void {
    if (!solution) return
    void ensureEditor().then((e) => { e.setValue(solution); e.focus() })
  }

  const hint = hintIdx > 0 ? Math.min(hintIdx, hints.length) : 0

  return (
    <div {...stylex.props(s.root)} data-runner={id}>
      <div ref={boxRef} {...stylex.props(s.editor, tall && s.editorTall)}>
        <div ref={mountRef} {...stylex.props(s.mount)} />
        {!editorReady && <div data-fallback {...stylex.props(s.fallback)} dangerouslySetInnerHTML={{ __html: fallbackHtml }} />}
      </div>
      <div {...stylex.props(s.toolbar)}>
        <button type="button" disabled={busy} onClick={() => void run()} {...stylex.props(s.btn, s.btnPrimary)}>
          {phase === "loading" ? "Loading runtime…" : phase === "running" ? "Running…" : runLabel}
        </button>
        <button type="button" onClick={reset} {...stylex.props(s.btn, s.btnGhost)}>Reset</button>
        {hints.length > 0 && <button type="button" onClick={() => setHintIdx((i) => i + 1)} {...stylex.props(s.btn)}>Hint</button>}
        {solution && <button type="button" onClick={() => setSolutionShown(true)} {...stylex.props(s.btn)}>Show solution</button>}
        <span {...stylex.props(s.spacer)} />
        <span {...stylex.props(s.kbd)}>⌘/Ctrl + Enter</span>
      </div>
      {hint > 0 && <div {...stylex.props(s.hintText)}>Hint {hint}/{hints.length}: {hints[hint - 1]}</div>}
      <Output result={result} error={error} expected={expected} running={busy} />
      {whyShown && explanationHtml && (
        <div {...stylex.props(card.reveal)}>
          <div {...stylex.props(card.label)}>Why this works</div>
          <div className="md" dangerouslySetInnerHTML={{ __html: explanationHtml }} />
        </div>
      )}
      {solutionShown && solution && (
        <div {...stylex.props(card.reveal)}>
          <div {...stylex.props(card.label)}>Solution</div>
          {solutionHtml
            ? <div className="md" dangerouslySetInnerHTML={{ __html: solutionHtml }} />
            : <div className="md"><pre><code>{solution}</code></pre></div>}
          <button type="button" onClick={loadSolution} {...stylex.props(s.btn)}>Load solution into editor</button>
        </div>
      )}
    </div>
  )
}

function passes(r: FullResult, expected: string | undefined): boolean {
  return expected != null && r.diagnostics.length === 0 && !r.timedOut && r.exitCode === 0 && norm(r.stdout) === norm(expected)
}

function Output({ result: r, error, expected, running }: { result: FullResult | null; error: string | null; expected: string | undefined; running: boolean }) {
  if (error) return <div {...stylex.props(s.output)}><span {...stylex.props(s.diag)}>Run failed: {error}</span></div>
  if (running && !r) return <div {...stylex.props(s.output)}>…</div>
  if (!r) return <div {...stylex.props(s.output, s.outputEmpty)}>Press Run (or ⌘/Ctrl+Enter in the editor).</div>
  const lines: Array<React.ReactNode> = []
  if (r.diagnostics.length) {
    lines.push(<span key="diag" {...stylex.props(s.diag)}>Type errors (fix these first; the output below is what happened anyway):{"\n"}{r.diagnostics.map((d) => `  line ${d.line}: ${d.message}`).join("\n")}</span>)
  }
  if (norm(r.stdout)) lines.push(<span key="out">{r.stdout.trimEnd()}</span>)
  if (norm(r.stderr)) lines.push(<span key="err" {...stylex.props(s.stderr)}>{r.stderr.trim()}</span>)
  if (r.timedOut) lines.push(<span key="to" {...stylex.props(s.diag)}>Timed out after 10s. Is something waiting forever?</span>)
  if (!norm(r.stdout) && !norm(r.stderr) && !r.diagnostics.length) lines.push(<span key="none" {...stylex.props(s.meta)}>(no output)</span>)
  if (expected != null) {
    lines.push(passes(r, expected)
      ? <span key="pass" {...stylex.props(s.pass)}>✓ Correct</span>
      : <span key="fail"><span {...stylex.props(s.fail)}>✗ Not yet</span> <span {...stylex.props(s.meta)}>expected output:{"\n"}{norm(expected)}</span></span>)
  }
  lines.push(<span key="meta" {...stylex.props(s.meta)}>exit {String(r.exitCode)}{r.timedOut ? " (killed)" : ""} · {r.durationMs}ms</span>)
  return (
    <div {...stylex.props(s.output)}>
      {lines.map((l, i) => <span key={i}>{i > 0 && "\n"}{l}</span>)}
    </div>
  )
}
