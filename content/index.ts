import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Section } from "./types.ts"

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sections")

export async function loadSections(): Promise<Array<Section>> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()
  const sections: Array<Section> = []
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href)
    const section: Section | undefined = mod.default ?? mod.section
    if (!section) throw new Error(`${f} must export default a Section`)
    sections.push(section)
  }
  return sections.sort((a, b) => a.order - b.order)
}
