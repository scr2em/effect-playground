import path from "node:path"
import { check, warmup, ROOT } from "./lib/run.ts"
import { loadSections } from "./content/index.ts"

const PORT = Number(process.env.PORT ?? 4321)
const PUBLIC = path.join(ROOT, "public")

console.log("warming up type checker...")
warmup()

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/content") {
      // reload on every request so content edits show up without restarting
      const sections = await loadSections()
      return Response.json(sections)
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
