import type { Section } from "../types.ts"

const section: Section = {
  id: "batching",
  title: "Batching",
  order: 10,
  summary: "Describe what you need as Request values and let a RequestResolver turn many small lookups into one batched call.",
  intro: `
**The problem.** You render a list of ten posts, and each post needs its author. The natural code fetches them one at a time:

\`\`\`ts
for (const post of posts) {
  post.author = await db.getUser(post.authorId)   // 10 posts -> 10 queries
}
\`\`\`

This is the "N+1 problem": one query for the list, then N more for the details. The database could have answered with a single \`WHERE id IN (...)\` query. The usual fix is a hand-written DataLoader: collect ids in a queue, wait a tick, run one query, map the rows back to the right callers, and handle the ids that came back empty. You write one of these per entity, and each one is a small piece of concurrency code that is easy to get subtly wrong.

### The shift

Today you think of a lookup as **a function that fetches**. The function decides *how* to fetch, so batching means rewriting every function to queue and flush. Effect asks you to split the two halves. A \`Request\` is a plain value that says **what** you need: "user with id 3". A \`RequestResolver\` says **how** a whole batch of those requests gets answered. Your business code only ever says "I need this"; it never thinks about batching at all.

The runtime does the grouping. When several fibers ask for requests at the same time, the resolver receives all of them in one call. When they ask one after another, it receives one at a time. The same code runs in both cases. Deduplication, batch size limits, and per-entry failures become options on the resolver, not logic spread through your loaders.

| | Plain loop | Manual DataLoader | Request + RequestResolver |
|---|---|---|---|
| Queries for 10 ids | 10 | 1 | 1 |
| Where batching lives | Nowhere | Inside each loader class | In one resolver, reusable |
| Per-id failures | \`throw\` breaks the loop | Custom \`Error \\| Value\` arrays | Typed per-entry \`Exit\` |
| Dedup of repeated ids | Manual | Manual | \`RequestResolver.withCache\` |
| Max batch size | Manual chunking | Manual chunking | \`RequestResolver.batchN\` |

In this section you will define requests, write a resolver, prove with a counter that batching happens, deduplicate repeats, fail individual entries, and learn when batching is the wrong tool.
`,
  lessons: [
    {
      id: "batching-l1",
      title: "A Request says what, a RequestResolver says how",
      explain: `
Two pieces. First, a **request type**: an interface that extends \`Request.Request<Success, Error>\` and lists the fields the lookup needs. \`Request.tagged\` gives you a constructor that fills in the \`_tag\` for you.

Second, a **resolver**: \`RequestResolver.make\` takes a function that receives a batch of *entries* and must complete every one of them. An entry holds the original \`request\` and a \`completeUnsafe\` method that takes an \`Exit\`. The resolver runs one query for the whole batch and hands each entry its answer.

To use them together you call \`Effect.request(request, resolver)\`, which gives back a normal \`Effect<Success, Error>\`. Below, the "database" is a Map and every query prints the ids it was asked for, so you can see exactly how many round trips happen.
`,
      code: `import { Effect, Exit, Request, RequestResolver } from "effect"

// What we need: a user by id. Success is a string, it cannot fail (yet).
interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const usersTable = new Map([[1, "Ada"], [2, "Lin"], [3, "Sam"]])

// How a batch gets answered: one "query" for all ids in the batch
const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    const ids = entries.map((e) => e.request.id)
    console.log("query for ids:", ids.join(", "))
    for (const entry of entries) {
      // Every entry must be completed, or the waiting request fails
      entry.completeUnsafe(Exit.succeed(usersTable.get(entry.request.id) ?? "?"))
    }
  })
)

// Business code only says "I need user 2"
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const name = yield* getUser(2)
  console.log("got", name)
})

Effect.runPromise(program)
`,
      expectedOutput: `query for ids: 2
got Lin`,
      after: `Notice that \`getUser\` knows nothing about batching. It builds a value and hands it to the resolver. \`Effect.request\` is always asynchronous (the batch runs on its own fiber), so use \`runPromise\`, never \`runSync\`, for programs that contain requests.`
    },
    {
      id: "batching-l2",
      title: "Batching happens when requests run concurrently",
      explain: `
Here is the rule that makes everything work: **requests that are started at the same time end up in the same batch.** The resolver waits a tiny moment (by default, one scheduler tick) to collect them, then runs once.

In plain TypeScript you would need a DataLoader to get the same result:

\`\`\`ts
class UserLoader {
  private queue: Array<{ id: number; resolve: (u: string) => void }> = []
  load(id: number) {
    return new Promise<string>((resolve) => {
      this.queue.push({ id, resolve })
      if (this.queue.length === 1) queueMicrotask(() => this.flush())
    })
  }
  private async flush() {
    const batch = this.queue.splice(0)
    const rows = await db.getUsers(batch.map((b) => b.id))
    for (const b of batch) b.resolve(rows.get(b.id)!)
  }
}
\`\`\`

With Effect there is no loader class. The program below runs the *same* \`getUser\` twice: first with a sequential \`Effect.forEach\`, then with \`concurrency: "unbounded"\`. A \`Ref\` counts how many times the resolver was called, which is the proof.
`,
      code: `import { Effect, Exit, Ref, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)

  const UserResolver = RequestResolver.make<GetUser>((entries) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (n) => n + 1)   // count one query per batch
      for (const entry of entries) {
        entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
      }
    })
  )
  const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)
  const ids = [1, 2, 3, 4, 5]

  // Sequential: each request is alone in its batch
  yield* Effect.forEach(ids, getUser)
  console.log("sequential: resolver called", yield* Ref.get(calls), "times for", ids.length, "requests")

  // Concurrent: all five are collected into one batch
  yield* Ref.set(calls, 0)
  const names = yield* Effect.forEach(ids, getUser, { concurrency: "unbounded" })
  console.log("concurrent: resolver called", yield* Ref.get(calls), "time for", ids.length, "requests")
  console.log(names.join(", "))
})

Effect.runPromise(program)
`,
      expectedOutput: `sequential: resolver called 5 times for 5 requests
concurrent: resolver called 1 time for 5 requests
user-1, user-2, user-3, user-4, user-5`,
      after: `The results still come back in input order. Try \`concurrency: 2\`: you get batches of two, so the resolver is called 3 times. Batching follows concurrency, not the other way round.`
    },
    {
      id: "batching-l3",
      title: "Deduplicating repeated requests",
      explain: `
Ten posts by the same three authors produce ten \`GetUser\` requests but only three distinct ids. Two levels of deduplication are available:

| Level | Where | What it removes |
|---|---|---|
| Inside the resolver | Your code, with a \`Set\` of ids | Duplicate ids in the *query*, but every entry still gets completed |
| \`RequestResolver.withCache\` | Wraps the resolver | Duplicate *entries*: the second identical request waits for the first one's answer and is not even handed to the resolver, now or later |

\`withCache\` keys on the request value itself. Requests compare structurally, so \`GetUser({ id: 1 })\` equals another \`GetUser({ id: 1 })\`. One important detail: \`withCache\` returns an \`Effect<RequestResolver>\`, because it allocates the cache. You must \`yield*\` it **once** and share the result. If you pass the un-yielded effect to \`Effect.request\`, every request builds its own fresh cache and you get no dedup and no batching.
`,
      code: `import { Effect, Exit, Ref, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)

  const base = RequestResolver.make<GetUser>((entries) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (n) => n + 1)
      const unique = [...new Set(entries.map((e) => e.request.id))]
      console.log("resolver got", entries.length, "entries, queried ids", unique.join(","))
      for (const entry of entries) {
        entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
      }
    })
  )
  // Allocate the cache once. The resolver behind it is shared by every request.
  const UserResolver = yield* RequestResolver.withCache(base, { capacity: 100 })
  const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

  const names = yield* Effect.forEach([1, 2, 1, 3, 2], getUser, { concurrency: "unbounded" })
  console.log(names.join(", "))

  // A later request for a known id never reaches the resolver
  console.log("again:", yield* getUser(1), "| resolver calls so far:", yield* Ref.get(calls))
})

Effect.runPromise(program)
`,
      expectedOutput: `resolver got 3 entries, queried ids 1,2,3
user-1, user-2, user-1, user-3, user-2
again: user-1 | resolver calls so far: 1`,
      after: `Five requests, three entries, one query, and the follow-up call was served from the cache. Remove the \`yield*\` in front of \`withCache\` and watch the first line become five separate resolver calls.`
    },
    {
      id: "batching-l4",
      title: "Failing one entry without failing the batch",
      explain: `
A batch of ids will sometimes contain one that does not exist. The resolver should not throw away the whole batch. Because each entry is completed individually, it can succeed some and fail others.

To make the failure typed, give the request an error type: \`Request.Request<User, UserNotFound>\`. Then \`completeUnsafe(Exit.fail(new UserNotFound(...)))\` type-checks, and \`Effect.request\` returns \`Effect<User, UserNotFound>\`, so callers see the error in the type and can handle it with the usual tools.

Two other rules about completion. If the resolver's effect *itself* fails, every entry in the batch receives that failure. And if the resolver finishes without completing an entry, that request dies with a defect: "RequestResolver did not complete request". Always complete every entry.
`,
      code: `import { Effect, Exit, Request, RequestResolver, Result, Schema } from "effect"

class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  id: Schema.Number
}) {}

interface GetUser extends Request.Request<string, UserNotFound> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const usersTable = new Map([[1, "Ada"], [2, "Lin"]])

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    console.log("one query for", entries.length, "ids")
    for (const entry of entries) {
      const name = usersTable.get(entry.request.id)
      // Each entry gets its own Exit: success for known ids, typed failure otherwise
      entry.completeUnsafe(
        name === undefined ? Exit.fail(new UserNotFound({ id: entry.request.id })) : Exit.succeed(name)
      )
    }
  })
)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  // Effect.result turns each outcome into a value so one failure does not stop the others
  const results = yield* Effect.forEach([1, 9, 2], (id) => Effect.result(getUser(id)), { concurrency: "unbounded" })
  for (const r of results) {
    console.log(Result.isSuccess(r) ? "ok " + r.success : "missing user " + r.failure.id)
  }

  // Or handle it like any typed error
  const name = yield* getUser(9).pipe(Effect.catchTag("UserNotFound", (e) => Effect.succeed("guest-" + e.id)))
  console.log(name)
})

Effect.runPromise(program)
`,
      expectedOutput: `one query for 3 ids
ok Ada
missing user 9
ok Lin
one query for 1 ids
guest-9`,
      after: `Without \`Effect.result\`, \`forEach\` would stop at the first failure and you would only see the error. Try it: replace \`Effect.result(getUser(id))\` with \`getUser(id)\` and the program rejects with \`UserNotFound\`.`
    },
    {
      id: "batching-l5",
      title: "Limiting batch size, and when not to batch",
      explain: `
Real backends cap how many ids fit in one query. \`RequestResolver.batchN(resolver, n)\` collects at most \`n\` entries per batch and starts a new one for the rest. Everything else stays the same.

Batching is not free, and it is not always right:

| Situation | Batch? | Why |
|---|---|---|
| Many concurrent reads of the same kind (users by id) | Yes | Classic N+1, one query replaces N |
| One lookup at a time, sequential by nature | No | There is nothing to group; you pay a scheduler tick for no gain |
| Writes that must happen in a specific order | No | Batches run together; ordering across entries is not guaranteed |
| The backend has no bulk endpoint | No | The resolver would loop and call it N times anyway |
| Latency of the first request matters more than throughput | Careful | \`RequestResolver.setDelay\` widens the window; the default is one tick |

If your resolver would only ever receive one entry, use a plain function that returns an Effect and skip the machinery.
`,
      code: `import { Effect, Exit, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const base = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    console.log("batch of", entries.length, "->", entries.map((e) => e.request.id).join(","))
    for (const entry of entries) {
      entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
    }
  })
)

// The backend accepts at most 2 ids per query
const UserResolver = RequestResolver.batchN(base, 2)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const names = yield* Effect.forEach([1, 2, 3, 4, 5], getUser, { concurrency: "unbounded" })
  console.log(names.length, "users loaded")
})

Effect.runPromise(program)
`,
      expectedOutput: `batch of 2 -> 1,2
batch of 2 -> 3,4
batch of 1 -> 5
5 users loaded`,
      after: `\`batchN\` is a wrapper, so you can combine it: \`batchN\` first, then \`withCache\`, and both rules apply. Try changing the limit to 10: all five ids land in a single batch again.`
    }
  ],
  challenges: [
    {
      id: "batching-c1",
      title: "Five queries instead of one",
      task: `The resolver is correct, but the program runs five queries. Change the loop so all five requests land in one batch and the program prints \`resolver calls: 1\`.`,
      code: `import { Effect, Exit, Ref, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  const UserResolver = RequestResolver.make<GetUser>((entries) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (n) => n + 1)
      for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
    })
  )
  const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

  const names = yield* Effect.forEach([1, 2, 3, 4, 5], getUser)
  console.log(names.join(","))
  console.log("resolver calls:", yield* Ref.get(calls))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Ref, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  const UserResolver = RequestResolver.make<GetUser>((entries) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (n) => n + 1)
      for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
    })
  )
  const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

  const names = yield* Effect.forEach([1, 2, 3, 4, 5], getUser, { concurrency: "unbounded" })
  console.log(names.join(","))
  console.log("resolver calls:", yield* Ref.get(calls))
})

Effect.runPromise(program)
`,
      expectedOutput: `user-1,user-2,user-3,user-4,user-5
resolver calls: 1`,
      hints: [
        "When does the runtime put two requests in the same batch? Lesson 2 has the rule in bold.",
        "Effect.forEach runs sequentially by default, so each request is alone in its batch.",
        "Pass { concurrency: \"unbounded\" } as the third argument to Effect.forEach."
      ],
      explanation: `Batching follows concurrency. A sequential \`forEach\` starts request 1, waits for its answer, then starts request 2, so the resolver never sees more than one entry at a time. With \`concurrency: "unbounded"\` all five requests are started before any of them completes, the resolver's collection window catches all of them, and one query is run. The resolver code did not change at all.`
    },
    {
      id: "batching-c2",
      title: "The cache that never caches",
      task: `\`withCache\` was added to deduplicate, but the resolver still receives all five entries and is called five times. Fix the setup so it prints \`resolver got 3 entries\` and \`calls: 1\`. Do not change the list of ids.`,
      code: `import { Effect, Exit, Ref, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  const base = RequestResolver.make<GetUser>((entries) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (n) => n + 1)
      console.log("resolver got", entries.length, "entries")
      for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
    })
  )
  const UserResolver = RequestResolver.withCache(base, { capacity: 100 })
  const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

  yield* Effect.forEach([1, 2, 1, 3, 2], getUser, { concurrency: "unbounded" })
  console.log("calls:", yield* Ref.get(calls))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Ref, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const program = Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  const base = RequestResolver.make<GetUser>((entries) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (n) => n + 1)
      console.log("resolver got", entries.length, "entries")
      for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
    })
  )
  const UserResolver = yield* RequestResolver.withCache(base, { capacity: 100 })
  const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

  yield* Effect.forEach([1, 2, 1, 3, 2], getUser, { concurrency: "unbounded" })
  console.log("calls:", yield* Ref.get(calls))
})

Effect.runPromise(program)
`,
      expectedOutput: `resolver got 3 entries
calls: 1`,
      hints: [
        "Hover over UserResolver. Is it a RequestResolver, or an Effect that produces one?",
        "Effect.request accepts an Effect<RequestResolver> for convenience, but then it runs that effect for every single request, building a brand-new cache and resolver each time.",
        "Add yield* in front of RequestResolver.withCache so the cache is created once and shared."
      ],
      explanation: `\`RequestResolver.withCache\` returns an \`Effect<RequestResolver>\` because it allocates mutable cache storage. Passing that effect straight to \`Effect.request\` compiles, but each request runs it again and gets its own private resolver with its own empty cache. Five private resolvers means five batches and five calls. Running the effect once with \`yield*\` produces one resolver object that every request shares, so duplicates are linked to the first pending entry and only three reach the query.`
    },
    {
      id: "batching-c3",
      title: "A request that cannot fail",
      task: `The resolver wants to fail entries for unknown ids, but the program does not compile. Fix the request **type** so a typed failure is allowed, without changing the resolver body. The program should print the two lines below.`,
      code: `import { Effect, Exit, Request, RequestResolver, Result } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const usersTable = new Map([[1, "Ada"]])

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    for (const entry of entries) {
      const name = usersTable.get(entry.request.id)
      entry.completeUnsafe(name === undefined ? Exit.fail("no user " + entry.request.id) : Exit.succeed(name))
    }
  })
)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const results = yield* Effect.forEach([1, 7], (id) => Effect.result(getUser(id)), { concurrency: "unbounded" })
  for (const r of results) console.log(Result.isSuccess(r) ? "ok " + r.success : "error: " + r.failure)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Request, RequestResolver, Result } from "effect"

interface GetUser extends Request.Request<string, string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const usersTable = new Map([[1, "Ada"]])

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    for (const entry of entries) {
      const name = usersTable.get(entry.request.id)
      entry.completeUnsafe(name === undefined ? Exit.fail("no user " + entry.request.id) : Exit.succeed(name))
    }
  })
)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const results = yield* Effect.forEach([1, 7], (id) => Effect.result(getUser(id)), { concurrency: "unbounded" })
  for (const r of results) console.log(Result.isSuccess(r) ? "ok " + r.success : "error: " + r.failure)
})

Effect.runPromise(program)
`,
      expectedOutput: `ok Ada
error: no user 7`,
      hints: [
        "Read the type error on completeUnsafe: it expects Exit<string, never>. What does never in the error slot promise?",
        "Request.Request<A, E> has a second type parameter for the error, just like Effect<A, E>.",
        "Change the interface to extend Request.Request<string, string>."
      ],
      explanation: `\`Request.Request<string>\` is short for \`Request.Request<string, never>\`: this request cannot fail. \`completeUnsafe\` therefore only accepts \`Exit<string, never>\`, and \`Exit.fail("...")\` is rejected at compile time. Declaring the error as \`string\` widens the contract, and the widening flows through: \`Effect.request\` now returns \`Effect<string, string>\`, so every caller sees in the type that a lookup can fail. In a plain DataLoader the same mistake would be a runtime surprise.`
    },
    {
      id: "batching-c4",
      title: "The entry nobody answered",
      task: `Requests for unknown ids crash the whole program with a defect instead of failing cleanly. Fix the resolver so every entry is completed and the program prints \`ok Ada\` then \`missing 5\`.`,
      code: `import { Effect, Exit, Request, RequestResolver, Result } from "effect"

interface GetUser extends Request.Request<string, string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const usersTable = new Map([[1, "Ada"]])

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    for (const entry of entries) {
      const name = usersTable.get(entry.request.id)
      if (name !== undefined) {
        entry.completeUnsafe(Exit.succeed(name))
      }
    }
  })
)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const results = yield* Effect.forEach([1, 5], (id) => Effect.result(getUser(id)), { concurrency: "unbounded" })
  for (const r of results) console.log(Result.isSuccess(r) ? "ok " + r.success : "missing " + r.failure)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Request, RequestResolver, Result } from "effect"

interface GetUser extends Request.Request<string, string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const usersTable = new Map([[1, "Ada"]])

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    for (const entry of entries) {
      const name = usersTable.get(entry.request.id)
      if (name !== undefined) {
        entry.completeUnsafe(Exit.succeed(name))
      } else {
        entry.completeUnsafe(Exit.fail(String(entry.request.id)))
      }
    }
  })
)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const results = yield* Effect.forEach([1, 5], (id) => Effect.result(getUser(id)), { concurrency: "unbounded" })
  for (const r of results) console.log(Result.isSuccess(r) ? "ok " + r.success : "missing " + r.failure)
})

Effect.runPromise(program)
`,
      expectedOutput: `ok Ada
missing 5`,
      hints: [
        "Read the crash message: \"RequestResolver did not complete request\". Which entry was skipped?",
        "A resolver must call completeUnsafe on every entry it receives, including the ones it cannot find.",
        "Add an else branch that completes the entry with Exit.fail(String(entry.request.id))."
      ],
      explanation: `The runtime hands the resolver a batch and, when the resolver's effect finishes, checks that each entry was completed. An entry that was never completed would otherwise wait forever, so the runtime fails it with a defect instead. Defects are for bugs, and "you forgot an entry" is a bug. Completing the missing id with \`Exit.fail\` turns it into the expected, typed error that \`Effect.result\` can report, while the other entry in the same batch still succeeds.`
    },
    {
      id: "batching-c5",
      title: "Too many ids per query",
      task: `The backend rejects queries with more than 2 ids, but the program sends all five in one batch. Without touching the resolver body, make the program print batches of \`2, 2, 1\` as shown in the expected output.`,
      code: `import { Effect, Exit, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const base = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    console.log("batch of", entries.length)
    for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
  })
)
const UserResolver = base
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const names = yield* Effect.forEach([1, 2, 3, 4, 5], getUser, { concurrency: "unbounded" })
  console.log("loaded", names.length)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const base = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    console.log("batch of", entries.length)
    for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
  })
)
const UserResolver = RequestResolver.batchN(base, 2)
const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const names = yield* Effect.forEach([1, 2, 3, 4, 5], getUser, { concurrency: "unbounded" })
  console.log("loaded", names.length)
})

Effect.runPromise(program)
`,
      expectedOutput: `batch of 2
batch of 2
batch of 1
loaded 5`,
      hints: [
        "Batch size is a property of the resolver, not of the loop. Lesson 5 shows the wrapper.",
        "RequestResolver.batchN(resolver, n) caps every batch at n entries.",
        "Replace the UserResolver line with RequestResolver.batchN(base, 2)."
      ],
      explanation: `\`batchN\` changes the resolver's "keep collecting?" rule: as soon as a batch holds 2 entries it is run and a fresh batch starts for the next ones. The loop, the request type, and the resolver body stay exactly as they were. This is the advantage of putting batching in the resolver: policies like maximum size are one wrapper, applied once, instead of chunking logic repeated at every call site.`
    },
    {
      id: "batching-c6",
      title: "A resolver per call",
      task: `Everything looks batched, yet the resolver is called three times for three concurrent requests. Find the structural mistake and fix it so the output is \`resolver calls: 1\`.`,
      code: `import { Effect, Exit, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

let calls = 0

const getUser = (id: number) => {
  const UserResolver = RequestResolver.make<GetUser>((entries) =>
    Effect.sync(() => {
      calls++
      for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
    })
  )
  return Effect.request(GetUser({ id }), UserResolver)
}

const program = Effect.gen(function* () {
  const names = yield* Effect.forEach([1, 2, 3], getUser, { concurrency: "unbounded" })
  console.log(names.join(","))
  console.log("resolver calls:", calls)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Request, RequestResolver } from "effect"

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

let calls = 0

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    calls++
    for (const entry of entries) entry.completeUnsafe(Exit.succeed("user-" + entry.request.id))
  })
)

const getUser = (id: number) => Effect.request(GetUser({ id }), UserResolver)

const program = Effect.gen(function* () {
  const names = yield* Effect.forEach([1, 2, 3], getUser, { concurrency: "unbounded" })
  console.log(names.join(","))
  console.log("resolver calls:", calls)
})

Effect.runPromise(program)
`,
      expectedOutput: `user-1,user-2,user-3
resolver calls: 1`,
      hints: [
        "The runtime groups requests by resolver. How many resolver objects does this program create?",
        "RequestResolver.make is called inside getUser, so every request gets a brand-new resolver and its own batch.",
        "Move the RequestResolver.make call out of getUser to module level, and reference the shared UserResolver."
      ],
      explanation: `Pending batches are keyed by the resolver *object*. Three calls to \`getUser\` built three different resolvers, so the runtime saw three unrelated batches of one entry each. Hoisting the resolver makes every request point at the same object, which is what "same batch" means. Rule: create resolvers once, at module level or inside a service, and only build request values per call.`
    }
  ],
  problems: [
    {
      id: "batching-p1",
      title: "Posts with authors",
      spec: `
You have four posts and a users table. Load the author of every post with a batched request, then print one line per post and a final line with the number of queries.

Requirements:

1. Define \`GetUser\` as a request for a \`string\` name by numeric \`id\`, using \`Request.tagged\`.
2. Write \`UserResolver\` with \`RequestResolver.make\`. It increments the \`queries\` counter once per batch and completes each entry from \`usersTable\` (all ids exist).
3. \`withAuthor(post)\` returns the post title joined with the author name as \`"<title> by <name>"\`.
4. In \`program\`, load all posts concurrently, print each line, then print \`queries: 1\`.

Exact output:

\`\`\`
Hello by Ada
Effect by Lin
Batching by Ada
Types by Sam
queries: 1
\`\`\`
`,
      starter: `import { Effect, Exit, Request, RequestResolver } from "effect"

const usersTable = new Map([[1, "Ada"], [2, "Lin"], [3, "Sam"]])
const posts = [
  { title: "Hello", authorId: 1 },
  { title: "Effect", authorId: 2 },
  { title: "Batching", authorId: 1 },
  { title: "Types", authorId: 3 }
]

let queries = 0

// TODO: interface GetUser extends Request.Request<string> with _tag and id
// TODO: const GetUser = Request.tagged<GetUser>("GetUser")
// TODO: UserResolver with RequestResolver.make, count one query per batch

// TODO: withAuthor(post) -> Effect<string>

const program = Effect.gen(function* () {
  // TODO: load all posts concurrently, print each line, then "queries: N"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Request, RequestResolver } from "effect"

const usersTable = new Map([[1, "Ada"], [2, "Lin"], [3, "Sam"]])
const posts = [
  { title: "Hello", authorId: 1 },
  { title: "Effect", authorId: 2 },
  { title: "Batching", authorId: 1 },
  { title: "Types", authorId: 3 }
]

let queries = 0

interface GetUser extends Request.Request<string> {
  readonly _tag: "GetUser"
  readonly id: number
}
const GetUser = Request.tagged<GetUser>("GetUser")

const UserResolver = RequestResolver.make<GetUser>((entries) =>
  Effect.sync(() => {
    queries++
    for (const entry of entries) {
      entry.completeUnsafe(Exit.succeed(usersTable.get(entry.request.id) ?? "?"))
    }
  })
)

const withAuthor = (post: { title: string; authorId: number }) =>
  Effect.request(GetUser({ id: post.authorId }), UserResolver).pipe(
    Effect.map((name) => post.title + " by " + name)
  )

const program = Effect.gen(function* () {
  const lines = yield* Effect.forEach(posts, withAuthor, { concurrency: "unbounded" })
  for (const line of lines) console.log(line)
  console.log("queries:", queries)
})

Effect.runPromise(program)
`,
      expectedOutput: `Hello by Ada
Effect by Lin
Batching by Ada
Types by Sam
queries: 1`,
      hints: [
        "Follow lesson 1 for the request and resolver shape. The resolver body is a for loop over entries calling completeUnsafe.",
        "withAuthor can be Effect.request(...).pipe(Effect.map((name) => post.title + \" by \" + name)).",
        "Effect.forEach(posts, withAuthor, { concurrency: \"unbounded\" }) keeps output order and lets the runtime batch all four requests."
      ]
    },
    {
      id: "batching-p2",
      title: "Stock check with unknown SKUs",
      spec: `
A warehouse API returns stock levels for a list of SKUs, but silently omits SKUs it does not know. Build a batched, deduplicated stock check that reports unknown SKUs as typed failures.

Requirements:

1. \`class UnknownSku extends Schema.TaggedError<UnknownSku>()("UnknownSku", { sku: Schema.String })\`.
2. \`GetStock\` is a request for a \`number\` that can fail with \`UnknownSku\`, with a \`sku: string\` field.
3. The resolver counts calls in \`apiCalls\`, prints \`api call for: <unique skus joined by ", ">\` (deduplicated inside the resolver, in first-seen order), and completes each entry from \`stockTable\` or fails it with \`UnknownSku\`.
4. Wrap the resolver with \`RequestResolver.withCache\` (capacity 50) so repeated SKUs are not even passed to the resolver.
5. \`program\` checks the list \`["A1", "B2", "A1", "Z9", "B2"]\` concurrently with \`Effect.result\`, prints one line per item, then \`api calls: 1\`.

Exact output:

\`\`\`
api call for: A1, B2, Z9
A1: 5 in stock
B2: 0 in stock
A1: 5 in stock
Z9: unknown sku
B2: 0 in stock
api calls: 1
\`\`\`
`,
      starter: `import { Effect, Exit, Request, RequestResolver, Result, Schema } from "effect"

const stockTable = new Map([["A1", 5], ["B2", 0], ["C3", 12]])
let apiCalls = 0

// TODO: UnknownSku error class

// TODO: GetStock request (number, can fail with UnknownSku) with a sku field

// TODO: base resolver: count, print "api call for: ...", complete or fail every entry

const program = Effect.gen(function* () {
  // TODO: const StockResolver = yield* RequestResolver.withCache(base, { capacity: 50 })
  // TODO: check ["A1", "B2", "A1", "Z9", "B2"] concurrently with Effect.result
  // TODO: print each line, then "api calls: N"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Exit, Request, RequestResolver, Result, Schema } from "effect"

const stockTable = new Map([["A1", 5], ["B2", 0], ["C3", 12]])
let apiCalls = 0

class UnknownSku extends Schema.TaggedError<UnknownSku>()("UnknownSku", {
  sku: Schema.String
}) {}

interface GetStock extends Request.Request<number, UnknownSku> {
  readonly _tag: "GetStock"
  readonly sku: string
}
const GetStock = Request.tagged<GetStock>("GetStock")

const base = RequestResolver.make<GetStock>((entries) =>
  Effect.sync(() => {
    apiCalls++
    const unique = [...new Set(entries.map((e) => e.request.sku))]
    console.log("api call for: " + unique.join(", "))
    for (const entry of entries) {
      const qty = stockTable.get(entry.request.sku)
      entry.completeUnsafe(
        qty === undefined ? Exit.fail(new UnknownSku({ sku: entry.request.sku })) : Exit.succeed(qty)
      )
    }
  })
)

const program = Effect.gen(function* () {
  const StockResolver = yield* RequestResolver.withCache(base, { capacity: 50 })
  const getStock = (sku: string) => Effect.request(GetStock({ sku }), StockResolver)

  const skus = ["A1", "B2", "A1", "Z9", "B2"]
  const results = yield* Effect.forEach(skus, (sku) => Effect.result(getStock(sku)), { concurrency: "unbounded" })

  results.forEach((r, i) => {
    console.log(Result.isSuccess(r) ? skus[i] + ": " + r.success + " in stock" : r.failure.sku + ": unknown sku")
  })
  console.log("api calls:", apiCalls)
})

Effect.runPromise(program)
`,
      expectedOutput: `api call for: A1, B2, Z9
A1: 5 in stock
B2: 0 in stock
A1: 5 in stock
Z9: unknown sku
B2: 0 in stock
api calls: 1`,
      hints: [
        "Lesson 4 shows the error class, the request with an error type, and completing entries with Exit.fail.",
        "withCache returns an Effect. yield* it inside program, then define getStock after it so the shared resolver is captured.",
        "Effect.result per item keeps the failures from short-circuiting forEach; Result.isSuccess narrows so r.success and r.failure.sku are typed."
      ]
    }
  ],
  recall: [
    {
      q: "What decides whether two `Effect.request` calls end up in the same batch?",
      a: "Timing and identity. They must be started concurrently (before the resolver's collection window closes) **and** point at the same resolver object. A sequential loop, or a resolver created per call, gives one batch per request."
    },
    {
      q: "What would the type of `Effect.request(GetUser({ id: 1 }), resolver)` be if `GetUser extends Request.Request<User, NotFound>`?",
      a: "`Effect<User, NotFound, never>`. The request's success and error types become the effect's. If the request had requirements as a third parameter they would appear in `R`."
    },
    {
      q: "What happens if a resolver finishes without calling `completeUnsafe` on one of its entries?",
      a: "That request fails with a defect: `RequestResolver did not complete request`. Every entry must be completed, with `Exit.succeed` or `Exit.fail`, even the ones the backend did not return."
    },
    {
      q: "Which function would you reach for to stop identical requests from reaching the resolver twice?",
      a: "`RequestResolver.withCache(resolver, { capacity })`. It returns an `Effect<RequestResolver>`, so `yield*` it once and share the result. Deduplicating ids with a `Set` inside the resolver only shrinks the query; the entries still arrive."
    },
    {
      q: "The backend accepts at most 100 ids per call. Where does that rule go?",
      a: "On the resolver: `RequestResolver.batchN(resolver, 100)`. Call sites do not chunk; the resolver splits large batches automatically."
    },
    {
      q: "Name a case where you should not use Request and RequestResolver.",
      a: "When lookups are naturally sequential (nothing to group), when writes must happen in a strict order, or when the backend has no bulk endpoint so the resolver would loop anyway. Use a plain function returning an Effect instead."
    }
  ]
}

export default section
