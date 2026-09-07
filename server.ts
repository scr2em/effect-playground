import path from "node:path"
import { check, warmup, ROOT } from "./lib/run.ts"
import { readdirSync, statSync } from "node:fs"

const PORT = Number(process.env.PORT ?? 4321)
const PUBLIC = path.join(ROOT, "public")

// Content is loaded in a child process so edits to content/sections/*.ts are picked up
// without a restart (Bun caches dynamic imports in-process). Cached by newest mtime.
const SECTIONS_DIR = path.join(ROOT, "content", "sections")
let contentCache: { stamp: number; json: string } | null = null
async function contentJson(): Promise<string> {
  const stamp = Math.max(...readdirSync(SECTIONS_DIR).map((f) => statSync(path.join(SECTIONS_DIR, f)).mtimeMs))
  if (contentCache && contentCache.stamp === stamp) return contentCache.json
  const proc = Bun.spawn(["bun", "run", path.join(ROOT, "scripts", "dump-content.ts")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [json, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error("content failed to load:\n" + err)
  contentCache = { stamp, json }
  return json
}

console.log("warming up type checker...")
warmup()

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/content") {
      return new Response(await contentJson(), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname === "/api/run" && req.method === "POST") {
      const { code } = (await req.json()) as { code: string }
      if (typeof code !== "string") return new Response("code required", { status: 400 })
      const result = await check(code)
      return Response.json(result)
    }
    const filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
    const file = Bun.file(path.join(PUBLIC, filePath))
    if (await file.exists()) return new Response(file)
    return new Response("not found", { status: 404 })
  }
})

console.log(`Effect playground: http://localhost:${PORT}`)
