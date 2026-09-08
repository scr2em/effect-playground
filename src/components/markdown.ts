/**
 * Build-time markdown rendering: marked for the prose, shiki for fenced code.
 * Used by Markdown.astro and CodeRunner.astro (solution / fallback highlighting).
 */
import { Marked } from "marked"
import { createHighlighter, type Highlighter } from "shiki"

/** Dual themes: shiki emits --shiki-light / --shiki-dark per token; markdown-css.ts picks one by html[data-theme]. */
export const THEMES = { light: "github-light", dark: "github-dark-default" } as const
const LANGS = ["typescript", "tsx", "javascript", "json", "bash", "text"]
const ALIAS: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", txt: "text" }

let highlighterPromise: Promise<Highlighter> | undefined
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: Object.values(THEMES), langs: LANGS })
  return highlighterPromise
}

/** Highlight a code string; unlabeled fences are TypeScript, like the legacy UI. */
export async function highlightCode(code: string, lang?: string): Promise<string> {
  const h = await getHighlighter()
  const requested = ALIAS[lang ?? ""] ?? (lang || "typescript")
  const language = h.getLoadedLanguages().includes(requested) ? requested : "text"
  return h.codeToHtml(code, { lang: language, themes: THEMES, defaultColor: false })
}

export async function renderMarkdown(md: string): Promise<string> {
  const h = await getHighlighter()
  const marked = new Marked({
    renderer: {
      code(code: string, infostring?: string): string {
        const lang = (infostring ?? "").trim().split(/\s+/)[0]
        const requested = ALIAS[lang] ?? (lang || "typescript")
        const language = h.getLoadedLanguages().includes(requested) ? requested : "text"
        return h.codeToHtml(code, { lang: language, themes: THEMES, defaultColor: false })
      }
    }
  })
  return marked.parse(md ?? "", { async: false }) as string
}

export function renderInline(md: string): string {
  return new Marked().parseInline(md ?? "", { async: false }) as string
}
