/**
 * The browser exec path in Node: transpile a lesson with src/runtime/transpile.ts (imports
 * rewritten to the prebuilt public/effect.js), import it with the console shim installed, and
 * compare stdout with the lesson's expectedOutput.
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { loadSections } from "../../content/index.ts"
import type { Lesson, Section } from "../../content/types.ts"
import { ROOT } from "../../lib/run.ts"
import { installConsole } from "../../src/runtime/format.ts"
import { transpile } from "../../src/runtime/transpile.ts"

const urls = {
  effect: pathToFileURL(path.join(ROOT, "public/effect.js")).href,
  testing: pathToFileURL(path.join(ROOT, "public/effect-testing.js")).href
}

let sections: Array<Section>
beforeAll(async () => {
  sections = await loadSections()
})

const pick = (sectionId: string, index: number): Lesson => {
  const l = sections.find((s) => s.id === sectionId)?.lessons[index]
  if (!l) throw new Error(`missing ${sectionId}[${index}]`)
  return l
}

const original = { log: console.log, info: console.info, debug: console.debug, table: console.table, error: console.error, warn: console.warn }
afterEach(() => {
  Object.assign(console, original)
})

async function runLesson(lesson: Lesson): Promise<string> {
  const js = transpile(lesson.code, urls)
  expect(js).not.toMatch(/from\s+["']effect(\/testing)?["']/)
  const out: Array<string> = []
  installConsole({ out: (l) => out.push(l), err: (l) => out.push("[stderr] " + l) })
  try {
    await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)
    // let un-awaited Effect.runPromise programs finish
    await new Promise((r) => setTimeout(r, 500))
  } finally {
    Object.assign(console, original)
  }
  return out.join("\n").trim()
}

describe("exec smoke", () => {
  it("runs a lesson through transpile + public/effect.js and prints its expectedOutput", async () => {
    const lesson = pick("sink", 0)
    expect(lesson.id).toBe("sink-l1")
    expect(await runLesson(lesson)).toBe(lesson.expectedOutput.trim())
  })

  it("runs a testing lesson through public/effect-testing.js", async () => {
    const lesson = pick("testing", 0)
    expect(await runLesson(lesson)).toBe(lesson.expectedOutput.trim())
  })

  it("effect-testing.js shares one Effect instance with effect.js", async () => {
    // esbuild code splitting: otherwise effect/testing values would not be recognised by effect.
    const main = await import(/* @vite-ignore */ urls.effect)
    const testing = await import(/* @vite-ignore */ urls.testing)
    expect(main.Layer.isLayer(testing.TestClock.layer())).toBe(true)
  })
})
