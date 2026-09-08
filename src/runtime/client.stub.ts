/**
 * UI-owned STUB of Interface 2 (src/runtime/client.ts) for building the UI before the real
 * runtime lands. Returns a fake result; never type checks or executes anything.
 */
export interface Diagnostic { line: number; col: number; endLine: number; endCol: number; message: string }
export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}
export interface FullResult extends RunResult { diagnostics: Array<Diagnostic> }

export interface Runner {
  ready: Promise<void>
  typecheck(code: string): Promise<Array<Diagnostic>>
  execute(code: string, timeoutMs?: number): Promise<RunResult>
  check(code: string, timeoutMs?: number): Promise<FullResult>
}

let runner: Runner | undefined

export function getRunner(): Runner {
  if (runner) return runner
  const typecheck = async (code: string): Promise<Array<Diagnostic>> =>
    /\bTYPE_ERROR\b/.test(code)
      ? [{ line: 1, col: 1, endLine: 1, endCol: 2, message: "Stub diagnostic: the code contains TYPE_ERROR" }]
      : []
  const execute = async (code: string): Promise<RunResult> => {
    const start = performance.now()
    await new Promise((r) => setTimeout(r, 150))
    // Echo string-literal console.log arguments so the UI flow can be exercised by hand.
    const lines = [...code.matchAll(/console\.log\(\s*(["'`])((?:(?!\1).)*)\1\s*\)/g)].map((m) => m[2] ?? "")
    return {
      stdout: lines.length ? lines.join("\n") + "\n" : "",
      stderr: /\bRUNTIME_ERROR\b/.test(code) ? "Error: stub runtime error\n" : "",
      exitCode: /\bRUNTIME_ERROR\b/.test(code) ? 1 : 0,
      timedOut: false,
      durationMs: Math.round(performance.now() - start)
    }
  }
  runner = {
    ready: Promise.resolve(),
    typecheck,
    execute,
    check: async (code) => ({ diagnostics: await typecheck(code), ...(await execute(code)) })
  }
  return runner
}
