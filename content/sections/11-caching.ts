import type { Section } from "../types.ts"

const section: Section = {
  id: "caching",
  title: "Caching",
  order: 11,
  summary: "Memoize a single effect with Effect.cached, add expiry and invalidation, and build a keyed Cache that shares in-flight lookups.",
  intro: `
**The problem.** Every app gets a hand-made cache at some point. It usually starts as a \`Map\` and a timestamp:

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

This code looks correct until 2 requests miss at the same moment. Both see an empty slot, both call \`db.load\`, and the second write replaces the first. Under load, 1 expired key becomes 100 identical database calls. Then you add a "pending" map to deduplicate the active loads. Then you add a way to invalidate, then a size limit. Now the cache is the most fragile concurrency code in the service.

### The shift

Today you think of a cache as **a data structure that you check before you do the work**. Effect asks you to think of it as **an effect that knows how to do the work**. \`Cache.get(cache, key)\` returns an Effect. When the key is missing, it starts the lookup on its own fiber and stores that *fiber*, not the finished value. A second caller that arrives during the lookup gets the same fiber and waits for it. 2 callers can never both decide to load, because the decision and the load are 1 atomic step inside the runtime.

\`Effect.cached\` is the same idea without a key. It memoizes any effect: it stores the result of the first run and returns that result to all later callers. The effect runs at most 1 time, also when concurrent callers use it. Expiry and invalidation are variants of the same function. They are not extra state that you manage.

| | Plain memoize / \`Map\` | \`Effect.cached\` family | \`Cache\` module |
|---|---|---|---|
| Shape | Mutable variables | 1 effect, memoized | Key to value, with a lookup function |
| Concurrent misses | Race condition, duplicate work | Shared, runs once | Shared per key, runs once |
| Expiry | Manual timestamps | \`cachedWithTTL\` | \`timeToLive\` option |
| Invalidation | \`map.delete\` | \`cachedInvalidateWithTTL\` | \`Cache.invalidate\` / \`refresh\` |
| Size limit | Manual eviction | Not needed, 1 value | \`capacity\`, removes the oldest entry |
| Failures | Usually not cached | Cached until expiry | Cached until expiry |

In this section you will:

1. Memoize 1 effect.
2. Give it a lifetime and a manual invalidation.
3. Build a keyed cache.
4. Watch a counter to see when the lookup runs.
`,
  lessons: [
    {
      id: "caching-l1",
      title: "Effect.cached: run at most once",
      explain: `
The plain TypeScript memoize that you wrote before looks like this:

\`\`\`ts
let memo: Promise<Config> | undefined
function loadConfigOnce() {
  if (!memo) memo = loadConfig()      // stores the Promise so concurrent callers share it
  return memo
}
\`\`\`

\`Effect.cached(effect)\` does the same job, with 1 difference that causes mistakes: it returns an \`Effect<Effect<A>>\`. The outer effect *creates* the memoized version (it allocates the storage). You \`yield*\` it 1 time to get the inner effect. The inner effect is the one that you run many times. In the program below, \`calls\` counts how often the expensive body runs. 3 concurrent runs plus 1 later run cause only 1 run of the body.
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
      after: `None of the 3 concurrent callers ran the body a second time. The first run was in progress, and the other callers waited for it. Try to remove \`yield*\` before \`Effect.cached\`. The compiler reports an error where you use the result, because you then hold the builder effect instead of the memoized effect.`
    },
    {
      id: "caching-l2",
      title: "Lifetimes and a kill switch: cachedWithTTL, cachedInvalidateWithTTL",
      explain: `
A value that is cached forever is only correct for data that never changes. A TTL (time to live) is the time that a cached value stays valid. The family has 3 members:

| Function | Returns | Recomputes when |
|---|---|---|
| \`Effect.cached(e)\` | \`Effect<Effect<A>>\` | Never |
| \`Effect.cachedWithTTL(e, ttl)\` | \`Effect<Effect<A>>\` | After \`ttl\` has passed since the last computation |
| \`Effect.cachedInvalidateWithTTL(e, ttl)\` | \`Effect<[Effect<A>, Effect<void>]>\` | After \`ttl\`, **or** when you run the second effect |

You write durations as strings such as \`"20 millis"\` or \`"1 hour"\`. The program below uses a very short TTL and a \`sleep\` that is longer than the TTL. Then it counts the calls. It never prints times, so the output is stable.
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
      after: `\`invalidate\` does not recompute the value. It only removes the stored value. The next read recomputes the value, so nothing runs if nobody reads. Try to call \`invalidate\` 2 times in a row. The count still shows 1 extra call.`
    },
    {
      id: "caching-l3",
      title: "Cache: many keys, one lookup function",
      explain: `
When the values depend on a key, use the \`Cache\` module. \`Cache.make\` takes a \`lookup\` function that produces a value for a key, a \`capacity\`, and an optional \`timeToLive\`. A miss is a read of a key that the cache does not hold. A hit is a read that the cache answers from a stored entry. Then:

| Function | Does |
|---|---|
| \`Cache.get(cache, key)\` | Returns the cached value, or runs \`lookup\` on a miss |
| \`Cache.has(cache, key)\` | Returns \`true\` if an entry exists and has not expired. It does not run a lookup |
| \`Cache.invalidate(cache, key)\` | Removes 1 entry |
| \`Cache.size(cache)\` | Returns the number of stored entries |

There is no built-in hit counter. The program counts the lookups in a \`Ref\` and computes the hits as reads minus lookups. Use this pattern each time you must prove that a cache works.
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
      after: `\`Cache.has\` never starts a lookup, so it is safe for a check of the type "is this key stored?". \`Cache.get\` always produces a value, and it runs the lookup when necessary. Use the function that matches your intent.`
    },
    {
      id: "caching-l4",
      title: "Concurrent misses share one lookup",
      explain: `
This is the case that the \`Map\` version got wrong. 3 fibers ask for the same key at the same instant, and the cache is empty. With a plain Map:

\`\`\`ts
// all three run this before any of them has stored a value
if (!map.has(key)) map.set(key, await load(key))   // three loads
\`\`\`

With \`Cache\`, the first \`get\` creates an entry that holds the *lookup fiber*. It stores the entry immediately, before the lookup finishes. The second and the third \`get\` find that entry and wait for the same fiber. 1 load, 3 results. The cache stores failures in the same way. If the lookup fails, every caller that waits gets the same failure. Later reads also see the failure until it expires or you invalidate it.
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
      after: `Change the sleep to \`"0 millis"\`. The count is still 1. The shared lookup does not depend on the exact time of the calls. It comes from the fact that the cache stores the fiber before the lookup starts.`
    },
    {
      id: "caching-l5",
      title: "Capacity, time to live, and refresh",
      explain: `
2 more options and 1 more operation remain.

\`capacity\` is the maximum number of entries. When a new entry pushes the cache over the limit, the cache removes the oldest entries. A read moves an entry to the "newest" end, so this is a least-recently-used policy.

\`timeToLive\` makes entries expire. An expired entry counts as missing: \`has\` returns \`false\`, and \`get\` runs the lookup again.

\`Cache.refresh(cache, key)\` always runs the lookup and replaces the entry. Use it when you know that the data changed and you want the new value now. \`invalidate\` waits for the next reader.
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
      after: `The \`#n\` suffix is a useful technique. Put the call number in the value, and you can tell hits from misses without a clock. Try \`capacity: 3\`. \`has 1\` then becomes \`true\`.`
    }
  ],
  dosAndDonts: [
    {
      do: "\`yield*\` \`Effect.cached(effect)\` once, outside loops and functions, and run the inner effect many times.",
      dont: "Do not call \`yield* Effect.cached(effect)\` inside a loop.",
      why: "The outer effect allocates new empty storage each time it runs, so the expensive body runs on every iteration."
    },
    {
      do: "Use \`Effect.cachedInvalidateWithTTL\` when your code knows the moment that the data changes.",
      dont: "Do not depend on a TTL alone to see an update that your own code made.",
      why: "A TTL is an estimate, and the cache returns old data until the TTL passes."
    },
    {
      do: "Use the \`Cache\` module when the values depend on a key.",
      dont: "Do not check a \`Map\` and then load the value in 2 separate steps.",
      why: "2 concurrent misses both load the value, and under load 1 expired key becomes many identical calls."
    },
    {
      do: "Use \`Cache.makeWith\` with a \`timeToLive\` function that returns \`Duration.zero\` for failures.",
      dont: "Do not store a transient failure for the full TTL.",
      why: "The cache returns the stored failure to every reader until it expires, so 1 outage becomes a cache that stays failed."
    },
    {
      do: "Set a capacity that holds the number of keys that the program reads often.",
      dont: "Do not use a capacity that is smaller than the number of keys in rotation.",
      why: "Each new key removes an older key, so every read is a miss, and the cache only adds overhead."
    },
    {
      do: "Use \`Cache.has\` for a check that must not start a lookup.",
      dont: "Do not use \`Cache.get\` to check whether a key is stored.",
      why: "\`Cache.get\` runs the lookup on a miss, so the check does work and stores a value."
    },
    {
      do: "Prove that a cache works with a lookup counter in a \`Ref\`, or with the call number in the value.",
      dont: "Do not print times or depend on timestamps in a check.",
      why: "Checks that depend on the clock are unreliable, and counts are deterministic."
    }
  ],
  challenges: [
    {
      id: "caching-c1",
      title: "The cache that thrashes",
      task: `The program reads 2 keys in turn, but every read is a miss. Change 1 number so that the program prints \`lookups: 2\`.`,
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
        "How many different keys does the loop use? How many entries can the cache hold?",
        "Each time the cache stores key 2, it removes key 1. Each time it stores key 1, it removes key 2.",
        "Set capacity to 2 (or more)."
      ],
      explanation: `With \`capacity: 1\` the cache holds 1 entry. A read of key 2 removes key 1. The next read of key 1 is a miss that removes key 2, and so on: 6 reads, 6 lookups. A capacity of 2 keeps both keys in the cache, so only the first read of each key is a miss. The capacity is an important setting. Note: if the capacity is too small, the cache only adds overhead.`
    },
    {
      id: "caching-c2",
      title: "Memoized three times",
      task: `The program uses \`Effect.cached\`, but the expensive effect runs once per iteration. Fix it so that the loop prints \`42,42,42\` and \`runs: 1\`.`,
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
        "yield* Effect.cached(...) builds a new memoized effect each time it runs. Where does it run?",
        "Inside the loop, each iteration gets its own empty cache.",
        "Move the const memo line above the for loop."
      ],
      explanation: `The outer effect that \`Effect.cached\` returns allocates the memo storage. When you run it inside the loop, it allocates new, empty storage on every iteration. The \`memo\` of each iteration has never run before. When you build the memoized effect once, outside the loop, all 3 iterations use the same storage. The rule is the same as for a resolver in the Batching section: create the shared object once, and use it many times.`
    },
    {
      id: "caching-c3",
      title: "Holding the builder",
      task: `The program does not compile. Fix the 1 line that is wrong so that the program prints \`total: 84\` and \`runs: 1\`. Do not change the console.log lines.`,
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
        "Effect.cached returns Effect<Effect<number>>. One yield* removes only 1 layer.",
        "Add yield* in front of Effect.cached(expensive), so that memo is the inner Effect<number>."
      ],
      explanation: `\`Effect.cached(expensive)\` is an \`Effect<Effect<number>>\`. Without the outer \`yield*\`, \`memo\` is the builder effect, and \`yield* memo\` gives you the *inner effect*, not a number. TypeScript rejects \`Effect + Effect\`. The compiler catches a mistake that plain JavaScript prints as \`[object Object][object Object]\`. Yield the builder effect once to get the memoized \`Effect<number>\`. Then yield that effect to get numbers.`
    },
    {
      id: "caching-c4",
      title: "Stale after update",
      task: `The config is cached for 1 hour. But after \`bumpVersion\` runs, the next read must return the new version. Change the cache setup so that the program prints \`config v1\`, \`config v1\`, \`config v2\` on 3 lines.`,
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
        "cachedWithTTL only expires by time. The table in lesson 2 lists a variant that also gives you a manual reset.",
        "cachedInvalidateWithTTL returns a pair: the cached effect and an invalidate effect.",
        "Destructure const [config, invalidate] = yield* Effect.cachedInvalidateWithTTL(loadConfig, \"1 hour\"). Then yield* invalidate directly after bumpVersion."
      ],
      explanation: `A TTL is an estimate of how long the data stays valid. When you *know* that the data changed, an estimate is the wrong tool. \`cachedInvalidateWithTTL\` keeps the same TTL and adds an explicit \`invalidate\` effect that removes the stored value. The read after it recomputes the value and sees \`v2\`. Run \`invalidate\` at the place where the data changes. This is the whole pattern: write, then invalidate, then the readers see new data.`
    },
    {
      id: "caching-c5",
      title: "The failure that stuck",
      task: `The database is down for the first lookup only. The cache stores that failure, so the second read also fails. Make failed lookups expire immediately, and keep the successes. The program must print \`attempt 1: db down\`, \`attempt 2: user-1\`, \`lookups: 2\`. Keep the \`Cache\` module.`,
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
        "Cache stores the Exit of the lookup, success or failure, for the configured time to live.",
        "Cache.makeWith(lookup, options) accepts a timeToLive *function*. The function receives the Exit and can return a different duration per outcome.",
        "Return Duration.zero for failures and Duration.infinity for successes. A zero TTL removes the entry as soon as the lookup completes."
      ],
      explanation: `Sometimes you want the cache to store failures (a missing user stays missing). But for transient errors, 1 outage becomes a cache that stays failed. \`Cache.make\` applies 1 TTL to everything. \`Cache.makeWith\` lets the TTL depend on the \`Exit\`, so a failure can expire immediately and a success can stay. Concurrent callers during the failed lookup still share it, so the protection against duplicate loads stays. Only the stored failure is removed.`
    },
    {
      id: "caching-c6",
      title: "A cache that can fail",
      task: `\`safeName\` declares that it cannot fail, but the cache lookup can fail. The program does not compile. Fix \`safeName\` so that it keeps its declared type and returns \`"unknown"\` for failed lookups. The program must print \`Ada\` and then \`unknown\`.`,
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
        "Read the error: Effect<string, string> is not assignable to Effect<string, never>. The cache carries the error type of the lookup.",
        "Cache.get(cache, id) has the same error type as lookup. safeName must process the error before it returns.",
        "Pipe through Effect.catch(() => Effect.succeed(\"unknown\"))."
      ],
      explanation: `A \`Cache<Key, A, E>\` keeps the error type of the lookup, and \`Cache.get\` returns \`Effect<A, E>\`. The annotation \`Effect<string>\` (error \`never\`) on \`safeName\` is a promise that the body cannot keep, so the compiler stops you. \`Effect.catch\` turns the failure into a success value and makes the error channel \`never\`. The type now matches the annotation. A \`Map\`-based cache hides the failure until it throws at run time.`
    }
  ],
  problems: [
    {
      id: "caching-p1",
      title: "Feature flags with manual refresh",
      spec: `
A service reads feature flags from a slow source. The cache must keep the flags for 1 hour, but an admin endpoint can force a reload. Build it with \`Effect.cachedInvalidateWithTTL\`.

Requirements:

1. \`loadFlags\` increments \`loads\` (a \`Ref<number>\`) and returns \`"flags v<n>"\`, where \`n\` is the number of loads so far. Use \`Ref.updateAndGet\`.
2. \`program\` creates the cached pair with a TTL of \`"1 hour"\`. Then it reads 2 times, runs the invalidate effect, prints \`invalidated\`, reads 1 more time, and prints the load count.
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
        "Ref.updateAndGet returns the new value, so loadFlags is 1 pipe: update, then map to the string.",
        "cachedInvalidateWithTTL returns [cachedEffect, invalidateEffect]. Destructure the pair after yield*.",
        "A small read effect that taps console.log keeps the 3 reads identical."
      ]
    },
    {
      id: "caching-p2",
      title: "Product price cache",
      spec: `
Build a keyed price cache in front of a price table. Prove that duplicate concurrent reads share 1 lookup. Then apply a price change with invalidation.

Requirements:

1. \`priceTable\` is a mutable \`Map<string, number>\` with \`A: 10\`, \`B: 20\`, \`C: 30\`.
2. Create a \`Cache\` with capacity 100. Its lookup increments \`lookups\` and reads the table (all keys exist).
3. Read \`["A", "B", "A", "C"]\` **concurrently**. Print the prices joined by \`, \`, then \`lookups: 3\` and \`size: 3\`.
4. Change \`A\` to \`11\` in the table, invalidate \`A\`, and print \`price update for A\`.
5. Read \`["A", "B"]\` again and print the prices and the lookups.

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
        "The lookup can be Ref.update(...).pipe(Effect.map(() => priceTable.get(sku) ?? 0)). The map runs after the counter update.",
        "Effect.forEach with concurrency: \"unbounded\" starts all 4 gets at once. The 2 reads of A share 1 lookup, so lookups is 3, not 4.",
        "After Cache.invalidate(cache, \"A\"), the next get of A is a miss (lookup 4), and B is still a hit."
      ]
    }
  ],
  recall: [
    {
      q: "Why does `Effect.cached(effect)` return `Effect<Effect<A>>` and not `Effect<A>`?",
      a: "The outer effect allocates the memo storage. When you run it once, you get the inner, memoized effect. If you run the outer effect in a loop or inside a function, you get a new empty cache each time. This is the most common mistake with `Effect.cached`."
    },
    {
      q: "What is the type of `yield* Effect.cachedInvalidateWithTTL(load, \"1 hour\")` if `load: Effect<Config, LoadError>`?",
      a: "`[Effect<Config, LoadError>, Effect<void>]`: the cached effect, which keeps the error type of `load`, and an invalidate effect that cannot fail."
    },
    {
      q: "3 fibers call `Cache.get` for the same missing key at the same time. How many lookups run?",
      a: "1. The first `get` stores the lookup fiber in the entry before the lookup finishes. The other 2 find the entry and wait for that fiber. A plain `Map` cache cannot do this without extra 'pending' state."
    },
    {
      q: "The data changed, and the cache must hold the new value immediately, not on the next read. Which function do you use?",
      a: "`Cache.refresh(cache, key)`. It runs the lookup immediately and replaces the entry. `Cache.invalidate` only removes the entry, so the next reader pays for the lookup."
    },
    {
      q: "Does `Cache` store failed lookups?",
      a: "Yes. The cache stores the `Exit`, success or failure, until it expires or you invalidate it. To expire failures faster, use `Cache.makeWith` with a `timeToLive` function. The function inspects the `Exit` and returns `Duration.zero` for failures."
    },
    {
      q: "How do you prove that a cache works without timestamps?",
      a: "Count the lookups in a `Ref` inside the lookup function, or put the call number in the returned value (`\"user-3#4\"`). Reads minus lookups gives the hits. Checks that depend on the clock are unreliable. Counts are deterministic."
    }
  ]
}

export default section
