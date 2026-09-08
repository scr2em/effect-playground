# Effect Playground

An interactive course for Effect v4 (TypeScript). You learn by fixing broken programs and by
building small ones. Type checking and execution happen in your browser: no server, no install.

**Open it:** https://scr2em.github.io/effect-playground/

Or run it locally (Node 20.19 or newer):

```
npx effect-playground
```

## How a section is built, and why

Each section follows the same arc, based on how people learn a new programming model:

1. **The problem** in plain TypeScript. You cannot value a solution before you see the problem.
2. **The shift** in mental model. Effect is not a set of helpers. It changes what a "program" is.
   The shift is named so that you do not write Promise code with Effect syntax.
3. **A table** of the alternatives with "use it when" columns, so you get a map before the details.
4. **Learn**: worked examples that run. Each introduces one idea. Formats vary: problem-first,
   comparison tables, plain TypeScript next to Effect.
5. **Do and don't**: a 3-column table (do, don't, why) specific to the section's APIs.
6. **Fix it**: broken programs. Early ones lack one call, later ones lack more. Some fail only
   as a type error, which is the point of Effect. Hints are progressive. After success, the
   page explains why the fix works.
7. **Build it**: small real programs from a spec with an exact expected output.
8. **Recall**: questions to answer in your head. Come back to them the next day.

All prose follows ASD-STE100 Simplified Technical English. Every heading has a `#` link, so you
can share a link to one lesson, one challenge, or one table.

Progress, drafts, and editor heights are stored in your browser. "Reset progress" in the
sidebar clears them.

## What runs your code

Your code is type-checked in a web worker against the real `effect@4.0.0-rc.112` declarations,
then transpiled and executed in a sandboxed worker with a bundled copy of Effect. Type errors do
not block execution, so you see both the compiler's view and what actually happened. A run that
does not finish in 10 seconds is stopped.

See `ARCHITECTURE.md` for the design.

## Develop

```
pnpm install
pnpm run build:assets   # bundles Effect for the browser and collects its types into public/
pnpm dev                # Astro dev server
pnpm test               # Vitest: runtime, content schema, and React component tests
pnpm run verify         # runs every lesson, challenge, and problem in Node; all must pass
pnpm run build          # assets + static site into dist/
```

The stack: Astro 7 with React 19 islands, StyleX for styling, Vitest, pnpm. TypeScript 7 (the
native compiler) checks the project. The in-browser type checker and the Node verifier use the last
JavaScript-based TypeScript (6.0) under the `typescript-js` alias, so both give identical diagnostics.

Content lives in `content/sections/*.ts`. See `content/AUTHORING.md` for the rules and
`content/types.ts` for the schema. Run `pnpm run verify <sectionId>` after you edit a section.

Pushes to `main` build, verify, and deploy to GitHub Pages through `.github/workflows/deploy.yml`.

## License

MIT
