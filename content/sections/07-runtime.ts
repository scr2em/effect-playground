import type { Section } from "../types.ts"

const section: Section = {
  id: "runtime",
  title: "Runtime",
  order: 7,
  summary: "Fibers, the run functions, ManagedRuntime, and how an Effect app starts and stops.",
  intro: `
**The problem.** A plain TypeScript app starts with \`await main()\`. The rest is not planned. Services are module-level singletons that are made on import. Background work is a Promise that nobody holds. Shutdown is \`process.on("SIGTERM", ...)\` that calls \`db.close()\`, and you hope that the requests are complete:

\`\`\`ts
const db = await connect()               // runs on import, cannot be replaced in tests
app.get("/orders", async (req, res) => {
  fetchAndCache(req.params.id)           // nobody waits for this; errors disappear
  res.json(await db.query(...))
})
process.on("SIGTERM", () => db.close())  // requests that still run? unknown
\`\`\`

Every HTTP handler, every test, and every cron job answers the same questions again: where do the services come from, who owns the background work, what happens at exit.

### The shift

Today you think of a program as functions that you call. In Effect, you give descriptions to a runtime. The runtime has 3 jobs. It runs each effect as a **fiber**. A fiber is a light unit of work that the runtime can pause, continue, and interrupt. The runtime schedules the fibers, so thousands of fibers share 1 JavaScript thread. And the runtime carries the services and the settings of a fiber with the fiber.

In an app, you build the services 1 time as a \`Layer\`. A \`ManagedRuntime\` makes a long-lived runtime from that layer. Every entry point that the outside world calls, an HTTP handler, a message consumer, a test, runs its effect through that 1 runtime. All of them share the same database pool and the same config. \`runtime.dispose()\` releases all resources in the correct order at shutdown. Callback code that needs services captures the current \`Context\` and runs effects with it. The edge of the app owns the services, the fibers, and the shutdown. All code inside the edge is a description.

| Need | Use | Returns |
|---|---|---|
| Run a sync effect and get the value | \`Effect.runSync\` | \`A\` (throws on failure) |
| Run any effect and get a Promise | \`Effect.runPromise\` | \`Promise<A>\` |
| Run and never throw | \`Effect.runSyncExit\` / \`Effect.runPromiseExit\` | \`Exit<A, E>\` |
| Run in the background | \`Effect.runFork\` | \`Fiber<A, E>\` |
| Run from callback code | \`Effect.runCallback\` | a cancel function |
| The same, with services | \`ManagedRuntime.make(layer).run*\` or \`Effect.run*With(context)\` | as above |

Note: 2 things changed in v4. The v3 type \`Runtime<R>\` does not exist. A \`Context<R>\` has that role. The v3 accessor \`Effect.runtime()\` is now \`Effect.context()\`. The \`Runtime\` module holds only the process-exit helpers that the platform packages use.
`,
  lessons: [
    {
      id: "runtime-l1",
      title: "Fibers: what runFork gives you",
      explain: `
Every run function makes a fiber. \`Effect.runFork\` gives the fiber back to you. It does not wait for the fiber. A \`Fiber<A, E>\` is an effect that runs. You can \`Fiber.join\` it: an effect that waits and gives the value, or fails as the fiber failed. You can \`Fiber.await\` it: an effect that waits and gives the \`Exit\`, and never fails. You can \`Fiber.interrupt\` it.

The runtime schedules fibers in turns. When 1 fiber pauses (it sleeps, it waits for a Promise, or it completes a batch of steps), the next fiber runs. 2 fibers with different sleep times end in sleep order, not in fork order. In the program below, "slow" is forked first, but "fast" prints first.

Compare a fiber with a Promise. A Promise starts immediately, and you cannot cancel it. A fiber starts when you fork it, and you can interrupt it at any pause point. Its finalizers run. The Concurrency section covers this in detail. Here you only need to know that \`runFork\` starts work and returns a handle.
`,
      code: `import { Effect, Fiber } from "effect"

const task = (name: string, delayMs: number) =>
  Effect.gen(function* () {
    yield* Effect.sleep(delayMs)
    console.log(name + " finished")
    return name.toUpperCase()
  })

const main = async () => {
  console.log("forking")
  const slow = Effect.runFork(task("slow", 40))    // starts now, returns a Fiber
  const fast = Effect.runFork(task("fast", 5))
  console.log("both running in the background")

  const fastResult = await Effect.runPromise(Fiber.join(fast))    // wait for the value
  const slowResult = await Effect.runPromise(Fiber.join(slow))
  console.log("joined: " + fastResult + " " + slowResult)

  const failing = Effect.runFork(Effect.fail("boom"))
  const exit = await Effect.runPromise(Fiber.await(failing))      // wait for the Exit, never throws
  console.log("await gives an Exit: " + exit._tag)
}

main()
`,
      expectedOutput: `forking
both running in the background
fast finished
slow finished
joined: FAST SLOW
await gives an Exit: Failure`,
      after: `The line "both running in the background" prints before both fibers end, because \`runFork\` returned immediately. Replace \`Fiber.await(failing)\` with \`Fiber.join(failing)\`. The join fails with "boom", and \`runPromise\` rejects. Use \`await\` when you want to inspect the outcome.`
    },
    {
      id: "runtime-l2",
      title: "Select a run function",
      explain: `
The run functions differ in 2 ways: what they return, and if they throw. Select 1 by the shape of the code that calls you.

| The caller is... | Use | Notes |
|---|---|---|
| Sync code that wants a value now | \`runSync\` | Throws on failure, or when the effect does async work |
| \`async\` code | \`runPromise\` | Rejects on failure |
| Any code that must not throw | \`runSyncExit\` / \`runPromiseExit\` | Returns an \`Exit\` |
| Callback-style code (event handlers, older libraries) | \`runCallback\` | You give \`onExit\`; you get a function that interrupts |
| Code that does not wait | \`runFork\` | Returns the fiber |

People often forget \`runCallback\` and \`runFork\`. \`runCallback\` is the bridge for an API that wants a callback and a cancel function. \`runFork\` is the base of the other run functions. \`runPromise\` is "fork, then wrap the fiber in a Promise".

All run functions accept \`RunOptions\`: an \`AbortSignal\` to interrupt the fiber from outside, and a custom scheduler.
`,
      code: `import { Effect, Exit } from "effect"

const work = Effect.gen(function* () {
  yield* Effect.sleep("5 millis")
  return 21 * 2
})

const main = async () => {
  // 1. Promise: the usual choice at the top of an app
  console.log("promise:", await Effect.runPromise(work))

  // 2. Exit variants never throw
  const exit = await Effect.runPromiseExit(Effect.fail("nope"))
  console.log("exit:", Exit.isFailure(exit) ? "failure, handled without try/catch" : "success")

  // 3. Callback: for APIs that hand you a callback. Returns a cancel function.
  await new Promise<void>((resolve) => {
    const cancel = Effect.runCallback(work, {
      onExit: (exit) => {
        console.log("callback:", Exit.isSuccess(exit) ? exit.value : "failed")
        resolve()
      }
    })
    console.log("callback registered, cancel is a", typeof cancel)
  })

  // 4. AbortSignal: interrupt from the outside
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(Effect.sleep("10 seconds"), { signal: controller.signal })
  controller.abort()
  const aborted = await pending
  console.log("aborted:", Exit.isFailure(aborted) ? "interrupted" : "finished")
}

main()
`,
      expectedOutput: `promise: 42
exit: failure, handled without try/catch
callback registered, cancel is a function
callback: 42
aborted: interrupted`,
      after: `Look at the abort case. A sleep of 10 seconds ended immediately, and the program continued. Interruption is part of the runtime. Every \`Effect.sleep\`, every \`Effect.callback\`, and every \`yield*\` is a point where the runtime can stop a fiber. The Concurrency section covers finalizers, which run at that point.`
    },
    {
      id: "runtime-l3",
      title: "ManagedRuntime: build the services 1 time, run many effects",
      explain: `
\`Effect.provide(program, layer)\` builds the layer each time you run \`program\`. For 1 \`main\`, this is fine. An HTTP server processes thousands of requests, and a test file has 50 tests. There you want to build the services 1 time and use them again.

\`ManagedRuntime.make(layer)\` does that. It builds the layer at the first use, keeps the \`Context\` that results, and gives you the full set of run functions (\`runPromise\`, \`runSync\`, \`runFork\`, \`runCallback\`, and the \`Exit\` forms). These run functions accept effects that **require the services of the layer**. The runtime supplies the requirement, so the types are correct.

The runtime also owns a \`Scope\`. The layer below opens a database connection. \`runtime.dispose()\` releases such resources, in reverse order. After \`dispose\`, the runtime is dead. A run gives a failure. It does not connect again without a message.
`,
      code: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly query: (sql: string) => Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      console.log("db: connect")                   // runs once, when the runtime first builds the layer
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log("db: close")))
      return { query: (sql: string) => Effect.succeed("rows for " + sql) }
    })
  )
}

// An "HTTP handler": an effect that needs Db
const handler = (sql: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    return yield* db.query(sql)
  })

const runtime = ManagedRuntime.make(Db.layer)   // nothing built yet

const main = async () => {
  console.log(await runtime.runPromise(handler("select 1")))   // builds the layer, connects
  console.log(await runtime.runPromise(handler("select 2")))   // reuses the same Db
  console.log(runtime.runSync(handler("select 3")))            // sync is fine when the effect is sync
  await runtime.dispose()                                      // releases the connection
  const exit = await runtime.runPromiseExit(handler("select 4"))
  console.log("after dispose: " + exit._tag)
}

main()
`,
      expectedOutput: `db: connect
rows for select 1
rows for select 2
rows for select 3
db: close
after dispose: Failure`,
      after: `"db: connect" appears 1 time for 3 runs, and "db: close" appears 1 time at \`dispose\`. Replace each \`runtime.runPromise(handler(...))\` with \`Effect.runPromise(Effect.provide(handler(...), Db.layer))\` and count the connects: 3, with 3 closes. This is the difference that a \`ManagedRuntime\` makes at a boundary.`
    },
    {
      id: "runtime-l4",
      title: "At the boundary: handlers and tests",
      explain: `
A \`ManagedRuntime\` belongs at the **edge** of the app. The edge is each place where code that is not Effect calls code that is Effect. Every project has 2 such edges:

- **Request handlers.** A framework calls your function with a request. The function runs an effect through the shared runtime and returns the result. Every request sees the same services.
- **Tests.** A test file builds 1 runtime from a test layer (a fake database, a fixed clock). Each test runs its effect through that runtime. Different files can use different layers.

Below, \`fakeServer\` has the role of a framework. It takes a plain async function and calls it 1 time per request. The body of the handler is 1 line: \`runtime.runPromise(...)\`. The route logic and the counter are effects. They know nothing about the framework or the runtime.

Note: the \`Stats\` service holds state in a \`Ref\`. All requests share it, because the runtime built it 1 time.
`,
      code: `import { Context, Effect, Layer, ManagedRuntime, Ref } from "effect"

class Stats extends Context.Service<Stats, { readonly hits: Ref.Ref<number> }>()("Stats") {
  static readonly layer = Layer.effect(this, Effect.map(Ref.make(0), (hits) => ({ hits })))
}

// The app: effects that need Stats. No framework code here.
const route = (path: string) =>
  Effect.gen(function* () {
    const stats = yield* Stats
    const n = yield* Ref.updateAndGet(stats.hits, (h) => h + 1)
    return path === "/health" ? "ok" : "hit #" + n + " on " + path
  })

// A stand-in for a web framework: calls your handler once per request
const fakeServer = (handler: (path: string) => Promise<string>) => async (paths: Array<string>) => {
  for (const path of paths) {
    console.log(path + " -> " + (await handler(path)))
  }
}

const runtime = ManagedRuntime.make(Stats.layer)

// The boundary: one line that turns an effect into a Promise for the framework
const listen = fakeServer((path) => runtime.runPromise(route(path)))

listen(["/orders", "/health", "/orders/7"]).then(() => runtime.dispose())
`,
      expectedOutput: `/orders -> hit #1 on /orders
/health -> ok
/orders/7 -> hit #3 on /orders/7`,
      after: `The hit counter got to 3 across 3 separate handler calls, because the \`Ref\` is in the runtime, not in the handler. In a test file, write \`const runtime = ManagedRuntime.make(Layer.merge(FakeDb.layer, Stats.layer))\` 1 time at the top, and \`runtime.runPromise(...)\` in each test.`
    },
    {
      id: "runtime-l5",
      title: "Run an effect from a callback that needs services",
      explain: `
Sometimes you are inside an effect, with services available, and you must give a plain callback to a library: a timer, an event emitter, a WebSocket \`onmessage\`. The callback runs later, outside a fiber, so it cannot \`yield*\`. But it can run an effect, if it has the services.

The pattern has 2 steps. First, capture the current services with \`Effect.context<R>()\`. This gives a \`Context<R>\`. Second, inside the callback, use \`Effect.runPromiseWith(context)(effect)\` (or \`runForkWith\`, or \`runSyncWith\`). The \`With\` forms accept effects that require exactly the services that the context holds. In v3, this was \`Effect.runtime<R>()\` plus \`Runtime.runPromise(runtime)\`. In v4, the context does both.

The type parameter on \`Effect.context<Db>()\` is important. It says which services you capture, and it adds \`Db\` to the requirements of the outer effect. The compiler makes sure that the services are present.
`,
      code: `import { Context, Effect, Layer } from "effect"

class Db extends Context.Service<Db, { readonly query: (sql: string) => Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.succeed(this)({ query: (sql) => Effect.succeed("rows for " + sql) })
}

const handleMessage = (message: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    console.log(yield* db.query("insert " + message))
  })

// A library that only knows about callbacks
const subscribe = (onMessage: (message: string) => void) => {
  setTimeout(() => onMessage("hello"), 5)
  setTimeout(() => onMessage("world"), 10)
}

const program = Effect.gen(function* () {
  const services = yield* Effect.context<Db>()          // capture the services we have right now

  yield* Effect.callback<void>((resume) => {
    let received = 0
    subscribe((message) => {
      // Outside any fiber: run the effect against the captured services
      Effect.runPromiseWith(services)(handleMessage(message)).then(() => {
        received += 1
        if (received === 2) resume(Effect.void)
      })
    })
  })

  console.log("all messages handled")
})

Effect.runPromise(Effect.provide(program, Db.layer))
`,
      expectedOutput: `rows for insert hello
rows for insert world
all messages handled`,
      after: `Remove \`<Db>\` from \`Effect.context<Db>()\` and read the error on \`runPromiseWith\`. The captured context is now \`Context<never>\`, and it cannot run an effect that needs \`Db\`. The type parameter is the list of services that you carry into the callback.`
    },
    {
      id: "runtime-l6",
      title: "Keep-alive and shutdown",
      explain: `
Node exits when the event loop is empty. A fiber that waits for an Effect value (a \`Deferred\`, a queue) is not a Node timer or a socket. In Effect v3, the process sometimes exited while a fiber still waited, unless you used \`runMain\` from a platform package. In v4, the runtime keeps a keep-alive timer with a reference count while a fiber is paused. The program below waits for the deferred. The process exits only after the last fiber ends.

The core runtime does **not** process signals. For a real service, use \`NodeRuntime.runMain(program)\` from \`@effect/platform-node\` (or \`BunRuntime.runMain\`). It listens for \`SIGINT\` and \`SIGTERM\`, interrupts the main fiber so that the finalizers run, logs failures that nobody caught, and sets the process exit code (0 on success, 1 on failure, 130 on interrupt). It is the recommended entry point. The core \`Runtime\` module only exports the parts that those packages use.

The shutdown sequence is: signal, interrupt the main fiber, the finalizers close the resources in reverse order, exit code. Your handlers do not know about it.
`,
      code: `import { Deferred, Effect } from "effect"

const program = Effect.gen(function* () {
  const shutdown = yield* Deferred.make<string>()

  // Something outside Effect will complete it later (a signal handler, in real life)
  setTimeout(() => {
    Effect.runSync(Deferred.succeed(shutdown, "SIGTERM (simulated)"))
  }, 20)

  console.log("running; waiting for a shutdown signal")
  const reason = yield* Deferred.await(shutdown)     // fiber suspends; v4 keeps the process alive
  console.log("got " + reason + ", closing resources")
  yield* Effect.sleep("5 millis")                    // pretend to flush
  console.log("clean exit")
})

Effect.runPromise(program)
`,
      expectedOutput: `running; waiting for a shutdown signal
got SIGTERM (simulated), closing resources
clean exit`,
      after: `In v3, without \`runMain\`, this program can print the first line and then exit. Nothing in the Node event loop was open while the fiber waited for the deferred. In v4, a fiber that waits counts as open work. You still want \`runMain\` in a service, for the signals and the exit codes.`
    }
  ],
  dosAndDonts: [
    {
      do: "Keep the fiber from `Effect.runFork` and `Fiber.join` it, `Fiber.await` it, or `Fiber.interrupt` it.",
      dont: "Do not call `Effect.runFork(work)` and drop the result.",
      why: "Nobody waits for the fiber, so the main code continues before the work is complete, and a failure in the fiber is lost."
    },
    {
      do: "Use `Fiber.await` when you want to inspect the outcome of a fiber.",
      dont: "Do not use `Fiber.join` when the fiber can fail and you want to continue.",
      why: "`join` fails as the fiber failed; `await` never fails and gives the `Exit`."
    },
    {
      do: "Make 1 `ManagedRuntime` at the module level and run every handler through it.",
      dont: "Do not call `ManagedRuntime.make(layer)` inside a request handler.",
      why: "Each call builds the layer again, so the database connects for every request."
    },
    {
      do: "Call `runtime.dispose()` in the shutdown path, after the last request.",
      dont: "Do not let the process end without `dispose`.",
      why: "The runtime keeps its scope open on purpose, so the finalizers of the layer never run and the connection never closes."
    },
    {
      do: "Give the runtime a layer with all services: `ManagedRuntime.make(Layer.merge(Db.layer, Mailer.layer))`.",
      dont: "Do not run an effect that needs `Mailer` through a runtime that was made from `Db.layer` only.",
      why: "The run functions of the runtime accept only effects whose requirements are inside its layer, so the call does not compile."
    },
    {
      do: "Write `Effect.context<Db>()` with the type parameter when you capture services for a callback.",
      dont: "Do not write `Effect.context()` without a type parameter.",
      why: "The default type parameter is `never`, so the captured `Context<never>` cannot run an effect that needs `Db`."
    },
    {
      do: "Use `Effect.runPromiseWith(services)(effect)` inside a callback that runs outside a fiber.",
      dont: "Do not use `Effect.runPromise(effect)` in the callback when the effect needs services.",
      why: "`runPromise` accepts only effects with no requirements, so the call does not compile."
    },
    {
      do: "Use `NodeRuntime.runMain` or `BunRuntime.runMain` as the entry point of a service.",
      dont: "Do not rely on `Effect.runPromise(main)` alone for a long-lived service.",
      why: "`runMain` listens for `SIGINT` and `SIGTERM`, interrupts the main fiber so the finalizers run, and sets the exit code."
    }
  ],
  challenges: [
    {
      id: "runtime-c1",
      title: "The fiber that nobody waits for",
      task: `The program must print \`work done\` before \`main finished\`, but the order is reversed. Change \`main\` so that it waits for the forked work. Keep \`Effect.runFork\`.`,
      code: `import { Effect, Fiber } from "effect"

const work = Effect.gen(function* () {
  yield* Effect.sleep("5 millis")
  console.log("work done")
})

const main = async () => {
  Effect.runFork(work)
  console.log("main finished")
}

main()
`,
      solution: `import { Effect, Fiber } from "effect"

const work = Effect.gen(function* () {
  yield* Effect.sleep("5 millis")
  console.log("work done")
})

const main = async () => {
  const fiber = Effect.runFork(work)
  await Effect.runPromise(Fiber.join(fiber))
  console.log("main finished")
}

main()
`,
      expectedOutput: `work done
main finished`,
      hints: [
        "runFork returns immediately. What does it return?",
        "You can join a Fiber. Fiber.join(fiber) is an effect that waits for the fiber.",
        "Keep the fiber, then await Effect.runPromise(Fiber.join(fiber)) before you print."
      ],
      explanation: `\`Effect.runFork\` starts the work in a new fiber and returns the \`Fiber\` at once. \`main\` printed its line while the fiber still slept. \`Fiber.join\` is an effect that waits for the fiber and gives its result. \`runPromise\` makes a Promise from it, and \`await\` waits for the Promise. The rule: when you hold a fiber, you must \`join\` it, \`await\` it, or \`interrupt\` it. If you do not, its outcome is lost.`
    },
    {
      id: "runtime-c2",
      title: "1 runtime per request",
      task: `The database must connect 1 time and close 1 time, but the log shows a connect for every request. Change the program so that the output is correct. Do not change \`Db\` or \`handler\`.`,
      code: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly query: (sql: string) => Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      console.log("db: connect")
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log("db: close")))
      return { query: (sql: string) => Effect.succeed("rows for " + sql) }
    })
  )
}

const handler = (sql: string) => Effect.flatMap(Db, (db) => db.query(sql))

const handleRequest = async (sql: string) => {
  const runtime = ManagedRuntime.make(Db.layer)
  const result = await runtime.runPromise(handler(sql))
  await runtime.dispose()
  return result
}

const main = async () => {
  for (const sql of ["select 1", "select 2", "select 3"]) {
    console.log(await handleRequest(sql))
  }
}

main()
`,
      solution: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly query: (sql: string) => Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      console.log("db: connect")
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log("db: close")))
      return { query: (sql: string) => Effect.succeed("rows for " + sql) }
    })
  )
}

const handler = (sql: string) => Effect.flatMap(Db, (db) => db.query(sql))

const runtime = ManagedRuntime.make(Db.layer)

const handleRequest = (sql: string) => runtime.runPromise(handler(sql))

const main = async () => {
  for (const sql of ["select 1", "select 2", "select 3"]) {
    console.log(await handleRequest(sql))
  }
  await runtime.dispose()
}

main()
`,
      expectedOutput: `db: connect
rows for select 1
rows for select 2
rows for select 3
db: close`,
      hints: [
        "Where is ManagedRuntime.make called? How many times does that line run?",
        "A ManagedRuntime must live as long as the app. Build it 1 time, outside the handler.",
        "Move ManagedRuntime.make to the module level. Make handleRequest use it. Call dispose 1 time after the loop."
      ],
      explanation: `\`ManagedRuntime.make\` builds the layer at the first use. When you call it inside \`handleRequest\`, it builds a new database connection for each request and disposes it after the request. When you move the runtime to the module level, the layer is built 1 time, all requests share the connection, and \`dispose\` runs 1 time at the end. This is the reason that \`ManagedRuntime\` exists: 1 runtime at the edge, many effects through it.`
    },
    {
      id: "runtime-c3",
      title: "The runtime without a service",
      task: `\`notify\` needs \`Db\` and \`Mailer\`, but the runtime provides only 1 of them. The program does not compile. Change the layer of the runtime so that the program prints the 2 lines below.`,
      code: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly find: (id: number) => Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.succeed(this)({ find: (id) => Effect.succeed("user-" + id + "@example.com") })
}

class Mailer extends Context.Service<Mailer, { readonly send: (to: string) => Effect.Effect<void> }>()("Mailer") {
  static readonly layer = Layer.succeed(this)({ send: (to) => Effect.sync(() => console.log("mail sent to " + to)) })
}

const notify = (id: number) =>
  Effect.gen(function* () {
    const db = yield* Db
    const mailer = yield* Mailer
    const email = yield* db.find(id)
    yield* mailer.send(email)
  })

const runtime = ManagedRuntime.make(Db.layer)

runtime.runPromise(notify(1))
  .then(() => runtime.runPromise(notify(2)))
  .then(() => runtime.dispose())
`,
      solution: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly find: (id: number) => Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.succeed(this)({ find: (id) => Effect.succeed("user-" + id + "@example.com") })
}

class Mailer extends Context.Service<Mailer, { readonly send: (to: string) => Effect.Effect<void> }>()("Mailer") {
  static readonly layer = Layer.succeed(this)({ send: (to) => Effect.sync(() => console.log("mail sent to " + to)) })
}

const notify = (id: number) =>
  Effect.gen(function* () {
    const db = yield* Db
    const mailer = yield* Mailer
    const email = yield* db.find(id)
    yield* mailer.send(email)
  })

const runtime = ManagedRuntime.make(Layer.merge(Db.layer, Mailer.layer))

runtime.runPromise(notify(1))
  .then(() => runtime.runPromise(notify(2)))
  .then(() => runtime.dispose())
`,
      expectedOutput: `mail sent to user-1@example.com
mail sent to user-2@example.com`,
      hints: [
        "Read the error on runtime.runPromise. Which service is in the requirements of the effect but not in the runtime?",
        "A ManagedRuntime provides exactly what its layer provides. You can combine 2 layers into 1 layer.",
        "Use Layer.merge(Db.layer, Mailer.layer) when you make the runtime."
      ],
      explanation: `\`ManagedRuntime.make(Db.layer)\` produces a \`ManagedRuntime<Db, never>\`. Its \`runPromise\` accepts only effects whose requirements are inside \`Db\`. \`notify\` requires \`Db | Mailer\`, so the compiler rejects the call. An absent service is a compile error. It is not a "service not found" defect at run time. \`Layer.merge\` builds a layer that provides both services, and the type of the runtime changes with it. This check is the benefit of the \`R\` type parameter: you find the problem at the boundary, at build time.`
    },
    {
      id: "runtime-c4",
      title: "Nobody closed the connection",
      task: `The program runs, but the last line, \`db: close\`, never prints. Make the resources release after the requests are complete.`,
      code: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly ping: Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      console.log("db: connect")
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log("db: close")))
      return { ping: Effect.succeed("pong") }
    })
  )
}

const runtime = ManagedRuntime.make(Db.layer)

const main = async () => {
  console.log(await runtime.runPromise(Effect.flatMap(Db, (db) => db.ping)))
  console.log(await runtime.runPromise(Effect.flatMap(Db, (db) => db.ping)))
  console.log("requests finished")
}

main()
`,
      solution: `import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Db extends Context.Service<Db, { readonly ping: Effect.Effect<string> }>()("Db") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      console.log("db: connect")
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log("db: close")))
      return { ping: Effect.succeed("pong") }
    })
  )
}

const runtime = ManagedRuntime.make(Db.layer)

const main = async () => {
  console.log(await runtime.runPromise(Effect.flatMap(Db, (db) => db.ping)))
  console.log(await runtime.runPromise(Effect.flatMap(Db, (db) => db.ping)))
  console.log("requests finished")
  await runtime.dispose()
}

main()
`,
      expectedOutput: `db: connect
pong
pong
requests finished
db: close`,
      hints: [
        "A finalizer from a layer runs when the scope that owns the layer closes. Who owns the scope here?",
        "The ManagedRuntime owns the scope. It has a method that closes the scope.",
        "Add await runtime.dispose() at the end of main."
      ],
      explanation: `A resource that a layer opens belongs to the scope of the code that built the layer. With \`Effect.provide\`, that scope closes when the program ends. A \`ManagedRuntime\` keeps the scope open on purpose, so the services survive across runs. The app must say when it is complete. \`runtime.dispose()\` closes the scope and runs every finalizer in reverse order. In a real service, that call is in the shutdown path, after the server no longer accepts requests.`
    },
    {
      id: "runtime-c5",
      title: "The wrong context",
      task: `The callback must run \`record\` with the services of the outer effect, but the program does not compile. Change the capture so that the program compiles and prints the lines below. Do not change \`record\` or the \`runPromiseWith\` line.`,
      code: `import { Context, Effect, Layer } from "effect"

class Audit extends Context.Service<Audit, { readonly log: (event: string) => Effect.Effect<void> }>()("Audit") {
  static readonly layer = Layer.succeed(this)({ log: (event) => Effect.sync(() => console.log("audit: " + event)) })
}

const record = (event: string) => Effect.flatMap(Audit, (audit) => audit.log(event))

const program = Effect.gen(function* () {
  const services = yield* Effect.context()

  yield* Effect.callback<void>((resume) => {
    setTimeout(() => {
      Effect.runPromiseWith(services)(record("timer fired")).then(() => resume(Effect.void))
    }, 5)
  })

  console.log("done")
})

Effect.runPromise(Effect.provide(program, Audit.layer))
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Audit extends Context.Service<Audit, { readonly log: (event: string) => Effect.Effect<void> }>()("Audit") {
  static readonly layer = Layer.succeed(this)({ log: (event) => Effect.sync(() => console.log("audit: " + event)) })
}

const record = (event: string) => Effect.flatMap(Audit, (audit) => audit.log(event))

const program = Effect.gen(function* () {
  const services = yield* Effect.context<Audit>()

  yield* Effect.callback<void>((resume) => {
    setTimeout(() => {
      Effect.runPromiseWith(services)(record("timer fired")).then(() => resume(Effect.void))
    }, 5)
  })

  console.log("done")
})

Effect.runPromise(Effect.provide(program, Audit.layer))
`,
      expectedOutput: `audit: timer fired
done`,
      hints: [
        "Read the error. What does services contain, by its type?",
        "Effect.context() without a type argument captures Context<never>. For the compiler, it has no services.",
        "Write Effect.context<Audit>(). Then the type of the captured context includes Audit."
      ],
      explanation: `At run time, the context of the fiber contains \`Audit\`. This bug is visible only in the types. The type parameter of \`Effect.context()\` defaults to \`never\`. The result is a \`Context<never>\`, and \`runPromiseWith\` rejects an effect that needs \`Audit\`. \`Effect.context<Audit>()\` corrects the capture. It also adds \`Audit\` to the requirements of \`program\`. If you forget to provide \`Audit\`, that is also a compile error.`
    }
  ],
  problems: [
    {
      id: "runtime-p1",
      title: "1 runtime, many requests",
      spec: `
Build a small service and call it from a fake web framework through 1 \`ManagedRuntime\`.

1. A \`Users\` service (\`Context.Service\`) with \`find(id): Effect<string, string>\`. Its layer prints \`users: ready\` when it is built, adds a finalizer that prints \`users: closed\`, and returns names from the map \`{ 1: "Ada", 2: "Lin" }\`. For other ids, \`find\` fails with the string \`"no user " + id\`.
2. A \`Requests\` service that holds a \`Ref<number>\` counter. Build it with \`Layer.effect\`.
3. \`route(id)\`: adds 1 to the counter, then reads the user and returns \`"hello " + name\`. On failure, catch the error with \`Effect.catch\` and return the error string.
4. Make **1** \`ManagedRuntime\` from both layers. \`serve\` gets the ids \`[1, 3, 2]\`. It runs \`route\` for each id through the runtime and prints \`<id>: <result>\`. Then it prints \`requests: <count>\`, read from the counter through the runtime. Then it disposes the runtime.

Exact output:

\`\`\`
users: ready
1: hello Ada
3: no user 3
2: hello Lin
requests: 3
users: closed
\`\`\`
`,
      starter: `import { Context, Effect, Layer, ManagedRuntime, Ref } from "effect"

// TODO: Users service + layer (prints "users: ready", finalizer prints "users: closed")

// TODO: Requests service holding a Ref<number>

// TODO: route(id): count, look up, recover from failure with the error string

// TODO: one ManagedRuntime from both layers

const serve = async (ids: Array<number>) => {
  // TODO: run route for each id, print "<id>: <result>", then "requests: <count>", then dispose
}

serve([1, 3, 2])
`,
      solution: `import { Context, Effect, Layer, ManagedRuntime, Ref } from "effect"

class Users extends Context.Service<Users, { readonly find: (id: number) => Effect.Effect<string, string> }>()("Users") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      console.log("users: ready")
      yield* Effect.addFinalizer(() => Effect.sync(() => console.log("users: closed")))
      const names: Record<number, string> = { 1: "Ada", 2: "Lin" }
      return {
        find: (id: number) => (id in names ? Effect.succeed(names[id]!) : Effect.fail("no user " + id))
      }
    })
  )
}

class Requests extends Context.Service<Requests, { readonly count: Ref.Ref<number> }>()("Requests") {
  static readonly layer = Layer.effect(this, Effect.map(Ref.make(0), (count) => ({ count })))
}

const route = (id: number) =>
  Effect.gen(function* () {
    const requests = yield* Requests
    yield* Ref.update(requests.count, (n) => n + 1)
    const users = yield* Users
    const name = yield* users.find(id)
    return "hello " + name
  }).pipe(Effect.catch((message) => Effect.succeed(message)))

const runtime = ManagedRuntime.make(Layer.merge(Users.layer, Requests.layer))

const serve = async (ids: Array<number>) => {
  for (const id of ids) {
    console.log(id + ": " + (await runtime.runPromise(route(id))))
  }
  const total = await runtime.runPromise(Effect.flatMap(Requests, (r) => Ref.get(r.count)))
  console.log("requests: " + total)
  await runtime.dispose()
}

serve([1, 3, 2])
`,
      expectedOutput: `users: ready
1: hello Ada
3: no user 3
2: hello Lin
requests: 3
users: closed`,
      hints: [
        "Layer.effect(Users, Effect.gen(...)) can print, add a finalizer with Effect.addFinalizer, and return the service object.",
        "ManagedRuntime.make(Layer.merge(Users.layer, Requests.layer)) gives a runtime. Its runPromise accepts effects that need 1 or both services.",
        "Effect.catch((message) => Effect.succeed(message)) makes a success value from the failure. The counter still counts, because the update runs before the lookup."
      ]
    },
    {
      id: "runtime-p2",
      title: "Background worker with a clean shutdown",
      spec: `
Run a worker in a background fiber. Wait until it has processed its jobs. Then stop it and inspect how it ended.

1. \`worker(jobs, drained)\`: an effect. For each job in \`jobs\`, it sleeps \`"1 millis"\` and prints \`processed <job>\`. Then it completes the \`Deferred<void>\` \`drained\` with \`Deferred.succeed\`. Then it waits with \`Effect.never\` (a real worker waits for more jobs).
2. \`program\`: makes the deferred, forks the worker with \`Effect.forkChild\` (this is inside an effect, so do not use \`runFork\`), prints \`worker started\`, waits for the deferred with \`Deferred.await\`, prints \`all jobs done, shutting down\`, interrupts the fiber with \`Fiber.interrupt\`, gets its \`Exit\` with \`Fiber.await\`, and prints the result. When the exit is a failure and \`Cause.hasInterruptsOnly(exit.cause)\` is true, print \`worker exit: interrupted\`. In all other cases, print \`worker exit: <tag>\`.

The jobs are \`["job-1", "job-2", "job-3"]\`. Exact output:

\`\`\`
worker started
processed job-1
processed job-2
processed job-3
all jobs done, shutting down
worker exit: interrupted
\`\`\`
`,
      starter: `import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

// TODO: worker(jobs, drained): process each job, complete drained, then Effect.never

const program = Effect.gen(function* () {
  // TODO: make the deferred, fork the worker, wait, interrupt, inspect the Exit
})

Effect.runPromise(program)
`,
      solution: `import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

const worker = (jobs: Array<string>, drained: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    for (const job of jobs) {
      yield* Effect.sleep("1 millis")
      console.log("processed " + job)
    }
    yield* Deferred.succeed(drained, undefined)
    yield* Effect.never
  })

const program = Effect.gen(function* () {
  const drained = yield* Deferred.make<void>()
  const fiber = yield* Effect.forkChild(worker(["job-1", "job-2", "job-3"], drained))
  console.log("worker started")

  yield* Deferred.await(drained)
  console.log("all jobs done, shutting down")

  yield* Fiber.interrupt(fiber)
  const exit = yield* Fiber.await(fiber)
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    console.log("worker exit: interrupted")
  } else {
    console.log("worker exit: " + exit._tag)
  }
})

Effect.runPromise(program)
`,
      expectedOutput: `worker started
processed job-1
processed job-2
processed job-3
all jobs done, shutting down
worker exit: interrupted`,
      hints: [
        "Deferred.make<void>() makes it. Deferred.succeed(drained, undefined) completes it. Deferred.await(drained) waits for it.",
        "Effect.forkChild(worker(...)) inside Effect.gen gives a Fiber, and you stay inside the effect. Effect.never pauses until an interrupt.",
        "Fiber.interrupt(fiber) waits until the fiber has stopped. Fiber.await(fiber) then gives an Exit. Its cause contains only an interrupt."
      ]
    }
  ],
  recall: [
    {
      q: "What does `Effect.runFork` return, and what must you do with it?",
      a: "A `Fiber<A, E>`, the effect that runs. You must `Fiber.join` it (get the value), `Fiber.await` it (get the `Exit`), or `Fiber.interrupt` it. If you do not, its outcome is lost."
    },
    {
      q: "Which function do you use to run effects from 50 HTTP handlers that all need the same database service?",
      a: "`ManagedRuntime.make(layer)` 1 time at the module level, then `runtime.runPromise(effect)` in each handler. The layer is built 1 time, and the handlers share its services. `runtime.dispose()` releases them at shutdown."
    },
    {
      q: "What is the type of `ManagedRuntime.make(Layer.merge(Db.layer, Mailer.layer))`?",
      a: "`ManagedRuntime<Db | Mailer, never>`. The first parameter is the services that it provides. The second parameter is the error type of the layer build (`never` here). Its run functions accept effects whose `R` is inside `Db | Mailer`."
    },
    {
      q: "You are inside an effect, and you must give a callback to a library. How does the callback run an effect that needs services?",
      a: "Capture the services first: `const services = yield* Effect.context<MyService>()`. In the callback, call `Effect.runPromiseWith(services)(effect)` (or `runForkWith`, or `runSyncWith`). This replaces `Effect.runtime()` + `Runtime.runPromise` from v3."
    },
    {
      q: "Why did a v3 program sometimes exit while a fiber still waited for a `Deferred`, and what changed in v4?",
      a: "A wait for a `Deferred` is not a Node timer or a socket. Node saw an empty event loop and exited. In v4, the runtime keeps a keep-alive timer with a reference count while a fiber is paused. `runMain` from the platform packages is still recommended, for the signals and the exit codes."
    },
    {
      q: "What is the difference between `Fiber.join` and `Fiber.await`?",
      a: "`join` gives the success value of the fiber, and it fails as the fiber failed. `await` never fails. It gives the `Exit` of the fiber, so you can inspect success, failure, or interruption."
    }
  ]
}

export default section
