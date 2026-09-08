export interface Diagnostic { line: number; col: number; endLine: number; endCol: number; message: string }
export interface RunResult {
  stdout: string        // everything console.log/info/debug printed, joined with "\n" endings
  stderr: string        // console.error/warn output and uncaught error text
  exitCode: number | null   // 0 = finished with no uncaught error; 1 = uncaught error or rejection; null = killed
  timedOut: boolean
  durationMs: number
}
export interface FullResult extends RunResult { diagnostics: Array<Diagnostic> }
