import type { Section } from "../types.ts"

const section: Section = {
  id: "resource-management",
  title: "Resource Management",
  order: 4,
  summary: "Scopes and finalizers: closing is attached to acquiring, and the runtime guarantees it on success, failure, and interruption.",
  intro: `
**The problem.** Everything that you open, you must close: files, sockets, database connections, locks, temp directories. Plain TypeScript gives you \`try\`/\`finally\`. It looks correct for 1 resource:

\`\`\`ts
async function report() {
  const db = await connect()
  const file = await openFile("out.csv")     // if THIS throws, db is never closed
  try {
    await file.write(await db.query("select ..."))
  } finally {
    await file.close()
    await db.close()                          // you must list them, by hand, in reverse
  }
}
\`\`\`

This code has 3 problems. The second \`open\` is outside the \`try\`. If it fails, the first resource stays open. The \`finally\` block is a manual list. Every caller of \`connect\` must repeat it, in the correct order. And a Promise cannot be cancelled. If a timeout stops the wait for \`report()\`, the function continues to run, and you cannot tell it to clean up now. The signature \`report(): Promise<void>\` does not say that a resource is involved.

### The shift

Today you think of cleanup as **a step to remember at every use site**. Effect asks you to think of it as **part of the acquisition**. \`Effect.acquireRelease(open, close)\` pairs the 2 steps once, where you define the resource. When you use the resource, the type gets a requirement, \`Scope\`. A scope is a container for the cleanups that must still run. So the compiler knows that a cleanup must still run. \`Effect.scoped\` marks the region where the resource lives. When that region ends, for any reason, the runtime runs every registered finalizer in reverse order, and gives each one the outcome.

The result: resource safety does not depend on discipline. A function that acquires 3 resources and fails on the fourth line closes exactly the 3 resources that it opened. When a timeout interrupts a fiber, the fiber still closes its files. A layer that opens a database connection closes it when the application stops. You write the close once. The runtime gives the guarantee.

| | \`try\`/\`finally\` | Effect |
|---|---|---|
| Where the cleanup is | At every call site | Next to the acquire, once |
| 2 resources | Nested try blocks, or a manual list | 2 \`yield*\`, released in reverse order automatically |
| Acquire fails after the first resource | Earlier resources stay open unless you nest carefully | Effect releases only what it acquired |
| Cancellation | Not possible for a Promise | An interrupt runs the finalizers |
| Cleanup knows the outcome | No, \`finally\` sees nothing | Yes, the finalizer receives the \`Exit\` |
| Visible in the type | No | Yes, \`Scope\` in \`R\` until \`Effect.scoped\` |

In this section, you:

- pair acquire with release
- see the reverse order of release
- read the \`Exit\` inside a finalizer
- use the short form for the simple case
- see that an interrupt runs the finalizers
- attach a resource to a layer
`,
  lessons: [
    {
      id: "resource-management-l1",
      title: "Acquire and release, together",
      explain: `
Start with the problem. In plain TypeScript, the close is separate from the open. Nothing connects the 2 steps:

\`\`\`ts
const file = await openFile("a.txt")
const data = await read(file)          // throws? file is never closed
await file.close()
\`\`\`

\`Effect.acquireRelease(acquire, release)\` connects the 2 steps into 1 value. When you \`yield*\` this value, you get the resource *and* Effect registers the release with the current **scope**. A scope is a container for the cleanups that must still run. This is why the type of \`openFile\` ends in \`Scope\`. It means "a cleanup must still run somewhere."

\`Effect.scoped\` makes the scope, runs the effect inside it, then closes the scope. When the scope closes, the release runs. \`Effect.scoped\` also removes \`Scope\` from \`R\`. Without it, the program does not compile, because no code has agreed to close the resource.
`,
      code: `import { Effect } from "effect"

interface File {
  readonly name: string
}

// Open and close are declared together, once. The close is not optional anymore.
const openFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return { name } as File
    }),
    (file) => Effect.sync(() => console.log("close", file.name))
  )
// openFile("a.txt"): Effect<File, never, Scope>

const program = Effect.gen(function* () {
  const file = yield* openFile("a.txt")   // registers the close in the current scope
  console.log("reading", file.name)
  return file.name.length
})
// program: Effect<number, never, Scope>

// Effect.scoped creates the scope, runs program, then closes it. R becomes never.
const result = Effect.runSync(Effect.scoped(program))
console.log("result", result)
`,
      expectedOutput: `open a.txt
reading a.txt
close a.txt
result 5`,
      after: `Note that "close" prints before "result". The scope closes when \`program\` finishes, before the value reaches \`runSync\`. Remove \`Effect.scoped\`. The compiler reports \`Type 'Scope' is not assignable to type 'never'\`. The cleanup that must still run is visible in the type until some code agrees to run it.`
    },
    {
      id: "resource-management-l2",
      title: "Finalizers run in reverse",
      explain: `
A scope is a stack. Each \`acquireRelease\` pushes a release onto the stack. When the scope closes, it pops the releases off. So the last resource opened is the first resource closed. This is the order that you write by hand in a careful \`finally\` block. Here it is automatic.

\`Effect.addFinalizer\` pushes a cleanup onto the scope without a resource. Use it for "when this region ends, also do X": flush a buffer, log a summary, remove a temp directory. It is the lowest-level function. \`acquireRelease\` uses the same mechanism.

| Function | Pushes onto the scope | Returns |
|---|---|---|
| \`Effect.acquireRelease(acquire, release)\` | \`release(resource, exit)\` | The resource |
| \`Effect.addFinalizer((exit) => cleanup)\` | \`cleanup\` | Nothing |
`,
      code: `import { Effect } from "effect"

const open = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return name
    }),
    (name) => Effect.sync(() => console.log("close", name))
  )

const program = Effect.gen(function* () {
  const db = yield* open("database")       // pushed first, closed last
  const cache = yield* open("cache")       // pushed second
  const log = yield* open("log file")      // pushed third, closed first

  // A finalizer without a resource. Still part of the same stack.
  yield* Effect.addFinalizer(() => Effect.sync(() => console.log("flush metrics")))

  console.log("working with", db, cache, log)
})

Effect.runSync(Effect.scoped(program))
`,
      expectedOutput: `open database
open cache
open log file
working with database cache log file
flush metrics
close log file
close cache
close database`,
      after: `"flush metrics" was added last, so it runs first. Reverse order matters when resources depend on each other. For example, the cache can need the database to flush, so the cache must close first. You did not write that order. It comes from the order of acquisition.`
    },
    {
      id: "resource-management-l3",
      title: "The finalizer sees how it ended: Exit",
      explain: `
A \`finally\` block sees nothing. It does not know if the work succeeded or failed. So "commit on success, roll back on failure" needs a flag variable. Effect finalizers receive the **Exit**. An Exit is a plain value that is \`Success\` with a \`value\`, or \`Failure\` with a \`cause\`. The release function of \`acquireRelease\` receives it as its second argument.

Sometimes you do not have a resource, only 1 effect that needs a cleanup. Effect has a small group of functions for that. Select one by what the cleanup must know:

| Function | Runs when | Sees | Use when |
|---|---|---|---|
| \`Effect.ensuring(cleanup)\` | Always | Nothing | The cleanup is the same in all cases |
| \`Effect.onExit((exit) => ...)\` | Always | The \`Exit\` | The cleanup depends on the outcome |
| \`Effect.onError((cause) => ...)\` | Failure or interrupt | The \`Cause\` | Only failures need work |
| \`Effect.onInterrupt(() => ...)\` | Interrupt only | Nothing | React to an interrupt |
| \`Effect.acquireRelease\` | The scope closes | The resource and the \`Exit\` | You hold a resource |

Effect guarantees that all of these run after the effect has started, whatever happens next.
`,
      code: `import { Effect, Exit } from "effect"

// A transaction: the release decides commit or rollback by reading the Exit
const transaction = Effect.acquireRelease(
  Effect.sync(() => {
    console.log("begin")
    return { id: 1 }
  }),
  (tx, exit) =>
    Effect.sync(() => console.log(Exit.isSuccess(exit) ? "commit tx " + tx.id : "rollback tx " + tx.id))
)

// Each insert owns its scope, so the transaction ends when the insert ends
const insert = (row: string, ok: boolean) =>
  Effect.scoped(Effect.gen(function* () {
    const tx = yield* transaction
    console.log("insert", row, "in tx", tx.id)
    if (!ok) {
      yield* Effect.fail("constraint violated")
    }
  }))

// onExit on a plain effect, no resource involved
const audited = (label: string, effect: Effect.Effect<void, string>) =>
  effect.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => console.log(label + ":", Exit.isSuccess(exit) ? "ok" : "failed"))
    )
  )

Effect.runSyncExit(audited("first", insert("ada", true)))
Effect.runSyncExit(audited("second", insert("lin", false)))
`,
      expectedOutput: `begin
insert ada in tx 1
commit tx 1
first: ok
begin
insert lin in tx 1
rollback tx 1
second: failed`,
      after: `The failure in the second run did not reach the finalizer as an exception. It arrived as data, \`Exit.Failure\`, and the release selected "rollback". Replace \`Effect.onExit\` with \`Effect.ensuring(Effect.sync(() => console.log(label + ": done")))\` to see the version that does not know the outcome.`
    },
    {
      id: "resource-management-l4",
      title: "acquireUseRelease for the simple case",
      explain: `
When the whole life of a resource is in 1 place (open, use, close), you do not need a scope. \`Effect.acquireUseRelease(acquire, use, release)\` is the direct translation of the \`try\`/\`finally\` that you know, with 2 improvements. The release sees the \`Exit\`. And the runtime cannot interrupt the acquire before it completes.

\`\`\`ts
// Plain TypeScript
const conn = await connect()
try {
  return await conn.query("select 1")
} finally {
  await conn.close()
}
\`\`\`

The Effect version has the same 3 parts as arguments. No \`Scope\` appears in \`R\`, because the function itself closes the resource as soon as \`use\` finishes. Use \`acquireRelease\` plus \`scoped\` instead when the resource must live longer than 1 function. Examples: several steps share it, or a layer holds it.
`,
      code: `import { Effect, Exit } from "effect"

interface Connection {
  readonly id: number
  readonly query: (sql: string) => Effect.Effect<string>
}

const connect = Effect.sync((): Connection => {
  console.log("connect")
  return { id: 7, query: (sql) => Effect.succeed("rows for " + sql) }
})

// acquire, use, release: the resource never escapes, no Scope in R
const program = Effect.acquireUseRelease(
  connect,
  (conn) =>
    Effect.gen(function* () {
      const rows = yield* conn.query("select 1")
      console.log("using connection", conn.id, "->", rows)
      return rows
    }),
  (conn, exit) =>
    Effect.sync(() => console.log("close connection", conn.id, Exit.isSuccess(exit) ? "(clean)" : "(after error)"))
)
// program: Effect<string, never, never>

console.log("returned:", Effect.runSync(program))
`,
      expectedOutput: `connect
using connection 7 -> rows for select 1
close connection 7 (clean)
returned: rows for select 1`,
      after: `Add \`yield* Effect.fail("timeout")\` inside \`use\` and run with \`runSyncExit\`. The close line prints "(after error)" and still runs. This is the guarantee that \`try\`/\`finally\` gives you for 1 resource, now with the outcome included.`
    },
    {
      id: "resource-management-l5",
      title: "Interruption still releases",
      explain: `
A Promise cannot be cancelled. If a request times out, the work continues and keeps its connection open until the work finishes on its own. Effect programs run on **fibers**. A fiber is a lightweight thread that the Effect runtime manages. You can interrupt a fiber from the outside with \`Fiber.interrupt\`, or from the inside with \`Effect.interrupt\`. In both cases, the fiber stops at its next step, and every finalizer that it registered runs.

An interrupt is not a failure. The \`Exit\` that a finalizer receives is a \`Failure\` whose cause contains an interrupt reason. \`Exit.hasInterrupts(exit)\` tells the 2 cases apart, so a finalizer can log "cancelled" instead of "crashed".

The program below shows both directions. First, a job interrupts itself while it holds a lock. Then the main fiber forks a second job with \`Effect.forkChild\`, waits a few milliseconds, and interrupts it with \`Fiber.interrupt\`. Both locks are released.
`,
      code: `import { Effect, Exit, Fiber } from "effect"

const lock = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("lock", name)
      return name
    }),
    (name, exit) =>
      Effect.sync(() => console.log("unlock", name, Exit.hasInterrupts(exit) ? "(interrupted)" : "(normal)"))
  )

// 1. Interrupted from the inside: the code after Effect.interrupt never runs
const selfCancel = Effect.scoped(Effect.gen(function* () {
  yield* lock("A")
  yield* Effect.interrupt
  console.log("never printed")
}))

// 2. Interrupted from the outside: a long job cancelled by whoever forked it
const longJob = Effect.scoped(Effect.gen(function* () {
  yield* lock("B")
  yield* Effect.sleep("1 second")
  console.log("never printed either")
}))

const program = Effect.gen(function* () {
  const exit = yield* Effect.exit(selfCancel)
  console.log("selfCancel interrupted?", Exit.hasInterrupts(exit))

  const fiber = yield* Effect.forkChild(longJob)
  yield* Effect.sleep("10 millis")
  console.log("main: cancelling the job")
  yield* Fiber.interrupt(fiber)
  console.log("main: done")
})

Effect.runPromise(program)
`,
      expectedOutput: `lock A
unlock A (interrupted)
selfCancel interrupted? true
lock B
main: cancelling the job
unlock B (interrupted)
main: done`,
      after: `\`Fiber.interrupt\` waits until the interrupted fiber has finished its finalizers. This is why "unlock B" prints before "main: done". Concurrency and timeouts use this mechanism. \`Effect.timeout\` is an interrupt, and Effect releases every resource that the timed-out work held.`
    },
    {
      id: "resource-management-l6",
      title: "Scoped layers: a connection for the whole app",
      explain: `
A database connection must open once when the app starts, and close once when the app stops. That is a resource whose scope is the layer. In v4, there is no separate \`Layer.scoped\`. \`Layer.effect\` already provides a scope to its build effect and removes \`Scope\` from the requirements of the layer. So the pattern is \`Layer.effect\` with \`Effect.acquireRelease\` inside.

The scope of the layer stays open as long as the program that \`Effect.provide\` wraps runs. When that program finishes, Effect closes the layer, and the release runs. In the meantime, each request can open its own short-lived resources with a nested \`Effect.scoped\`. Those resources close at the end of the request, long before the connection closes.

\`\`\`
app scope        [ connect ......................... disconnect ]
request 1 scope        [ open tmp ... close tmp ]
request 2 scope                          [ open tmp ... close tmp ]
\`\`\`
`,
      code: `import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

// Layer.effect gives the build effect a scope. The release runs when the app ends.
const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const conn = yield* Effect.acquireRelease(
      Effect.sync(() => {
        console.log("db: connect")
        return { id: 1 }
      }),
      () => Effect.sync(() => console.log("db: disconnect"))
    )
    return { query: (sql) => Effect.succeed("conn " + conn.id + ": " + sql) }
  })
)
// DatabaseLive: Layer<Database, never, never>, no Scope left over

const tempFile = (request: number) =>
  Effect.acquireRelease(
    Effect.sync(() => console.log("[req " + request + "] open temp file")),
    () => Effect.sync(() => console.log("[req " + request + "] close temp file"))
  )

// Each request has its own, shorter scope
const handle = (request: number) =>
  Effect.scoped(Effect.gen(function* () {
    const db = yield* Database
    yield* tempFile(request)
    console.log("[req " + request + "]", yield* db.query("select " + request))
  }))

const app = Effect.gen(function* () {
  yield* handle(1)
  yield* handle(2)
  console.log("app: all requests done")
})

Effect.runPromise(app.pipe(Effect.provide(DatabaseLive)))
`,
      expectedOutput: `db: connect
[req 1] open temp file
[req 1] conn 1: select 1
[req 1] close temp file
[req 2] open temp file
[req 2] conn 1: select 2
[req 2] close temp file
app: all requests done
db: disconnect`,
      after: `"db: disconnect" comes after "app: all requests done". The layer lives longer than every request and closes when the provided program ends. Remove the \`Effect.scoped\` inside \`handle\`. The compiler reports \`Scope\` in \`R\` at \`runPromise\`. Some code must own the cleanup for each request.`
    }
  ],
  dosAndDonts: [
    {
      do: "Declare the close together with the open in `Effect.acquireRelease`.",
      dont: "Do not write the close as a normal step after the use.",
      why: "A failure before that step skips it, and the resource stays open."
    },
    {
      do: "Wrap the whole region of use in `Effect.scoped`.",
      dont: "Do not wrap only the acquire, for example `Effect.scoped(openFile(name))`.",
      why: "The scope closes as soon as the acquire finishes, so the next line uses a released resource."
    },
    {
      do: "Put `yield*` in front of `Effect.addFinalizer(...)`.",
      dont: "Do not call `Effect.addFinalizer(...)` on its own line without `yield*`.",
      why: "The call only builds an effect, and an effect that does not run registers nothing."
    },
    {
      do: "Give a release the error type `never`, with `Effect.ignore` or `Effect.orDie`.",
      dont: "Do not return an effect that can fail from a release function.",
      why: "A finalizer runs while the program already exits, so a second failure has no correct place, and the program does not compile."
    },
    {
      do: "Use `Effect.onExit` when the cleanup depends on the outcome.",
      dont: "Do not use `Effect.ensuring` with a flag variable that records success or failure.",
      why: "`Effect.ensuring` takes a fixed effect and cannot see the `Exit`, so the flag is a manual copy of information that Effect already has."
    },
    {
      do: "Acquire an application-wide resource inside `Layer.effect` with `Effect.acquireRelease`.",
      dont: "Do not look for `Layer.scoped` in v4, and do not open the connection in each request.",
      why: "`Layer.effect` already provides the scope, and a connection opened in each request closes at the end of that request."
    },
    {
      do: "Use `Effect.acquireUseRelease` when the open, the use, and the close are in 1 place.",
      dont: "Do not create a scope for a resource that only 1 function uses.",
      why: "The scope adds `Scope` to `R` for no benefit, and `acquireUseRelease` closes the resource as soon as `use` finishes."
    }
  ],
  challenges: [
    {
      id: "resource-management-c1",
      title: "Nobody promised to close it",
      task: `The program opens a file and does not compile. Some code must own the cleanup. Make the program print the 3 lines below. Do not change \`openFile\` or the generator body.`,
      code: `import { Effect } from "effect"

const openFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return name
    }),
    (name) => Effect.sync(() => console.log("close", name))
  )

const program = Effect.gen(function* () {
  const file = yield* openFile("notes.txt")
  console.log("reading", file)
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const openFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return name
    }),
    (name) => Effect.sync(() => console.log("close", name))
  )

const program = Effect.gen(function* () {
  const file = yield* openFile("notes.txt")
  console.log("reading", file)
})

Effect.runSync(Effect.scoped(program))
`,
      expectedOutput: `open notes.txt
reading notes.txt
close notes.txt`,
      hints: [
        "Read the error. Which type is 'not assignable to never'? That type is a requirement that nothing satisfied.",
        "Lesson 1: the requirement is Scope. One function makes a scope, runs the effect, and closes the scope.",
        "Wrap it: Effect.runSync(Effect.scoped(program))."
      ],
      explanation: `\`acquireRelease\` registers the release in the *current* scope. So each effect that uses it has \`Scope\` in \`R\`. With that requirement, the compiler says "a cleanup must still run, and no code owns it." \`Effect.scoped\` takes ownership. It makes the scope, runs the program inside, closes the scope after, and removes \`Scope\` from the type. In plain TypeScript, a missing \`finally\` causes no message. Here it is a compile error.`
    },
    {
      id: "resource-management-c2",
      title: "Closed too early",
      task: `The file closes before the program uses it. Move 1 call so that the output is \`open\`, then \`reading\`, then \`close\`.`,
      code: `import { Effect } from "effect"

const openFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return name
    }),
    (name) => Effect.sync(() => console.log("close", name))
  )

const program = Effect.gen(function* () {
  const file = yield* Effect.scoped(openFile("notes.txt"))
  console.log("reading", file)
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const openFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return name
    }),
    (name) => Effect.sync(() => console.log("close", name))
  )

const program = Effect.scoped(Effect.gen(function* () {
  const file = yield* openFile("notes.txt")
  console.log("reading", file)
}))

Effect.runSync(program)
`,
      expectedOutput: `open notes.txt
reading notes.txt
close notes.txt`,
      hints: [
        "Effect.scoped closes the scope as soon as the effect that it wraps finishes. What does it wrap now?",
        "The scope must be at least as large as every use of the resource.",
        "Move Effect.scoped so that it wraps the whole Effect.gen, not only openFile(...)."
      ],
      explanation: `\`Effect.scoped(openFile(...))\` opened a scope, acquired the file, and closed the scope immediately, because the wrapped effect was only the acquisition. The generator then used a file that Effect had already released. The scope defines the lifetime, so it must enclose every use. This is the same error as a resource returned out of a \`using\` block or a \`with\` statement in other languages. It compiles without errors, so keep this rule in mind: \`scoped\` goes around the region of use.`
    },
    {
      id: "resource-management-c3",
      title: "The finalizer that was never added",
      task: `The program must print \`cleanup\` after \`work\`, but only \`work\` appears. It compiles without errors. Find the missing keyword.`,
      code: `import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function* () {
  Effect.addFinalizer(() => Effect.sync(() => console.log("cleanup")))
  console.log("work")
}))

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.sync(() => console.log("cleanup")))
  console.log("work")
}))

Effect.runSync(program)
`,
      expectedOutput: `work
cleanup`,
      hints: [
        "Effect.addFinalizer returns an effect. An effect that does not run does nothing.",
        "Getting Started: which keyword runs an effect inside Effect.gen?",
        "Put yield* in front of Effect.addFinalizer(...)."
      ],
      explanation: `\`Effect.addFinalizer(...)\` builds a description: "register this cleanup." Like every effect, it does nothing until it runs. Inside a generator, that means \`yield*\`. This error is dangerous because TypeScript accepts an unused expression on its own line, so no error appears. When an effect seems to do nothing, check for a missing \`yield*\` first.`
    },
    {
      id: "resource-management-c4",
      title: "Close it on the way out too",
      task: `When the write fails, the file never closes. Change the structure so that the close is guaranteed. The program must print \`open\`, \`close\`, then \`failed: disk full\`, in that order. Keep the \`Effect.fail\`.`,
      code: `import { Cause, Effect, Exit } from "effect"

const open = (name: string) =>
  Effect.sync(() => {
    console.log("open", name)
    return name
  })

const close = (name: string) => Effect.sync(() => console.log("close", name))

const program = Effect.scoped(Effect.gen(function* () {
  const file = yield* open("report.csv")
  yield* Effect.fail("disk full")
  yield* close(file)
}))

const exit = Effect.runSyncExit(program)
if (Exit.isFailure(exit)) {
  console.log("failed:", Cause.squash(exit.cause))
}
`,
      solution: `import { Cause, Effect, Exit } from "effect"

const open = (name: string) =>
  Effect.sync(() => {
    console.log("open", name)
    return name
  })

const close = (name: string) => Effect.sync(() => console.log("close", name))

const program = Effect.scoped(Effect.gen(function* () {
  const file = yield* Effect.acquireRelease(open("report.csv"), close)
  yield* Effect.fail("disk full")
}))

const exit = Effect.runSyncExit(program)
if (Exit.isFailure(exit)) {
  console.log("failed:", Cause.squash(exit.cause))
}
`,
      expectedOutput: `open report.csv
close report.csv
failed: disk full`,
      hints: [
        "yield* Effect.fail stops the generator. The generator skips every line after it, and that includes the close.",
        "Lesson 1: attach the close to the open. Then the scope runs the close in every case, whatever way the generator ends.",
        "const file = yield* Effect.acquireRelease(open(\"report.csv\"), close), and remove the manual close line."
      ],
      explanation: `A close written as a normal step runs only when control reaches it. A failure never gets there. \`Effect.acquireRelease(open, close)\` registers \`close\` in the scope at the moment the file opens. So the scope runs \`close\` when the generator exits with a failure. The plain-TypeScript equivalent moves \`close\` into a \`finally\`. Here, the pair lives with the resource, and every caller gets it.`
    },
    {
      id: "resource-management-c5",
      title: "A release that can fail",
      task: `A socket close can throw, so the release wraps it in \`Effect.try\`. Now the program does not compile: a finalizer is not permitted to fail. Correct the release so that the code compiles and prints \`open\`, \`send\`, \`close\`.`,
      code: `import { Effect } from "effect"

const socket = {
  close: () => console.log("close socket")
}

const openSocket = Effect.acquireRelease(
  Effect.sync(() => {
    console.log("open socket")
    return socket
  }),
  (s) => Effect.try({ try: () => s.close(), catch: () => "close failed" })
)

const program = Effect.scoped(Effect.gen(function* () {
  yield* openSocket
  console.log("send packet")
}))

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const socket = {
  close: () => console.log("close socket")
}

const openSocket = Effect.acquireRelease(
  Effect.sync(() => {
    console.log("open socket")
    return socket
  }),
  (s) => Effect.try({ try: () => s.close(), catch: () => "close failed" }).pipe(Effect.ignore)
)

const program = Effect.scoped(Effect.gen(function* () {
  yield* openSocket
  console.log("send packet")
}))

Effect.runSync(program)
`,
      expectedOutput: `open socket
send packet
close socket`,
      hints: [
        "Read the error: the release must be an effect whose error type is never. Effect.try produces a string error.",
        "Decide what a failed close means. For a cleanup, to ignore it and continue is a reasonable choice.",
        "Add .pipe(Effect.ignore) to the Effect.try. Use Effect.orDie instead if a failed close must count as a bug."
      ],
      explanation: `The release type is \`Effect<unknown, never, R>\`. It must not fail. This is intentional. A finalizer runs while the program already exits, possibly because of another error, and there is no correct place for a second error. So Effect makes you decide before: \`Effect.ignore\` discards the failure, and \`Effect.orDie\` changes it into a defect that stops the program. Both give the finalizer the error type \`never\`, which the compiler asked for.`
    },
    {
      id: "resource-management-c6",
      title: "ensuring cannot see the result",
      task: `The audit line must say \`audit: ok\` after a success and \`audit: failed\` after a failure. Now both runs print \`audit: done\`. Change the operator so that the cleanup can see the outcome.`,
      code: `import { Effect, Exit } from "effect"

const audited = (effect: Effect.Effect<void, string>) =>
  effect.pipe(
    Effect.ensuring(Effect.sync(() => console.log("audit: done")))
  )

Effect.runSyncExit(audited(Effect.sync(() => console.log("saved"))))
Effect.runSyncExit(audited(Effect.fail("not saved")))
`,
      solution: `import { Effect, Exit } from "effect"

const audited = (effect: Effect.Effect<void, string>) =>
  effect.pipe(
    Effect.onExit((exit) => Effect.sync(() => console.log("audit:", Exit.isSuccess(exit) ? "ok" : "failed")))
  )

Effect.runSyncExit(audited(Effect.sync(() => console.log("saved"))))
Effect.runSyncExit(audited(Effect.fail("not saved")))
`,
      expectedOutput: `saved
audit: ok
audit: failed`,
      hints: [
        "See the table in lesson 3: which function always runs and also receives the Exit?",
        "The callback gets an Exit. Exit.isSuccess(exit) tells the 2 cases apart.",
        "Effect.onExit((exit) => Effect.sync(() => console.log(\"audit:\", Exit.isSuccess(exit) ? \"ok\" : \"failed\")))."
      ],
      explanation: `\`Effect.ensuring\` takes a fixed effect, so it cannot depend on the result. \`Effect.onExit\` takes a function from \`Exit\` to an effect. It runs in the same situations, but it can examine the outcome. Effect guarantees that both run after the wrapped effect starts. When the cleanup is identical in both cases, \`ensuring\` is easier to read. When you need a flag variable to remember what happened, change to \`onExit\`.`
    }
  ],
  problems: [
    {
      id: "resource-management-p1",
      title: "Transactions that commit or roll back",
      spec: `
Write a \`transaction\` resource and a \`withTransaction(work)\` helper.

1. Build \`transaction\` with \`Effect.acquireRelease\`. The acquire prints \`begin\` and returns \`{ id: number }\` from a module-level counter that starts at 1. The release reads the \`Exit\`. It prints \`commit <id>\` on success and \`rollback <id>\` in all other cases.
2. \`withTransaction(work)\` takes a function from the transaction to an effect. It runs the function inside its own scope with the transaction, and returns the result. Its type must not have \`Scope\` in \`R\`.
3. Run 2 orders. Order 1 inserts and succeeds. Order 2 inserts and then fails with \`"card declined"\`. Use \`Effect.runSyncExit\` and \`Cause.squash\` to print the error.

Exact output:

\`\`\`
begin
insert order 1 in tx 1
commit 1
begin
insert order 2 in tx 2
rollback 2
error: card declined
\`\`\`
`,
      starter: `import { Cause, Effect, Exit } from "effect"

interface Tx {
  readonly id: number
}

let nextId = 1

// TODO: transaction = Effect.acquireRelease(begin, (tx, exit) => commit or rollback)

// TODO: withTransaction(work: (tx: Tx) => Effect<A, E>) => Effect<A, E>  (no Scope in R)

const placeOrder = (order: number, ok: boolean) =>
  Effect.gen(function* () {
    // TODO: use withTransaction: print "insert order <n> in tx <id>", then fail with "card declined" if !ok
  })

Effect.runSyncExit(placeOrder(1, true))
const exit = Effect.runSyncExit(placeOrder(2, false))
// TODO: print "error: <message>" when exit is a failure
`,
      solution: `import { Cause, Effect, Exit } from "effect"

interface Tx {
  readonly id: number
}

let nextId = 1

const transaction = Effect.acquireRelease(
  Effect.sync((): Tx => {
    console.log("begin")
    return { id: nextId++ }
  }),
  (tx, exit) => Effect.sync(() => console.log(Exit.isSuccess(exit) ? "commit " + tx.id : "rollback " + tx.id))
)

const withTransaction = <A, E>(work: (tx: Tx) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.scoped(Effect.gen(function* () {
    const tx = yield* transaction
    return yield* work(tx)
  }))

const placeOrder = (order: number, ok: boolean) =>
  withTransaction((tx) =>
    Effect.gen(function* () {
      console.log("insert order " + order + " in tx " + tx.id)
      if (!ok) {
        yield* Effect.fail("card declined")
      }
    })
  )

Effect.runSyncExit(placeOrder(1, true))
const exit = Effect.runSyncExit(placeOrder(2, false))
if (Exit.isFailure(exit)) {
  console.log("error:", Cause.squash(exit.cause))
}
`,
      expectedOutput: `begin
insert order 1 in tx 1
commit 1
begin
insert order 2 in tx 2
rollback 2
error: card declined`,
      hints: [
        "The release callback receives (tx, exit). Exit.isSuccess(exit) selects commit or rollback.",
        "withTransaction wraps an Effect.gen in Effect.scoped: yield* transaction, then return yield* work(tx). Effect.scoped removes Scope from R.",
        "The release runs when the scope closes. So a failure inside work still reaches the release, as an Exit.Failure."
      ]
    },
    {
      id: "resource-management-p2",
      title: "One connection, many requests",
      spec: `
Build a \`Database\` service whose connection lives as long as the app. Build a request handler that takes a short-lived lock for each request.

1. \`Database\` has \`query(sql): Effect<string>\`. \`DatabaseLive\` is a \`Layer.effect\` that acquires a connection with \`Effect.acquireRelease\`. The acquire prints \`connect\`. The release prints \`disconnect\`. \`query\` returns \`"result of <sql>"\`.
2. \`lock(request)\` is an \`Effect.acquireRelease\`. It prints \`[<request>] lock\` on acquire and \`[<request>] unlock\` on release.
3. \`handle(request)\` runs in its own scope. It takes the lock, queries \`"select <request>"\`, and prints \`[<request>] <result>\`.
4. \`app\` handles requests 1 and 2, then prints \`all done\`. Provide \`DatabaseLive\` once and run with \`Effect.runPromise\`.

Exact output:

\`\`\`
connect
[1] lock
[1] result of select 1
[1] unlock
[2] lock
[2] result of select 2
[2] unlock
all done
disconnect
\`\`\`
`,
      starter: `import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

// TODO: DatabaseLive with Layer.effect + Effect.acquireRelease (connect / disconnect)

// TODO: lock(request) with Effect.acquireRelease ("[n] lock" / "[n] unlock")

// TODO: handle(request): scoped; lock, query "select <n>", print "[n] <result>"

const app = Effect.gen(function* () {
  // TODO: handle 1, handle 2, print "all done"
})

// TODO: provide DatabaseLive and run with Effect.runPromise
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => console.log("connect")),
      () => Effect.sync(() => console.log("disconnect"))
    )
    return { query: (sql) => Effect.succeed("result of " + sql) }
  })
)

const lock = (request: number) =>
  Effect.acquireRelease(
    Effect.sync(() => console.log("[" + request + "] lock")),
    () => Effect.sync(() => console.log("[" + request + "] unlock"))
  )

const handle = (request: number) =>
  Effect.scoped(Effect.gen(function* () {
    const db = yield* Database
    yield* lock(request)
    const result = yield* db.query("select " + request)
    console.log("[" + request + "]", result)
  }))

const app = Effect.gen(function* () {
  yield* handle(1)
  yield* handle(2)
  console.log("all done")
})

Effect.runPromise(app.pipe(Effect.provide(DatabaseLive)))
`,
      expectedOutput: `connect
[1] lock
[1] result of select 1
[1] unlock
[2] lock
[2] result of select 2
[2] unlock
all done
disconnect`,
      hints: [
        "Inside the build effect of Layer.effect, yield* Effect.acquireRelease(...). Layer.effect provides the scope, so the R of the layer stays never.",
        "Each handle(request) is Effect.scoped(Effect.gen(...)). The lock is released when that inner scope closes, not when the app ends.",
        "The disconnect prints last because the scope of the layer closes after the provided program finishes."
      ]
    },
    {
      id: "resource-management-p3",
      title: "Cancel a download and clean up",
      spec: `
A download writes to a \`.part\` file. If the download is interrupted, the program must remove the partial file.

1. \`partFile(name)\` is an \`Effect.acquireRelease\`. The acquire prints \`create <name>.part\` and returns the path. The release reads the \`Exit\`. It prints \`remove <name>.part (cancelled)\` if \`Exit.hasInterrupts(exit)\` is true. In all other cases, it prints \`keep <name>.part\`.
2. \`download(name)\` is scoped. It makes the part file, prints \`downloading <name>\`, then sleeps for 1 second, then prints \`finished <name>\`. The last line must never appear in the output.
3. \`main\` forks \`download("big.iso")\` with \`Effect.forkChild\`, sleeps 10 milliseconds, prints \`timeout, cancelling\`, interrupts the fiber with \`Fiber.interrupt\`, and prints \`main done\`.

Exact output:

\`\`\`
create big.iso.part
downloading big.iso
timeout, cancelling
remove big.iso.part (cancelled)
main done
\`\`\`
`,
      starter: `import { Effect, Exit, Fiber } from "effect"

// TODO: partFile(name): acquireRelease; release prints "remove <name>.part (cancelled)" or "keep <name>.part"

// TODO: download(name): scoped; create part file, print "downloading <name>", sleep 1 second, print "finished <name>"

const main = Effect.gen(function* () {
  // TODO: fork the download, sleep 10 millis, print "timeout, cancelling", interrupt it, print "main done"
})

Effect.runPromise(main)
`,
      solution: `import { Effect, Exit, Fiber } from "effect"

const partFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("create " + name + ".part")
      return name + ".part"
    }),
    (path, exit) =>
      Effect.sync(() => console.log(Exit.hasInterrupts(exit) ? "remove " + path + " (cancelled)" : "keep " + path))
  )

const download = (name: string) =>
  Effect.scoped(Effect.gen(function* () {
    yield* partFile(name)
    console.log("downloading " + name)
    yield* Effect.sleep("1 second")
    console.log("finished " + name)
  }))

const main = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(download("big.iso"))
  yield* Effect.sleep("10 millis")
  console.log("timeout, cancelling")
  yield* Fiber.interrupt(fiber)
  console.log("main done")
})

Effect.runPromise(main)
`,
      expectedOutput: `create big.iso.part
downloading big.iso
timeout, cancelling
remove big.iso.part (cancelled)
main done`,
      hints: [
        "Effect.forkChild returns a Fiber. Fiber.interrupt(fiber) stops it and waits for its finalizers to finish.",
        "The second argument of the release callback is the Exit. Exit.hasInterrupts(exit) is true when the fiber was interrupted.",
        "The forked fiber runs its first steps as soon as main sleeps. This is why the 2 download lines appear before the timeout line."
      ]
    }
  ],
  recall: [
    {
      q: "Why is `try`/`finally` not sufficient when 2 resources are involved?",
      a: "If the second acquire is outside the `try`, a failure there leaves the first resource open. If it is inside the `try`, the `finally` must check which resources are open. You maintain the close list by hand at every call site, in reverse order. A Promise cannot be cancelled, so a timeout leaves everything open."
    },
    {
      q: "What is the type of `Effect.acquireRelease(Effect.succeed(handle), (h) => Effect.void)`, if `handle` is a `Handle`?",
      a: "`Effect<Handle, never, Scope>`. The `Scope` in `R` means that a release must still run. Some code must close the scope, usually `Effect.scoped` or a `Layer.effect`."
    },
    {
      q: "Which function runs a fixed cleanup after 1 effect, whatever the outcome? Which function do you use if the cleanup must know if the effect succeeded?",
      a: "`Effect.ensuring(cleanup)` for a fixed cleanup. `Effect.onExit((exit) => ...)` when the cleanup needs the outcome, for example commit or rollback."
    },
    {
      q: "A scope acquires 3 resources in the order A, B, C. In what order does it release them?",
      a: "C, B, A. The scope is a stack: the last release registered runs first. `Effect.addFinalizer` pushes onto the same stack."
    },
    {
      q: "A fiber holds a resource, and `Fiber.interrupt` interrupts it. Does the release run, and what does it see?",
      a: "Yes. The interrupt closes the scopes of the fiber, so every finalizer runs. The release receives an `Exit.Failure` whose cause contains an interrupt. `Exit.hasInterrupts(exit)` returns true, so the release can tell an interrupt from a failure."
    },
    {
      q: "You want a database connection that opens when the app starts and closes when it stops. The v3 docs say `Layer.scoped`. What do you write in v4?",
      a: "`Layer.effect(Tag, Effect.gen(function* () { const conn = yield* Effect.acquireRelease(open, close); return { ... } }))`. In v4, `Layer.effect` already provides a scope to the build effect and removes `Scope` from the requirements of the layer. There is no separate `Layer.scoped`."
    },
    {
      q: "When is `Effect.acquireUseRelease` the better choice, compared to `acquireRelease` plus `scoped`?",
      a: "When the whole life of the resource is in 1 place: open, use, close, and nothing else needs it. It closes the resource as soon as `use` finishes and leaves no `Scope` in `R`. Use `acquireRelease` with a scope when several steps share the resource or a layer owns it."
    }
  ]
}

export default section
