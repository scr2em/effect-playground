# Effect Playground

An interactive course for learning Effect (v4.0.0-rc.112) by fixing and building real programs.

## Run

```
bun install
bun run start        # http://localhost:4321
bun run verify       # runs every lesson, challenge and problem; all must pass
```

The page needs internet once to load the Monaco editor and marked from cdnjs. Everything else is local.

## How a section is built, and why

Each section follows the same arc, based on how people actually learn a new programming model:

1. **The problem** in plain TypeScript. You cannot value a solution before you feel the pain.
2. **The shift** in mental model. Effect is not a library of helpers, it changes what a "program" is. Naming the shift explicitly stops you from writing Promise code with Effect syntax.
3. **A table** of the alternatives with "reach for it when" columns, so you get a map before the details.
4. **Learn**: worked examples that run. Each introduces one new idea. Formats vary: problem-first, comparison tables, plain TS vs Effect side by side.
5. **Do and don't**: a 3-column table (do, don't, why) specific to the section's APIs. Read it before you practice.
6. **Fix it**: faded worked examples. Early challenges are missing one call, later ones are missing more. Some fail only as a type error, which is the point of Effect. Hints are progressive. The explanation after success says *why* the fix works.
7. **Build it**: small real programs from a spec with exact expected output. This is the transfer step.
8. **Recall**: retrieval questions to answer in your head. Come back to them the next day.

All prose follows ASD-STE100 Simplified Technical English: short active sentences, one term per
meaning, no metaphors, "must" for requirements. Code is exempt.

Every title has a `#` link. The URL shape is `/#<section>/<item>`, so you can share a link to one
lesson, challenge, or table.

Progress, drafts and editor heights are stored in your browser's localStorage. "Reset progress" in the sidebar clears them.

## What runs your code

`POST /api/run` type-checks the file with a persistent TypeScript language service against the installed
`effect` package (real E and R channel errors, about 60ms warm), then executes it with `bun run` under a
10 second timeout. Type errors do not block execution, so you see both the compiler's view and what
actually happened.

## Adding or editing content

Sections live in `content/sections/*.ts` and are reloaded on every request. See `content/AUTHORING.md`
for the rules and `content/types.ts` for the schema. Run `bun run verify <sectionId>` after editing.
