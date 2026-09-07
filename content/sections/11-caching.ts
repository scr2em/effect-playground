import type { Section } from "../types.ts"

const section: Section = {
  id: "caching",
  title: "Caching",
  order: 11,
  summary: "Memoize a single effect with Effect.cached, add expiry and invalidation, and build a keyed Cache that shares in-flight lookups.",
  intro: `
**The problem.** Every app grows a hand-made cache at some point. It usually starts as a \`Map\` and a timestamp:

\`\`\`ts
const cache = new Map<string, { value: User; expiresAt: number }>()

async function getUser(id: string) {
  const hit = cache.get(id)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const user = await db.load(id)                       // two callers miss at once -> two loads
  cache.set(id, { value: user, expiresAt: Date.now() + 60_000 })
  return user
}
\`\`\`

It looks fine until two requests miss at the same moment. Both see an empty slot, both call \`db.load\`, and the second write overwrites the first. Under load that becomes a "thundering herd": one expired key turns into a hundred identical database calls. Then you add a "pending" map to dedupe in-flight loads, then a way to invalidate, then a size limit, and now the cache is the most delicate concurrency code in the service.

### The shift

Today you think of a cache as **a data structure you check before doing the work**. Effect asks you to think of it as **an effect that already knows how to do the work**. \`Cache.get(cache, key)\` returns an Effect. When the key is missing it starts the lookup on its own fiber and stores that *fiber*, not the finished value. A second caller that arrives during the lookup gets the same fiber and waits on it. There is no moment where two callers can both decide to load, because deciding and loading are one atomic step inside the runtime.

The same idea, without a key, is \`Effect.cached\`: take any effect and get back a version that runs at most once, even when called concurrently. Expiry and invalidation are variants of the same function, not extra state you manage.

| | Plain memoize / \`Map\` | \`Effect.cached\` family | \`Cache\` module |
|---|---|---|---|
| Shape | Mutable variables | One effect, memoized | Key to value, with a lookup function |
| Concurrent misses | Race, duplicate work | Shared, runs once | Shared per key, runs once |
| Expiry | Manual timestamps | \`cachedWithTTL\` | \`timeToLive\` option |
| Invalidation | \`map.delete\` | \`cachedInvalidateWithTTL\` | \`Cache.invalidate\` / \`refresh\` |
| Size limit | Manual eviction | Not needed, one value | \`capacity\`, oldest evicted |
| Failures | Usually not cached | Cached until expiry | Cached until expiry |

In this section you will memoize one effect, give it a lifetime and a kill switch, then build a keyed cache and watch a counter to see exactly when the lookup runs.
`,
  lessons: [
    {
      id: "caching-l1",
      title: "Effect.cached: run at most once",
      explain: `
The plain TypeScript memoize you have written before looks like this:

\`\`\`ts
let memo: Promise<Config> | undefined
function loadConfigOnce() {
  if (!memo) memo = loadConfig()      // stores the Promise so concurrent callers share it
  return memo
}
\`\`\`

\`Effect.cached(effect)\` does the same job with one twist that trips people up: it returns an \`Effect<Effect<A>>\`. The outer effect *creates* the memoized version (it allocates the storage). You \`yield*\` it once to get the inner effect, and the inner effect is the thing you run many times. Below, \`calls\` counts how often the expensive body actually runs. Three concurrent runs plus one more afterwards still add up to a single execution.
`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)

  const loadConfig = Effect.gen(function* () {
    yield* Ref.update(calls, (n) => n + 1)   // count real executions
    yield* Effect.sleep("5 millis")          // pretend this is slow
    return { port: 8080 }
  })

  // Plain effect: every run does the work again
  yield* loadConfig
  yield* loadConfig
  console.log("plain: ran", yield* Ref.get(calls), "times")

  // cached: the outer yield* builds the memoized effect once
  yield* Ref.set(calls, 0)
  const cachedConfig = yield* Effect.cached(loadConfig)

  const results = yield* Effect.all([cachedConfig, cachedConfig, cachedConfig], { concurrency: "unbounded" })
  const again = yield* cachedConfig
  console.log("cached: ran", yield* Ref.get(calls), "time, ports:", results.map((c) => c.port).join(","), again.port)
})

Effect.runPromise(program)
`,
      expectedOutput: `plain: ran 2 times
cached: ran 1 time, ports: 8080,8080,8080 8080`,
      after: `Notice the three concurrent callers: none of them ran the body a second time, because the first run was in progress and they joined it. Try removing \`yield*\` before \`Effect.cached\`: the compiler complains where you use the result, because you would be holding the "builder" instead of the memoized effect.`
    },
    {
      id: "caching-l2",
      title: "Lifetimes and a kill switch: cachedWithTTL, cachedInvalidateWithTTL",
      explain: `
A value cached forever is only right for things that never change. The family has three members:

| Function | Returns | Recomputes when |
|---|---|---|
| \`Effect.cached(e)\` | \`Effect<Effect<A>>\` | Never |
| \`Effect.cachedWithTTL(e, ttl)\` | \`Effect<Effect<A>>\` | After \`ttl\` has passed since the last computation |
| \`Effect.cachedInvalidateWithTTL(e, ttl)\` | \`Effect<[Effect<A>, Effect<void>]>\` | After \`ttl\`, **or** when you run the second effect |

Durations are written as strings like \`"20 millis"\` or \`"1 hour"\`. The program below uses a very short TTL and a \`sleep\` longer than it, then counts calls. It never prints times, so the output is stable.
`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  const version = yield* Ref.make(0)
  const load = Effect.gen(function* () {
    yield* Ref.update(calls, (n) => n + 1)
    return "v" + (yield* Ref.updateAndGet(version, (n) => n + 1))
  })

  // TTL: fresh for 20ms, then recomputed on the next read
  const withTtl = yield* Effect.cachedWithTTL(load, "20 millis")
  console.log(yield* withTtl, yield* withTtl, "calls:", yield* Ref.get(calls))
  yield* Effect.sleep("40 millis")
  console.log(yield* withTtl, "calls after expiry:", yield* Ref.get(calls))

  // Invalidate: a long TTL plus a manual reset
  yield* Ref.set(calls, 0)
  const [cfg, invalidate] = yield* Effect.cachedInvalidateWithTTL(load, "1 hour")
  console.log(yield* cfg, yield* cfg, "calls:", yield* Ref.get(calls))
  yield* invalidate                       // next read recomputes even though 1 hour has not passed
  console.log(yield* cfg, "calls after invalidate:", yield* Ref.get(calls))
})

Effect.runPromise(program)
`,
      expectedOutput: `v1 v1 calls: 1
v2 calls after expiry: 2
v3 v3 calls: 1
v4 calls after invalidate: 2`,
      after: `\`invalidate\` does not recompute by itself; it only clears the stored value. The recomputation happens on the next read, so nothing runs if nobody asks. Try calling \`invalidate\` twice in a row: still one extra call.`
    },
    {
      id: "caching-l3",
      title: "Cache: many keys, one lookup function",
      explain: `
When values depend on a key, use the \`Cache\` module. \`Cache.make\` takes the \`lookup\` function that produces a value for a key, a \`capacity\`, and an optional \`timeToLive\`. Then:

| Function | Does |
|---|---|
| \`Cache.get(cache, key)\` | Return the cached value, or run \`lookup\` on a miss |
| \`Cache.has(cache, key)\` | \`true\` if a non-expired entry exists, no lookup |
| \`Cache.invalidate(cache, key)\` | Remove one entry |
| \`Cache.size(cache)\` | Number of stored entries |

There is no built-in hit counter, so the program counts lookups in a \`Ref\` and computes hits as reads minus lookups. That is the pattern you will use whenever you need to prove a cache is working.
`,
      code: `import { Cache, Effect, Ref } from "effect"

const usersTable = new Map([[1, "Ada"], [2, "Lin"], [3, "Sam"]])

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)

  const cache = yield* Cache.make({
    capacity: 100,
    lookup: (id: number) =>
      Effect.gen(function* () {
        yield* Ref.update(lookups, (n) => n + 1)   // a lookup means a cache miss
        return usersTable.get(id) ?? "?"
      })
  })

  const reads = [1, 2, 1, 1, 3, 2]
  const names: Array<string> = []
  for (const id of reads) names.push(yield* Cache.get(cache, id))

  const misses = yield* Ref.get(lookups)
  console.log(names.join(","))
  console.log("reads:", reads.length, "misses:", misses, "hits:", reads.length - misses)
  console.log("has 1:", yield* Cache.has(cache, 1), "has 9:", yield* Cache.has(cache, 9), "size:", yield* Cache.size(cache))

  yield* Cache.invalidate(cache, 1)
  yield* Cache.get(cache, 1)                     // miss again after invalidation
  console.log("after invalidate, misses:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      expectedOutput: `Ada,Lin,Ada,Ada,Sam,Lin
reads: 6 misses: 3 hits: 3
has 1: true has 9: false size: 3
after invalidate, misses: 4`,
      after: `\`Cache.has\` never triggers a lookup, which makes it safe for "is this warm?" checks. \`Cache.get\` always produces a value, running the lookup if needed. Pick the one that matches your intent.`
    },
    {
      id: "caching-l4",
      title: "Concurrent misses share one lookup",
      explain: `
This is the case the \`Map\` version got wrong. Three fibers ask for the same key at the same instant while the cache is empty. With a plain Map:

\`\`\`ts
// all three run this before any of them has stored a value
if (!map.has(key)) map.set(key, await load(key))   // three loads
\`\`\`

With \`Cache\`, the first \`get\` creates an entry that holds the *running lookup fiber* and stores it immediately, before the lookup finishes. The second and third \`get\` find that entry and wait on the same fiber. One load, three results. Failures are stored the same way, so if the lookup fails, everyone waiting gets the same failure and later reads see it too until it expires or is invalidated.
`,
      code: `import { Cache, Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)

  const cache = yield* Cache.make({
    capacity: 10,
    lookup: (id: number) =>
      Effect.gen(function* () {
        yield* Ref.update(lookups, (n) => n + 1)
        yield* Effect.sleep("10 millis")     // slow enough that all three callers arrive during it
        return "user-" + id
      })
  })

  // Three concurrent readers of the same missing key
  const results = yield* Effect.all(
    [Cache.get(cache, 7), Cache.get(cache, 7), Cache.get(cache, 7)],
    { concurrency: "unbounded" }
  )
  console.log(results.join(","))
  console.log("lookups for 3 concurrent gets:", yield* Ref.get(lookups))

  // Different keys still run their own lookups, concurrently
  yield* Effect.all([Cache.get(cache, 8), Cache.get(cache, 9)], { concurrency: "unbounded" })
  console.log("lookups after two new keys:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      expectedOutput: `user-7,user-7,user-7
lookups for 3 concurrent gets: 1
lookups after two new keys: 3`,
      after: `Change the sleep to \`"0 millis"\` and the count is still 1. The sharing does not depend on timing luck; it comes from storing the fiber before the lookup starts.`
    },
    {
      id: "caching-l5",
      title: "Capacity, time to live, and refresh",
      explain: `
Two more options and one more operation finish the picture.

\`capacity\` is the maximum number of entries. When a new entry pushes the cache over the limit, the oldest entries are removed. Reading an entry moves it to the "newest" end, so this is a least-recently-used policy.

\`timeToLive\` makes entries expire. An expired entry counts as missing: \`has\` returns \`false\` and \`get\` runs the lookup again.

\`Cache.refresh(cache, key)\` always runs the lookup and replaces the entry. Use it when you know the data changed and want the new value now, rather than \`invalidate\`, which waits for the next reader.
`,
      code: `import { Cache, Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)
  const cache = yield* Cache.make({
    capacity: 2,                    // only two entries fit
    timeToLive: "20 millis",
    lookup: (id: number) =>
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(lookups, (c) => c + 1)
        return "user-" + id + "#" + n   // the suffix shows which lookup produced it
      })
  })

  yield* Cache.get(cache, 1)
  yield* Cache.get(cache, 2)
  yield* Cache.get(cache, 3)      // capacity 2: entry 1 is the oldest and gets evicted
  console.log("has 1:", yield* Cache.has(cache, 1), "has 3:", yield* Cache.has(cache, 3), "size:", yield* Cache.size(cache))

  console.log(yield* Cache.get(cache, 3), "(cached)")
  yield* Effect.sleep("40 millis")
  console.log(yield* Cache.get(cache, 3), "(expired, looked up again)")

  console.log(yield* Cache.refresh(cache, 3), "(refresh forces a lookup)")
  console.log(yield* Cache.get(cache, 3), "(and the refreshed value is what get returns)")
})

Effect.runPromise(program)
`,
      expectedOutput: `has 1: false has 3: true size: 2
user-3#3 (cached)
user-3#4 (expired, looked up again)
user-3#5 (refresh forces a lookup)
user-3#5 (and the refreshed value is what get returns)`,
      after: `The \`#n\` suffix is a trick worth keeping: encode the call number in the value and you can tell hits from misses without any timing. Try \`capacity: 3\` and \`has 1\` becomes \`true\`.`
    }
  ],
  challenges: [
    {
      id: "caching-c1",
      title: "The cache that thrashes",
      task: `Two keys are read in turn, but every read is a miss. Change one number so the program prints \`lookups: 2\`.`,
      code: `import { Cache, Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)
  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (id: number) => Ref.update(lookups, (n) => n + 1).pipe(Effect.as("user-" + id))
  })

  for (const id of [1, 2, 1, 2, 1, 2]) yield* Cache.get(cache, id)
  console.log("lookups:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      solution: `import { Cache, Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)
  const cache = yield* Cache.make({
    capacity: 2,
    lookup: (id: number) => Ref.update(lookups, (n) => n + 1).pipe(Effect.as("user-" + id))
  })

  for (const id of [1, 2, 1, 2, 1, 2]) yield* Cache.get(cache, id)
  console.log("lookups:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      expectedOutput: `lookups: 2`,
      hints: [
        "How many distinct keys does the loop use? How many entries can the cache hold?",
        "Every time key 2 is stored, key 1 is evicted, and the other way round.",
        "Set capacity to 2 (or more)."
      ],
      explanation: `With \`capacity: 1\` the cache can hold one entry. Reading key 2 evicts key 1, the next read of key 1 is a miss that evicts key 2, and so on: six reads, six lookups. A capacity of 2 keeps both keys resident, so only the first read of each is a miss. Capacity is a real tuning knob: too small and the cache is pure overhead.`
    },
    {
      id: "caching-c2",
      title: "Memoized three times",
      task: `\`Effect.cached\` is used, yet the expensive effect runs once per iteration. Fix it so the loop prints \`42,42,42\` and \`runs: 1\`.`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const runs = yield* Ref.make(0)
  const expensive = Ref.update(runs, (n) => n + 1).pipe(Effect.as(42))

  const values: Array<number> = []
  for (let i = 0; i < 3; i++) {
    const memo = yield* Effect.cached(expensive)
    values.push(yield* memo)
  }
  console.log(values.join(","))
  console.log("runs:", yield* Ref.get(runs))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const runs = yield* Ref.make(0)
  const expensive = Ref.update(runs, (n) => n + 1).pipe(Effect.as(42))

  const memo = yield* Effect.cached(expensive)
  const values: Array<number> = []
  for (let i = 0; i < 3; i++) {
    values.push(yield* memo)
  }
  console.log(values.join(","))
  console.log("runs:", yield* Ref.get(runs))
})

Effect.runPromise(program)
`,
      expectedOutput: `42,42,42
runs: 1`,
      hints: [
        "yield* Effect.cached(...) builds a fresh memoized effect each time it runs. Where does it run?",
        "Inside the loop, each iteration gets its own empty cache.",
        "Move the const memo line above the for loop."
      ],
      explanation: `The outer effect returned by \`Effect.cached\` allocates the memo storage. Running it inside the loop allocates new, empty storage on every iteration, so each iteration's \`memo\` has never run before. Building the memoized effect once, outside the loop, gives all three iterations the same storage. The rule is the same as for a resolver in the Batching section: create the shared thing once, use it many times.`
    },
    {
      id: "caching-c3",
      title: "Holding the builder",
      task: `The program does not compile. Fix the one line that is wrong so it prints \`total: 84\` and \`runs: 1\`. Do not change the console.log lines.`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const runs = yield* Ref.make(0)
  const expensive = Ref.update(runs, (n) => n + 1).pipe(Effect.as(42))

  const memo = Effect.cached(expensive)
  const a = yield* memo
  const b = yield* memo
  console.log("total:", a + b)
  console.log("runs:", yield* Ref.get(runs))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const runs = yield* Ref.make(0)
  const expensive = Ref.update(runs, (n) => n + 1).pipe(Effect.as(42))

  const memo = yield* Effect.cached(expensive)
  const a = yield* memo
  const b = yield* memo
  console.log("total:", a + b)
  console.log("runs:", yield* Ref.get(runs))
})

Effect.runPromise(program)
`,
      expectedOutput: `total: 84
runs: 1`,
      hints: [
        "Read the type error on a + b. What is the type of a?",
        "Effect.cached returns Effect<Effect<number>>. One yield* unwraps only one layer.",
        "Add yield* in front of Effect.cached(expensive) so memo is the inner Effect<number>."
      ],
      explanation: `\`Effect.cached(expensive)\` is an \`Effect<Effect<number>>\`. Without the outer \`yield*\`, \`memo\` is the builder, and \`yield* memo\` gives you the *inner effect*, not a number. TypeScript refuses \`Effect + Effect\`, which is the compiler catching a mistake that in plain JavaScript would print \`[object Object][object Object]\`. Yielding the builder once produces the memoized \`Effect<number>\`, and yielding that gives numbers.`
    },
    {
      id: "caching-c4",
      title: "Stale after update",
      task: `The config is cached for an hour, but after \`bumpVersion\` runs the next read must return the new version. Change the caching so the program prints \`config v1\`, \`config v1\`, \`config v2\` on three lines.`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const version = yield* Ref.make(1)
  const loadConfig = Ref.get(version).pipe(Effect.map((v) => "config v" + v))
  const bumpVersion = Ref.update(version, (v) => v + 1)

  const config = yield* Effect.cachedWithTTL(loadConfig, "1 hour")

  console.log(yield* config)
  console.log(yield* config)
  yield* bumpVersion
  console.log(yield* config)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const version = yield* Ref.make(1)
  const loadConfig = Ref.get(version).pipe(Effect.map((v) => "config v" + v))
  const bumpVersion = Ref.update(version, (v) => v + 1)

  const [config, invalidate] = yield* Effect.cachedInvalidateWithTTL(loadConfig, "1 hour")

  console.log(yield* config)
  console.log(yield* config)
  yield* bumpVersion
  yield* invalidate
  console.log(yield* config)
})

Effect.runPromise(program)
`,
      expectedOutput: `config v1
config v1
config v2`,
      hints: [
        "cachedWithTTL only expires by time. Lesson 2's table lists a variant that also gives you a manual reset.",
        "cachedInvalidateWithTTL returns a pair: the cached effect and an invalidate effect.",
        "Destructure const [config, invalidate] = yield* Effect.cachedInvalidateWithTTL(loadConfig, \"1 hour\") and yield* invalidate right after bumpVersion."
      ],
      explanation: `A TTL is a guess about how long data stays valid. When you *know* it changed, a guess is the wrong tool. \`cachedInvalidateWithTTL\` keeps the same TTL safety net and adds an explicit \`invalidate\` effect that clears the stored value. The read after it recomputes and sees \`v2\`. Running \`invalidate\` at the place where the data changes is the whole pattern: write, then invalidate, then readers see fresh data.`
    },
    {
      id: "caching-c5",
      title: "The failure that stuck",
      task: `The database is down for the first lookup only. The cache remembers that failure, so the second read fails too. Make failed lookups expire immediately while successes are kept, so the program prints \`attempt 1: db down\`, \`attempt 2: user-1\`, \`lookups: 2\`. Keep using the \`Cache\` module.`,
      code: `import { Cache, Duration, Effect, Exit, Ref, Result } from "effect"

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)

  const cache = yield* Cache.make({
    capacity: 10,
    lookup: (id: number) =>
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(lookups, (c) => c + 1)
        if (n === 1) return yield* Effect.fail("db down")
        return "user-" + id
      })
  })

  for (const attempt of [1, 2]) {
    const r = yield* Effect.result(Cache.get(cache, 1))
    console.log("attempt " + attempt + ":", Result.isSuccess(r) ? r.success : r.failure)
  }
  console.log("lookups:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      solution: `import { Cache, Duration, Effect, Exit, Ref, Result } from "effect"

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)

  const cache = yield* Cache.makeWith(
    (id: number) =>
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(lookups, (c) => c + 1)
        if (n === 1) return yield* Effect.fail("db down")
        return "user-" + id
      }),
    {
      capacity: 10,
      timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity)
    }
  )

  for (const attempt of [1, 2]) {
    const r = yield* Effect.result(Cache.get(cache, 1))
    console.log("attempt " + attempt + ":", Result.isSuccess(r) ? r.success : r.failure)
  }
  console.log("lookups:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      expectedOutput: `attempt 1: db down
attempt 2: user-1
lookups: 2`,
      hints: [
        "Cache stores the lookup's Exit, success or failure, for the configured time to live.",
        "Cache.makeWith(lookup, options) accepts a timeToLive *function* that receives the Exit and can return a different duration per outcome.",
        "Return Duration.zero for failures and Duration.infinity for successes; a zero TTL removes the entry as soon as the lookup completes."
      ],
      explanation: `Caching failures is sometimes what you want (a missing user stays missing), but for transient errors it turns one outage into a stuck cache. \`Cache.make\` applies one TTL to everything. \`Cache.makeWith\` lets the TTL depend on the \`Exit\`, so a failure can expire instantly while a success lives on. Concurrent callers during the failed lookup still share it, so the herd protection stays; only the memory of the failure is dropped.`
    },
    {
      id: "caching-c6",
      title: "A cache that can fail",
      task: `\`safeName\` promises it cannot fail, but the cache lookup can. The program does not compile. Fix \`safeName\` so it keeps its declared type, returns \`"unknown"\` for failed lookups, and the program prints \`Ada\` then \`unknown\`.`,
      code: `import { Cache, Effect } from "effect"

const usersTable = new Map([[1, "Ada"]])

const program = Effect.gen(function* () {
  const cache = yield* Cache.make({
    capacity: 10,
    lookup: (id: number) => {
      const name = usersTable.get(id)
      return name === undefined ? Effect.fail("no user " + id) : Effect.succeed(name)
    }
  })

  const safeName = (id: number): Effect.Effect<string> => Cache.get(cache, id)

  console.log(yield* safeName(1))
  console.log(yield* safeName(2))
})

Effect.runPromise(program)
`,
      solution: `import { Cache, Effect } from "effect"

const usersTable = new Map([[1, "Ada"]])

const program = Effect.gen(function* () {
  const cache = yield* Cache.make({
    capacity: 10,
    lookup: (id: number) => {
      const name = usersTable.get(id)
      return name === undefined ? Effect.fail("no user " + id) : Effect.succeed(name)
    }
  })

  const safeName = (id: number): Effect.Effect<string> =>
    Cache.get(cache, id).pipe(Effect.catch(() => Effect.succeed("unknown")))

  console.log(yield* safeName(1))
  console.log(yield* safeName(2))
})

Effect.runPromise(program)
`,
      expectedOutput: `Ada
unknown`,
      hints: [
        "Read the error: Effect<string, string> is not assignable to Effect<string, never>. The cache carries the lookup's error type.",
        "Cache.get(cache, id) has the same error type as lookup. safeName needs to handle it before returning.",
        "Pipe through Effect.catch(() => Effect.succeed(\"unknown\"))."
      ],
      explanation: `A \`Cache<Key, A, E>\` remembers the lookup's error type, and \`Cache.get\` returns \`Effect<A, E>\`. Annotating \`safeName\` as \`Effect<string>\` (error \`never\`) is a promise the body cannot keep, so the compiler stops you. Handling the error with \`Effect.catch\` turns the failure into a success value and makes the error channel \`never\`, which now matches the annotation. A \`Map\`-based cache would have hidden the failure until it threw at runtime.`
    }
  ],
  problems: [
    {
      id: "caching-p1",
      title: "Feature flags with manual refresh",
      spec: `
A service reads feature flags from a slow source. Flags should be cached for an hour, but an admin endpoint can force a reload. Build it with \`Effect.cachedInvalidateWithTTL\`.

Requirements:

1. \`loadFlags\` increments \`loads\` (a \`Ref<number>\`) and returns \`"flags v<n>"\` where \`n\` is the number of loads so far. Use \`Ref.updateAndGet\`.
2. \`program\` creates the cached pair with a TTL of \`"1 hour"\`, then: reads twice, prints \`invalidated\` after running the invalidate effect, reads once more, and finally prints the load count.
3. Each read prints \`read: <value>\`.

Exact output:

\`\`\`
read: flags v1
read: flags v1
invalidated
read: flags v2
loads: 2
\`\`\`
`,
      starter: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const loads = yield* Ref.make(0)

  // TODO: loadFlags: bump loads and return "flags v<n>"

  // TODO: const [flags, invalidate] = yield* Effect.cachedInvalidateWithTTL(...)

  // TODO: read twice, invalidate (print "invalidated"), read once, print "loads: N"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const loads = yield* Ref.make(0)

  const loadFlags = Ref.updateAndGet(loads, (n) => n + 1).pipe(Effect.map((n) => "flags v" + n))

  const [flags, invalidate] = yield* Effect.cachedInvalidateWithTTL(loadFlags, "1 hour")
  const read = flags.pipe(Effect.tap((v) => Effect.sync(() => console.log("read:", v))))

  yield* read
  yield* read
  yield* invalidate
  console.log("invalidated")
  yield* read
  console.log("loads:", yield* Ref.get(loads))
})

Effect.runPromise(program)
`,
      expectedOutput: `read: flags v1
read: flags v1
invalidated
read: flags v2
loads: 2`,
      hints: [
        "Ref.updateAndGet returns the new value, so loadFlags is one pipe: update, then map to the string.",
        "cachedInvalidateWithTTL returns [cachedEffect, invalidateEffect]; destructure it after yield*.",
        "A small read effect that taps console.log keeps the three reads identical."
      ]
    },
    {
      id: "caching-p2",
      title: "Product price cache",
      spec: `
Build a keyed price cache in front of a price table, prove that duplicate concurrent reads share one lookup, then apply a price change with invalidation.

Requirements:

1. \`priceTable\` is a mutable \`Map<string, number>\` with \`A: 10\`, \`B: 20\`, \`C: 30\`.
2. Create a \`Cache\` with capacity 100 whose lookup increments \`lookups\` and reads the table (all keys exist).
3. Read \`["A", "B", "A", "C"]\` **concurrently** and print the prices joined by \`, \`, then \`lookups: 3\` and \`size: 3\`.
4. Change \`A\` to \`11\` in the table, invalidate \`A\`, print \`price update for A\`.
5. Read \`["A", "B"]\` again and print prices and lookups.

Exact output:

\`\`\`
prices: 10, 20, 10, 30
lookups: 3
size: 3
price update for A
prices: 11, 20
lookups: 4
\`\`\`
`,
      starter: `import { Cache, Effect, Ref } from "effect"

const priceTable = new Map([["A", 10], ["B", 20], ["C", 30]])

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)

  // TODO: cache with capacity 100; lookup bumps lookups and reads priceTable

  // TODO: read A, B, A, C concurrently; print "prices: ...", "lookups: N", "size: N"

  // TODO: priceTable.set("A", 11), invalidate "A", print "price update for A"

  // TODO: read A, B; print "prices: ...", "lookups: N"
})

Effect.runPromise(program)
`,
      solution: `import { Cache, Effect, Ref } from "effect"

const priceTable = new Map([["A", 10], ["B", 20], ["C", 30]])

const program = Effect.gen(function* () {
  const lookups = yield* Ref.make(0)

  const cache = yield* Cache.make({
    capacity: 100,
    lookup: (sku: string) => Ref.update(lookups, (n) => n + 1).pipe(Effect.map(() => priceTable.get(sku) ?? 0))
  })

  const readAll = (skus: Array<string>) =>
    Effect.forEach(skus, (sku) => Cache.get(cache, sku), { concurrency: "unbounded" }).pipe(
      Effect.tap((prices) => Effect.sync(() => console.log("prices:", prices.join(", "))))
    )

  yield* readAll(["A", "B", "A", "C"])
  console.log("lookups:", yield* Ref.get(lookups))
  console.log("size:", yield* Cache.size(cache))

  priceTable.set("A", 11)
  yield* Cache.invalidate(cache, "A")
  console.log("price update for A")

  yield* readAll(["A", "B"])
  console.log("lookups:", yield* Ref.get(lookups))
})

Effect.runPromise(program)
`,
      expectedOutput: `prices: 10, 20, 10, 30
lookups: 3
size: 3
price update for A
prices: 11, 20
lookups: 4`,
      hints: [
        "The lookup can be Ref.update(...).pipe(Effect.map(() => priceTable.get(sku) ?? 0)); the map runs after the counter bump.",
        "Effect.forEach with concurrency: \"unbounded\" starts all four gets at once; the two reads of A share one lookup, so lookups is 3, not 4.",
        "After Cache.invalidate(cache, \"A\"), the next get of A is a miss (lookup 4) and B is still a hit."
      ]
    }
  ],
  recall: [
    {
      q: "Why does `Effect.cached(effect)` return `Effect<Effect<A>>` instead of `Effect<A>`?",
      a: "The outer effect allocates the memo storage. Running it once gives you the inner, memoized effect. If you run the outer effect in a loop or inside a function you get a fresh empty cache each time, which is the most common mistake with it."
    },
    {
      q: "What would the type of `yield* Effect.cachedInvalidateWithTTL(load, \"1 hour\")` be if `load: Effect<Config, LoadError>`?",
      a: "`[Effect<Config, LoadError>, Effect<void>]`: the cached effect, which keeps `load`'s error type, and an invalidate effect that cannot fail."
    },
    {
      q: "Three fibers call `Cache.get` for the same missing key at the same time. How many lookups run?",
      a: "One. The first `get` stores the running lookup fiber in the entry before the lookup finishes; the other two find the entry and wait on that fiber. This is what a plain `Map` cache cannot do without extra 'pending' bookkeeping."
    },
    {
      q: "Which function would you reach for when data changed and you want the cache to hold the new value right away, not on the next read?",
      a: "`Cache.refresh(cache, key)`. It runs the lookup immediately and replaces the entry. `Cache.invalidate` only removes the entry, so the next reader pays for the lookup."
    },
    {
      q: "Does `Cache` remember failed lookups?",
      a: "Yes. The `Exit` is stored, success or failure, until it expires or is invalidated. To expire failures faster, use `Cache.makeWith` with a `timeToLive` function that inspects the `Exit` and returns `Duration.zero` for failures."
    },
    {
      q: "How would you prove a cache is working without printing timestamps?",
      a: "Count lookups in a `Ref` inside the lookup function, or encode the call number in the returned value (`\"user-3#4\"`). Reads minus lookups gives hits. Timing-based checks are flaky; counts are deterministic."
    }
  ]
}

export default section
