import type { Section } from "../types.ts"

const section: Section = {
  id: "batching",
  title: "Batching",
  order: 10,
  summary: "Describe what you need as Request values and let a RequestResolver turn many small lookups into one batched call.",
  intro: `
**The problem.** You show a list of 10 posts. Each post needs its author. The usual code gets the authors one at a time:

\`\`\`ts
for (const post of posts) {
  post.author = await db.getUser(post.authorId)   // 10 posts -> 10 queries
}
\`\`\`

This is the "N+1 problem": 1 query for the list, then N more queries for the details. The database can answer all of them with a single \`WHERE id IN (...)\` query. The usual fix is a hand-written DataLoader. A DataLoader collects the ids in a queue, waits for 1 tick, runs 1 query, and maps the rows back to the callers. It must also process the ids that the database did not return.

You write 1 DataLoader per entity. Each one is a small piece of concurrency code, and it is easy to get it wrong.

### The shift

Today you think of a lookup as **a function that fetches**. The function decides *how* it fetches. To batch, you must rewrite every function so that it queues and flushes. Effect asks you to separate the 2 parts. A \`Request\` is a plain value that says **what** you need: "user with id 3". A \`RequestResolver\` says **how** the runtime answers a whole batch of those requests. Your business code only says "I need this". It does not know about batches.

The runtime groups the requests. When several fibers send requests at the same time, the resolver receives all of them in 1 call. When the fibers send requests one after another, the resolver receives 1 request at a time. The same code runs in both cases. Deduplication, batch size limits, and per-entry failures are options on the resolver. They are not logic that you spread through your loaders.

| | Plain loop | Manual DataLoader | Request + RequestResolver |
|---|---|---|---|
| Queries for 10 ids | 10 | 1 | 1 |
| Where the batch logic lives | Nowhere | Inside each loader class | In 1 resolver, reusable |
| Per-id failures | \`throw\` stops the loop | Custom \`Error \\| Value\` arrays | Typed per-entry \`Exit\` |
| Dedup of repeated ids | Manual | Manual | \`RequestResolver.withCache\` |
| Max batch size | Manual chunks | Manual chunks | \`RequestResolver.batchN\` |

In this section you will:

1. Define requests.
2. Write a resolver.
3. Prove with a counter that the runtime batches the requests.
4. Deduplicate repeated requests.
5. Fail individual entries.
6. Learn when a batch is the wrong choice.
`,
  lessons: [
    {
      id: "batching-l1",
      title: "A Request says what, a RequestResolver says how",
      explain: `
You need 2 parts. The first part is a **request type**. It is an interface that extends \`Request.Request<Success, Error>\` and lists the fields that the lookup needs. \`Request.tagged\` gives you a constructor that sets the \`_tag\` for you.

The second part is a **resolver**. \`RequestResolver.make\` takes a function that receives a batch of *entries*. The function must complete every entry. An entry holds the original \`request\` and a \`completeUnsafe\` method that takes an \`Exit\`. The resolver runs 1 query for the whole batch and gives each entry its answer.

To use them together, call \`Effect.request(request, resolver)\`. It returns a normal \`Effect<Success, Error>\`. In the program below, the "database" is a Map. Every query prints the ids that it received, so you can see the number of round trips.
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
      after: `\`getUser\` knows nothing about batches. It builds a value and gives the value to the resolver. Note: \`Effect.request\` is always asynchronous, because the batch runs on its own fiber. Use \`runPromise\` for programs that contain requests. \`runSync\` does not work for them.`
    },
    {
      id: "batching-l2",
      title: "Batching happens when requests run concurrently",
      explain: `
This is the rule that makes the system work. **Requests that start at the same time go in the same batch.** The resolver waits for a short time (by default, 1 scheduler tick) to collect them. Then it runs once.

In plain TypeScript you need a DataLoader to get the same result:

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

With Effect there is no loader class. The program below runs the *same* \`getUser\` function 2 times. The first run uses a sequential \`Effect.forEach\`. The second run uses \`concurrency: "unbounded"\`. A \`Ref\` counts the number of resolver calls. This count is the proof.
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
      after: `The results come back in input order. Try \`concurrency: 2\`. You get batches of 2, so the runtime calls the resolver 3 times. The concurrency level decides the batches. The batches do not decide the concurrency level.`
    },
    {
      id: "batching-l3",
      title: "Deduplicating repeated requests",
      explain: `
10 posts by the same 3 authors make 10 \`GetUser\` requests, but only 3 different ids. You can deduplicate at 2 levels:

| Level | Where | What it removes |
|---|---|---|
| Inside the resolver | Your code, with a \`Set\` of ids | Duplicate ids in the *query*. The resolver must still complete every entry |
| \`RequestResolver.withCache\` | A wrapper around the resolver | Duplicate *entries*. The second identical request waits for the answer of the first request. The resolver never receives the second request, now or later |

\`withCache\` uses the request value as the key. Requests compare by structure, so \`GetUser({ id: 1 })\` is equal to another \`GetUser({ id: 1 })\`. Note: \`withCache\` returns an \`Effect<RequestResolver>\`, because it allocates the cache. You must \`yield*\` it **once** and share the result. If you give the effect itself to \`Effect.request\`, every request builds its own new cache. Then you get no deduplication and no batch.
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
      after: `The program made 5 requests, the resolver got 3 entries, and it ran 1 query. The cache answered the last call. Remove the \`yield*\` in front of \`withCache\`. The first line then shows 5 separate resolver calls.`
    },
    {
      id: "batching-l4",
      title: "Failing one entry without failing the batch",
      explain: `
A batch of ids sometimes contains an id that does not exist. The resolver must not fail the whole batch. The resolver completes each entry on its own, so it can succeed some entries and fail other entries.

To make the failure typed, give the request an error type: \`Request.Request<User, UserNotFound>\`. Then \`completeUnsafe(Exit.fail(new UserNotFound(...)))\` type-checks. \`Effect.request\` returns \`Effect<User, UserNotFound>\`. The callers see the error in the type, and they can process it with the usual tools.

There are 2 more rules about completion. If the effect of the resolver *itself* fails, every entry in the batch receives that failure. If the resolver finishes and an entry is not complete, that request ends with a defect (an unexpected error): "RequestResolver did not complete request". Always complete every entry.
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
      after: `Without \`Effect.result\`, \`forEach\` stops at the first failure, and you only see the error. Try it: replace \`Effect.result(getUser(id))\` with \`getUser(id)\`. The program then fails with \`UserNotFound\`.`
    },
    {
      id: "batching-l5",
      title: "Limiting batch size, and when not to batch",
      explain: `
Real backends limit the number of ids in 1 query. \`RequestResolver.batchN(resolver, n)\` collects at most \`n\` entries per batch and starts a new batch for the rest. Everything else stays the same.

A batch has a cost, and it is not always the correct choice:

| Situation | Batch? | Why |
|---|---|---|
| Many concurrent reads of the same kind (users by id) | Yes | This is the N+1 problem. 1 query replaces N queries |
| 1 lookup at a time, sequential by nature | No | There is nothing to group. You pay a scheduler tick and get nothing |
| Writes that must happen in a specific order | No | The entries of a batch run together. Their order is not guaranteed |
| The backend has no bulk endpoint | No | The resolver loops and calls the backend N times |
| The latency of the first request is more important than throughput | Caution | \`RequestResolver.setDelay\` makes the collection window longer. The default is 1 tick |

If your resolver only ever receives 1 entry, use a plain function that returns an Effect. Do not use requests.
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
      after: `\`batchN\` is a wrapper, so you can combine it with other wrappers. Apply \`batchN\` first, then \`withCache\`, and both rules apply. Try a limit of 10. All 5 ids go in a single batch again.`
    }
  ],
  dosAndDonts: [
    {
      do: "Create a resolver once, at the module level or inside a service.",
      dont: "Do not call \`RequestResolver.make\` inside the function that builds the requests.",
      why: "Each call creates a new resolver, and the runtime puts requests with different resolvers in different batches."
    },
    {
      do: "Start the requests concurrently with \`Effect.forEach\` and \`{ concurrency: \"unbounded\" }\` or a number.",
      dont: "Do not run the requests in a sequential loop and expect 1 batch.",
      why: "The runtime only groups requests that start before the collection window closes, so a sequential loop gives 1 query per request."
    },
    {
      do: "Call \`completeUnsafe\` on every entry, with \`Exit.succeed\` or \`Exit.fail\`.",
      dont: "Do not skip the entries that the backend did not return.",
      why: "An entry that is not complete fails with the defect \"RequestResolver did not complete request\"."
    },
    {
      do: "\`yield*\` \`RequestResolver.withCache\` once and share the result.",
      dont: "Do not give the \`Effect<RequestResolver>\` itself to \`Effect.request\`.",
      why: "Each request then runs the effect again and gets its own empty cache, so the runtime deduplicates nothing and batches nothing."
    },
    {
      do: "Give the request an error type, such as \`Request.Request<User, UserNotFound>\`, when a lookup can fail.",
      dont: "Do not fail an entry of a request that declares \`never\` as its error type.",
      why: "The compiler rejects \`Exit.fail\` for that entry, and the callers do not see in the type that the lookup can fail."
    },
    {
      do: "Put the batch size limit on the resolver with \`RequestResolver.batchN\`.",
      dont: "Do not split the ids into chunks at every call site.",
      why: "Chunk logic at the call sites is repeated and easy to get wrong, and the resolver does it once."
    },
    {
      do: "Use \`Effect.runPromise\` for programs that contain requests.",
      dont: "Do not use \`Effect.runSync\` for programs that contain requests.",
      why: "\`Effect.request\` is always asynchronous, because the batch runs on its own fiber, so \`runSync\` fails."
    }
  ],
  challenges: [
    {
      id: "batching-c1",
      title: "Five queries instead of one",
      task: `The resolver is correct, but the program runs 5 queries. Change the loop so that all 5 requests go in 1 batch. The program must print \`resolver calls: 1\`.`,
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
        "When does the runtime put 2 requests in the same batch? Lesson 2 shows the rule in bold.",
        "Effect.forEach runs sequentially by default, so each request is alone in its batch.",
        "Pass { concurrency: \"unbounded\" } as the third argument to Effect.forEach."
      ],
      explanation: `The concurrency level decides the batches. A sequential \`forEach\` starts request 1, waits for its answer, and then starts request 2. The resolver never sees more than 1 entry at a time. With \`concurrency: "unbounded"\`, all 5 requests start before any of them completes. The collection window of the resolver catches all of them, and the runtime runs 1 query. The resolver code did not change.`
    },
    {
      id: "batching-c2",
      title: "The cache that never caches",
      task: `The program uses \`withCache\` to deduplicate the requests, but the resolver still receives all 5 entries. The runtime calls the resolver 5 times. Fix the setup so that the program prints \`resolver got 3 entries\` and \`calls: 1\`. Do not change the list of ids.`,
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
        "Look at the type of UserResolver. Is it a RequestResolver, or an Effect that produces one?",
        "Effect.request accepts an Effect<RequestResolver>. But then it runs that effect for every request, and each run builds a new cache and a new resolver.",
        "Add yield* in front of RequestResolver.withCache. Then the program creates the cache once and shares it."
      ],
      explanation: `\`RequestResolver.withCache\` returns an \`Effect<RequestResolver>\`, because it allocates mutable cache storage. If you give that effect directly to \`Effect.request\`, the program compiles. But each request runs the effect again and gets its own private resolver with its own empty cache. 5 private resolvers make 5 batches and 5 calls. When you run the effect once with \`yield*\`, you get 1 resolver object that every request shares. The cache links the duplicates to the first pending entry, and only 3 entries reach the query.`
    },
    {
      id: "batching-c3",
      title: "A request that cannot fail",
      task: `The resolver tries to fail the entries for unknown ids, but the program does not compile. Fix the request **type** so that a typed failure is permitted. Do not change the resolver body. The program must print the 2 lines below.`,
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
        "Read the type error on completeUnsafe. It expects Exit<string, never>. What does never in the error slot promise?",
        "Request.Request<A, E> has a second type parameter for the error, the same as Effect<A, E>.",
        "Change the interface so that it extends Request.Request<string, string>."
      ],
      explanation: `\`Request.Request<string>\` is short for \`Request.Request<string, never>\`: this request cannot fail. Therefore \`completeUnsafe\` only accepts \`Exit<string, never>\`, and the compiler rejects \`Exit.fail("...")\`. When you declare the error as \`string\`, the contract becomes wider, and the wider type flows through. \`Effect.request\` now returns \`Effect<string, string>\`, so every caller sees in the type that a lookup can fail. In a plain DataLoader, the same mistake only shows at run time.`
    },
    {
      id: "batching-c4",
      title: "The entry nobody answered",
      task: `Requests for unknown ids stop the whole program with a defect. They do not fail in a clean way. Fix the resolver so that it completes every entry. The program must print \`ok Ada\` and then \`missing 5\`.`,
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
        "Read the defect message: \"RequestResolver did not complete request\". Which entry did the resolver skip?",
        "A resolver must call completeUnsafe on every entry that it receives. This includes the entries that it cannot find.",
        "Add an else branch that completes the entry with Exit.fail(String(entry.request.id))."
      ],
      explanation: `The runtime gives the resolver a batch. When the effect of the resolver finishes, the runtime checks that each entry is complete. Without this check, an entry that is not complete waits forever. The runtime prevents this: it fails the entry with a defect. Defects are for bugs, and a forgotten entry is a bug. When you complete the missing id with \`Exit.fail\`, it becomes the expected, typed error that \`Effect.result\` can report. The other entry in the same batch still succeeds.`
    },
    {
      id: "batching-c5",
      title: "Too many ids per query",
      task: `The backend rejects queries with more than 2 ids, but the program sends all 5 ids in 1 batch. Do not change the resolver body. Make the program print batches of \`2, 2, 1\`, as the expected output shows.`,
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
        "The batch size is a property of the resolver, not of the loop. Lesson 5 shows the wrapper.",
        "RequestResolver.batchN(resolver, n) limits every batch to n entries.",
        "Replace the UserResolver line with RequestResolver.batchN(base, 2)."
      ],
      explanation: `\`batchN\` changes the collection rule of the resolver. As soon as a batch holds 2 entries, the runtime runs it and starts a new batch for the next entries. The loop, the request type, and the resolver body stay the same. This is the advantage of batch logic in the resolver. A policy such as the maximum size is 1 wrapper that you apply once. You do not repeat chunk logic at every call site.`
    },
    {
      id: "batching-c6",
      title: "A resolver per call",
      task: `Everything looks correct, but the runtime calls the resolver 3 times for 3 concurrent requests. Find the structural mistake and fix it. The output must be \`resolver calls: 1\`.`,
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
        "The runtime groups the requests by resolver. How many resolver objects does this program create?",
        "The program calls RequestResolver.make inside getUser, so every request gets a new resolver and its own batch.",
        "Move the RequestResolver.make call out of getUser to the module level. Then use the shared UserResolver."
      ],
      explanation: `The runtime keys the pending batches by the resolver *object*. 3 calls to \`getUser\` built 3 different resolvers, so the runtime saw 3 unrelated batches of 1 entry each. When you move the resolver to the module level, every request points at the same object. This is what "same batch" means. Rule: create a resolver once, at the module level or inside a service. Build only the request values per call.`
    }
  ],
  problems: [
    {
      id: "batching-p1",
      title: "Posts with authors",
      spec: `
You have 4 posts and a users table. Load the author of every post with a batched request. Then print 1 line per post and a final line with the number of queries.

Requirements:

1. Define \`GetUser\` as a request for a \`string\` name by numeric \`id\`. Use \`Request.tagged\`.
2. Write \`UserResolver\` with \`RequestResolver.make\`. It must increment the \`queries\` counter once per batch and complete each entry from \`usersTable\` (all ids exist).
3. \`withAuthor(post)\` must return the post title and the author name as \`"<title> by <name>"\`.
4. In \`program\`, load all posts concurrently, print each line, and then print \`queries: 1\`.

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
        "Follow lesson 1 for the shape of the request and the resolver. The resolver body is a for loop over the entries, and it calls completeUnsafe.",
        "withAuthor can be Effect.request(...).pipe(Effect.map((name) => post.title + \" by \" + name)).",
        "Effect.forEach(posts, withAuthor, { concurrency: \"unbounded\" }) keeps the output order and lets the runtime put all 4 requests in 1 batch."
      ]
    },
    {
      id: "batching-p2",
      title: "Stock check with unknown SKUs",
      spec: `
A warehouse API returns the stock levels for a list of SKUs. It omits the SKUs that it does not know, without an error. Build a batched, deduplicated stock check that reports unknown SKUs as typed failures.

Requirements:

1. \`class UnknownSku extends Schema.TaggedError<UnknownSku>()("UnknownSku", { sku: Schema.String })\`.
2. \`GetStock\` is a request for a \`number\` that can fail with \`UnknownSku\`. It has a \`sku: string\` field.
3. The resolver must count its calls in \`apiCalls\` and print \`api call for: <unique skus joined by ", ">\`. Deduplicate the SKUs inside the resolver, in first-seen order. Complete each entry from \`stockTable\`, or fail it with \`UnknownSku\`.
4. Wrap the resolver with \`RequestResolver.withCache\` (capacity 50), so that the resolver does not receive repeated SKUs.
5. \`program\` checks the list \`["A1", "B2", "A1", "Z9", "B2"]\` concurrently with \`Effect.result\`. It prints 1 line per item, then \`api calls: 1\`.

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
        "Lesson 4 shows the error class, the request with an error type, and how to complete entries with Exit.fail.",
        "withCache returns an Effect. yield* it inside program. Then define getStock after it, so that getStock uses the shared resolver.",
        "With Effect.result per item, a failure does not stop forEach. Result.isSuccess narrows the type, so r.success and r.failure.sku are typed."
      ]
    }
  ],
  recall: [
    {
      q: "What decides whether 2 `Effect.request` calls go in the same batch?",
      a: "Time and identity. The 2 calls must start concurrently (before the collection window of the resolver closes), **and** they must point at the same resolver object. A sequential loop, or a resolver that you create per call, gives 1 batch per request."
    },
    {
      q: "What is the type of `Effect.request(GetUser({ id: 1 }), resolver)` if `GetUser extends Request.Request<User, NotFound>`?",
      a: "`Effect<User, NotFound, never>`. The success and error types of the request become the types of the effect. If the request has requirements as a third parameter, they appear in `R`."
    },
    {
      q: "What happens if a resolver finishes and did not call `completeUnsafe` on one of its entries?",
      a: "That request fails with a defect: `RequestResolver did not complete request`. The resolver must complete every entry with `Exit.succeed` or `Exit.fail`. This includes the entries that the backend did not return."
    },
    {
      q: "Which function prevents that the resolver receives identical requests 2 times?",
      a: "`RequestResolver.withCache(resolver, { capacity })`. It returns an `Effect<RequestResolver>`, so `yield*` it once and share the result. A `Set` of ids inside the resolver only makes the query smaller. The entries still arrive."
    },
    {
      q: "The backend accepts at most 100 ids per call. Where does that rule go?",
      a: "On the resolver: `RequestResolver.batchN(resolver, 100)`. The call sites do not split the ids. The resolver splits large batches automatically."
    },
    {
      q: "Name a case where you must not use Request and RequestResolver.",
      a: "When the lookups are sequential by nature (there is nothing to group). When writes must happen in a strict order. When the backend has no bulk endpoint, so the resolver loops in any case. Use a plain function that returns an Effect instead."
    }
  ]
}

export default section
