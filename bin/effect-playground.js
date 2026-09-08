#!/usr/bin/env node
// Serves the prebuilt static site (dist/) on localhost and opens the browser.
import http from "node:http"
import path from "node:path"
import { createReadStream, existsSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const BASE = "/effect-playground"
const args = process.argv.slice(2)
const portArg = args.find((a) => a.startsWith("--port="))
const port = Number(portArg ? portArg.split("=")[1] : process.env.PORT ?? 4321)
const noOpen = args.includes("--no-open")

if (args.includes("--help") || args.includes("-h")) {
  console.log(`effect-playground [--port=4321] [--no-open]

Serves the interactive Effect course at http://localhost:<port>${BASE}/`)
  process.exit(0)
}
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("dist/ is missing. Run `npm run build` first (published packages include it).")
  process.exit(1)
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json", ".txt": "text/plain", ".wasm": "application/wasm"
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
  if (p === "/" || p === BASE) {
    res.writeHead(302, { location: BASE + "/" })
    return res.end()
  }
  if (!p.startsWith(BASE + "/")) {
    res.writeHead(404)
    return res.end("not found")
  }
  p = p.slice(BASE.length)
  let file = path.join(dist, path.normalize(p))
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end() }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html")
  if (!existsSync(file) && existsSync(file + ".html")) file = file + ".html"
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" })
    return res.end("not found")
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" })
  createReadStream(file).pipe(res)
})

server.listen(port, () => {
  const url = `http://localhost:${port}${BASE}/`
  console.log(`Effect playground: ${url}`)
  if (!noOpen) {
    const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
    try { spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref() } catch {}
  }
})
