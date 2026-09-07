# Authoring guide for playground sections

Read this fully before writing a section. Then read `content/types.ts` and the exemplar
`content/sections/01-getting-started.ts`, and match its style and depth exactly.

## Who the learner is

A working TypeScript developer who ships production code, is fluent with Promise/async,
classes, generics, and has never used Effect. They learn best by seeing the *pain* in
plain TypeScript first, then the Effect way, then fixing broken code, then building.

## Target library: Effect v4.0.0-rc.112 (NOT v3)

All code runs against the `effect@4.0.0-rc.112` package installed here. Source of truth:
`/Users/mohamed/projects/gocv2/repos/effect/packages/effect/src/*.ts` (JSDoc has examples)
and `/Users/mohamed/projects/gocv2/repos/effect/ai-docs/src/**` (small verified programs).
Migration notes: `/Users/mohamed/projects/gocv2/repos/effect/migration/*.md`.

Known renames from v3 (the public website docs are v3, do NOT trust them for names):
- `Effect.catchAll` -> `Effect.catch`, `catchAllCause` -> `catchCause`, `catchAllDefect` -> `catchDefect`, `catchSome` -> `catchFilter`
- `Effect.fork` -> `Effect.forkChild`, `forkDaemon` -> `forkDetach` (`forkScoped`, `forkIn` unchanged)
- `Either` -> `Result` (`Result.succeed` / `Result.fail`, `Result.isSuccess`...) — check `Result.ts`
- `Context.Tag` / `Effect.Service` -> `Context.Service` / `ServiceMap.Service` — read `migration/services.md`
- `TRef` etc -> `TxRef` etc; `TestClock` -> `effect/testing`
- `Cause` is a flat `reasons` array of `Fail | Die | Interrupt` (no Sequential/Parallel/Empty)
- Errors: prefer `Schema.TaggedError`; `Data.TaggedError` also exists
- `Effect.try` exists (exported as `try`), `Effect.tryPromise`, `Effect.fn`, `Effect.callback`, `Effect.fromNullishOr`
When unsure, grep the source: `grep -n "^export const NAME" packages/effect/src/Module.ts` and read the JSDoc.
Every API you use MUST exist in this version. The verifier will catch type errors.

## Section structure (all fields required, see types.ts)

1. `intro` (markdown, 250-500 words). MUST contain, in this order:
   - **The problem** — a concrete pain in plain TypeScript, with a tiny code snippet showing it.
   - **The shift** — a short paragraph with the heading `### The shift` describing how the
     learner thinks about this today (imperative / Promise / exceptions / DI container / etc.)
     and how Effect thinks about it instead, and *why* the new model pays off.
   - **The idea in one table** when the topic has 2+ alternatives (plain TS vs Effect, or the
     family of functions with "use when" column). Markdown tables render.
2. `lessons` (4-7). Each: `explain` in plain English (80-200 words), a full runnable
   program, exact `expectedOutput`, optional `after` ("Notice ..., try changing ..."). Vary
   the format across lessons: problem-first, comparison table, side-by-side "plain TS vs
   Effect" (show the plain TS version as a code block in `explain`, the Effect version as `code`).
   Lessons build on each other: each introduces ONE new thing.
3. `challenges` (5-8) "Fix it". Faded worked examples: early ones have a single missing
   call or a wrong function name with the shape obvious; later ones remove more. Each MUST:
   - fail as given (type error or wrong output), pass with `solution`
   - have 2-3 progressive `hints`
   - have an `explanation` of *why* the fix works (not just what)
   - include at least ONE challenge whose bug is only visible as a TYPE error (e.g. an
     unhandled error type, a missing requirement, wrong channel). That is the point of Effect.
   - task text must not give away the answer, but must be precise about what "fixed" means.
4. `problems` (2-4) "Build it". Real, small, motivating programs (an order pipeline, a retrying
   fetch with fake data, a rate limiter, an inventory system...). `starter` = imports +
   type definitions + TODO comments, must fail. `spec` states required behavior AND the exact
   output. Solutions 25-80 lines. Deterministic: no real clocks in output, no real network,
   no randomness (use fixed data). Use `Effect.sleep` only with tiny durations if needed.
5. `recall` (5-8). Short retrieval questions with markdown answers. Include one
   "what would the type be?" question and one "which function would you reach for?" question.

## Code rules

- Every `code`/`solution`/`starter` is a COMPLETE file: imports, definitions, and a final
  `Effect.runPromise(program)` or `Effect.runSync(...)` that prints via `console.log`.
- Output must be DETERMINISTIC and reproduced exactly by `expectedOutput` (trimmed compare).
  Avoid printing durations, timestamps, object identity, or `Effect.log` (it prints timestamps).
  If you must show a log, use `console.log`.
- Programs finish within 3 seconds. No infinite streams without `take`.
- Keep programs 10-60 lines. Comments explain the *why* at the exact line of interest.
- Prefer `Effect.gen` for sequencing, `pipe` for transformations; show both once.
- Content lives in template literals: escape backticks as \` and `${` as \${ inside them.
- IDs: `<sectionId>-l1`, `<sectionId>-c1`, `<sectionId>-p1` etc. Unique across the section.

## Tone: ASD-STE100 Simplified Technical English (MANDATORY for all prose)

All prose (intro, explain, after, task, hints, explanation, spec, recall q/a) MUST follow
ASD-STE100 Simplified Technical English. Code, identifiers, API names and output are exempt.

Writing rules:
- One sentence = one idea. Descriptive sentences max 25 words. Instruction sentences max 20 words.
- Paragraphs max 6 sentences. Start a paragraph with the most important sentence.
- Active voice only. Present tense for descriptions. Imperative for instructions ("Change the
  runner", not "You should change the runner" / "The runner should be changed").
- Use "must" for requirements. Do not use "should", "may", "might", "could" for requirements.
- No contractions (write "do not", "it is"). No slang, idioms, metaphors, or figurative language
  (no "recipe vs meal", "under the hood", "escape hatch", "fire and forget", "the point of").
  Say what the thing does in plain words instead.
- No gerund / -ing verb forms as nouns or in progressive tense ("Running the effect starts..." ->
  "When you run the effect, it starts..."). Use "-ing" only as a technical adjective ("the
  remaining fibers") when there is no alternative.
- Use articles ("a", "the") and demonstratives ("this", "these"). Do not drop them.
- Noun clusters max 3 words ("service tag", not "service tag lookup table entry").
- One term = one meaning, one meaning = one term. Pick a term and use it everywhere:
  "effect" (a value), "run" (execute), "fail" (expected error), "defect" (unexpected error),
  "service", "layer", "fiber", "interrupt", "provide". Do not alternate synonyms
  (not "execute/run/perform", not "error/failure/exception" for the same thing).
- Prefer approved simple verbs: make, do, get, put, show, give, start, stop, remove, use, add,
  change, keep, send, read, write, hold, wait, apply, set, become, cause, permit, prevent.
  Avoid: utilize, leverage, facilitate, ensure ("make sure"), reach for ("use"), handle
  ("process" or say what is done), grab, spin up, tear down, bubble up, blow up, swallow.
- Vertical lists for sequences and for more than 3 parallel items.
- Write numbers as digits. Write a warning or a limitation as its own sentence that starts with
  "Note:" or "Caution:".
- Do not use "simply", "just", "obviously", "of course", "basically".
- Say what happens when something is wrong: "If you do not run the effect, nothing prints."
- Explain a technical term the first time you use it, in one short sentence.

Example rewrite:
  Before: "Effect asks you to think of a program as a value that describes work. An Effect is a
           recipe, not a meal. You build the recipe, pass it around, and at the end hand it to a
           runtime that cooks it."
  After:  "In Effect, a program is a value. The value describes work. It does not do the work.
           You build the value, you combine it with other values, and at the end you give it to
           the runtime. The runtime does the work."

## Verify before you finish

```
cd /Users/mohamed/projects/effect-playground
bun run scripts/verify.ts <sectionId>
```
All checks must be `ok`. Iterate until they are. Do not weaken a challenge to make it pass;
fix the content.
