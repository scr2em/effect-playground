/**
 * Build-time section loader for pages. Mirrors content/index.ts (default export per file,
 * sorted by `order`) but through Vite's import.meta.glob: content/index.ts reads the sections
 * directory relative to import.meta.url, which no longer exists once Vite bundles it for the
 * static build.
 */
import type { Section } from "../../content/types.ts"

const modules = import.meta.glob<{ default?: Section; section?: Section }>("../../content/sections/*.ts", { eager: true })

export function loadSections(): Array<Section> {
  return Object.entries(modules)
    .map(([file, mod]) => {
      const section = mod.default ?? mod.section
      if (!section) throw new Error(`${file} must export default a Section`)
      return section
    })
    .sort((a, b) => a.order - b.order)
}
