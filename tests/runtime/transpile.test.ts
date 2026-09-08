/**
 * src/runtime/transpile.ts: learner TypeScript -> browser ES module with "effect" and
 * "effect/testing" specifiers rewritten to the bundle URLs.
 */
import { describe, expect, it } from "vitest"
import { transpile } from "../../src/runtime/transpile.ts"

const urls = { effect: "https://x.test/effect.js", testing: "https://x.test/effect-testing.js" }

describe("transpile", () => {
  it('rewrites import ... from "effect"', () => {
    const js = transpile(`import { Effect } from "effect"\nconsole.log(Effect)\n`, urls)
    expect(js).toContain(`from "${urls.effect}"`)
    expect(js).not.toMatch(/from\s+["']effect["']/)
  })

  it('rewrites import ... from "effect/testing"', () => {
    const js = transpile(`import { TestClock } from "effect/testing"\nconsole.log(TestClock)\n`, urls)
    expect(js).toContain(`from "${urls.testing}"`)
    expect(js).not.toMatch(/from\s+["']effect\/testing["']/)
  })

  it("rewrites re-exports and dynamic import()", () => {
    const js = transpile(`export * from "effect"\nconst m = await import("effect/testing")\nconsole.log(m)\n`, urls)
    expect(js).toContain(`export * from "${urls.effect}"`)
    expect(js).toContain(`import("${urls.testing}")`)
  })

  it("leaves other imports untouched", () => {
    const js = transpile(`import { x } from "other"\nimport { y } from "effect-ts-thing"\nimport { z } from "effect/Schema"\nconsole.log(x, y, z)\n`, urls)
    expect(js).toContain(`from "other"`)
    expect(js).toContain(`from "effect-ts-thing"`)
    expect(js).toContain(`from "effect/Schema"`)
  })

  it("strips types", () => {
    const js = transpile(
      `interface A { a: number }\ntype B = string\nconst n: number = 1\nconst f = (a: A, b: B): void => console.log(a, b, n)\nf({ a: 1 } as A, "b" satisfies B)\n`,
      urls
    )
    expect(js).not.toContain("interface")
    expect(js).not.toContain("type B")
    expect(js).not.toContain(": number")
    expect(js).not.toContain(" as A")
    expect(js).not.toContain("satisfies")
    expect(js).toContain("const n = 1")
  })

  it("drops `import type` entirely", () => {
    const js = transpile(`import type { Option } from "effect"\nconst o: Option.Option<number> | undefined = undefined\nconsole.log(o)\n`, urls)
    expect(js).not.toContain("import")
    expect(js).not.toContain("Option")
  })

  it("keeps side-effect imports and rewrites them when they target effect", () => {
    const js = transpile(`import "effect"\nimport "./polyfill.js"\n`, urls)
    expect(js).toContain(`import "${urls.effect}"`)
    expect(js).toContain(`import "./polyfill.js"`)
  })

  it("does not preserve line numbers (nothing in the runtime maps them back)", () => {
    // Type-only lines are removed by ts.transpileModule. This documents the current behaviour so a
    // future change that starts relying on line numbers (e.g. mapping stack traces) is caught.
    const src = `import type { Option } from "effect"\ninterface A { a: number }\nconsole.log(1)\n`
    const js = transpile(src, urls)
    expect(js.trimEnd().split("\n")).toEqual(["console.log(1);", "export {};"])
    expect(js.split("\n").length).toBeLessThan(src.split("\n").length)
  })

  it("emits ESNext modules and ES2022 syntax", () => {
    const js = transpile(`const v = await Promise.resolve(1)\nconsole.log(v ?? 0)\nclass C { #p = 1 }\nconsole.log(new C())\n`, urls)
    expect(js).toContain("await Promise.resolve(1)")
    expect(js).toContain("??")
    expect(js).toContain("#p = 1")
    expect(js).not.toContain("require(")
  })
})
