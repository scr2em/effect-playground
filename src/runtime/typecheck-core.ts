/**
 * The type checker: a TypeScript language service over a virtual file system loaded from
 * public/effect-types.json (built by scripts/build-effect-types.mjs). Pure TypeScript, no DOM
 * or Node imports: it runs inside src/runtime/typecheck.worker.ts in the browser and directly in
 * Node for tests/runtime/typecheck-parity.test.ts. Compiler options mirror lib/run.ts so both checkers
 * report the same diagnostics.
 */
import ts from "typescript-js"
import type { Diagnostic } from "./types.ts"

export interface TypesBundle {
  files: Record<string, string>
}

export const FILE = "/playground.ts"
const LIB_DIR = "/lib"

export const compilerOptions: ts.CompilerOptions = {
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

export interface Checker {
  typecheck(code: string): Array<Diagnostic>
}

export function createChecker(bundle: TypesBundle): Checker {
  const files = bundle.files
  const dirs = new Set<string>(["/"])
  for (const f of Object.keys(files)) {
    let d = f
    while ((d = d.slice(0, d.lastIndexOf("/"))) !== "") dirs.add(d)
  }
  const snapshots = new Map<string, ts.IScriptSnapshot>()
  const snapshotOf = (f: string) => {
    let s = snapshots.get(f)
    if (!s) {
      s = ts.ScriptSnapshot.fromString(files[f]!)
      snapshots.set(f, s)
    }
    return s
  }
  const childrenOf = (dir: string, wantDirs: boolean) => {
    const prefix = dir === "/" ? "/" : dir + "/"
    const out = new Set<string>()
    for (const f of wantDirs ? dirs : Object.keys(files)) {
      if (!f.startsWith(prefix) || f === dir) continue
      const rest = f.slice(prefix.length)
      if (!rest.includes("/")) out.add(rest)
    }
    return [...out]
  }

  let current = ""
  let version = 0
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [FILE],
    getScriptVersion: (f) => (f === FILE ? String(version) : "0"),
    getScriptSnapshot: (f) => {
      if (f === FILE) return ts.ScriptSnapshot.fromString(current)
      return f in files ? snapshotOf(f) : undefined
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: () => `${LIB_DIR}/lib.es2022.d.ts`,
    fileExists: (f) => f === FILE || f in files,
    readFile: (f) => (f === FILE ? current : files[f]),
    directoryExists: (d) => dirs.has(d),
    getDirectories: (d) => childrenOf(d, true),
    readDirectory: (d) => childrenOf(d, false).map((f) => `${d === "/" ? "" : d}/${f}`),
    useCaseSensitiveFileNames: () => true
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry(true, "/"))

  return {
    typecheck(code) {
      current = code
      version++
      const diags = [...service.getSyntacticDiagnostics(FILE), ...service.getSemanticDiagnostics(FILE)]
      return diags.map(toDiagnostic)
    }
  }
}

export function toDiagnostic(d: ts.Diagnostic): Diagnostic {
  const file = d.file
  const start = file && d.start !== undefined ? file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
  const end = file && d.start !== undefined ? file.getLineAndCharacterOfPosition(d.start + (d.length ?? 0)) : start
  return {
    line: start.line + 1,
    col: start.character + 1,
    endLine: end.line + 1,
    endCol: end.character + 1,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n")
  }
}
