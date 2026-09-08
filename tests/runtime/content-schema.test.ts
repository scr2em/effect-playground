/**
 * Structural invariants of the course content (content/sections/*.ts via loadSections()).
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadSections } from "../../content/index.ts"
import type { Section } from "../../content/types.ts"

let sections: Array<Section>
beforeAll(async () => {
  sections = await loadSections()
})

describe("content schema", () => {
  it("has 19 sections with unique ids", () => {
    expect(sections).toHaveLength(19)
    expect(new Set(sections.map((s) => s.id)).size).toBe(19)
  })

  it("orders sections 1..19", () => {
    expect(sections.map((s) => s.order)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1))
  })

  it("gives every item a unique id across the course", () => {
    const ids = sections.flatMap((s) => [...s.lessons, ...s.challenges, ...s.problems].map((i) => i.id))
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
    expect(ids.length).toBeGreaterThan(0)
  })

  it("gives every section 5-8 dos and don'ts", () => {
    for (const s of sections) {
      expect(s.dosAndDonts.length, s.id).toBeGreaterThanOrEqual(5)
      expect(s.dosAndDonts.length, s.id).toBeLessThanOrEqual(8)
    }
  })

  it("gives every challenge hints and an explanation", () => {
    for (const s of sections) {
      for (const c of s.challenges) {
        expect(c.hints.length, c.id).toBeGreaterThan(0)
        expect(c.hints.every((h) => h.trim() !== ""), c.id).toBe(true)
        expect(c.explanation.trim(), c.id).not.toBe("")
      }
    }
  })

  it('has a "### The shift" heading in every intro', () => {
    for (const s of sections) expect(s.intro, s.id).toContain("### The shift")
  })

  it("has no expectedOutput ending with whitespace", () => {
    for (const s of sections) {
      for (const item of [...s.lessons, ...s.challenges, ...s.problems]) {
        expect(item.expectedOutput, item.id).toBe(item.expectedOutput.trimEnd())
      }
    }
  })
})
