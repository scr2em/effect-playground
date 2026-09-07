import type { Section } from "../types.ts"

const section: Section = {
  id: "resource-management",
  title: "Resource Management",
  order: 4,
  summary: "Scopes and finalizers: closing is attached to acquiring, and the runtime guarantees it on success, failure, and interruption.",
  intro: `
**The problem.** Anything you open must be closed: files, sockets, database connections, locks, temp directories. Plain TypeScript gives you \`try\`/\`finally\`, and it looks fine for one resource:

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

Three holes. The second \`open\` sits outside the \`try\`, so a failure there leaks the first resource. The \`finally\` block is a hand-maintained list that every caller of \`connect\` has to repeat, in the right order. And a Promise cannot be cancelled: if a timeout gives up on \`report()\`, the function keeps running with no way to tell it to clean up now. Nothing in the signature \`report(): Promise<void>\` says a resource is involved at all.

### The shift

Today you think of cleanup as **something to remember at every use site**. Effect asks you to think of it as **part of the acquisition**. \`Effect.acquireRelease(open, close)\` pairs the two once, where the resource is defined. Using the resource adds a requirement, \`Scope\`, to the type, so the compiler knows a cleanup is pending. \`Effect.scoped\` marks the region where the resource lives; when that region ends, for any reason, the runtime runs every registered finalizer in reverse order and hands each one the outcome.

The payoff is that resource safety stops depending on discipline. A function that acquires three resources and fails on the fourth line closes exactly the three it opened. A fiber interrupted by a timeout still closes its files. A database connection opened by a Layer is closed when the application shuts down. You write the close once, and the runtime carries the guarantee.

| | \`try\`/\`finally\` | Effect |
|---|---|---|
| Where the cleanup lives | At every call site | Next to the acquire, once |
| Two resources | Nested try blocks, or a manual list | Two \`yield*\`, released in reverse automatically |
| Acquire fails halfway | Earlier resources leak unless you nest carefully | Only what was acquired is released |
| Cancellation | Not possible for a Promise | Interruption runs finalizers |
| Cleanup knows the outcome | No, \`finally\` is blind | Yes, the finalizer receives the \`Exit\` |
| Visible in the type | No | Yes, \`Scope\` in \`R\` until \`Effect.scoped\` |

In this section you will pair acquire with release, see the reverse order, read the \`Exit\` inside a finalizer, use the short form for the simple case, watch interruption clean up, and attach a resource to a Layer.
`,
  lessons: [
    {
      id: "resource-management-l1",
      title: "Acquire and release, together",
      explain: `
Start with the leak. In plain TypeScript the close is separate from the open, so the two drift apart:

\`\`\`ts
const file = await openFile("a.txt")
const data = await read(file)          // throws? file is never closed
await file.close()
\`\`\`

\`Effect.acquireRelease(acquire, release)\` glues them together into one value. Yielding it gives you the resource *and* registers the release with the current **Scope**, a container of pending cleanups. That is why the type of \`openFile\` ends in \`Scope\`: it means "a cleanup is waiting somewhere."

\`Effect.scoped\` creates the scope, runs the effect inside it, then closes the scope, which runs the release. It also removes \`Scope\` from \`R\`. Without it the program does not compile, because nobody has promised to close what was opened.
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
      after: `Notice "close" prints before "result": the scope closes when \`program\` finishes, before the value reaches \`runSync\`. Try removing \`Effect.scoped\`: the compiler says \`Type 'Scope' is not assignable to type 'never'\`. The pending cleanup is visible in the type until something promises to run it.`
    },
    {
      id: "resource-management-l2",
      title: "Finalizers run in reverse",
      explain: `
A scope is a stack. Each \`acquireRelease\` pushes a release onto it, and closing the scope pops them off, so the last thing opened is the first thing closed. This is the order you would write by hand in a careful \`finally\` block, and here it is automatic.

\`Effect.addFinalizer\` pushes cleanup onto the scope without a resource attached. Use it for "when this region ends, also do X": flush a buffer, log a summary, delete a temp directory. It is the lowest-level piece; \`acquireRelease\` is built on the same idea.

| Function | Pushes onto the scope | Gives you back |
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
      after: `"flush metrics" was added last, so it runs first. Reverse order matters when resources depend on each other: the cache may need the database to flush, so the cache must close first. You never wrote that order; it came from the order of acquisition.`
    },
    {
      id: "resource-management-l3",
      title: "The finalizer sees how it ended: Exit",
      explain: `
A \`finally\` block is blind. It does not know whether the work succeeded or blew up, so "commit on success, roll back on failure" needs a flag variable. Effect finalizers receive the **Exit**: a plain value that is \`Success\` with a \`value\`, or \`Failure\` with a \`cause\`. The release function of \`acquireRelease\` gets it as its second argument.

Sometimes you do not have a resource, only one effect that needs cleanup attached. Effect has a small family for that. Pick by what the cleanup needs to know:

| Function | Runs when | Sees | Use when |
|---|---|---|---|
| \`Effect.ensuring(cleanup)\` | Always | Nothing | Cleanup is the same no matter what |
| \`Effect.onExit((exit) => ...)\` | Always | The \`Exit\` | Cleanup depends on the outcome |
| \`Effect.onError((cause) => ...)\` | Failure or interrupt | The \`Cause\` | Only failures need work |
| \`Effect.onInterrupt(() => ...)\` | Interrupt only | Nothing | React to cancellation |
| \`Effect.acquireRelease\` | Scope closes | Resource and \`Exit\` | You hold a resource |

All of them are guaranteed to run once the effect has started, whatever happens next.
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
      after: `The failure in the second run did not reach the finalizer as an exception; it arrived as data, \`Exit.Failure\`, and the release chose "rollback". Replace \`Effect.onExit\` with \`Effect.ensuring(Effect.sync(() => console.log(label + ": done")))\` to see the blind version.`
    },
    {
      id: "resource-management-l4",
      title: "acquireUseRelease for the simple case",
      explain: `
When the whole life of a resource fits in one place, open, use, close, you do not need a scope at all. \`Effect.acquireUseRelease(acquire, use, release)\` is the direct translation of the \`try\`/\`finally\` you know, with two upgrades: the release sees the \`Exit\`, and the acquire cannot be interrupted halfway.

\`\`\`ts
// Plain TypeScript
const conn = await connect()
try {
  return await conn.query("select 1")
} finally {
  await conn.close()
}
\`\`\`

The Effect version is the same three parts as arguments. No \`Scope\` appears in \`R\`, because the function itself closes the resource as soon as \`use\` finishes. Reach for \`acquireRelease\` plus \`scoped\` instead when the resource must outlive one function, for example when it is shared by several steps or held by a Layer.
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
      after: `Add \`yield* Effect.fail("timeout")\` inside \`use\` and run with \`runSyncExit\`: the close line prints "(after error)" and still runs. That is the guarantee \`try\`/\`finally\` gives you for one resource, now with the outcome included.`
    },
    {
      id: "resource-management-l5",
      title: "Interruption still releases",
      explain: `
A Promise cannot be cancelled. If a request times out, the underlying work keeps running and keeps its connection open until it finishes on its own. Effect programs run on **fibers**, and a fiber can be interrupted: from the outside with \`Fiber.interrupt\`, or from the inside with \`Effect.interrupt\`. Either way the fiber stops at its next step, and every finalizer it registered runs.

Interruption is not a failure. The \`Exit\` a finalizer receives is a \`Failure\` whose cause contains an interrupt reason. \`Exit.hasInterrupts(exit)\` tells the two apart, so a finalizer can log "cancelled" instead of "crashed".

The program below shows both directions. First a job interrupts itself while holding a lock. Then the main fiber forks a second job with \`Effect.forkChild\`, waits a few milliseconds, and cancels it with \`Fiber.interrupt\`. Both locks are released.
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
      after: `\`Fiber.interrupt\` waits until the interrupted fiber has finished its finalizers, which is why "unlock B" prints before "main: done". Concurrency and timeouts are built on this: \`Effect.timeout\` is an interruption, and every resource the timed-out work held is released.`
    },
    {
      id: "resource-management-l6",
      title: "Scoped layers: a connection for the whole app",
      explain: `
A database connection should be opened once when the app starts and closed once when it ends. That is a resource whose scope is the Layer. In v4 there is no separate \`Layer.scoped\`: \`Layer.effect\` already provides a scope to its build effect and removes \`Scope\` from the layer's requirements. So the recipe is \`Layer.effect\` with \`Effect.acquireRelease\` inside.

The layer's scope stays open for as long as the program that \`Effect.provide\` wraps is running. When that program finishes, the layer is torn down and the release runs. Meanwhile, each request can open its own short-lived resources with a nested \`Effect.scoped\`; those close at the end of the request, long before the connection does.

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
      after: `"db: disconnect" comes after "app: all requests done": the layer outlives every request and closes when the provided program ends. Remove the \`Effect.scoped\` inside \`handle\` and the compiler reports \`Scope\` in \`R\` at \`runPromise\`. The per-request cleanup has to belong to someone.`
    }
  ],
  challenges: [
    {
      id: "resource-management-c1",
      title: "Nobody promised to close it",
      task: `The program opens a file and does not compile. Something has to own the cleanup. Make it print the three lines below without changing \`openFile\` or the generator body.`,
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
        "Read the error: which type is 'not assignable to never'? That is a requirement nobody satisfied.",
        "Lesson 1: the requirement is Scope. One function creates a scope, runs the effect, and closes it.",
        "Wrap it: Effect.runSync(Effect.scoped(program))."
      ],
      explanation: `\`acquireRelease\` registers the release in the *current* scope, so anything that uses it carries \`Scope\` in \`R\`. That requirement is the compiler's way of saying "a cleanup is pending and nobody has taken responsibility." \`Effect.scoped\` takes responsibility: it creates the scope, runs the program inside, closes the scope afterwards, and removes \`Scope\` from the type. In plain TypeScript a forgotten \`finally\` is silent; here it is a compile error.`
    },
    {
      id: "resource-management-c2",
      title: "Closed too early",
      task: `The file is closed before it is used. Move one call so the output is \`open\`, then \`reading\`, then \`close\`.`,
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
        "Effect.scoped closes the scope as soon as the effect it wraps finishes. What does it wrap right now?",
        "The scope must be at least as large as every use of the resource.",
        "Move Effect.scoped so it wraps the whole Effect.gen, not only openFile(...)."
      ],
      explanation: `\`Effect.scoped(openFile(...))\` opened a scope, acquired the file, and closed the scope immediately, because the wrapped effect was only the acquisition. The generator then used a file that had already been released. The scope defines the lifetime, so it has to enclose every use. This is the same mistake as returning a handle out of a \`using\` block or a \`with\` statement in other languages, and it compiles fine, so keep the rule in mind: \`scoped\` goes around the region of use.`
    },
    {
      id: "resource-management-c3",
      title: "The finalizer that was never added",
      task: `The program is supposed to print \`cleanup\` after \`work\`, but only \`work\` appears. It compiles without errors. Find the missing keyword.`,
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
        "Effect.addFinalizer returns an Effect. An Effect that is not run does nothing.",
        "Getting Started: what keyword runs an Effect inside Effect.gen?",
        "Put yield* in front of Effect.addFinalizer(...)."
      ],
      explanation: `\`Effect.addFinalizer(...)\` builds a description of "register this cleanup." Like every Effect, it does nothing until it runs, and inside a generator that means \`yield*\`. This one is dangerous precisely because TypeScript accepts an unused expression on its own line, so no error appears. When an Effect seems to have no effect, check for a missing \`yield*\` first.`
    },
    {
      id: "resource-management-c4",
      title: "Close it on the way out too",
      task: `When the write fails, the file is never closed. Restructure so the close is guaranteed and the program prints \`open\`, \`close\`, then \`failed: disk full\`, in that order. Keep the \`Effect.fail\`.`,
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
        "yield* Effect.fail stops the generator. Every line after it, including the close, is skipped.",
        "Lesson 1: attach the close to the open so the scope runs it no matter how the generator ends.",
        "const file = yield* Effect.acquireRelease(open(\"report.csv\"), close), and delete the manual close line."
      ],
      explanation: `A close written as a normal step only runs when control reaches it, and a failure never gets there. \`Effect.acquireRelease(open, close)\` registers \`close\` in the scope at the moment the file is opened, so the scope runs it when the generator exits by failure. The plain-TypeScript equivalent is moving \`close\` into a \`finally\`, except this time the pairing lives with the resource, and every caller inherits it.`
    },
    {
      id: "resource-management-c5",
      title: "A release that can fail",
      task: `Closing a socket may throw, so the release wraps it in \`Effect.try\`. Now the program does not compile: a finalizer is not allowed to fail. Fix the release so the code compiles and prints \`open\`, \`send\`, \`close\`.`,
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
        "Read the error: the release must be an Effect whose error type is never. Effect.try produces a string error.",
        "Decide what a failed close should mean. Ignoring it and moving on is a reasonable choice for cleanup.",
        "Append .pipe(Effect.ignore) to the Effect.try (or Effect.orDie if a failed close should be treated as a bug)."
      ],
      explanation: `The release type is \`Effect<unknown, never, R>\`: it may not fail. That is deliberate. A finalizer runs while the program is already on its way out, possibly because of another error, and there is no sensible place for a second error to go. So Effect forces you to decide up front: \`Effect.ignore\` swallows it, \`Effect.orDie\` turns it into a defect that crashes loudly. Both give the finalizer the error type \`never\`, which is what the compiler asked for.`
    },
    {
      id: "resource-management-c6",
      title: "ensuring cannot see the result",
      task: `The audit line must say \`audit: ok\` after a success and \`audit: failed\` after a failure. Right now both runs print \`audit: done\`. Change the operator so the cleanup can see the outcome.`,
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
        "Lesson 3's table: which function runs always and also receives the Exit?",
        "The callback gets an Exit; Exit.isSuccess(exit) tells the two cases apart.",
        "Effect.onExit((exit) => Effect.sync(() => console.log(\"audit:\", Exit.isSuccess(exit) ? \"ok\" : \"failed\")))."
      ],
      explanation: `\`Effect.ensuring\` takes a fixed effect, so by construction it cannot depend on the result. \`Effect.onExit\` takes a function from \`Exit\` to an effect, which runs in the same situations but can inspect the outcome. Both are guaranteed to run once the wrapped effect starts. When the cleanup is identical either way, \`ensuring\` reads better; the moment you reach for a flag variable to remember what happened, switch to \`onExit\`.`
    }
  ],
  problems: [
    {
      id: "resource-management-p1",
      title: "Transactions that commit or roll back",
      spec: `
Write a \`transaction\` resource and a \`withTransaction(work)\` helper.

1. \`transaction\` is built with \`Effect.acquireRelease\`. Acquiring prints \`begin\` and returns \`{ id: number }\` using a module-level counter starting at 1. The release reads the \`Exit\`: it prints \`commit <id>\` on success and \`rollback <id>\` otherwise.
2. \`withTransaction(work)\` takes a function from the transaction to an effect, runs it inside its own scope with the transaction, and returns the result. Its type must not have \`Scope\` in \`R\`.
3. Run two orders. Order 1 inserts and succeeds. Order 2 inserts and then fails with \`"card declined"\`. Use \`Effect.runSyncExit\` and \`Cause.squash\` to print the error.

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
        "The release callback receives (tx, exit). Exit.isSuccess(exit) picks commit versus rollback.",
        "withTransaction wraps an Effect.gen in Effect.scoped: yield* transaction, then return yield* work(tx). Effect.scoped removes Scope from R.",
        "Because the release runs when the scope closes, a failure inside work still reaches it, as an Exit.Failure."
      ]
    },
    {
      id: "resource-management-p2",
      title: "One connection, many requests",
      spec: `
Build a \`Database\` service whose connection lives as long as the app, and a request handler that takes a short-lived lock per request.

1. \`Database\` has \`query(sql): Effect<string>\`. \`DatabaseLive\` is a \`Layer.effect\` that acquires a connection with \`Effect.acquireRelease\`: acquiring prints \`connect\`, releasing prints \`disconnect\`. \`query\` returns \`"result of <sql>"\`.
2. \`lock(request)\` is an \`Effect.acquireRelease\` that prints \`[<request>] lock\` on acquire and \`[<request>] unlock\` on release.
3. \`handle(request)\` runs in its own scope: takes the lock, queries \`"select <request>"\`, prints \`[<request>] <result>\`.
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
        "Inside the Layer.effect build effect, yield* Effect.acquireRelease(...). Layer.effect supplies the scope, so the layer's R stays never.",
        "Each handle(request) is Effect.scoped(Effect.gen(...)); the lock is released when that inner scope closes, not when the app ends.",
        "The disconnect prints last because the layer's scope closes after the provided program finishes."
      ]
    },
    {
      id: "resource-management-p3",
      title: "Cancel a download and clean up",
      spec: `
A download writes to a \`.part\` file. If the download is cancelled, the partial file must be removed.

1. \`partFile(name)\` is an \`Effect.acquireRelease\`. Acquiring prints \`create <name>.part\` and returns the path. The release reads the \`Exit\`: it prints \`remove <name>.part (cancelled)\` if \`Exit.hasInterrupts(exit)\`, otherwise \`keep <name>.part\`.
2. \`download(name)\` is scoped: it creates the part file, prints \`downloading <name>\`, then sleeps for 1 second, then prints \`finished <name>\` (which must never appear in the output).
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
        "The release callback's second argument is the Exit. Exit.hasInterrupts(exit) is true when the fiber was interrupted.",
        "The forked fiber runs its first steps as soon as main sleeps, which is why the two download lines appear before the timeout line."
      ]
    }
  ],
  recall: [
    {
      q: "Why does `try`/`finally` stop being enough once two resources are involved?",
      a: "The second acquire either sits outside the `try` (and a failure there leaks the first resource) or inside it (and the `finally` has to check what was actually opened). The close list is maintained by hand at every call site, in reverse order, and a Promise cannot be cancelled, so a timeout leaves everything open."
    },
    {
      q: "What would the type of `Effect.acquireRelease(Effect.succeed(handle), (h) => Effect.void)` be, if `handle` is a `Handle`?",
      a: "`Effect<Handle, never, Scope>`. The `Scope` in `R` means a release is pending and something must close the scope, usually `Effect.scoped` or a `Layer.effect`."
    },
    {
      q: "Which function would you reach for to run a fixed cleanup after one effect no matter how it ends, and which one if the cleanup must know whether it succeeded?",
      a: "`Effect.ensuring(cleanup)` for a fixed cleanup. `Effect.onExit((exit) => ...)` when the cleanup needs the outcome, for example commit versus rollback."
    },
    {
      q: "Three resources are acquired in a scope in the order A, B, C. In what order are they released?",
      a: "C, B, A. The scope is a stack: the last release registered runs first. `Effect.addFinalizer` pushes onto the same stack."
    },
    {
      q: "A fiber holding a resource is interrupted with `Fiber.interrupt`. Does the release run, and what does it see?",
      a: "Yes. Interruption closes the fiber's scopes, so every finalizer runs. The release receives an `Exit.Failure` whose cause contains an interrupt; `Exit.hasInterrupts(exit)` returns true, which lets it tell cancellation from a crash."
    },
    {
      q: "You want a database connection opened when the app starts and closed when it ends. v3 docs say `Layer.scoped`. What do you write in v4?",
      a: "`Layer.effect(Tag, Effect.gen(function* () { const conn = yield* Effect.acquireRelease(open, close); return { ... } }))`. In v4 `Layer.effect` already provides a scope to the build effect and removes `Scope` from the layer's requirements, so there is no separate `Layer.scoped`."
    },
    {
      q: "When is `Effect.acquireUseRelease` the better choice over `acquireRelease` plus `scoped`?",
      a: "When the whole life of the resource fits in one place: open, use, close, and nothing else needs it. It closes as soon as `use` finishes and leaves no `Scope` in `R`. Use `acquireRelease` with a scope when the resource must be shared across steps or owned by a Layer."
    }
  ]
}

export default section
