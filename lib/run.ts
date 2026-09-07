import ts from "typescript"
import path from "node:path"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"

export const ROOT = path.resolve(import.meta.dir, "..")
const RUN_DIR = path.join(ROOT, "runner")
mkdirSync(RUN_DIR, { recursive: true })

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
  types: ["bun-types"],
  typeRoots: [path.join(ROOT, "node_modules/@types")]
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
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n")
    }
  })
}

// ---------- Execution: write a temp file, run with bun, kill after a timeout ----------
export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

export async function execute(code: string, timeoutMs = 10_000): Promise<RunResult> {
  const file = path.join(RUN_DIR, `run-${crypto.randomUUID()}.ts`)
  writeFileSync(file, code)
  const started = performance.now()
  const proc = Bun.spawn(["bun", "run", file], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  clearTimeout(timer)
  rmSync(file, { force: true })
  return {
    stdout,
    stderr: stderr.replaceAll(file, "playground.ts"),
    exitCode,
    timedOut,
    durationMs: Math.round(performance.now() - started)
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
