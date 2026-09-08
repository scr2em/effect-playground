/**
 * Runs one transpiled learner module. Protocol (see client.ts):
 *   main -> worker  { type: "warm", urls }    preload the Effect bundles, reply { type: "ready" }
 *   main -> worker  { type: "run", js }       run the module, stream { type: "out"|"err", line },
 *                                             then { type: "done", exitCode, durationMs }
 * A worker runs one program and is terminated by the main thread afterwards (or on timeout), so
 * every run starts from a fresh realm like a fresh Node process.
 *
 * Completion: Node exits when the event loop is empty. The worker emulates that by wrapping
 * setTimeout/setInterval/clearTimeout/clearInterval before the module loads and counting pending
 * timers: the run is done when the module's import promise has settled and, after a macrotask
 * boundary (so queued microtasks ran), no timer is pending. Effect's scheduler and Clock only use
 * setTimeout in a worker (no setImmediate), so this covers Effect.runPromise/runFork programs
 * that are not awaited at top level. Limitation: work that waits on something that is neither a
 * timer nor a microtask (fetch, MessageChannel, a Promise nobody resolves) is not visible: the
 * run reports done as soon as the tracked queue is empty, which is what Node does for a Promise
 * that never settles, and cuts a fetch short. An uncaught error or unhandled rejection ends the
 * run immediately with exitCode 1, like Node.
 */
import { installConsole } from "./format.ts"
import type { EffectUrls } from "./transpile.ts"

export type ExecRequest = { type: "warm"; urls: EffectUrls } | { type: "run"; js: string }
export type ExecEvent =
  | { type: "ready" }
  | { type: "out"; line: string }
  | { type: "err"; line: string }
  | { type: "done"; exitCode: number; durationMs: number }

const post = (m: ExecEvent) => self.postMessage(m)

// Effect's pretty logger picks its Node ("tty") format when a `process.stdout` exists and its
// browser format (console.log with %c CSS groups) otherwise. A stub keeps log lines identical to
// Node's non-TTY output (`[12:00:00.000] INFO (#1): message`). Effect guards every other
// process access (env, hrtime, cwd, isBun) with typeof checks.
;(globalThis as { process?: unknown }).process = { stdout: { isTTY: false }, env: {} }

const native = {
  setTimeout: self.setTimeout.bind(self),
  clearTimeout: self.clearTimeout.bind(self),
  setInterval: self.setInterval.bind(self),
  clearInterval: self.clearInterval.bind(self)
}
const pending = new Set<number>()
self.setTimeout = ((fn: (...a: Array<unknown>) => void, ms?: number, ...args: Array<unknown>) => {
  const id: number = native.setTimeout(() => {
    pending.delete(id)
    fn(...args)
  }, ms)
  pending.add(id)
  return id
}) as typeof setTimeout
self.clearTimeout = ((id?: number) => {
  if (id !== undefined) pending.delete(id)
  native.clearTimeout(id)
}) as typeof clearTimeout
self.setInterval = ((fn: (...a: Array<unknown>) => void, ms?: number, ...args: Array<unknown>) => {
  const id: number = native.setInterval(() => fn(...args), ms)
  pending.add(id)
  return id
}) as typeof setInterval
self.clearInterval = ((id?: number) => {
  if (id !== undefined) pending.delete(id)
  native.clearInterval(id)
}) as typeof clearInterval

const macrotask = () => new Promise<void>((r) => native.setTimeout(r, 0))
const nap = (ms: number) => new Promise<void>((r) => native.setTimeout(r, ms))

function errorText(e: unknown): string {
  if (e instanceof Error) return e.stack && e.stack.includes(e.message) ? e.stack : `${e.name}: ${e.message}${e.stack ? "\n" + e.stack : ""}`
  return typeof e === "string" ? e : String(e)
}

let done = false
let started = 0
let exitCode = 0
function finish() {
  if (done) return
  done = true
  post({ type: "done", exitCode, durationMs: Math.round(performance.now() - started) })
}

self.addEventListener("error", (e) => {
  e.preventDefault()
  post({ type: "err", line: errorText(e.error ?? e.message) })
  exitCode = 1
  finish()
})
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault()
  post({ type: "err", line: errorText(e.reason) })
  exitCode = 1
  finish()
})

async function run(js: string) {
  installConsole({ out: (line) => post({ type: "out", line }), err: (line) => post({ type: "err", line }) })
  started = performance.now()
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }))
  try {
    await import(/* @vite-ignore */ url)
  } catch (e) {
    post({ type: "err", line: errorText(e) })
    exitCode = 1
    finish()
    return
  }
  // drain: microtasks run before the macrotask boundary; then wait while timers are pending
  await macrotask()
  while (!done && pending.size > 0) await nap(5)
  await macrotask()
  finish()
}

self.onmessage = async (e: MessageEvent<ExecRequest>) => {
  const req = e.data
  if (req.type === "warm") {
    try {
      await Promise.all([import(/* @vite-ignore */ req.urls.effect), import(/* @vite-ignore */ req.urls.testing)])
    } catch (err) {
      post({ type: "err", line: `failed to load the Effect bundle: ${errorText(err)}` })
    }
    post({ type: "ready" })
  } else {
    void run(req.js)
  }
}
