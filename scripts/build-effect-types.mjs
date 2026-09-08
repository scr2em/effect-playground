/**
 * Writes public/effect-types.json: a virtual file system for the browser type checker
 * (src/runtime/typecheck-core.ts). Shape: { "files": { "<absolute path>": "<content>" } } with
 *   /node_modules/effect/package.json and /node_modules/effect/dist/**\/*.d.ts (unstable/ excluded:
 *     the content never imports effect/unstable/*),
 *   /node_modules/fast-check/package.json + its .d.ts (re-exported by effect/testing FastCheck),
 *   /lib/lib.*.d.ts: TypeScript's lib.es2022.d.ts and lib.dom.d.ts plus every lib they reference.
 * Run: node scripts/build-effect-types.mjs
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const nm = path.join(root, "node_modules")
const files = {}

function walk(dir, keep) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, keep)
    else if (keep(abs)) files["/node_modules/" + path.relative(nm, abs).split(path.sep).join("/")] = readFileSync(abs, "utf8")
  }
}

const effectDist = path.join(nm, "effect/dist")
walk(effectDist, (f) => f.endsWith(".d.ts") && !f.startsWith(path.join(effectDist, "unstable")))
files["/node_modules/effect/package.json"] = readFileSync(path.join(nm, "effect/package.json"), "utf8")

// fast-check is a dependency of effect; resolve it from effect's location so pnpm's non-hoisted layout works.
const fcPkgPath = createRequire(path.join(realpathSync(path.join(nm, "effect")), "package.json")).resolve("fast-check/package.json")
const fcDir = path.dirname(fcPkgPath)
const fc = JSON.parse(readFileSync(fcPkgPath, "utf8"))
files["/node_modules/fast-check/package.json"] = JSON.stringify({ name: fc.name, version: fc.version, types: fc.types })
files["/node_modules/fast-check/" + fc.types] = readFileSync(path.join(fcDir, fc.types), "utf8")

// TypeScript lib files: the ones the compiler options name, plus the /// <reference lib="..."/> chain
const tsLib = path.join(nm, "typescript-js/lib")
const queue = ["es2022", "dom"]
const seen = new Set()
while (queue.length) {
  const lib = queue.shift()
  if (seen.has(lib)) continue
  seen.add(lib)
  const text = readFileSync(path.join(tsLib, `lib.${lib}.d.ts`), "utf8")
  files[`/lib/lib.${lib}.d.ts`] = text
  for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g)) queue.push(m[1])
}

const json = JSON.stringify({ files })
mkdirSync(path.join(root, "public"), { recursive: true })
writeFileSync(path.join(root, "public/effect-types.json"), json)
const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`public/effect-types.json: ${Object.keys(files).length} files, ${kb(Buffer.byteLength(json))} raw, ${kb(gzipSync(json).length)} gzip`)
console.log(`  lib files: ${[...seen].map((l) => `lib.${l}.d.ts`).join(", ")}`)
