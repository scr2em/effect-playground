/**
 * lib/run.ts: the Node runner used by scripts/verify.ts (typecheck via a TS language service,
 * execute via a child process running node + tsx + the console shim).
 */
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { ROOT, check } from "../../lib/run.ts"

/** Live (non-zombie) child processes spawned by execute(): their argv ends with runner/run-<uuid>.ts. */
function liveRunnerProcesses(): Array<string> {
  const marker = `${ROOT}/runner/run-`
  const ps = execFileSync("ps", ["-eo", "pid,stat,command"], { encoding: "utf8" })
  return ps
    .split("\n")
    .filter((line) => line.includes(marker))
    .filter((line) => !/^\s*\d+\s+Z/.test(line))
}

async function waitFor(pred: () => boolean, ms: number) {
  const until = Date.now() + ms
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  return pred()
}

describe("lib/run.ts check", () => {
  it("returns exitCode 0 and stdout for a passing program", async () => {
    const r = await check(`import { Effect } from "effect"\nconsole.log(Effect.runSync(Effect.succeed({ a: 1 })))\nconsole.log("done")\n`)
    expect(r.diagnostics).toEqual([])
    expect(r.stdout).toBe("{ a: 1 }\ndone\n")
    expect(r.stderr).toBe("")
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  it("returns exitCode 1 and stderr for a throwing program", async () => {
    const r = await check(`console.log("before")\nthrow new Error("boom")\n`)
    expect(r.diagnostics).toEqual([])
    expect(r.stdout).toBe("before\n")
    expect(r.stderr).toContain("boom")
    expect(r.exitCode).toBe(1)
    expect(r.timedOut).toBe(false)
  })

  it("reports type errors alongside execution", async () => {
    const r = await check(`const x: number = "a"\nconsole.log(x)\n`)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]).toMatchObject({ line: 1, col: 7 })
    expect(r.stdout).toBe("a\n")
  })

  it("times out an infinite loop and kills the whole process tree", async () => {
    const timeoutMs = 1500
    const started = performance.now()
    const r = await check(`console.log("start")\nwhile (true) {}\n`, timeoutMs)
    const elapsed = performance.now() - started
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeNull()
    expect(elapsed).toBeLessThan(timeoutMs + 1000)
    expect(await waitFor(() => liveRunnerProcesses().length === 0, 2000), liveRunnerProcesses().join("\n")).toBe(true)
  })
})
