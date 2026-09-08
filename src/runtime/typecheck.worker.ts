/**
 * Web worker that owns the TypeScript compiler: type checks learner code against the bundled
 * Effect types (typecheck-core.ts) and transpiles it for the exec worker (transpile.ts). One
 * copy of TypeScript per page; exec.worker.ts stays tiny and is recreated for every run.
 */
import { createChecker, type Checker } from "./typecheck-core.ts"
import { transpile, type EffectUrls } from "./transpile.ts"

export type TypecheckRequestBody =
  | { type: "init"; typesUrl: string }
  | { type: "typecheck"; code: string }
  | { type: "transpile"; code: string; urls: EffectUrls }
export type TypecheckRequest = TypecheckRequestBody & { id: number }

export type TypecheckResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

let checker: Promise<Checker> | undefined

async function handle(req: TypecheckRequest): Promise<unknown> {
  switch (req.type) {
    case "init": {
      checker = fetch(req.typesUrl)
        .then((r) => {
          if (!r.ok) throw new Error(`${req.typesUrl}: HTTP ${r.status}`)
          return r.json()
        })
        .then((bundle) => {
          const c = createChecker(bundle)
          // build the program once so the first real check is fast
          c.typecheck(`import { Effect } from "effect"\nEffect.runSync(Effect.succeed(1))\n`)
          return c
        })
      await checker
      return undefined
    }
    case "typecheck": {
      if (!checker) throw new Error("typecheck worker not initialised")
      return (await checker).typecheck(req.code)
    }
    case "transpile":
      return transpile(req.code, req.urls)
  }
}

self.onmessage = async (e: MessageEvent<TypecheckRequest>) => {
  const req = e.data
  try {
    const result = await handle(req)
    self.postMessage({ id: req.id, ok: true, result } satisfies TypecheckResponse)
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies TypecheckResponse)
  }
}
