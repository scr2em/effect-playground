/**
 * Verifies every code block in the content:
 *  - lessons: zero type errors, stdout === expectedOutput
 *  - challenges: solution passes; broken code must NOT pass (type error or different output)
 *  - problems: solution passes; starter must NOT pass
 * Usage: node --import tsx scripts/verify.ts [sectionId ...]   (npm run verify)
 * Programs run with node + tsx + scripts/console-shim.ts (lib/run.ts).
 */
import { check } from "../lib/run.ts"
import { loadSections } from "../content/index.ts"

const only = new Set(process.argv.slice(2))
const sections = (await loadSections()).filter((s) => only.size === 0 || only.has(s.id))

let failures = 0
let total = 0

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim()

async function passes(code: string, expected: string) {
  const r = await check(code)
  const ok = r.diagnostics.length === 0 && !r.timedOut && r.exitCode === 0 && norm(r.stdout) === norm(expected)
  return { ok, r }
}

function report(label: string, ok: boolean, detail?: string) {
  total++
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? "\n" + detail.split("\n").map((l) => "       " + l).join("\n") : ""}`)
  }
}

function describe(r: Awaited<ReturnType<typeof check>>, expected: string) {
  const parts: Array<string> = []
  if (r.diagnostics.length) parts.push("type errors:\n" + r.diagnostics.map((d) => `  L${d.line}:${d.col} ${d.message}`).join("\n"))
  if (r.timedOut) parts.push("timed out")
  if (r.exitCode !== 0) parts.push(`exit ${r.exitCode}\n${r.stderr.trim()}`)
  if (norm(r.stdout) !== norm(expected)) parts.push(`expected:\n${norm(expected)}\nactual:\n${norm(r.stdout)}`)
  return parts.join("\n")
}

for (const s of sections) {
  console.log(`\n== ${s.id} (${s.lessons.length} lessons, ${s.challenges.length} challenges, ${s.problems.length} problems, ${s.recall.length} recall)`)
  report(`has dosAndDonts (5-8)`, Array.isArray(s.dosAndDonts) && s.dosAndDonts.length >= 5 && s.dosAndDonts.length <= 8, `found ${s.dosAndDonts?.length ?? 0}`)
  const ids = new Set<string>()
  for (const item of [...s.lessons, ...s.challenges, ...s.problems]) {
    if (ids.has(item.id)) report(`duplicate id ${item.id}`, false)
    ids.add(item.id)
  }
  for (const l of s.lessons) {
    const { ok, r } = await passes(l.code, l.expectedOutput)
    report(`lesson    ${l.id}`, ok, ok ? undefined : describe(r, l.expectedOutput))
  }
  for (const c of s.challenges) {
    const sol = await passes(c.solution, c.expectedOutput)
    report(`challenge ${c.id} solution`, sol.ok, sol.ok ? undefined : describe(sol.r, c.expectedOutput))
    const broken = await passes(c.code, c.expectedOutput)
    report(`challenge ${c.id} broken code must fail`, !broken.ok, broken.ok ? "broken code already passes; the challenge is not a challenge" : undefined)
    if (c.hints.length === 0) report(`challenge ${c.id} has hints`, false)
  }
  for (const p of s.problems) {
    const sol = await passes(p.solution, p.expectedOutput)
    report(`problem   ${p.id} solution`, sol.ok, sol.ok ? undefined : describe(sol.r, p.expectedOutput))
    const starter = await passes(p.starter, p.expectedOutput)
    report(`problem   ${p.id} starter must fail`, !starter.ok, starter.ok ? "starter already passes" : undefined)
  }
}

console.log(`\n${total - failures}/${total} checks passed${failures ? `, ${failures} FAILED` : ""}`)
process.exit(failures ? 1 : 0)
