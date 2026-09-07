import type { Section } from "../types.ts"

const section: Section = {
  id: "configuration",
  title: "Configuration",
  order: 6,
  summary: "Describe the config your app needs once, validate it once, and get typed values everywhere.",
  intro: `
**The problem.** Configuration in plain TypeScript is a string lookup that happens wherever someone needs a value:

\`\`\`ts
const port = Number(process.env.PORT!)                 // NaN if unset, nobody notices until listen() fails
const debug = process.env.DEBUG === "true"             // "yes", "1", "TRUE" are all false
const host = process.env.DB_HOST ?? "localhost"        // the default lives here, and in three other files
\`\`\`

Each line does its own parsing, its own defaulting, and its own error handling (usually none). The \`!\` tells TypeScript to stop worrying, so a missing variable becomes \`undefined\`, then \`NaN\`, then a confusing error deep in the program. The full set of variables the app needs exists nowhere except by grepping for \`process.env\`. Tests either mutate the real environment or skip the code that reads it.

### The shift

Today you think of config as **values you read from the environment**. Effect asks you to think of it as **a description of what you need, separate from where it comes from**. \`Config.number("PORT")\` is a recipe: "read the key PORT and parse it as a number". Recipes compose: add a default, mark one optional, nest a group under a prefix, combine several into a struct. The result is still a recipe, and it is also an Effect, so you \`yield*\` it like anything else.

Where the values come from is a service, the \`ConfigProvider\`. By default it reads environment variables. In tests, or in this playground, you provide one built from a plain object instead. The recipe does not change. And because reading is an effect, a missing or malformed key is a typed error, \`ConfigError\`, that shows up in the error channel and is reported once, with the path of the key that failed, instead of as \`NaN\` somewhere else.

| | \`process.env\` | \`Config\` |
|---|---|---|
| Type of a value | Always \`string \\| undefined\` | \`number\`, \`boolean\`, a literal union, whatever you asked for |
| Parsing | By hand at every use | Once, by the recipe |
| Missing key | \`undefined\`, or a crash later | \`ConfigError\` with the key path, at load time |
| Defaults | Scattered \`??\` | \`Config.withDefault\` on the recipe |
| Tests | Mutate \`process.env\` | Provide a \`ConfigProvider\` from an object |

The constructor family you will use most:

| Recipe | Produces | Rejects |
|---|---|---|
| \`Config.string(key)\` | \`string\` | missing key |
| \`Config.number(key)\` / \`Config.int(key)\` | \`number\` | non-numeric, non-integer |
| \`Config.boolean(key)\` | \`boolean\` | anything but true/false/yes/no/on/off/1/0 |
| \`Config.port(key)\` | \`number\` | integers outside 1 to 65535 |
| \`Config.literals([...], key)\` | one of the listed values | anything else |

Every program in this section provides a \`ConfigProvider\` from a fixed object so the output is stable. The API here is the v4 one: constructors are lowercase (\`Config.string\`, not \`Config.String\`).
`,
  lessons: [
    {
      id: "configuration-l1",
      title: "A Config is a recipe, and the provider is a service",
      explain: `
Two ideas in one small program. First, \`Config.string("HOST")\` does not read anything. It describes a read. You \`yield*\` it inside \`Effect.gen\` to perform the read, exactly like any other effect, because a \`Config<A>\` **is** an \`Effect<A, ConfigError>\`.

Second, the read goes through the current \`ConfigProvider\`. It is a reference with a default that reads environment variables, so in a real app you often provide nothing and it works. Here we swap it for \`ConfigProvider.fromUnknown({...})\`, a provider backed by a plain object, installed with \`ConfigProvider.layer\`. That is also how tests give an app its config without touching \`process.env\`.
`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

// Recipes. Nothing is read yet.
const host = Config.string("HOST")
const port = Config.string("PORT")

const program = Effect.gen(function* () {
  // yield* performs the read through the current ConfigProvider
  const h = yield* host
  const p = yield* port
  console.log("listening on " + h + ":" + p)
})

// The default provider reads process.env. This one reads a fixed object.
const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ HOST: "0.0.0.0", PORT: "8080" })
)

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `listening on 0.0.0.0:8080`,
      after: `Delete the \`Effect.provide(..., TestConfig)\` wrapper and run \`program\` directly: it reads the real environment, and unless you happen to have \`HOST\` and \`PORT\` set, it fails with a \`ConfigError\` naming the missing key. Nothing else in the program changed.`
    },
    {
      id: "configuration-l2",
      title: "Typed values: number, int, boolean, port",
      explain: `
Environment variables are strings. In plain TypeScript every reader converts on its own:

\`\`\`ts
const port = Number(process.env.PORT)          // "abc" becomes NaN, silently
const debug = process.env.DEBUG === "true"     // "yes" and "1" are treated as false
\`\`\`

A Config recipe does the conversion and the validation once, and the value you get out has the type you asked for. \`Config.number\` parses numbers, \`Config.int\` additionally rejects fractions, \`Config.boolean\` understands the usual spellings (\`true/false\`, \`yes/no\`, \`on/off\`, \`1/0\`), and \`Config.port\` accepts only integers from 1 to 65535.

Under the hood each of these is \`Config.schema(SomeSchema, key)\`: a Config built from a Schema. That means anything you can describe as a Schema can be a config value, and the same validation errors you get from Schema apply here.
`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ PORT: "8080", DEBUG: "yes", WORKERS: "4", RATIO: "0.25" })
)

const program = Effect.gen(function* () {
  const port = yield* Config.port("PORT")         // number, validated 1..65535
  const debug = yield* Config.boolean("DEBUG")    // "yes" is understood
  const workers = yield* Config.int("WORKERS")    // rejects "4.5"
  const ratio = yield* Config.number("RATIO")

  console.log("port", port, typeof port)
  console.log("debug", debug, typeof debug)
  console.log("workers + 1 =", workers + 1)        // real arithmetic, not "41"
  console.log("ratio", ratio)
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `port 8080 number
debug true boolean
workers + 1 = 5
ratio 0.25`,
      after: `Change \`WORKERS\` to \`"4.5"\` and run again: \`Config.int\` fails with \`Expected an integer at ["WORKERS"]\`. Change \`PORT\` to \`"70000"\` and \`Config.port\` rejects it. The validation happens where the value is read, with the key path in the message.`
    },
    {
      id: "configuration-l3",
      title: "Defaults and optional keys",
      explain: `
Not every key must be present. Two recipes cover the two meanings of "not present":

| Recipe | When the key is missing | Result type |
|---|---|---|
| \`Config.withDefault(value)\` | Use \`value\` | \`A\` |
| \`Config.option\` | Give \`Option.none()\` | \`Option<A>\` |

Use \`withDefault\` when there is a sensible fallback, and \`option\` when the program must behave differently depending on whether the key was set (for example, only enable a feature when its endpoint is configured).

An important detail: both only handle a **missing** key. A key that is present but malformed (\`TIMEOUT_MS=soon\`) still fails with \`ConfigError\`. A default is not a way to hide bad input.
`,
      code: `import { Config, ConfigProvider, Effect, Option } from "effect"

const timeoutMs = Config.number("TIMEOUT_MS").pipe(Config.withDefault(30000))
const region = Config.option(Config.string("REGION"))   // Config<Option<string>>

const program = Effect.gen(function* () {
  const t = yield* timeoutMs
  const r = yield* region
  const where = Option.match(r, {
    onNone: () => "no region pinned",
    onSome: (name) => "pinned to " + name
  })
  console.log("timeout " + t + "ms, " + where)
})

const minimal = ConfigProvider.layer(ConfigProvider.fromUnknown({}))
const full = ConfigProvider.layer(ConfigProvider.fromUnknown({ TIMEOUT_MS: "5000", REGION: "eu-west" }))

Effect.runSync(Effect.provide(program, minimal))
Effect.runSync(Effect.provide(program, full))
`,
      expectedOutput: `timeout 30000ms, no region pinned
timeout 5000ms, pinned to eu-west`,
      after: `The same \`program\` ran twice against two providers. That is the test story for configuration: one description, many sources. Try \`TIMEOUT_MS: "soon"\` in \`full\`: the default does not apply, because the key is present and wrong.`
    },
    {
      id: "configuration-l4",
      title: "Nested keys and prefixes",
      explain: `
Real config has groups: everything about the database, everything about the cache. A recipe reads a **path**, not only a single key, and \`Config.nested("db")\` prepends a segment to the path of the recipe it wraps.

How a path maps onto the source depends on the provider:

| Provider | Path \`["db", "host"]\` looks up |
|---|---|
| \`ConfigProvider.fromUnknown({ db: { host } })\` | The nested object key |
| \`ConfigProvider.fromEnv({ env })\` (and the default) | The variable \`db_host\` (segments joined with \`_\`) |

So the same recipe \`Config.string("host").pipe(Config.nested("db"))\` reads \`{ db: { host } }\` from a JSON-like object and \`DB_HOST\` from environment variables. The recipe describes structure; the provider decides spelling. \`ConfigProvider.nested\` does the same thing on the provider side when you want to scope an entire provider under a prefix.
`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

// One recipe: the "host" key inside the "db" group
const dbHost = Config.string("host").pipe(Config.nested("db"))

// Source 1: a nested object
const fromObject = ConfigProvider.fromUnknown({
  db: { host: "db.internal", port: 5432 }
})

// Source 2: flat environment variables. The path ["db", "host"] becomes DB_HOST.
const fromEnvVars = ConfigProvider.fromEnv({
  env: { DB_HOST: "10.0.0.7", DB_PORT: "5432" }
})

console.log(Effect.runSync(dbHost.parse(fromObject)))    // parse(provider) runs a recipe directly
console.log(Effect.runSync(dbHost.parse(fromEnvVars)))
`,
      expectedOutput: `db.internal
10.0.0.7`,
      after: `\`config.parse(provider)\` is a shortcut for running one recipe against one provider; \`ConfigProvider.layer\` is what you use for a whole program. Both go through the same path logic. Notice that the env provider matched \`DB_HOST\` for the lowercase path \`["db", "host"]\`: lookups are case-insensitive on that provider.`
    },
    {
      id: "configuration-l5",
      title: "Combining recipes into one typed object",
      explain: `
Reading keys one at a time inside a generator works, but a real app wants one \`AppConfig\` value it can pass around. \`Config.all\` combines recipes:

- Given a record \`{ host: Config.string("HOST"), port: Config.port("PORT") }\` it produces a \`Config<{ host: string; port: number }>\`.
- Given a tuple \`[a, b]\` it produces a tuple.

Everything composes: nest the whole group under a prefix, add defaults to individual fields, and derive the TypeScript type with \`Config.Success<typeof AppConfig>\` so you never write the interface twice.

For deeply structured config, \`Config.schema(Schema.Struct({...}), "prefix")\` reads a whole object through a Schema in one go. Both work; \`Config.all\` reads well when fields have different defaults, \`Config.schema\` when you already have a Schema for the shape.
`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const DbConfig = Config.all({
  host: Config.string("host"),
  port: Config.port("port").pipe(Config.withDefault(5432)),
  ssl: Config.boolean("ssl").pipe(Config.withDefault(false))
}).pipe(Config.nested("db"))

const AppConfig = Config.all({
  name: Config.string("APP_NAME"),
  mode: Config.literals(["dev", "prod"], "MODE"),
  db: DbConfig
})

// Derive the type instead of writing it by hand
type AppConfig = Config.Success<typeof AppConfig>

const describe = (c: AppConfig) =>
  c.name + " [" + c.mode + "] -> " + c.db.host + ":" + c.db.port + (c.db.ssl ? " (ssl)" : "")

const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    APP_NAME: "orders",
    MODE: "prod",
    db: { host: "db.internal", ssl: "true" }   // port falls back to 5432
  })
)

const program = Effect.gen(function* () {
  const config = yield* AppConfig      // one read, one typed object
  console.log(describe(config))
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `orders [prod] -> db.internal:5432 (ssl)`,
      after: `Hover \`AppConfig\` in an editor: \`mode\` is the union \`"dev" | "prod"\`, not \`string\`. Change \`MODE\` to \`"staging"\` in the provider and the read fails with \`Expected "dev" | "prod"\`. Config is where a literal union earns its keep.`
    },
    {
      id: "configuration-l6",
      title: "ConfigError: one typed error, with the path",
      explain: `
Every read can fail, and the failure is one error type: \`ConfigError\`. It has \`_tag: "ConfigError"\` and a \`cause\` that is either a \`SchemaError\` (the value was missing or did not match) or a \`SourceError\` (the provider itself could not be read, for example a file that does not exist). The message includes the path of the offending key.

Because the error is in the type, \`Effect.catchTag("ConfigError", ...)\` handles it like any other tagged error. A typical app does not catch it at all: it lets the program fail at startup with a clear message, which is far better than starting with \`NaN\` as a port. Here we catch it so we can print several cases in one run.
`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ PORT: "70000", MODE: "staging" })
)

// Try a recipe and report the outcome instead of crashing
const attempt = (label: string, config: Config.Config<unknown>) =>
  config.pipe(
    Effect.map((value) => label + ": ok " + String(value)),
    Effect.catchTag("ConfigError", (e) => Effect.succeed(label + ": " + e.cause._tag + " - " + e.message))
  )

const program = Effect.gen(function* () {
  console.log(yield* attempt("mode", Config.literals(["dev", "prod"], "MODE")))
  console.log(yield* attempt("port", Config.port("PORT")))
  console.log(yield* attempt("missing", Config.string("API_KEY")))
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `mode: SchemaError - SchemaError(Expected "dev" | "prod"
  at ["MODE"])
port: SchemaError - SchemaError(Expected a value between 1 and 65535
  at ["PORT"])
missing: SchemaError - SchemaError(Expected string
  at ["API_KEY"])`,
      after: `Note that \`attempt\` takes a \`Config.Config<unknown>\`: a Config is an Effect, so it can be passed around, mapped, and caught like one. A missing key reports as "Expected string" at that path, because the schema received nothing. \`Config.withDefault\` is the tool when that is acceptable.`
    }
  ],
  challenges: [
    {
      id: "configuration-c1",
      title: "String arithmetic",
      task: `The program should print \`next port: 8081\` but prints \`next port: 80801\`. Fix the recipe, not the arithmetic.`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ PORT: "8080" }))

const program = Effect.gen(function* () {
  const port = yield* Config.string("PORT")
  console.log("next port: " + (port + 1))
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      solution: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ PORT: "8080" }))

const program = Effect.gen(function* () {
  const port = yield* Config.number("PORT")
  console.log("next port: " + (port + 1))
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `next port: 8081`,
      hints: [
        "What type does Config.string give you? What does + do with that type?",
        "The recipe decides the type. Ask for a number.",
        "Use Config.number(\"PORT\") (Config.port also works)."
      ],
      explanation: `\`Config.string\` hands back a \`string\`, and \`"8080" + 1\` is string concatenation in JavaScript. This is the classic \`process.env\` bug, and TypeScript cannot catch it because \`string + number\` is legal. Asking for \`Config.number\` moves the parsing into the recipe, so \`port\` is a real \`number\` and the same expression adds. The lesson: choose the recipe that produces the type you need, and never parse a config string at the use site.`
    },
    {
      id: "configuration-c2",
      title: "Crash on a missing key",
      task: `\`RETRIES\` is optional and should fall back to \`3\` when it is not set. Right now the program crashes with a \`ConfigError\`. Make it print \`retries: 3\` without adding \`RETRIES\` to the provider.`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOST: "api.internal" }))

const retries = Config.int("RETRIES")

const program = Effect.gen(function* () {
  const n = yield* retries
  console.log("retries: " + n)
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      solution: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOST: "api.internal" }))

const retries = Config.int("RETRIES").pipe(Config.withDefault(3))

const program = Effect.gen(function* () {
  const n = yield* retries
  console.log("retries: " + n)
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `retries: 3`,
      hints: [
        "A missing key is an error unless the recipe says what to do about it.",
        "Lesson 3 shows two recipes for absent keys. You want a concrete fallback value.",
        "Pipe the recipe through Config.withDefault(3)."
      ],
      explanation: `A bare \`Config.int("RETRIES")\` means "RETRIES is required". The provider does not have it, so the read fails with \`ConfigError\` and \`runSync\` throws. \`Config.withDefault(3)\` changes the recipe's meaning to "RETRIES, or 3 when absent", and the default lives in one place next to the description of the key rather than at every use site. A present but non-integer value would still fail, which is what you want.`
    },
    {
      id: "configuration-c3",
      title: "The annotation that forgot the error",
      task: `\`loadSettings\` is annotated as an effect that cannot fail, but reading config can. The program does not compile. Fix the type annotation so it compiles and prints the line below. Do not remove the annotation or catch the error.`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

interface Settings {
  readonly host: string
  readonly port: number
}

const loadSettings: Effect.Effect<Settings> = Effect.gen(function* () {
  const host = yield* Config.string("HOST")
  const port = yield* Config.port("PORT")
  return { host, port }
})

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOST: "localhost", PORT: "3000" }))

const settings = Effect.runSync(Effect.provide(loadSettings, TestConfig))
console.log(settings.host + ":" + settings.port)
`,
      solution: `import { Config, ConfigProvider, Effect } from "effect"

interface Settings {
  readonly host: string
  readonly port: number
}

const loadSettings: Effect.Effect<Settings, Config.ConfigError> = Effect.gen(function* () {
  const host = yield* Config.string("HOST")
  const port = yield* Config.port("PORT")
  return { host, port }
})

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOST: "localhost", PORT: "3000" }))

const settings = Effect.runSync(Effect.provide(loadSettings, TestConfig))
console.log(settings.host + ":" + settings.port)
`,
      expectedOutput: `localhost:3000`,
      hints: [
        "Effect<Settings> is short for Effect<Settings, never, never>. What does never promise about errors?",
        "A Config<A> is an Effect<A, ConfigError>. Yielding one puts ConfigError in the error channel.",
        "Change the annotation to Effect.Effect<Settings, Config.ConfigError>."
      ],
      explanation: `Each \`Config\` you yield is an \`Effect<A, ConfigError>\`, so the generator's error type is \`ConfigError\`. The annotation \`Effect<Settings>\` claims \`never\`, and the compiler refuses the mismatch. Admitting \`Config.ConfigError\` in the annotation is honest: any caller now sees that loading settings can fail and must either handle it or let it propagate to the top. The program runs fine at runtime either way; this bug exists only in the types, which is exactly where you want to find it.`
    },
    {
      id: "configuration-c4",
      title: "Dotted keys are not paths",
      task: `The host lives inside the \`db\` group, but the program fails with a \`ConfigError\`. Fix the recipe so it prints \`db host: db.internal\`.`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ db: { host: "db.internal", port: 5432 } })
)

const dbHost = Config.string("db.host")

const program = Effect.gen(function* () {
  console.log("db host: " + (yield* dbHost))
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      solution: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ db: { host: "db.internal", port: 5432 } })
)

const dbHost = Config.string("host").pipe(Config.nested("db"))

const program = Effect.gen(function* () {
  console.log("db host: " + (yield* dbHost))
})

Effect.runSync(Effect.provide(program, TestConfig))
`,
      expectedOutput: `db host: db.internal`,
      hints: [
        "Read the error: it looked for a key literally named \"db.host\" at the top level.",
        "A recipe reads a path of segments. Lesson 4 shows how to add a segment in front.",
        "Use Config.string(\"host\").pipe(Config.nested(\"db\"))."
      ],
      explanation: `The key you pass to \`Config.string\` is one path segment, not a dotted expression, so \`"db.host"\` looked for a top-level key with a dot in its name. \`Config.nested("db")\` prepends a segment, making the path \`["db", "host"]\`, which the object provider resolves into the nested object and the env provider resolves as \`DB_HOST\`. Keeping paths structural is what lets one recipe work against both kinds of source.`
    },
    {
      id: "configuration-c5",
      title: "Printing an Option",
      task: `\`REGION\` is optional. The program should print \`region: us-east\` when it is set and \`region: (none)\` when it is not, but it prints something else. Fix how the value is turned into text; keep \`Config.option\`.`,
      code: `import { Config, ConfigProvider, Effect, Option } from "effect"

const region = Config.option(Config.string("REGION"))

const program = Effect.gen(function* () {
  const r = yield* region
  console.log("region: " + r)
})

Effect.runSync(Effect.provide(program, ConfigProvider.layer(ConfigProvider.fromUnknown({ REGION: "us-east" }))))
Effect.runSync(Effect.provide(program, ConfigProvider.layer(ConfigProvider.fromUnknown({}))))
`,
      solution: `import { Config, ConfigProvider, Effect, Option } from "effect"

const region = Config.option(Config.string("REGION"))

const program = Effect.gen(function* () {
  const r = yield* region
  console.log("region: " + Option.getOrElse(r, () => "(none)"))
})

Effect.runSync(Effect.provide(program, ConfigProvider.layer(ConfigProvider.fromUnknown({ REGION: "us-east" }))))
Effect.runSync(Effect.provide(program, ConfigProvider.layer(ConfigProvider.fromUnknown({}))))
`,
      expectedOutput: `region: us-east
region: (none)`,
      hints: [
        "What is the type of r? It is not a string.",
        "An Option must be unwrapped. Option.getOrElse takes a fallback.",
        "Use Option.getOrElse(r, () => \"(none)\")."
      ],
      explanation: `\`Config.option\` produces an \`Option<string>\`: \`Some(value)\` or \`None\`. Concatenating an Option into a string calls its \`toString\`, which is not what you want. \`Option.getOrElse\` unwraps it with a fallback for the \`None\` case, and \`Option.match\` is the choice when the two cases need different behavior. The type made you decide what "not set" means instead of letting \`undefined\` slip into the output.`
    },
    {
      id: "configuration-c6",
      title: "Not every number is a port",
      task: `\`PORT\` is set to \`70000\`, which is not a valid port. The program should reject it and print the error message below, but it happily starts. Fix the recipe. The output must be exactly:

\`\`\`
invalid config: SchemaError(Expected a value between 1 and 65535
  at ["PORT"])
\`\`\``,
      code: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ PORT: "70000" }))

const program = Config.number("PORT").pipe(
  Effect.map((port) => "listening on " + port),
  Effect.catchTag("ConfigError", (e) => Effect.succeed("invalid config: " + e.message))
)

console.log(Effect.runSync(Effect.provide(program, TestConfig)))
`,
      solution: `import { Config, ConfigProvider, Effect } from "effect"

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ PORT: "70000" }))

const program = Config.port("PORT").pipe(
  Effect.map((port) => "listening on " + port),
  Effect.catchTag("ConfigError", (e) => Effect.succeed("invalid config: " + e.message))
)

console.log(Effect.runSync(Effect.provide(program, TestConfig)))
`,
      expectedOutput: `invalid config: SchemaError(Expected a value between 1 and 65535
  at ["PORT"])`,
      hints: [
        "Config.number accepts any number. 70000 is a number.",
        "Lesson 2 lists a recipe that knows the valid range of a port.",
        "Use Config.port(\"PORT\")."
      ],
      explanation: `\`Config.number\` only checks "is this a number", so 70000 passes and the app would fail later when it tries to bind the socket. \`Config.port\` is \`Config.schema(Int between 1 and 65535, key)\`, so the range check runs at load time and the error names the key. Whenever a value has a domain rule, put it in the recipe: the whole point is to fail once, early, with a message that says what is wrong and where.`
    }
  ],
  problems: [
    {
      id: "configuration-p1",
      title: "Application config, two environments",
      spec: `
Describe an application's config once and load it from two different sources.

Build \`AppConfig\` with \`Config.all\` so that its value has this shape:

- \`name\`: string from key \`APP_NAME\`
- \`mode\`: one of \`"dev" | "prod"\` from key \`MODE\`, default \`"dev"\`
- \`db\`: a group under prefix \`db\` with \`host\` (string) and \`port\` (port, default \`5432\`)
- \`cache\`: \`Option<string>\` from key \`CACHE_URL\`

Write \`show(c)\` returning \`<name> mode=<mode> db=<host>:<port> cache=<url or off>\`, and \`program\` that yields \`AppConfig\` and prints \`show\`. Run it against these two providers, in order:

1. \`{ APP_NAME: "orders", db: { host: "localhost" } }\`
2. \`{ APP_NAME: "orders", MODE: "prod", db: { host: "db.internal", port: "6543" }, CACHE_URL: "redis://cache" }\`

Exact output:

\`\`\`
orders mode=dev db=localhost:5432 cache=off
orders mode=prod db=db.internal:6543 cache=redis://cache
\`\`\`
`,
      starter: `import { Config, ConfigProvider, Effect, Option } from "effect"

// TODO: AppConfig with Config.all (name, mode, db, cache)

// TODO: show(c) => "<name> mode=<mode> db=<host>:<port> cache=<url or off>"

const program = Effect.gen(function* () {
  // TODO: read AppConfig and print show(config)
})

const local = ConfigProvider.layer(ConfigProvider.fromUnknown({ APP_NAME: "orders", db: { host: "localhost" } }))
const prod = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    APP_NAME: "orders",
    MODE: "prod",
    db: { host: "db.internal", port: "6543" },
    CACHE_URL: "redis://cache"
  })
)

Effect.runSync(Effect.provide(program, local))
Effect.runSync(Effect.provide(program, prod))
`,
      solution: `import { Config, ConfigProvider, Effect, Option } from "effect"

const AppConfig = Config.all({
  name: Config.string("APP_NAME"),
  mode: Config.literals(["dev", "prod"], "MODE").pipe(Config.withDefault("dev")),
  db: Config.all({
    host: Config.string("host"),
    port: Config.port("port").pipe(Config.withDefault(5432))
  }).pipe(Config.nested("db")),
  cache: Config.option(Config.string("CACHE_URL"))
})

type AppConfig = Config.Success<typeof AppConfig>

const show = (c: AppConfig) =>
  c.name + " mode=" + c.mode + " db=" + c.db.host + ":" + c.db.port +
  " cache=" + Option.getOrElse(c.cache, () => "off")

const program = Effect.gen(function* () {
  const config = yield* AppConfig
  console.log(show(config))
})

const local = ConfigProvider.layer(ConfigProvider.fromUnknown({ APP_NAME: "orders", db: { host: "localhost" } }))
const prod = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    APP_NAME: "orders",
    MODE: "prod",
    db: { host: "db.internal", port: "6543" },
    CACHE_URL: "redis://cache"
  })
)

Effect.runSync(Effect.provide(program, local))
Effect.runSync(Effect.provide(program, prod))
`,
      expectedOutput: `orders mode=dev db=localhost:5432 cache=off
orders mode=prod db=db.internal:6543 cache=redis://cache`,
      hints: [
        "Config.all takes a record of recipes and gives one recipe for the whole record. It nests: a Config.all can be a field of another Config.all.",
        "Put Config.nested(\"db\") on the inner Config.all, and Config.withDefault on the individual fields that have defaults.",
        "Config.Success<typeof AppConfig> gives you the type for show. Option.getOrElse handles the cache field."
      ]
    },
    {
      id: "configuration-p2",
      title: "Validate at startup, report clearly",
      spec: `
Write a startup check that reads worker settings from environment-style variables under the prefix \`WORKER\` and reports every outcome on one line.

- \`WorkerConfig\`: \`Config.all\` of \`mode\` (\`Config.literals(["fast", "safe"], "MODE")\`), \`count\` (\`Config.int("COUNT")\`), and \`verbose\` (\`Config.boolean("VERBOSE")\` with default \`false\`), nested under \`WORKER\`.
- \`check(label, env)\`: builds \`ConfigProvider.fromEnv({ env })\`, runs \`WorkerConfig.parse(provider)\`, and returns a string: \`<label>: ok mode=<mode> count=<count> verbose=<verbose>\` on success, or \`<label>: <first line of e.message>\` on \`ConfigError\`, where the first line is everything before the first newline.
- Run \`check\` for these three, in order, printing each result:
  1. \`"a"\`, \`{ WORKER_MODE: "fast", WORKER_COUNT: "4" }\`
  2. \`"b"\`, \`{ WORKER_MODE: "turbo", WORKER_COUNT: "4" }\`
  3. \`"c"\`, \`{ WORKER_MODE: "safe", WORKER_COUNT: "2", WORKER_VERBOSE: "on" }\`

Exact output:

\`\`\`
a: ok mode=fast count=4 verbose=false
b: SchemaError(Expected "fast" | "safe"
c: ok mode=safe count=2 verbose=true
\`\`\`
`,
      starter: `import { Config, ConfigProvider, Effect } from "effect"

// TODO: WorkerConfig (mode, count, verbose) nested under "WORKER"

// TODO: check(label, env) => Effect<string>

const program = Effect.gen(function* () {
  console.log(yield* check("a", { WORKER_MODE: "fast", WORKER_COUNT: "4" }))
  console.log(yield* check("b", { WORKER_MODE: "turbo", WORKER_COUNT: "4" }))
  console.log(yield* check("c", { WORKER_MODE: "safe", WORKER_COUNT: "2", WORKER_VERBOSE: "on" }))
})

Effect.runSync(program)
`,
      solution: `import { Config, ConfigProvider, Effect } from "effect"

const WorkerConfig = Config.all({
  mode: Config.literals(["fast", "safe"], "MODE"),
  count: Config.int("COUNT"),
  verbose: Config.boolean("VERBOSE").pipe(Config.withDefault(false))
}).pipe(Config.nested("WORKER"))

const check = (label: string, env: Record<string, string>): Effect.Effect<string> =>
  WorkerConfig.parse(ConfigProvider.fromEnv({ env })).pipe(
    Effect.map((c) => label + ": ok mode=" + c.mode + " count=" + c.count + " verbose=" + c.verbose),
    Effect.catchTag("ConfigError", (e) => Effect.succeed(label + ": " + e.message.split("\\n")[0]))
  )

const program = Effect.gen(function* () {
  console.log(yield* check("a", { WORKER_MODE: "fast", WORKER_COUNT: "4" }))
  console.log(yield* check("b", { WORKER_MODE: "turbo", WORKER_COUNT: "4" }))
  console.log(yield* check("c", { WORKER_MODE: "safe", WORKER_COUNT: "2", WORKER_VERBOSE: "on" }))
})

Effect.runSync(program)
`,
      expectedOutput: `a: ok mode=fast count=4 verbose=false
b: SchemaError(Expected "fast" | "safe"
c: ok mode=safe count=2 verbose=true`,
      hints: [
        "Config.nested(\"WORKER\") on the Config.all makes the env provider look up WORKER_MODE, WORKER_COUNT, WORKER_VERBOSE.",
        "config.parse(provider) returns an Effect<A, ConfigError>. Map the success into a string, then catchTag(\"ConfigError\", ...) into the error string.",
        "e.message.split(\"\\n\")[0] gives the first line of the message."
      ]
    }
  ],
  recall: [
    {
      q: "What is `Config.number(\"PORT\")` before you yield it?",
      a: "A recipe: a description of a read that has not happened. It is also an `Effect<number, ConfigError>`, so `yield*` performs the read through the current `ConfigProvider`."
    },
    {
      q: "What would the type of `Config.option(Config.string(\"REGION\"))` be, and what does yielding it give you when the key is missing?",
      a: "`Config<Option<string>>`. A missing key gives `Option.none()`; a present key gives `Option.some(value)`. A present but malformed value still fails with `ConfigError`."
    },
    {
      q: "How do you give a program fixed config in a test without touching `process.env`?",
      a: "Provide `ConfigProvider.layer(ConfigProvider.fromUnknown({ ... }))` (or `ConfigProvider.fromEnv({ env: { ... } })` for env-style names). The recipes do not change; only the provider does."
    },
    {
      q: "Which function would you reach for to read `DB_HOST` and `DB_PORT` as one object?",
      a: "`Config.all({ host: Config.string(\"HOST\"), port: Config.port(\"PORT\") }).pipe(Config.nested(\"DB\"))`. `Config.all` combines recipes into a struct and `Config.nested` adds the `DB` prefix to every path inside."
    },
    {
      q: "What is inside a `ConfigError`?",
      a: "`_tag: \"ConfigError\"` and a `cause` that is either a `SchemaError` (missing key or value did not match the schema, with the key path) or a `SourceError` (the provider could not be read). Handle it with `Effect.catchTag(\"ConfigError\", ...)`, or let it fail the program at startup."
    },
    {
      q: "Does `Config.withDefault(3)` rescue a value like `RETRIES=three`?",
      a: "No. Defaults apply only when the key is absent. A present but invalid value still fails, so bad input is never silently replaced."
    }
  ]
}

export default section
