import type { Section } from "../types.ts"

const section: Section = {
  id: "requirements-management",
  title: "Requirements Management",
  order: 3,
  summary: "Services, the R channel, and Layers: dependencies tracked by the compiler and satisfied once at the edge.",
  intro: `
**The problem.** Every real program needs things that it did not create: a database, a logger, a clock, a config. Plain TypeScript gives you 3 ways to get them. Each way has a cost.

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

Option 1 puts unrelated arguments in every signature. Option 2 hides the dependency completely. A test cannot replace it, and the connection opens at import time. Option 3 checks nothing at compile time. In all 3 options, the type does not answer the question "what does this function need to run?".

### The shift

Today you think of a dependency as **a value that you pass in or get from a module**. Effect asks you to think of it as **a requirement recorded in the type**. When code reads the \`Database\` service, \`Database\` appears in the third type parameter, \`R\`. When you combine 2 effects, Effect combines their requirements. At the top of the program, \`R\` must be \`never\`. This means that every requirement is satisfied. If 1 requirement is missing, the program does not compile.

You satisfy a requirement once, at the top of the program, with a **Layer**. A layer is a value that describes how to build a service, possibly from other services. You combine layers into a graph. Effect builds the graph once. Effect builds each service in the graph 1 time and shares it.

The result: business logic never says how a service is built. To replace a real mailer with a fake one in tests, you change 1 line at the top of the program. Config does not travel through 5 signatures. The compiler tells you what is missing, not a crash at startup.

| | Arguments | Module singleton | DI container | Effect |
|---|---|---|---|---|
| Visible in the type | Yes, but with many arguments | No | No | Yes, in \`R\` |
| Replaceable in tests | Yes, with much work | No | Yes | Yes, provide a different layer |
| Missing dependency found | Compile time | Never | Runtime | Compile time |
| Construction order | Manual | Import order | Container | From the layer graph |
| Built once and shared | Manual | Yes | Usually | Yes, memoized in each graph |

In this section, you:

- define services
- read \`R\`
- build layers
- connect a small graph
- replace implementations
- see memoization
`,
  lessons: [
    {
      id: "requirements-management-l1",
      title: "A requirement shows up in R",
      explain: `
A **service** is 2 things together: a **tag** and a **shape**. The tag is a unique key that you use as a value. The shape is the TypeScript type of the value that the key points to. The class syntax below defines both at the same time. The class \`Logger\` is the tag. The object type between the angle brackets is the shape.

Inside \`Effect.gen\`, \`yield* Logger\` does 2 things. At runtime, it gets the implementation. At compile time, it adds \`Logger\` to the \`R\` of the effect around it. \`program\` does not say *how* to log. It says only *that* it needs a logger.

\`Effect.provideService\` satisfies 1 requirement with 1 call. Give it the tag and an implementation, and Effect removes \`Logger\` from \`R\`. Only then does \`runSync\` accept the program.
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
      after: `Change \`Effect.runSync(runnable)\` to \`Effect.runSync(program)\`. The compiler reports: \`Type 'Logger' is not assignable to type 'never'\`. This is the purpose of the R channel: a missing dependency is a type error, not a crash at the first request.`
    },
    {
      id: "requirements-management-l2",
      title: "Three ways to declare a service",
      explain: `
The class syntax is the default. 2 more forms exist for specific situations.

| Form | Write it as | Use when |
|---|---|---|
| Class | \`class Db extends Context.Service<Db, Shape>()("Db") {}\` | Almost always. The class is a clean identifier in \`R\`. |
| Function | \`const Clock = Context.Service<Clock>("Clock")\` | You already have an interface named \`Clock\` and want 1 line. |
| Reference | \`Context.Reference<T>("Tz", { defaultValue })\` | The service has a good default. You override it only sometimes. |

In the function form, the interface is the identifier, so \`R\` shows \`Clock\`. Note: 2 services with the same string key but different shapes collide at runtime. Keep the keys unique.

A \`Reference\` is different. It always has a default. When you read it, it adds **nothing** to \`R\`. You can run the program without it, and you can still override it with \`provideService\` when you want to. Config values and feature flags are the usual use.
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
      after: `There are 2 equivalent ways to read a service outside \`Effect.gen\`. \`Effect.service(Clock)\` returns the same effect as \`yield* Clock\`. \`Clock.use((c) => Effect.succeed(c.now()))\` reads the service and calls a method in 1 step. In generators, use \`yield*\`. It keeps the requirement visible where you use it.`
    },
    {
      id: "requirements-management-l3",
      title: "Layers: a recipe for building a service",
      explain: `
\`provideService\` takes an implementation that you already hold. Real services must be *built*: read the config, open a connection, print a startup line. A **Layer** is an effect that builds a service. Compare the plain TypeScript \`main\` that you have written many times:

\`\`\`ts
async function main() {
  console.log("connecting to database")
  const db = await Database.connect()        // built here, by hand, in the right order
  await runApp(db)                           // and threaded into everything
}
\`\`\`

With Effect, the construction becomes a value, \`DatabaseLive\`. \`Effect.provide\` connects it to the program. 2 constructors cover most cases:

| Constructor | Takes | Use when |
|---|---|---|
| \`Layer.succeed(Tag, impl)\` | A plain value | The implementation needs no setup |
| \`Layer.effect(Tag, effect)\` | An effect that returns the implementation | The implementation needs setup: config, connections, logs |

Read the type \`Layer<Database, never, never>\` as "provides \`Database\`, cannot fail when it builds, needs nothing to build."
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
      after: `"connecting to database" printed once, but \`query\` ran 2 times. The build effect of the layer runs when Effect builds the graph. Then Effect gives the same implementation to every \`yield* Database\`. For a service that needs no setup, replace \`Layer.effect\` with \`Layer.succeed(Database, { query: ... })\`.`
    },
    {
      id: "requirements-management-l4",
      title: "A graph of layers: provide, provideMerge, merge",
      explain: `
A layer built with \`Layer.effect\` can itself \`yield*\` other services. Those services become the requirements of the layer. \`Layer<UserRepo, never, Database>\` means "provides \`UserRepo\`, but needs \`Database\` to build." You connect layers from the bottom up with 3 functions.

| Function | Meaning | What the result provides |
|---|---|---|
| \`A.pipe(Layer.provide(B))\` | B provides its service to A | Only A. B is hidden. |
| \`A.pipe(Layer.provideMerge(B))\` | B provides its service to A | A and B. |
| \`Layer.merge(A, B)\` | No relation between A and B | A and B. |

The diagram below shows what the code builds. Each arrow is 1 \`Layer.provide\`. The top is what \`program\` needs:

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

If you forget 1 arrow, for example \`ConfigLive\`, the requirement moves up to the top. The compiler reports \`Type 'Config' is not assignable to type 'never'\` at the \`runSync\` call.
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
      after: `\`program\` cannot \`yield* Config\` now, because \`Layer.provide\` hides it. Change the inner \`Layer.provide(ConfigLive)\` to \`Layer.provideMerge(ConfigLive)\`. Change the outer \`Layer.provide\` to \`Layer.provideMerge\` also. Then \`Config\` becomes available to \`program\`. Usually you want to hide it: the app must not know which database URL the repository uses.`
    },
    {
      id: "requirements-management-l5",
      title: "Swapping implementations: real versus fake",
      explain: `
This lesson shows the largest benefit. \`signUp\` below needs a \`Mailer\`. It does not know if the mailer sends to an SMTP server or writes to an array. The same \`signUp\` runs with both. The only difference is which layer you provide at the top of the program.

In plain TypeScript, this needs constructor injection in every class, or a module mock in the test runner that patches \`import\` at load time. Here it is a normal value: a layer. The test layer is often shorter than the mock setup. The compiler checks it against the same shape as production, so the fake cannot become different from production.

The Effect codebase uses this convention for names: \`Mailer.layer\` for the primary implementation, and a descriptive suffix for variants, for example \`layerTest\`. This lesson uses \`MailerLive\` and \`MailerFake\` to make the difference clear.
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
      after: `Remove the \`send\` property from \`MailerFake\`. The program does not compile, because \`Layer.succeed\` checks the implementation against the shape declared on the tag. The compiler finds a fake that does not match production before any test runs.`
    },
    {
      id: "requirements-management-l6",
      title: "Layers are built once: memoization",
      explain: `
When 2 layers in the same graph both depend on \`Config\`, you can expect Effect to build \`Config\` 2 times. It does not. Effect memoizes layers by identity. Memoization means that Effect keeps the result of the first build and reuses it. Effect builds the same layer value once, even when 2 places in 1 graph use it, and shares the result.

\`\`\`
          AppLive (merge)
          /            \\
  DatabaseLive      CacheLive
        |                |
   ConfigLive   ==   ConfigLive     same value, built once
\`\`\`

This matters for anything expensive or stateful: a connection pool, a metrics client, a cache. Every service in the graph gets the same instance. A module singleton also gives you this, but with side effects at import time and no way to replace it.

The Effect team gives this rule: combine the whole graph with \`Layer.provide\` and \`Layer.merge\`, then call \`Effect.provide\` **once**. Memoization is a safety measure, not a replacement for correct composition.
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
      after: `To force a second build, for example to give a test its own isolated pool, wrap 1 occurrence in \`Layer.fresh(ConfigLive)\`. Then "building Config" prints 2 times. Memoization applies to 1 graph. If you split 1 program into 2 separate \`Effect.provide\` calls that run one after the other, each call builds its own copy. The correction is always the same: combine first, provide once.`
    }
  ],
  dosAndDonts: [
    {
      do: "Read a service with `yield* Tag` inside `Effect.gen`.",
      dont: "Do not import a module-level singleton inside business logic.",
      why: "A singleton hides the dependency, so `R` does not show it, and a test cannot replace it."
    },
    {
      do: "Use `Layer.effect(Tag, effect)` when the implementation needs setup.",
      dont: "Do not pass an effect to `Layer.succeed`.",
      why: "`Layer.succeed` stores the effect itself as the service, so the service has no methods, and the program does not compile."
    },
    {
      do: "Combine the whole layer graph first, then call `Effect.provide` once at the top.",
      dont: "Do not call `Effect.provide` on each step of the program.",
      why: "Each `Effect.provide` builds its own graph, so Effect builds an expensive layer once for each call."
    },
    {
      do: "Use `Layer.provide` to hide an internal dependency, for example a database URL.",
      dont: "Do not use `Layer.provideMerge` for every connection in the graph.",
      why: "`provideMerge` exposes the dependency, so code that uses the graph can depend on an internal detail."
    },
    {
      do: "Use `Context.Reference` with a `defaultValue` for config and flags that have a good default.",
      dont: "Do not declare an optional setting with `Context.Service`.",
      why: "`Context.Service` adds a hard requirement to `R`, so the program does not compile without a provider."
    },
    {
      do: "Give each service a unique string key.",
      dont: "Do not use the same string key for 2 services with different shapes.",
      why: "The 2 services collide at runtime, and one implementation replaces the other."
    },
    {
      do: "Use `Layer.fresh` only when a test needs its own separate instance.",
      dont: "Do not use `Layer.fresh` to correct a graph that builds a layer 2 times.",
      why: "The cause is 2 separate `Effect.provide` calls, and `Layer.fresh` makes more builds, not fewer."
    }
  ],
  challenges: [
    {
      id: "requirements-management-c1",
      title: "Nobody provided it",
      task: `The program is correct but does not compile. It needs a \`Clock\`, and nothing provides one. Satisfy the requirement so that the program prints \`the time is 42\`. Do not change \`program\`.`,
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
        "Read the type error. Which type is 'not assignable to never'? That type is the unsatisfied requirement.",
        "Lesson 1 satisfied 1 requirement with 1 call that takes the tag and an implementation.",
        "Wrap the program: program.pipe(Effect.provideService(Clock, { now: () => 42 }))."
      ],
      explanation: `\`program\` has the type \`Effect<void, never, Clock>\`. \`runSync\` accepts only \`R = never\`, so the compiler rejects it. \`Effect.provideService(Clock, impl)\` provides an implementation and removes \`Clock\` from \`R\`. In a DI container, this is a runtime error "no provider for Clock", possibly at the first request in production. Here the error does not leave your editor.`
    },
    {
      id: "requirements-management-c2",
      title: "A recipe where a value was expected",
      task: `\`DatabaseLive\` must print \`connecting\` once and then answer queries, but it does not compile. Correct the layer constructor so that the program prints the 2 lines below.`,
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
        "The error says that property 'query' is missing on an Effect. The layer received a build effect, not an implementation.",
        "Lesson 3 has a table with 2 constructors. One takes a value, the other takes an effect.",
        "Replace Layer.succeed with Layer.effect."
      ],
      explanation: `\`Layer.succeed\` expects the complete implementation. It tried to use the effect itself as the service, and found no \`query\` on it. \`Layer.effect\` expects an effect that *returns* the implementation. It runs that effect once when Effect builds the graph, and keeps the result. This is why "connecting" prints exactly once. Without the type check, the program crashes with "db.query is not a function" at the first query.`
    },
    {
      id: "requirements-management-c3",
      title: "The missing edge in the graph",
      task: `\`DatabaseLive\` needs \`Config\` to build, and the graph does not provide it, so the program does not compile. Connect \`ConfigLive\` to the graph so that the program prints \`rows from postgres://prod\`. Do not change \`program\` or the \`runSync\` line.`,
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
        "Hover over DatabaseLive: its third type parameter is Config. You must remove that requirement before the top.",
        "Lesson 4 connects layers from the bottom up. Which function provides one layer to another?",
        "AppLive = DatabaseLive.pipe(Layer.provide(ConfigLive))."
      ],
      explanation: `\`DatabaseLive\` has the type \`Layer<Database, never, Config>\`. It provides \`Database\` but *requires* \`Config\`. When you \`Effect.provide\` it, the unsatisfied requirement moves to the program. \`runSync\` sees \`R = Config\` and rejects it. \`Layer.provide(ConfigLive)\` satisfies the requirement inside the graph and gives \`Layer<Database, never, never>\`. A requirement can move up the graph, but it never disappears on its own. This is how the compiler finds the missing edge.`
    },
    {
      id: "requirements-management-c4",
      title: "Hidden by provide",
      task: `\`program\` needs both \`UserRepo\` and \`Config\`, but the graph exposes only \`UserRepo\`, so it does not compile. Change 1 layer function so that the graph exposes both, and the program prints the 2 lines below.`,
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
        "Config was provided to UserRepoLive, but the program also asks for Config. Where did Config go?",
        "See the table in lesson 4: one function provides a layer and hides the dependency, another provides it and keeps it visible.",
        "Use Layer.provideMerge(ConfigLive) instead of Layer.provide(ConfigLive)."
      ],
      explanation: `\`Layer.provide\` hides the dependency on purpose. It uses \`ConfigLive\` to build \`UserRepoLive\`, and then exposes only \`UserRepo\`. Code that uses the graph cannot get \`Config\`. \`Layer.provideMerge\` makes the same connection but exposes both. The result is \`Layer<UserRepo | Config, never, never>\`. Both functions are useful. Use \`provide\` for internal details, for example a database URL. Use \`provideMerge\` when the dependency is also part of the public interface.`
    },
    {
      id: "requirements-management-c5",
      title: "Built twice",
      task: `\`Config\` is expensive to build, and this program builds it 2 times. Change the structure of the program so that it prints \`building Config\` exactly once, then the 2 \`uses\` lines in the same order.`,
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
        "Each Effect.provide builds its own graph. Effect releases that graph when the provided effect finishes.",
        "The rule from lesson 6: combine first, provide once. Let stepA and stepB keep Config in their R.",
        "Remove both inner provides, and add .pipe(Effect.provide(ConfigLive)) to the outer Effect.gen."
      ],
      explanation: `Memoization applies to 1 graph. Each inner \`Effect.provide\` made a small graph, built \`Config\`, ran its step, and released the graph. The second call had nothing to reuse. Keep \`Config\` in the \`R\` of \`stepA\` and \`stepB\`, and provide once at the outer level. Then both steps are in 1 graph, and Effect builds the layer 1 time. The type is also more accurate: \`program\` now says that it needs \`Config\` until the top.`
    },
    {
      id: "requirements-management-c6",
      title: "It must have a default",
      task: `\`Settings\` must be optional. The program must run without it and print \`verbose: false\`. Then it must run again with an override and print \`verbose: true\`. Now it does not compile. Change how \`Settings\` is declared. Do not change \`program\` or the 2 \`runSync\` lines.`,
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
        "The table in lesson 2 has a form with a defaultValue.",
        "Context.Reference<Settings>(\"Settings\", { defaultValue: () => ({ verbose: false }) })."
      ],
      explanation: `\`Context.Service\` declares a requirement. You must provide it, or the program does not type check. \`Context.Reference\` declares a service **with a default**, so a read adds nothing to \`R\`. The first run uses the default. The second run overrides it with \`provideService\`, which works on References exactly as on Services. Use a Reference for config and flags that have a good default. Use a Service for anything that the program cannot work without.`
    }
  ],
  problems: [
    {
      id: "requirements-management-p1",
      title: "Order pipeline with three services",
      spec: `
Build \`placeOrder(sku, qty)\` on top of 3 services, then connect them with layers.

1. \`Pricing\` has \`price(sku): number\`. Prices: \`book\` is 15, \`pen\` is 2.
2. \`Inventory\` has \`reserve(sku, qty): Effect<void>\`. It prints \`reserved <qty> x <sku>\`.
3. \`Notifier\` has \`notify(message): Effect<void>\`. It prints \`notify: <message>\`.

\`placeOrder\` reserves stock, computes \`total = price * qty\`, prints \`total <total>\`, and notifies with the message \`order <sku> x<qty> = <total>\`. Build 1 layer for each service with \`Layer.succeed\`. Combine them with \`Layer.mergeAll\`. Run \`placeOrder("book", 2)\` and then \`placeOrder("pen", 5)\` with 1 \`Effect.provide\`. Exact output:

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
        "Inside placeOrder, yield* each of the 3 tags first, then use them. R becomes the union of all 3.",
        "Layer.succeed(Tag, { ... }) takes a plain object that matches the shape. The parameter types are inferred from the tag.",
        "Layer.mergeAll(a, b, c) makes 1 Layer<Pricing | Inventory | Notifier>. Provide it once at the end."
      ]
    },
    {
      id: "requirements-management-p2",
      title: "A test double for the payment gateway",
      spec: `
\`checkout(amount)\` charges a card and prints the receipt id. It must not know which gateway it uses.

1. Define a \`Payments\` service with \`charge(amount): Effect<string>\`. \`charge\` returns a receipt id.
2. \`PaymentsLive\` prints \`stripe: charging <amount>\` and returns \`"stripe-<amount>"\`.
3. \`PaymentsFake\` adds the amount to a module-level \`charges: Array<number>\` and returns \`"fake-<amount>"\`. It prints nothing.
4. \`checkout(amount)\` calls \`charge\` and prints \`receipt <id>\`.

Run \`checkout(42)\` with the live layer. Then run \`checkout(42)\` and \`checkout(7)\` with the fake layer. Then print \`fake charges: <amounts joined by ", ">\`. Exact output:

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
        "Put the 2 fake checkouts in 1 Effect.gen and provide PaymentsFake once."
      ]
    },
    {
      id: "requirements-management-p3",
      title: "A three-level graph",
      spec: `
Connect a chain \`Config -> Database -> UserRepo\` and expose the correct services at the top.

1. \`Config\` holds \`{ env: string, dbUrl: string }\`. \`ConfigLive\` provides \`{ env: "prod", dbUrl: "postgres://prod" }\` with \`Layer.succeed\`.
2. \`Database\` has \`query(sql): Effect<Array<string>>\`. \`DatabaseLive\` is a \`Layer.effect\`. It reads \`Config\`, prints \`connecting to <dbUrl>\` once when it builds, and answers every query with \`["Ada", "Lin"]\`.
3. \`UserRepo\` has \`name(id): Effect<string>\`. \`UserRepoLive\` reads \`Database\`, queries \`"select name from users"\`, and returns the row at index \`id - 1\`.
4. \`AppLive\` must have the type \`Layer.Layer<UserRepo | Config>\`. It exposes \`UserRepo\` and \`Config\` but hides \`Database\`. Annotate it with that type so that the compiler checks it.

\`program\` prints \`user 1 is <name>\`, \`user 2 is <name>\`, then \`env: <env>\` from \`Config\`. Exact output:

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
        "Build from the bottom up: DatabaseLive needs Config, UserRepoLive needs Database. Hover over each layer to read its third type parameter.",
        "Layer.provide hides the layer that it provides. Layer.provideMerge keeps it visible. You need 1 of each.",
        "UserRepoLive.pipe(Layer.provide(DatabaseLive), Layer.provideMerge(ConfigLive)). After the first provide, the layer still needs Config. The second provide satisfies it and exposes it."
      ]
    }
  ],
  recall: [
    {
      q: "What does `R = never` at the top of a program guarantee?",
      a: "Every service that the program reads is provided. `runSync` and `runPromise` accept only `R = never`. A missing dependency is a compile error at the run call, not a runtime crash."
    },
    {
      q: "What is the type of `Effect.gen(function* () { const db = yield* Database; return yield* db.query(\"x\") })`, if `query` returns `Effect<string>`?",
      a: "`Effect<string, never, Database>`. The `yield* Database` added `Database` to `R`. The success type comes from `query`."
    },
    {
      q: "Which function satisfies 1 requirement with a value that you already have? Which function provides a whole graph of services?",
      a: "`Effect.provideService(Tag, impl)` for 1 value. `Effect.provide(layer)` for a layer or a combined graph of layers."
    },
    {
      q: "What is the difference between `Layer.provide` and `Layer.provideMerge`?",
      a: "Both provide one layer to another. `provide` exposes only the service of the layer that receives, and hides the dependency. `provideMerge` exposes both. Use `provide` for internal details. Use `provideMerge` when code that uses the graph also needs the dependency."
    },
    {
      q: "When do you use `Layer.succeed`, and when do you use `Layer.effect`?",
      a: "Use `Layer.succeed(Tag, impl)` when the implementation is a plain value with no setup. Use `Layer.effect(Tag, effect)` when the build is work: read config, open a connection, or get other services with `yield*`."
    },
    {
      q: "2 layers in the same graph both depend on `ConfigLive`. How many times is it built? How do you force a second build?",
      a: "Once. Effect memoizes layers by identity in 1 graph. Wrap 1 occurrence in `Layer.fresh(ConfigLive)` to force a separate build, for example to isolate a test."
    },
    {
      q: "When is `Context.Reference` the correct choice instead of `Context.Service`?",
      a: "When the service has a good default, for example a log level or a feature flag. A Reference never appears in `R`. The program runs without it, and `provideService` can still override it."
    }
  ]
}

export default section
