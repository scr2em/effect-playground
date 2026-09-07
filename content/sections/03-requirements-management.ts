import type { Section } from "../types.ts"

const section: Section = {
  id: "requirements-management",
  title: "Requirements Management",
  order: 3,
  summary: "Services, the R channel, and Layers: dependencies tracked by the compiler and satisfied once at the edge.",
  intro: `
**The problem.** Every real program needs things it did not create: a database, a logger, a clock, config. Plain TypeScript gives you three ways to get them, and each one hurts.

\`\`\`ts
// 1. Pass everything down, five levels deep
async function placeOrder(order: Order, db: Database, logger: Logger, config: Config) {
  return chargeCard(order, db, logger, config)   // chargeCard passes them on again...
}

// 2. Reach for a module-level singleton
import { db } from "./db"                      // connects the moment the file is imported
async function placeOrder(order: Order) { return db.insert(order) }   // untestable

// 3. Ask a DI container by name at runtime
const db = container.resolve<Database>("Database")   // typo in the string? Crashes at startup, or later
\`\`\`

Option 1 turns every signature into a bucket of unrelated arguments. Option 2 hides the dependency completely, so a test cannot swap it and the connection opens at import time. Option 3 checks nothing at compile time. In all three, the question "what does this function need in order to run?" has no answer in the type.

### The shift

Today you think of a dependency as **something you pass in or reach out for**. Effect asks you to think of it as **a requirement recorded in the type**. When code reads the \`Database\` service, \`Database\` appears in the third type parameter, \`R\`. When you combine two effects, their requirements are combined. At the very top of the program, \`R\` must be \`never\`, which means every requirement has been satisfied. If one is missing, the program does not compile.

Satisfying a requirement is done once, at the edge, with a **Layer**: a recipe that says how to build a service, possibly from other services. Layers compose into a graph, the graph is built once, and each service in it is constructed a single time and shared.

The payoff: business logic never mentions how a service is built. Swapping a real mailer for a fake one in tests is a one-line change at the edge. Config never travels through five signatures. And the compiler, not a startup crash, tells you what is missing.

| | Arguments | Module singleton | DI container | Effect |
|---|---|---|---|---|
| Visible in the type | Yes, but cluttered | No | No | Yes, in \`R\` |
| Swappable in tests | Yes, painfully | No | Yes | Yes, provide a different Layer |
| Missing dependency found | Compile time | Never | Runtime | Compile time |
| Construction order | Manual | Import order | Container | Derived from the Layer graph |
| Built once and shared | Manual | Yes | Usually | Yes, memoized per graph |

In this section you will define services, read \`R\`, build Layers, wire a small graph, swap implementations, and see memoization in action.
`,
  lessons: [
    {
      id: "requirements-management-l1",
      title: "A requirement shows up in R",
      explain: `
A **service** is two things bundled together: a **tag** (a unique key, used as a value) and a **shape** (the TypeScript type of what the key points to). The class syntax below defines both at once. \`Logger\` the class is the tag, and the object type between the angle brackets is the shape.

Inside \`Effect.gen\`, writing \`yield* Logger\` does two things. At runtime it looks up the implementation. At compile time it adds \`Logger\` to the \`R\` of the surrounding effect. Nothing about *how* to log appears in \`program\`, only *that* it needs a logger.

\`Effect.provideService\` is the one-off way to satisfy a requirement: hand it the tag and an implementation, and \`Logger\` disappears from \`R\`. Only then does \`runSync\` accept the program.
`,
      code: `import { Context, Effect } from "effect"

// The tag is the class. The shape is the object type in the angle brackets.
class Logger extends Context.Service<Logger, {
  readonly log: (message: string) => Effect.Effect<void>
}>()("Logger") {}

// yield* on the tag returns the implementation and records Logger in R
const program = Effect.gen(function* () {
  const logger = yield* Logger
  yield* logger.log("order 42 placed")
  yield* logger.log("receipt emailed")
})
// program: Effect<void, never, Logger>

// Satisfy the requirement once, at the edge. R becomes never.
const runnable = program.pipe(
  Effect.provideService(Logger, {
    log: (message) => Effect.sync(() => console.log("[log]", message))
  })
)

Effect.runSync(runnable)
`,
      expectedOutput: `[log] order 42 placed
[log] receipt emailed`,
      after: `Try \`Effect.runSync(program)\` instead of \`runnable\`. The compiler answers: \`Type 'Logger' is not assignable to type 'never'\`. That is the R channel doing its job: a missing dependency is a type error, not a crash on the first request.`
    },
    {
      id: "requirements-management-l2",
      title: "Three ways to declare a service",
      explain: `
The class syntax is the default. Two more forms exist for specific situations.

| Form | Write it as | Use when |
|---|---|---|
| Class | \`class Db extends Context.Service<Db, Shape>()("Db") {}\` | Almost always. The class is a clean identifier in \`R\`. |
| Function | \`const Clock = Context.Service<Clock>("Clock")\` | You already have an interface named \`Clock\` and want a one-liner. |
| Reference | \`Context.Reference<T>("Tz", { defaultValue })\` | The service has a sensible default and is only sometimes overridden. |

In the function form the interface itself plays the role of identifier, so \`R\` shows \`Clock\`. Two services with the same string key but different shapes would collide at runtime, so keep keys unique.

A \`Reference\` is the interesting one. Because it always has a default, reading it adds **nothing** to \`R\`. You can run the program without providing it, and you can still override it with \`provideService\` when you want to. Config values and feature flags are the typical use.
`,
      code: `import { Context, Effect } from "effect"

// Function syntax: the interface is the shape, the string is the key
interface Clock {
  readonly now: () => number
}
const Clock = Context.Service<Clock>("Clock")

// A Reference is a service with a default. It never appears in R.
const Timezone = Context.Reference<string>("Timezone", { defaultValue: () => "UTC" })

const program = Effect.gen(function* () {
  const clock = yield* Clock       // adds Clock to R
  const tz = yield* Timezone       // adds nothing to R, the default is used
  console.log("time", clock.now(), "zone", tz)
})
// program: Effect<void, never, Clock>

// Same program, two environments. Overriding the Reference is optional.
Effect.runSync(program.pipe(Effect.provideService(Clock, { now: () => 1000 })))

Effect.runSync(program.pipe(
  Effect.provideService(Clock, { now: () => 2000 }),
  Effect.provideService(Timezone, "Europe/Berlin")
))
`,
      expectedOutput: `time 1000 zone UTC
time 2000 zone Europe/Berlin`,
      after: `Two equivalent ways to read a service, useful outside of \`Effect.gen\`: \`Effect.service(Clock)\` returns the same effect as \`yield* Clock\`, and \`Clock.use((c) => Effect.succeed(c.now()))\` reads it and calls a method in one step. Prefer \`yield*\` in generators, it keeps the requirement visible where it is used.`
    },
    {
      id: "requirements-management-l3",
      title: "Layers: a recipe for building a service",
      explain: `
\`provideService\` takes an implementation you already hold. Real services need to be *built*: read config, open a connection, print a startup line. A **Layer** is an Effect that builds a service. Compare the plain TypeScript \`main\` you have written many times:

\`\`\`ts
async function main() {
  console.log("connecting to database")
  const db = await Database.connect()        // built here, by hand, in the right order
  await runApp(db)                           // and threaded into everything
}
\`\`\`

With Effect the construction becomes a value, \`DatabaseLive\`, and \`Effect.provide\` wires it into the program. Two constructors cover most cases:

| Constructor | Takes | Use when |
|---|---|---|
| \`Layer.succeed(Tag, impl)\` | A plain value | The implementation needs no setup |
| \`Layer.effect(Tag, effect)\` | An Effect that returns the implementation | Setup is needed: config, connections, logging |

Read the type \`Layer<Database, never, never>\` as "provides \`Database\`, cannot fail while building, needs nothing to build."
`,
      code: `import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<Array<string>>
}>()("Database") {}

// Layer.effect: building the service is itself an Effect.
// It runs once, when the layer is built, not on every query.
const DatabaseLive = Layer.effect(
  Database,
  Effect.sync(() => {
    console.log("connecting to database")
    return {
      query: (sql) => Effect.succeed(["row for: " + sql])
    }
  })
)
// DatabaseLive: Layer<Database, never, never>

const program = Effect.gen(function* () {
  const db = yield* Database
  const users = yield* db.query("select * from users")
  const orders = yield* db.query("select * from orders")
  console.log(users[0])
  console.log(orders[0])
})
// program: Effect<void, never, Database>

// Effect.provide plugs the layer in. R becomes never.
Effect.runSync(program.pipe(Effect.provide(DatabaseLive)))
`,
      expectedOutput: `connecting to database
row for: select * from users
row for: select * from orders`,
      after: `"connecting to database" printed once although \`query\` ran twice. The layer's build effect runs when the graph is built, then the same implementation is handed to every \`yield* Database\`. Try replacing \`Layer.effect\` with \`Layer.succeed(Database, { query: ... })\` for a service that needs no setup.`
    },
    {
      id: "requirements-management-l4",
      title: "A graph of layers: provide, provideMerge, merge",
      explain: `
A layer built with \`Layer.effect\` can itself \`yield*\` other services. Those become the layer's own requirements: \`Layer<UserRepo, never, Database>\` means "provides \`UserRepo\`, but needs \`Database\` to be built." Wiring is done bottom-up with three functions.

| Function | Meaning | What the result provides |
|---|---|---|
| \`A.pipe(Layer.provide(B))\` | B feeds A | Only A. B is hidden. |
| \`A.pipe(Layer.provideMerge(B))\` | B feeds A | A and B. |
| \`Layer.merge(A, B)\` | Side by side, no relationship | A and B. |

The graph below is what the code builds. Each arrow is one \`Layer.provide\`, and the top is what \`program\` needs:

\`\`\`
       program        needs: UserRepo, Logger
          |
   +------+------+
   |             |
UserRepoLive   LoggerLive
   |  needs Database
DatabaseLive
   |  needs Config
ConfigLive
\`\`\`

If you forget one arrow, say \`ConfigLive\`, the requirement bubbles up to the top and the compiler reports \`Type 'Config' is not assignable to type 'never'\` at the \`runSync\` call.
`,
      code: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly dbUrl: string }>()("Config") {}
class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<Array<string>>
}>()("Database") {}
class UserRepo extends Context.Service<UserRepo, {
  readonly findName: (id: number) => Effect.Effect<string>
}>()("UserRepo") {}
class Logger extends Context.Service<Logger, {
  readonly log: (message: string) => Effect.Effect<void>
}>()("Logger") {}

const ConfigLive = Layer.succeed(Config, { dbUrl: "postgres://prod" })

// Needs Config: Layer<Database, never, Config>
const DatabaseLive = Layer.effect(Database, Effect.gen(function* () {
  const config = yield* Config
  return {
    query: (sql) => Effect.sync(() => {
      console.log("query on", config.dbUrl + ":", sql)
      return ["Ada"]
    })
  }
}))

// Needs Database: Layer<UserRepo, never, Database>
const UserRepoLive = Layer.effect(UserRepo, Effect.gen(function* () {
  const db = yield* Database
  return {
    findName: (id) => db.query("select name from users where id = " + id).pipe(Effect.map((rows) => rows[0]!))
  }
}))

const LoggerLive = Layer.succeed(Logger, {
  log: (message) => Effect.sync(() => console.log("[log]", message))
})

// Wire bottom-up. Each provide removes one requirement from the layer above it.
const AppLive = UserRepoLive.pipe(
  Layer.provide(DatabaseLive.pipe(Layer.provide(ConfigLive))),  // Layer<UserRepo, never, never>
  Layer.merge(LoggerLive)                                       // Layer<UserRepo | Logger, never, never>
)

const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  const logger = yield* Logger
  const name = yield* repo.findName(1)
  yield* logger.log("found " + name)
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      expectedOutput: `query on postgres://prod: select name from users where id = 1
[log] found Ada`,
      after: `\`program\` cannot \`yield* Config\` right now, because \`Layer.provide\` hid it. Change the inner \`Layer.provide(ConfigLive)\` to \`Layer.provideMerge(ConfigLive)\` and the outer one too, and \`Config\` becomes available to \`program\`. Hiding is usually what you want: the app should not know which database URL the repository uses.`
    },
    {
      id: "requirements-management-l5",
      title: "Swapping implementations: real versus fake",
      explain: `
This is the lesson that pays for all the others. \`signUp\` below needs a \`Mailer\`. It does not know whether that mailer talks to an SMTP server or writes to an array. The same \`signUp\` runs against both, and the only difference is which layer you provide at the edge.

In plain TypeScript this needs either constructor injection everywhere, or a module mock in the test runner that patches \`import\` at load time. Here it is a normal value: a layer. The test layer is often shorter than the mocking setup would be, and it is type-checked against the same shape as production, so the fake cannot drift.

Naming convention from the Effect codebase: \`Mailer.layer\` for the primary implementation and a descriptive suffix for variants, like \`layerTest\`. This lesson uses \`MailerLive\` and \`MailerFake\` to make the contrast obvious.
`,
      code: `import { Context, Effect, Layer } from "effect"

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, subject: string) => Effect.Effect<void>
}>()("Mailer") {}

// Business logic. Knows nothing about SMTP or fakes: Effect<void, never, Mailer>
const signUp = (email: string) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer
    yield* mailer.send(email, "Welcome")
    console.log("signed up", email)
  })

// Production: talks to the outside world
const MailerLive = Layer.succeed(Mailer, {
  send: (to, subject) => Effect.sync(() => console.log("SMTP: sending", subject, "to", to))
})

// Test: records what would have been sent, sends nothing
const sent: Array<string> = []
const MailerFake = Layer.succeed(Mailer, {
  send: (to, subject) => Effect.sync(() => { sent.push(subject + " -> " + to) })
})

// Same program, different edge
Effect.runSync(signUp("ada@example.com").pipe(Effect.provide(MailerLive)))
Effect.runSync(signUp("lin@example.com").pipe(Effect.provide(MailerFake)))

console.log("fake recorded:", sent.join(", "))
`,
      expectedOutput: `SMTP: sending Welcome to ada@example.com
signed up ada@example.com
signed up lin@example.com
fake recorded: Welcome -> lin@example.com`,
      after: `Try removing the \`send\` property from \`MailerFake\`. It fails to compile, because \`Layer.succeed\` checks the implementation against the shape declared on the tag. A fake that no longer matches production is caught before any test runs.`
    },
    {
      id: "requirements-management-l6",
      title: "Layers are built once: memoization",
      explain: `
When two layers in the same graph both depend on \`Config\`, you might expect \`Config\` to be built twice. It is not. Effect memoizes layers by identity: the same layer value, reached from two places in one graph, is built once and the result is shared.

\`\`\`
          AppLive (merge)
          /            \\
  DatabaseLive      CacheLive
        |                |
   ConfigLive   ==   ConfigLive     same value, built once
\`\`\`

This matters for anything expensive or stateful: a connection pool, a metrics client, a cache. Every service in the graph sees the same instance, which is what a module singleton gave you, without the import-time side effects and with the ability to swap it.

The rule from the Effect team: compose the whole graph with \`Layer.provide\` and \`Layer.merge\`, then call \`Effect.provide\` **once**. Memoization is a safety net, not a substitute for composing properly.
`,
      code: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly appName: string }>()("Config") {}
class Database extends Context.Service<Database, { readonly label: string }>()("Database") {}
class Cache extends Context.Service<Cache, { readonly label: string }>()("Cache") {}

// The print proves how many times this layer is built
const ConfigLive = Layer.effect(Config, Effect.sync(() => {
  console.log("building Config")
  return { appName: "shop" }
}))

const DatabaseLive = Layer.effect(Database, Effect.gen(function* () {
  const config = yield* Config
  return { label: "db for " + config.appName }
})).pipe(Layer.provide(ConfigLive))

const CacheLive = Layer.effect(Cache, Effect.gen(function* () {
  const config = yield* Config
  return { label: "cache for " + config.appName }
})).pipe(Layer.provide(ConfigLive))

const program = Effect.gen(function* () {
  const db = yield* Database
  const cache = yield* Cache
  console.log(db.label)
  console.log(cache.label)
})

// ConfigLive appears twice in this graph, but is built once
Effect.runSync(program.pipe(Effect.provide(Layer.merge(DatabaseLive, CacheLive))))
`,
      expectedOutput: `building Config
db for shop
cache for shop`,
      after: `To force a second build on purpose, for example to give a test its own isolated pool, wrap one occurrence in \`Layer.fresh(ConfigLive)\`: "building Config" then prints twice. Memoization is per graph, so if you split one program into two separate \`Effect.provide\` calls run one after the other, each builds its own copy. The fix is always the same: compose first, provide once.`
    }
  ],
  challenges: [
    {
      id: "requirements-management-c1",
      title: "Nobody provided it",
      task: `The program is correct but does not compile: it needs a \`Clock\` and nothing supplies one. Satisfy the requirement so it prints \`the time is 42\`. Do not change \`program\`.`,
      code: `import { Context, Effect } from "effect"

class Clock extends Context.Service<Clock, {
  readonly now: () => number
}>()("Clock") {}

const program = Effect.gen(function* () {
  const clock = yield* Clock
  console.log("the time is", clock.now())
})

Effect.runSync(program)
`,
      solution: `import { Context, Effect } from "effect"

class Clock extends Context.Service<Clock, {
  readonly now: () => number
}>()("Clock") {}

const program = Effect.gen(function* () {
  const clock = yield* Clock
  console.log("the time is", clock.now())
})

Effect.runSync(program.pipe(Effect.provideService(Clock, { now: () => 42 })))
`,
      expectedOutput: `the time is 42`,
      hints: [
        "Read the type error: which type is 'not assignable to never'? That is the unsatisfied requirement.",
        "Lesson 1 satisfied a single requirement with one call that takes the tag and an implementation.",
        "Wrap the program: program.pipe(Effect.provideService(Clock, { now: () => 42 }))."
      ],
      explanation: `\`program\` has type \`Effect<void, never, Clock>\`. \`runSync\` only accepts \`R = never\`, so the compiler refuses. \`Effect.provideService(Clock, impl)\` removes \`Clock\` from \`R\` by supplying an implementation. In a DI container this would have been a runtime "no provider for Clock" error, possibly on the first request in production. Here it never leaves your editor.`
    },
    {
      id: "requirements-management-c2",
      title: "A recipe where a value was expected",
      task: `\`DatabaseLive\` should print \`connecting\` once and then answer queries, but it does not compile. Fix the layer constructor so the program prints the two lines below.`,
      code: `import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

const DatabaseLive = Layer.succeed(
  Database,
  Effect.sync(() => {
    console.log("connecting")
    return { query: (sql: string) => Effect.succeed("rows for " + sql) }
  })
)

const program = Effect.gen(function* () {
  const db = yield* Database
  console.log(yield* db.query("select 1"))
})

Effect.runSync(program.pipe(Effect.provide(DatabaseLive)))
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

const DatabaseLive = Layer.effect(
  Database,
  Effect.sync(() => {
    console.log("connecting")
    return { query: (sql: string) => Effect.succeed("rows for " + sql) }
  })
)

const program = Effect.gen(function* () {
  const db = yield* Database
  console.log(yield* db.query("select 1"))
})

Effect.runSync(program.pipe(Effect.provide(DatabaseLive)))
`,
      expectedOutput: `connecting
rows for select 1`,
      hints: [
        "The error says property 'query' is missing on an Effect. The layer received a recipe, not an implementation.",
        "Lesson 3 has a table with two constructors. One takes a value, the other takes an Effect.",
        "Replace Layer.succeed with Layer.effect."
      ],
      explanation: `\`Layer.succeed\` expects the finished implementation, so it tried to use the Effect itself as the service and found no \`query\` on it. \`Layer.effect\` expects an Effect that *produces* the implementation, runs it once when the graph is built, and stores the result. That is why "connecting" prints exactly once. Without the type check this would have crashed with "db.query is not a function" at the first query.`
    },
    {
      id: "requirements-management-c3",
      title: "The missing edge in the graph",
      task: `\`DatabaseLive\` needs \`Config\` to be built, and the graph never supplies it, so the program does not compile. Wire \`ConfigLive\` into the graph (do not change \`program\` or the \`runSync\` line) so it prints \`rows from postgres://prod\`.`,
      code: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly dbUrl: string }>()("Config") {}
class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

const ConfigLive = Layer.succeed(Config, { dbUrl: "postgres://prod" })

const DatabaseLive = Layer.effect(Database, Effect.gen(function* () {
  const config = yield* Config
  return { query: (sql) => Effect.succeed("rows from " + config.dbUrl) }
}))

const AppLive = DatabaseLive

const program = Effect.gen(function* () {
  const db = yield* Database
  console.log(yield* db.query("select 1"))
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly dbUrl: string }>()("Config") {}
class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}

const ConfigLive = Layer.succeed(Config, { dbUrl: "postgres://prod" })

const DatabaseLive = Layer.effect(Database, Effect.gen(function* () {
  const config = yield* Config
  return { query: (sql) => Effect.succeed("rows from " + config.dbUrl) }
}))

const AppLive = DatabaseLive.pipe(Layer.provide(ConfigLive))

const program = Effect.gen(function* () {
  const db = yield* Database
  console.log(yield* db.query("select 1"))
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      expectedOutput: `rows from postgres://prod`,
      hints: [
        "Hover DatabaseLive: its third type parameter is Config. That requirement has to be removed before the top.",
        "Lesson 4 wires layers bottom-up. Which function feeds one layer into another?",
        "AppLive = DatabaseLive.pipe(Layer.provide(ConfigLive))."
      ],
      explanation: `\`DatabaseLive\` has type \`Layer<Database, never, Config>\`: it provides \`Database\` but *requires* \`Config\`. When you \`Effect.provide\` it, the unmet requirement moves onto the program, so \`runSync\` sees \`R = Config\` and refuses. \`Layer.provide(ConfigLive)\` satisfies it inside the graph, giving \`Layer<Database, never, never>\`. A requirement can move up the graph but never disappears on its own, which is exactly how the compiler finds the missing edge.`
    },
    {
      id: "requirements-management-c4",
      title: "Hidden by provide",
      task: `\`program\` needs both \`UserRepo\` and \`Config\`, but the graph exposes only \`UserRepo\`, so it does not compile. Change one layer function so both are exposed and the program prints the two lines below.`,
      code: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly env: string }>()("Config") {}
class UserRepo extends Context.Service<UserRepo, {
  readonly find: (id: number) => Effect.Effect<string>
}>()("UserRepo") {}

const ConfigLive = Layer.succeed(Config, { env: "staging" })

const UserRepoLive = Layer.effect(UserRepo, Effect.gen(function* () {
  const config = yield* Config
  return { find: (id) => Effect.succeed("user " + id + " from " + config.env) }
}))

const AppLive = UserRepoLive.pipe(Layer.provide(ConfigLive))

const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  const config = yield* Config
  console.log(yield* repo.find(7))
  console.log("running in", config.env)
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly env: string }>()("Config") {}
class UserRepo extends Context.Service<UserRepo, {
  readonly find: (id: number) => Effect.Effect<string>
}>()("UserRepo") {}

const ConfigLive = Layer.succeed(Config, { env: "staging" })

const UserRepoLive = Layer.effect(UserRepo, Effect.gen(function* () {
  const config = yield* Config
  return { find: (id) => Effect.succeed("user " + id + " from " + config.env) }
}))

const AppLive = UserRepoLive.pipe(Layer.provideMerge(ConfigLive))

const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  const config = yield* Config
  console.log(yield* repo.find(7))
  console.log("running in", config.env)
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      expectedOutput: `user 7 from staging
running in staging`,
      hints: [
        "Config was provided to UserRepoLive, but the program itself also asks for Config. Where did it go?",
        "Lesson 4's table: one function feeds a layer and hides the dependency, another feeds it and keeps it visible.",
        "Use Layer.provideMerge(ConfigLive) instead of Layer.provide(ConfigLive)."
      ],
      explanation: `\`Layer.provide\` is deliberately private: it uses \`ConfigLive\` to build \`UserRepoLive\` and then exposes only \`UserRepo\`. Downstream code cannot reach \`Config\`. \`Layer.provideMerge\` does the same wiring but exposes both, giving \`Layer<UserRepo | Config, never, never>\`. Both are useful: \`provide\` for internal details like a database URL, \`provideMerge\` when the dependency is also part of the public surface.`
    },
    {
      id: "requirements-management-c5",
      title: "Built twice",
      task: `\`Config\` is expensive to build, and this program builds it twice. Restructure the program so it prints \`building Config\` exactly once, followed by the two \`uses\` lines in the same order.`,
      code: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly appName: string }>()("Config") {}

const ConfigLive = Layer.effect(Config, Effect.sync(() => {
  console.log("building Config")
  return { appName: "shop" }
}))

const stepA = Effect.gen(function* () {
  const config = yield* Config
  console.log("A uses", config.appName)
})

const stepB = Effect.gen(function* () {
  const config = yield* Config
  console.log("B uses", config.appName)
})

const program = Effect.gen(function* () {
  yield* stepA.pipe(Effect.provide(ConfigLive))
  yield* stepB.pipe(Effect.provide(ConfigLive))
})

Effect.runSync(program)
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly appName: string }>()("Config") {}

const ConfigLive = Layer.effect(Config, Effect.sync(() => {
  console.log("building Config")
  return { appName: "shop" }
}))

const stepA = Effect.gen(function* () {
  const config = yield* Config
  console.log("A uses", config.appName)
})

const stepB = Effect.gen(function* () {
  const config = yield* Config
  console.log("B uses", config.appName)
})

const program = Effect.gen(function* () {
  yield* stepA
  yield* stepB
}).pipe(Effect.provide(ConfigLive))

Effect.runSync(program)
`,
      expectedOutput: `building Config
A uses shop
B uses shop`,
      hints: [
        "Each Effect.provide builds its own graph, and that graph is torn down when the provided effect finishes.",
        "Lesson 6's rule: compose first, provide once. Let stepA and stepB keep Config in their R.",
        "Remove both inner provides and add .pipe(Effect.provide(ConfigLive)) to the outer Effect.gen."
      ],
      explanation: `Memoization is per graph. Each inner \`Effect.provide\` created a small graph, built \`Config\`, ran its step, and released the graph. The second call had nothing to reuse. Leaving \`Config\` in the \`R\` of \`stepA\` and \`stepB\` and providing once at the outer level puts both steps inside one graph, so the layer is built a single time. This is also the more honest type: \`program\` now says it needs \`Config\` until the very edge.`
    },
    {
      id: "requirements-management-c6",
      title: "It should have a default",
      task: `\`Settings\` is meant to be optional: the program should run without providing it and print \`verbose: false\`, then run again with an override and print \`verbose: true\`. Right now it does not compile. Change how \`Settings\` is declared. Do not touch \`program\` or the two \`runSync\` lines.`,
      code: `import { Context, Effect } from "effect"

interface Settings {
  readonly verbose: boolean
}

const Settings = Context.Service<Settings>("Settings")

const program = Effect.gen(function* () {
  const settings = yield* Settings
  console.log("verbose:", settings.verbose)
})

Effect.runSync(program)
Effect.runSync(program.pipe(Effect.provideService(Settings, { verbose: true })))
`,
      solution: `import { Context, Effect } from "effect"

interface Settings {
  readonly verbose: boolean
}

const Settings = Context.Reference<Settings>("Settings", {
  defaultValue: () => ({ verbose: false })
})

const program = Effect.gen(function* () {
  const settings = yield* Settings
  console.log("verbose:", settings.verbose)
})

Effect.runSync(program)
Effect.runSync(program.pipe(Effect.provideService(Settings, { verbose: true })))
`,
      expectedOutput: `verbose: false
verbose: true`,
      hints: [
        "The first runSync fails because Settings is a hard requirement. Which kind of service never appears in R?",
        "Lesson 2's table has a form with a defaultValue.",
        "Context.Reference<Settings>(\"Settings\", { defaultValue: () => ({ verbose: false }) })."
      ],
      explanation: `\`Context.Service\` declares a requirement: it must be provided or the program does not type check. \`Context.Reference\` declares a service **with a default**, so reading it adds nothing to \`R\`. The first run uses the default; the second overrides it with \`provideService\`, which works on References exactly as on Services. Use a Reference for config and flags that have a sane default, and a Service for anything the program cannot work without.`
    }
  ],
  problems: [
    {
      id: "requirements-management-p1",
      title: "Order pipeline with three services",
      spec: `
Build \`placeOrder(sku, qty)\` on top of three services, then wire them with layers.

1. \`Pricing\` has \`price(sku): number\`. Prices: \`book\` is 15, \`pen\` is 2.
2. \`Inventory\` has \`reserve(sku, qty): Effect<void>\`. It prints \`reserved <qty> x <sku>\`.
3. \`Notifier\` has \`notify(message): Effect<void>\`. It prints \`notify: <message>\`.

\`placeOrder\` reserves stock, computes \`total = price * qty\`, prints \`total <total>\`, and notifies with the message \`order <sku> x<qty> = <total>\`. Build one layer per service with \`Layer.succeed\`, combine them with \`Layer.mergeAll\`, and run \`placeOrder("book", 2)\` then \`placeOrder("pen", 5)\` with a single \`Effect.provide\`. Exact output:

\`\`\`
reserved 2 x book
total 30
notify: order book x2 = 30
reserved 5 x pen
total 10
notify: order pen x5 = 10
\`\`\`
`,
      starter: `import { Context, Effect, Layer } from "effect"

class Pricing extends Context.Service<Pricing, {
  readonly price: (sku: string) => number
}>()("Pricing") {}

class Inventory extends Context.Service<Inventory, {
  readonly reserve: (sku: string, qty: number) => Effect.Effect<void>
}>()("Inventory") {}

class Notifier extends Context.Service<Notifier, {
  readonly notify: (message: string) => Effect.Effect<void>
}>()("Notifier") {}

// TODO: placeOrder(sku, qty): Effect<void, never, Pricing | Inventory | Notifier>
const placeOrder = (sku: string, qty: number) => Effect.void

// TODO: PricingLive, InventoryLive, NotifierLive with Layer.succeed
// TODO: AppLive = Layer.mergeAll(...)

const program = Effect.gen(function* () {
  yield* placeOrder("book", 2)
  yield* placeOrder("pen", 5)
})

// TODO: provide AppLive and run
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Pricing extends Context.Service<Pricing, {
  readonly price: (sku: string) => number
}>()("Pricing") {}

class Inventory extends Context.Service<Inventory, {
  readonly reserve: (sku: string, qty: number) => Effect.Effect<void>
}>()("Inventory") {}

class Notifier extends Context.Service<Notifier, {
  readonly notify: (message: string) => Effect.Effect<void>
}>()("Notifier") {}

const placeOrder = (sku: string, qty: number) =>
  Effect.gen(function* () {
    const pricing = yield* Pricing
    const inventory = yield* Inventory
    const notifier = yield* Notifier
    yield* inventory.reserve(sku, qty)
    const total = pricing.price(sku) * qty
    console.log("total", total)
    yield* notifier.notify("order " + sku + " x" + qty + " = " + total)
  })

const prices: Record<string, number> = { book: 15, pen: 2 }

const PricingLive = Layer.succeed(Pricing, { price: (sku) => prices[sku] ?? 0 })
const InventoryLive = Layer.succeed(Inventory, {
  reserve: (sku, qty) => Effect.sync(() => console.log("reserved", qty, "x", sku))
})
const NotifierLive = Layer.succeed(Notifier, {
  notify: (message) => Effect.sync(() => console.log("notify:", message))
})

const AppLive = Layer.mergeAll(PricingLive, InventoryLive, NotifierLive)

const program = Effect.gen(function* () {
  yield* placeOrder("book", 2)
  yield* placeOrder("pen", 5)
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      expectedOutput: `reserved 2 x book
total 30
notify: order book x2 = 30
reserved 5 x pen
total 10
notify: order pen x5 = 10`,
      hints: [
        "Inside placeOrder, yield* each of the three tags first, then use them. R becomes the union of all three.",
        "Layer.succeed(Tag, { ... }) takes a plain object matching the shape. Parameter types are inferred from the tag.",
        "Layer.mergeAll(a, b, c) produces one Layer<Pricing | Inventory | Notifier>; provide it once at the end."
      ]
    },
    {
      id: "requirements-management-p2",
      title: "A test double for the payment gateway",
      spec: `
\`checkout(amount)\` charges a card and prints the receipt id. It must not know which gateway it uses.

1. Define a \`Payments\` service with \`charge(amount): Effect<string>\` that returns a receipt id.
2. \`PaymentsLive\` prints \`stripe: charging <amount>\` and returns \`"stripe-<amount>"\`.
3. \`PaymentsFake\` pushes the amount into a module-level \`charges: Array<number>\` and returns \`"fake-<amount>"\`. It prints nothing.
4. \`checkout(amount)\` calls \`charge\` and prints \`receipt <id>\`.

Run \`checkout(42)\` with the live layer, then \`checkout(42)\` and \`checkout(7)\` with the fake layer, then print \`fake charges: <amounts joined by ", ">\`. Exact output:

\`\`\`
stripe: charging 42
receipt stripe-42
receipt fake-42
receipt fake-7
fake charges: 42, 7
\`\`\`
`,
      starter: `import { Context, Effect, Layer } from "effect"

// TODO: class Payments with charge(amount: number): Effect<string>

// TODO: checkout(amount) prints "receipt <id>"

// TODO: PaymentsLive (prints "stripe: charging <amount>", returns "stripe-<amount>")

const charges: Array<number> = []
// TODO: PaymentsFake (records into charges, returns "fake-<amount>")

// TODO: run checkout(42) with PaymentsLive
// TODO: run checkout(42) and checkout(7) with PaymentsFake
console.log("fake charges:", charges.join(", "))
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Payments extends Context.Service<Payments, {
  readonly charge: (amount: number) => Effect.Effect<string>
}>()("Payments") {}

const checkout = (amount: number) =>
  Effect.gen(function* () {
    const payments = yield* Payments
    const receipt = yield* payments.charge(amount)
    console.log("receipt", receipt)
  })

const PaymentsLive = Layer.succeed(Payments, {
  charge: (amount) => Effect.sync(() => {
    console.log("stripe: charging", amount)
    return "stripe-" + amount
  })
})

const charges: Array<number> = []
const PaymentsFake = Layer.succeed(Payments, {
  charge: (amount) => Effect.sync(() => {
    charges.push(amount)
    return "fake-" + amount
  })
})

Effect.runSync(checkout(42).pipe(Effect.provide(PaymentsLive)))

const tests = Effect.gen(function* () {
  yield* checkout(42)
  yield* checkout(7)
})
Effect.runSync(tests.pipe(Effect.provide(PaymentsFake)))

console.log("fake charges:", charges.join(", "))
`,
      expectedOutput: `stripe: charging 42
receipt stripe-42
receipt fake-42
receipt fake-7
fake charges: 42, 7`,
      hints: [
        "The shape is { readonly charge: (amount: number) => Effect.Effect<string> }. Both layers must match it exactly.",
        "Effect.sync can print and return a value in the same function body.",
        "Group the two fake checkouts in one Effect.gen and provide PaymentsFake once."
      ]
    },
    {
      id: "requirements-management-p3",
      title: "A three-level graph",
      spec: `
Wire a chain \`Config -> Database -> UserRepo\` and expose the right services at the top.

1. \`Config\` holds \`{ env: string, dbUrl: string }\`. \`ConfigLive\` provides \`{ env: "prod", dbUrl: "postgres://prod" }\` with \`Layer.succeed\`.
2. \`Database\` has \`query(sql): Effect<Array<string>>\`. \`DatabaseLive\` is a \`Layer.effect\` that reads \`Config\`, prints \`connecting to <dbUrl>\` once while building, and answers every query with \`["Ada", "Lin"]\`.
3. \`UserRepo\` has \`name(id): Effect<string>\`. \`UserRepoLive\` reads \`Database\`, queries \`"select name from users"\`, and returns the row at index \`id - 1\`.
4. \`AppLive\` must have the type \`Layer.Layer<UserRepo | Config>\`: it exposes \`UserRepo\` and \`Config\` but hides \`Database\`. Annotate it with that type so the compiler checks it.

\`program\` prints \`user 1 is <name>\`, \`user 2 is <name>\`, then \`env: <env>\` read from \`Config\`. Exact output:

\`\`\`
connecting to postgres://prod
user 1 is Ada
user 2 is Lin
env: prod
\`\`\`
`,
      starter: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, {
  readonly env: string
  readonly dbUrl: string
}>()("Config") {}

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<Array<string>>
}>()("Database") {}

class UserRepo extends Context.Service<UserRepo, {
  readonly name: (id: number) => Effect.Effect<string>
}>()("UserRepo") {}

// TODO: ConfigLive, DatabaseLive (Layer.effect, prints "connecting to <dbUrl>"), UserRepoLive

// TODO: wire the graph. Config must stay visible, Database must be hidden.
// (Layer.empty is a placeholder and is a type error on purpose)
const AppLive: Layer.Layer<UserRepo | Config> = Layer.empty

const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  const config = yield* Config
  console.log("user 1 is", yield* repo.name(1))
  console.log("user 2 is", yield* repo.name(2))
  console.log("env:", config.env)
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      solution: `import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, {
  readonly env: string
  readonly dbUrl: string
}>()("Config") {}

class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<Array<string>>
}>()("Database") {}

class UserRepo extends Context.Service<UserRepo, {
  readonly name: (id: number) => Effect.Effect<string>
}>()("UserRepo") {}

const ConfigLive = Layer.succeed(Config, { env: "prod", dbUrl: "postgres://prod" })

const DatabaseLive = Layer.effect(Database, Effect.gen(function* () {
  const config = yield* Config
  console.log("connecting to", config.dbUrl)
  return { query: (_sql) => Effect.succeed(["Ada", "Lin"]) }
}))

const UserRepoLive = Layer.effect(UserRepo, Effect.gen(function* () {
  const db = yield* Database
  return {
    name: (id) => db.query("select name from users").pipe(Effect.map((rows) => rows[id - 1]!))
  }
}))

// Database feeds UserRepo and is hidden; Config feeds Database and stays visible
const AppLive: Layer.Layer<UserRepo | Config> = UserRepoLive.pipe(
  Layer.provide(DatabaseLive),
  Layer.provideMerge(ConfigLive)
)

const program = Effect.gen(function* () {
  const repo = yield* UserRepo
  const config = yield* Config
  console.log("user 1 is", yield* repo.name(1))
  console.log("user 2 is", yield* repo.name(2))
  console.log("env:", config.env)
})

Effect.runSync(program.pipe(Effect.provide(AppLive)))
`,
      expectedOutput: `connecting to postgres://prod
user 1 is Ada
user 2 is Lin
env: prod`,
      hints: [
        "Build bottom-up: DatabaseLive needs Config, UserRepoLive needs Database. Hover each layer to read its third type parameter.",
        "Layer.provide hides what it feeds in, Layer.provideMerge keeps it visible. You need one of each.",
        "UserRepoLive.pipe(Layer.provide(DatabaseLive), Layer.provideMerge(ConfigLive)). After the first provide the layer still needs Config; the second one supplies it and exposes it."
      ]
    }
  ],
  recall: [
    {
      q: "What does `R = never` at the top of a program guarantee?",
      a: "Every service the program reads has been provided. `runSync` and `runPromise` only accept `R = never`, so a missing dependency is a compile error at the run call, not a runtime crash."
    },
    {
      q: "What would the type of `Effect.gen(function* () { const db = yield* Database; return yield* db.query(\"x\") })` be, if `query` returns `Effect<string>`?",
      a: "`Effect<string, never, Database>`. The `yield* Database` added `Database` to `R`; the success type comes from `query`."
    },
    {
      q: "Which function would you reach for to satisfy a single requirement with a value you already have, and which one to plug in a whole graph of services?",
      a: "`Effect.provideService(Tag, impl)` for a one-off value. `Effect.provide(layer)` for a Layer or a composed graph of Layers."
    },
    {
      q: "What is the difference between `Layer.provide` and `Layer.provideMerge`?",
      a: "Both feed one layer into another. `provide` exposes only the receiving layer's service, hiding the dependency. `provideMerge` exposes both. Use `provide` for internal details, `provideMerge` when downstream code also needs the dependency."
    },
    {
      q: "When do you use `Layer.succeed` versus `Layer.effect`?",
      a: "`Layer.succeed(Tag, impl)` when the implementation is a plain value with no setup. `Layer.effect(Tag, effect)` when building it is work: reading config, opening a connection, or depending on other services via `yield*`."
    },
    {
      q: "Two layers in the same graph both depend on `ConfigLive`. How many times is it built, and how would you force a second build?",
      a: "Once. Layers are memoized by identity within a graph. Wrap one occurrence in `Layer.fresh(ConfigLive)` to force a separate build, for example to isolate a test."
    },
    {
      q: "When is `Context.Reference` the right choice instead of `Context.Service`?",
      a: "When the service has a sensible default, like a log level or a feature flag. A Reference never appears in `R`, so the program runs without providing it, and `provideService` can still override it."
    }
  ]
}

export default section
