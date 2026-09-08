/**
 * The browser checker core (src/runtime/typecheck-core.ts over public/effect-types.json) must
 * report the same diagnostics as the Node checker (lib/run.ts). A representative subset of the
 * course is compared here; `node --import tsx scripts/verify.ts` covers every block.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { loadSections } from "../../content/index.ts"
import type { Section } from "../../content/types.ts"
import { ROOT, typecheck as nodeTypecheck } from "../../lib/run.ts"
import { createChecker, type Checker } from "../../src/runtime/typecheck-core.ts"

const SECTIONS = ["getting-started", "error-management", "concurrency"]
const LESSONS: Array<[section: string, index: number]> = [
  ["getting-started", 0],
  ["error-management", 0],
  ["concurrency", 0],
  ["stream", 0],
  ["testing", 0]
]

const pick = (d: { line: number; col: number; message: string }) => ({ line: d.line, col: d.col, message: d.message })

let browser: Checker
let sections: Array<Section>

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "public/effect-types.json"), "utf8"))
  browser = createChecker(bundle)
  sections = await loadSections()
})

const section = (id: string) => {
  const s = sections.find((s) => s.id === id)
  if (!s) throw new Error(`missing section ${id}`)
  return s
}

describe("typecheck-core", () => {
  it("reports exactly one diagnostic on line 1 for a plain type error", () => {
    const diags = browser.typecheck(`const x: number = "a"\n`)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ line: 1, col: 7, message: "Type 'string' is not assignable to type 'number'." })
  })

  it("reports nothing for a valid Effect program", () => {
    expect(browser.typecheck(`import { Effect } from "effect"\nEffect.runSync(Effect.succeed(1))\n`)).toEqual([])
  })
})

describe("parity with lib/run.ts", () => {
  describe.each(SECTIONS)("%s: every challenge whose broken code has type errors", (id) => {
    it("has at least one such challenge", () => {
      expect(section(id).challenges.some((c) => nodeTypecheck(c.code).length > 0)).toBe(true)
    })
    it("matches diagnostics (line, col, message)", () => {
      for (const c of section(id).challenges) {
        const node = nodeTypecheck(c.code)
        if (node.length === 0) continue
        expect(browser.typecheck(c.code).map(pick), `challenge ${c.id}`).toEqual(node.map(pick))
      }
    })
  })

  it.each(LESSONS)("lesson %s[%i] matches", (id, index) => {
    const lesson = section(id).lessons[index]
    if (!lesson) throw new Error(`missing lesson ${id}[${index}]`)
    expect(browser.typecheck(lesson.code).map(pick)).toEqual(nodeTypecheck(lesson.code).map(pick))
  })
})
