/**
 * Bundles `effect` and `effect/testing` for the browser with esbuild:
 *   public/effect.js          <- export * from "effect"
 *   public/effect-testing.js  <- export * from "effect/testing"
 *   public/effect-shared.js   <- code shared by both (esbuild code splitting), imported relatively
 * The exec worker rewrites `from "effect"` / `from "effect/testing"` in learner code to the
 * absolute URLs of the first two files. Node-only imports: effect/testing/TestSchema.js imports
 * `node:assert`, aliased to scripts/stubs/node-assert.js.
 * Run: node scripts/build-effect-bundle.mjs
 */
import { build } from "esbuild"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outdir = path.join(root, "public")

const result = await build({
  absWorkingDir: root,
  entryPoints: [
    { in: "node_modules/effect/dist/index.js", out: "effect" },
    { in: "node_modules/effect/dist/testing/index.js", out: "effect-testing" }
  ],
  outdir,
  bundle: true,
  format: "esm",
  splitting: true,
  chunkNames: "effect-shared",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  alias: { "node:assert": path.join(root, "scripts/stubs/node-assert.js") },
  metafile: true,
  logLevel: "warning"
})

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
let raw = 0
let gz = 0
for (const file of Object.keys(result.metafile.outputs)) {
  const abs = path.join(root, file)
  const buf = readFileSync(abs)
  const g = gzipSync(buf).length
  raw += statSync(abs).size
  gz += g
  console.log(`${file}: ${kb(buf.length)} raw, ${kb(g)} gzip`)
}
console.log(`total: ${kb(raw)} raw, ${kb(gz)} gzip`)
