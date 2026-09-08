/**
 * Console output formatting shared by the browser exec worker and the Node verifier
 * (scripts/console-shim.ts). Plain TypeScript: no Node or DOM imports.
 *
 * Rules (ARCHITECTURE.md, Interface 4): top-level strings print as is, nested strings with double
 * quotes, containers Node-style (`[ 1, 2 ]`, `{ a: 1 }`, `ClassName { a: 1 }`, `Map(1) { "a" => 1 }`),
 * `[Object]`/`[Array]` deeper than 4 levels, values with a `Symbol.for("nodejs.util.inspect.custom")`
 * method print what that method returns, errors print `Name: message`. A container prints on one
 * line when that line is 72 characters or fewer, otherwise one entry per line with 2-space indent.
 */

const INSPECT = Symbol.for("nodejs.util.inspect.custom")
const MAX_DEPTH = 4
const WIDTH = 72
const IDENT = /^[A-Za-z_$][\w$]*$/

export function format(args: ReadonlyArray<unknown>): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")
}

/** Formats one value the way it prints when nested (strings get quotes). */
export function inspect(value: unknown): string {
  return render(value, 0, new Set())
}

function render(v: unknown, depth: number, seen: Set<object>): string {
  switch (typeof v) {
    case "string":
      return JSON.stringify(v)
    case "number":
      return Object.is(v, -0) ? "-0" : String(v)
    case "bigint":
      return `${v}n`
    case "boolean":
    case "undefined":
      return String(v)
    case "symbol":
      return v.toString()
    case "function":
      return renderFunction(v)
    case "object":
      break
  }
  if (v === null) return "null"
  const o = v as object
  return renderObject(o, depth, seen)
}

function renderFunction(f: Function): string {
  const isClass = /^class[\s{]/.test(Function.prototype.toString.call(f))
  if (isClass) return f.name ? `[class ${f.name}]` : "[class (anonymous)]"
  return f.name ? `[Function: ${f.name}]` : "[Function (anonymous)]"
}

function renderObject(o: object, depth: number, seen: Set<object>): string {
  const custom = (o as Record<symbol, unknown>)[INSPECT]
  if (typeof custom === "function") {
    let r: unknown
    try {
      r = custom.call(o, MAX_DEPTH - depth, {}, inspect)
    } catch {
      r = undefined
    }
    if (typeof r === "string") return r
    if (r !== undefined && r !== o) return render(r, depth, seen)
  }
  if (seen.has(o)) return "[Circular]"
  if (o instanceof Error) return o.message ? `${o.name}: ${o.message}` : o.name
  if (o instanceof Date) return isNaN(o.getTime()) ? "Invalid Date" : o.toISOString()
  if (o instanceof RegExp) return String(o)
  if (o instanceof Promise) return "Promise { <pending> }"
  if (o instanceof Number || o instanceof String || o instanceof Boolean || o instanceof BigInt || o instanceof Symbol) {
    return `[${o.constructor.name}: ${render(o.valueOf(), depth, seen)}]`
  }
  if (o instanceof WeakMap || o instanceof WeakSet) return `${o.constructor.name} { <items unknown> }`
  if (o instanceof ArrayBuffer) return `ArrayBuffer { byteLength: ${o.byteLength} }`
  const isArray = Array.isArray(o)
  const typed = ArrayBuffer.isView(o) && !(o instanceof DataView) ? (o as unknown as ArrayLike<unknown>) : undefined
  if (depth > MAX_DEPTH) return isArray || typed ? "[Array]" : "[Object]"

  seen.add(o)
  try {
    if (isArray) return join("[", (o as Array<unknown>).map((x) => render(x, depth + 1, seen)), "]")
    if (typed) {
      return join(`${o.constructor.name}(${typed.length}) [`, Array.from(typed, (x) => render(x, depth + 1, seen)), "]")
    }
    if (o instanceof Map) {
      const entries = Array.from(o, ([k, x]) => `${render(k, depth + 1, seen)} => ${render(x, depth + 1, seen)}`)
      return join(`Map(${o.size}) {`, entries, "}")
    }
    if (o instanceof Set) {
      return join(`Set(${o.size}) {`, Array.from(o, (x) => render(x, depth + 1, seen)), "}")
    }
    const entries: Array<string> = []
    for (const k of Object.keys(o)) {
      entries.push(`${IDENT.test(k) ? k : JSON.stringify(k)}: ${render((o as Record<string, unknown>)[k], depth + 1, seen)}`)
    }
    for (const s of Object.getOwnPropertySymbols(o)) {
      if (!Object.prototype.propertyIsEnumerable.call(o, s)) continue
      entries.push(`[${s.toString()}]: ${render((o as Record<symbol, unknown>)[s], depth + 1, seen)}`)
    }
    return join(`${prefix(o)}{`, entries, "}")
  } finally {
    seen.delete(o)
  }
}

function prefix(o: object): string {
  const proto = Object.getPrototypeOf(o)
  if (proto === null) return "[Object: null prototype] "
  if (proto === Object.prototype) return ""
  const name = proto.constructor?.name
  return typeof name === "string" && name !== "" && name !== "Object" ? `${name} ` : ""
}

function join(open: string, entries: Array<string>, close: string): string {
  if (entries.length === 0) return open + close
  const single = `${open} ${entries.join(", ")} ${close}`
  if (single.length <= WIDTH && !entries.some((e) => e.includes("\n"))) return single
  const body = entries.map((e) => "  " + e.replace(/\n/g, "\n  ")).join(",\n")
  return `${open}\n${body}\n${close}`
}

export interface ConsoleSink {
  out(line: string): void
  err(line: string): void
}

/**
 * Replaces console.log/info/debug/table (-> sink.out) and console.error/warn (-> sink.err) on
 * globalThis.console in place, so code that captured the console object earlier is covered too.
 */
export function installConsole(sink: ConsoleSink): void {
  const out = (...args: Array<unknown>) => sink.out(format(args))
  const err = (...args: Array<unknown>) => sink.err(format(args))
  const c = globalThis.console
  c.log = out
  c.info = out
  c.debug = out
  c.table = out
  c.error = err
  c.warn = err
}
