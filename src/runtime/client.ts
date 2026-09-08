/**
 * Interface 2 (ARCHITECTURE.md): the runner used by the UI.
 *   import { getRunner } from "../runtime/client.ts"
 *   const r = getRunner(); await r.ready; const res = await r.check(code)
 * One typecheck worker (TypeScript + Effect types, also transpiles) lives for the page; one
 * exec worker per run, pre-warmed with the Effect bundle so a run starts immediately.
 */
import type { Diagnostic, FullResult, RunResult } from "./types.ts"
import type { TypecheckRequestBody, TypecheckResponse } from "./typecheck.worker.ts"
import type { ExecEvent, ExecRequest } from "./exec.worker.ts"
import type { EffectUrls } from "./transpile.ts"

export type { Diagnostic, FullResult, RunResult }

export interface Runner {
  ready: Promise<void>                       // resolves when types + bundle are loaded
  typecheck(code: string): Promise<Array<Diagnostic>>
  execute(code: string, timeoutMs?: number): Promise<RunResult>   // default 10_000
  check(code: string, timeoutMs?: number): Promise<FullResult>    // typecheck then execute, always both
}

const base = (() => {
  const b = import.meta.env.BASE_URL
  return b.endsWith("/") ? b : b + "/"
})()
export const assetUrls = {
  types: new URL(base + "effect-types.json", location.href).href,
  effect: new URL(base + "effect.js", location.href).href,
  testing: new URL(base + "effect-testing.js", location.href).href
}

class TypecheckClient {
  private worker = new Worker(new URL("./typecheck.worker.ts", import.meta.url), { type: "module" })
  private next = 1
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor() {
    this.worker.onmessage = (e: MessageEvent<TypecheckResponse>) => {
      const w = this.waiting.get(e.data.id)
      if (!w) return
      this.waiting.delete(e.data.id)
      if (e.data.ok) w.resolve(e.data.result)
      else w.reject(new Error(e.data.error))
    }
    this.worker.onerror = (e) => {
      for (const w of this.waiting.values()) w.reject(new Error(e.message))
      this.waiting.clear()
    }
  }

  request<T>(req: TypecheckRequestBody): Promise<T> {
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ ...req, id })
    })
  }
}

class ExecWorker {
  readonly worker = new Worker(new URL("./exec.worker.ts", import.meta.url), { type: "module" })
  readonly ready: Promise<void>
  private onEvent: ((e: ExecEvent) => void) | undefined

  constructor(urls: EffectUrls) {
    this.ready = new Promise((resolve) => {
      this.worker.onmessage = (e: MessageEvent<ExecEvent>) => {
        if (e.data.type === "ready") resolve()
        else this.onEvent?.(e.data)
      }
    })
    this.worker.onerror = (e) => e.preventDefault()
    this.worker.postMessage({ type: "warm", urls } satisfies ExecRequest)
  }

  run(js: string, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
      let stdout = ""
      let stderr = ""
      const started = performance.now()
      const timer = setTimeout(() => {
        this.worker.terminate()
        resolve({ stdout, stderr, exitCode: null, timedOut: true, durationMs: Math.round(performance.now() - started) })
      }, timeoutMs)
      this.onEvent = (e) => {
        if (e.type === "out") stdout += e.line + "\n"
        else if (e.type === "err") stderr += e.line + "\n"
        else if (e.type === "done") {
          clearTimeout(timer)
          this.worker.terminate()
          resolve({ stdout, stderr, exitCode: e.exitCode, timedOut: false, durationMs: e.durationMs })
        }
      }
      this.worker.postMessage({ type: "run", js } satisfies ExecRequest)
    })
  }
}

function createRunner(): Runner {
  const tc = new TypecheckClient()
  const urls: EffectUrls = { effect: assetUrls.effect, testing: assetUrls.testing }
  let spare = new ExecWorker(urls)
  const takeWorker = () => {
    const w = spare
    spare = new ExecWorker(urls)
    return w
  }
  const typesReady = tc.request<void>({ type: "init", typesUrl: assetUrls.types })
  const ready = Promise.all([typesReady, spare.ready]).then(() => undefined)
  ready.catch(() => {})

  // executions are serialised: a second call waits for the first
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const p = queue.then(task, task)
    queue = p.catch(() => {})
    return p
  }

  const typecheck = async (code: string) => {
    await typesReady
    return tc.request<Array<Diagnostic>>({ type: "typecheck", code })
  }
  const execute = (code: string, timeoutMs = 10_000) =>
    enqueue(async () => {
      const started = performance.now()
      let js: string
      try {
        js = await tc.request<string>({ type: "transpile", code, urls })
      } catch (e) {
        return { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: 1, timedOut: false, durationMs: Math.round(performance.now() - started) }
      }
      const w = takeWorker()
      await w.ready
      return w.run(js, timeoutMs)
    })

  return {
    ready,
    typecheck,
    execute,
    check: async (code, timeoutMs) => {
      const diagnostics = await typecheck(code)
      const run = await execute(code, timeoutMs)
      return { ...run, diagnostics }
    }
  }
}

let runner: Runner | undefined
export function getRunner(): Runner {
  runner ??= createRunner()
  return runner
}
