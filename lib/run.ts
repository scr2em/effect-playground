import ts from "typescript-js"
import path from "node:path"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const RUN_DIR = path.join(ROOT, "runner")
mkdirSync(RUN_DIR, { recursive: true })

// ---------- Learner files run with Node + tsx + the shared console formatter ----------
const SHIM = pathToFileURL(path.join(ROOT, "scripts/console-shim.ts")).href
export const RUNNER = [process.execPath, "--import", "tsx", "--import", SHIM]
export const runnerName = "node + tsx"

// ---------- Type checking: one persistent language service, one virtual file ----------
const VIRTUAL = path.join(RUN_DIR, "playground.ts")
let version = 0
let current = ""

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  strict: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  types: []
}

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => [VIRTUAL],
  getScriptVersion: (f) => (f === VIRTUAL ? String(version) : "0"),
  getScriptSnapshot: (f) => {
    if (f === VIRTUAL) return ts.ScriptSnapshot.fromString(current)
    if (!ts.sys.fileExists(f)) return undefined
    return ts.ScriptSnapshot.fromString(ts.sys.readFile(f)!)
  },
  getCurrentDirectory: () => ROOT,
  getCompilationSettings: () => compilerOptions,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories
}

const service = ts.createLanguageService(host, ts.createDocumentRegistry())

export interface Diagnostic {
  line: number
  col: number
  endLine: number
  endCol: number
  message: string
}

export function typecheck(code: string): Array<Diagnostic> {
  current = code
  version++
  const diags = [...service.getSyntacticDiagnostics(VIRTUAL), ...service.getSemanticDiagnostics(VIRTUAL)]
  return diags.map((d) => {
    const file = d.file
    const start = file && d.start !== undefined ? file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
    const end = file && d.start !== undefined
      ? file.getLineAndCharacterOfPosition(d.start + (d.length ?? 0))
      : start
    return {
      line: start.line + 1,
      col: start.character + 1,
      endLine: end.line + 1,
      endCol: end.character + 1,
      // paths in messages (typeof import("...")) are relative to the project, as in the browser
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n").replaceAll(ROOT, "")
    }
  })
}

// ---------- Running a TypeScript file in a child process ----------
export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

export function runFile(file: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    // detached: the child leads its own process group, so a timeout can kill the whole
    // tree (tsx runs user code in a grandchild process).
    const proc = spawn(RUNNER[0]!, [...RUNNER.slice(1), file], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let done = false
    proc.stdout.on("data", (d) => (stdout += d))
    proc.stderr.on("data", (d) => (stderr += d))
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, timedOut, durationMs: Math.round(performance.now() - started) })
    }
    const killTree = () => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL")
        else proc.kill("SIGKILL")
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
      // do not wait for orphaned pipes: report after a short grace period
      setTimeout(() => finish(null), 200)
    }, timeoutMs)
    proc.on("exit", (code) => {
      // give the stdio streams a tick to flush, then report
      setImmediate(() => finish(code))
    })
    proc.on("error", () => finish(null))
  })
}

export async function execute(code: string, timeoutMs = 10_000): Promise<RunResult> {
  const file = path.join(RUN_DIR, `run-${randomUUID()}.ts`)
  writeFileSync(file, code)
  try {
    const r = await runFile(file, timeoutMs)
    return { ...r, stderr: r.stderr.replaceAll(file, "playground.ts") }
  } finally {
    rmSync(file, { force: true })
  }
}

export interface FullResult extends RunResult {
  diagnostics: Array<Diagnostic>
}

export async function check(code: string, timeoutMs?: number): Promise<FullResult> {
  const diagnostics = typecheck(code)
  const run = await execute(code, timeoutMs)
  return { ...run, diagnostics }
}

export function warmup() {
  typecheck(`import { Effect } from "effect"\nEffect.runSync(Effect.succeed(1))\n`)
}
