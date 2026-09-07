import type { Section } from "../types.ts"

const section: Section = {
  id: "configuration",
  title: "Configuration",
  order: 6,
  summary: "Describe the config that your app needs 1 time, validate it 1 time, and get typed values everywhere.",
  intro: `
**The problem.** In plain TypeScript, configuration is a string lookup. It happens at each place that needs a value:

\`\`\`ts
const port = Number(process.env.PORT!)                 // NaN if not set; nobody sees it until listen() fails
const debug = process.env.DEBUG === "true"             // "yes", "1", "TRUE" are all false
const host = process.env.DB_HOST ?? "localhost"        // the default is here, and in 3 other files
\`\`\`

Each line does its own parse, its own default, and its own error check (usually none). The \`!\` tells TypeScript to stop the check. An absent variable becomes \`undefined\`, then \`NaN\`, then an error deep in the program that is hard to understand. There is no list of the variables that the app needs. You must search the code for \`process.env\`. Tests change the real environment, or they skip the code that reads it.

### The shift

Today you think of config as values that you read from the environment. In Effect, config is a description of what you need. The description is separate from the source. \`Config.number("PORT")\` is a description: "read the key PORT and parse it as a number". Descriptions compose. You can add a default, make 1 value optional, put a group under a prefix, or combine several descriptions into 1 object. The result is a description, and it is also an effect. You \`yield*\` it like any other effect.

The source of the values is a service, the \`ConfigProvider\`. By default it reads environment variables. In tests, and in this playground, you provide a \`ConfigProvider\` that reads a plain object. The description does not change. A read is an effect, so an absent key or a bad value is a typed error, \`ConfigError\`. The error is in the error channel. It is reported 1 time, with the path of the key that failed. It is not a \`NaN\` at another place.

| | \`process.env\` | \`Config\` |
|---|---|---|
| Type of a value | Always \`string \\| undefined\` | \`number\`, \`boolean\`, a literal union, the type you asked for |
| Parse | By hand at each use | 1 time, by the description |
| Absent key | \`undefined\`, or a crash later | \`ConfigError\` with the key path, at load time |
| Defaults | \`??\` in many files | \`Config.withDefault\` on the description |
| Tests | Change \`process.env\` | Provide a \`ConfigProvider\` from an object |

This table lists the constructors that you use most:

| Description | Produces | Rejects |
|---|---|---|
| \`Config.string(key)\` | \`string\` | an absent key |
| \`Config.number(key)\` / \`Config.int(key)\` | \`number\` | a non-numeric value, a non-integer value |
| \`Config.boolean(key)\` | \`boolean\` | all values except true/false/yes/no/on/off/1/0 |
| \`Config.port(key)\` | \`number\` | an integer outside 1 to 65535 |
| \`Config.literals([...], key)\` | 1 of the listed values | all other values |

Every program in this section provides a \`ConfigProvider\` from a fixed object, so the output is stable. Note: the API here is the v4 API. The constructors are lowercase (\`Config.string\`, not \`Config.String\`).
`,
  lessons: [
    {
      id: "configuration-l1",
      title: "A Config is a description, and the provider is a service",
      explain: `
This small program shows 2 ideas. First, \`Config.string("HOST")\` does not read a value. It describes a read. You \`yield*\` it inside \`Effect.gen\` to do the read, like any other effect. A \`Config<A>\` is an \`Effect<A, ConfigError>\`.

Second, the read goes through the current \`ConfigProvider\`. The provider is a reference with a default value, and the default reads environment variables. In a real app you often provide nothing, and it works. Here we replace it with \`ConfigProvider.fromUnknown({...})\`. This provider reads a plain object. We install it with \`ConfigProvider.layer\`. Tests give an app its config in the same way, and they do not touch \`process.env\`.
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
      after: `Remove the \`Effect.provide(..., TestConfig)\` wrapper and run \`program\` directly. It reads the real environment. If \`HOST\` and \`PORT\` are not set, it fails with a \`ConfigError\` that names the absent key. Nothing else in the program changed.`
    },
    {
      id: "configuration-l2",
      title: "Typed values: number, int, boolean, port",
      explain: `
Environment variables are strings. In plain TypeScript, each reader converts the string itself:

\`\`\`ts
const port = Number(process.env.PORT)          // "abc" becomes NaN, with no error
const debug = process.env.DEBUG === "true"     // "yes" and "1" become false
\`\`\`

A Config description does the conversion and the validation 1 time. The value that you get has the type that you asked for. \`Config.number\` parses a number. \`Config.int\` also rejects a fraction. \`Config.boolean\` accepts the usual forms (\`true/false\`, \`yes/no\`, \`on/off\`, \`1/0\`). \`Config.port\` accepts only an integer from 1 to 65535.

Each of these constructors is \`Config.schema(SomeSchema, key)\`: a Config that a Schema defines. Any value that you can describe as a Schema can be a config value. The validation errors from Schema apply here too.
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
      after: `Change \`WORKERS\` to \`"4.5"\` and run again. \`Config.int\` fails with \`Expected an integer at ["WORKERS"]\`. Change \`PORT\` to \`"70000"\`, and \`Config.port\` rejects it. The validation happens where the value is read, and the message has the key path.`
    },
    {
      id: "configuration-l3",
      title: "Defaults and optional keys",
      explain: `
Not every key must be present. There are 2 meanings of "not present", and 2 combinators for them:

| Combinator | When the key is absent | Result type |
|---|---|---|
| \`Config.withDefault(value)\` | Use \`value\` | \`A\` |
| \`Config.option\` | Give \`Option.none()\` | \`Option<A>\` |

Use \`withDefault\` when there is a good fallback value. Use \`option\` when the program must do something different when the key is set. For example, the program turns on a feature only when its endpoint is configured.

Note: both combinators apply only to an **absent** key. A key that is present with a bad value (\`TIMEOUT_MS=soon\`) still fails with \`ConfigError\`. A default does not hide bad input.
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
      after: `The same \`program\` ran 2 times with 2 providers. This is how you test configuration: 1 description, many sources. Set \`TIMEOUT_MS: "soon"\` in \`full\`. The default does not apply, because the key is present and the value is wrong.`
    },
    {
      id: "configuration-l4",
      title: "Nested keys and prefixes",
      explain: `
Real config has groups: all values for the database, all values for the cache. A description reads a **path**, not only a key. \`Config.nested("DB")\` adds a segment in front of the path of the description that it wraps.

The provider decides how a path maps to the source:

| Provider | Path \`["DB", "HOST"]\` reads |
|---|---|
| \`ConfigProvider.fromUnknown({ DB: { HOST } })\` | The key in the nested object |
| \`ConfigProvider.fromEnv({ env })\` (and the default) | The variable \`DB_HOST\` (segments joined with \`_\`) |

The same description \`Config.string("HOST").pipe(Config.nested("DB"))\` reads \`{ DB: { HOST } }\` from an object and \`DB_HOST\` from environment variables. The description defines the structure. The provider defines the key names. \`ConfigProvider.nested\` does the same on the provider side, when you want to put a full provider under a prefix.
`,
      code: `import { Config, ConfigProvider, Effect } from "effect"

// One recipe: the "HOST" key inside the "DB" group
const dbHost = Config.string("HOST").pipe(Config.nested("DB"))

// Source 1: a nested object
const fromObject = ConfigProvider.fromUnknown({
  DB: { HOST: "db.internal", PORT: 5432 }
})

// Source 2: flat environment variables. The path ["DB", "HOST"] becomes DB_HOST.
const fromEnvVars = ConfigProvider.fromEnv({
  env: { DB_HOST: "10.0.0.7", DB_PORT: "5432" }
})

console.log(Effect.runSync(dbHost.parse(fromObject)))    // parse(provider) runs a recipe directly
console.log(Effect.runSync(dbHost.parse(fromEnvVars)))
`,
      expectedOutput: `db.internal
10.0.0.7`,
      after: `\`config.parse(provider)\` runs 1 description with 1 provider. \`ConfigProvider.layer\` is the form for a full program. Both use the same path logic. Note: the lookup is case-sensitive. The path \`["db", "host"]\` does not find \`DB_HOST\`. Use \`ConfigProvider.constantCase\` when your descriptions use camelCase keys and your variables use upper case.`
    },
    {
      id: "configuration-l5",
      title: "Combine descriptions into 1 typed object",
      explain: `
You can read keys 1 at a time inside a generator. A real app wants 1 \`AppConfig\` value that it can pass around. \`Config.all\` combines descriptions:

- With a record \`{ host: Config.string("HOST"), port: Config.port("PORT") }\`, it produces a \`Config<{ host: string; port: number }>\`.
- With a tuple \`[a, b]\`, it produces a tuple.

All combinators work together. You can put the full group under a prefix, add defaults to single fields, and get the TypeScript type with \`Config.Success<typeof AppConfig>\`. You do not write the interface 2 times.

For deep structures, \`Config.schema(Schema.Struct({...}), "prefix")\` reads a full object through a Schema in 1 step. Both forms work. \`Config.all\` reads well when the fields have different defaults. \`Config.schema\` reads well when you have a Schema for the shape.
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
      after: `Look at the type of \`AppConfig\` in an editor. The type of \`mode\` is the union \`"dev" | "prod"\`, not \`string\`. Change \`MODE\` to \`"staging"\` in the provider. The read fails with \`Expected "dev" | "prod"\`. Config is a good place for a literal union.`
    },
    {
      id: "configuration-l6",
      title: "ConfigError: 1 typed error, with the path",
      explain: `
Every read can fail, and the failure has 1 type: \`ConfigError\`. It has \`_tag: "ConfigError"\` and a \`cause\`. The cause is a \`SchemaError\` (the value was absent or did not match) or a \`SourceError\` (the provider cannot read its source, for example a file that does not exist). The message has the path of the key that failed.

The error is in the type. \`Effect.catchTag("ConfigError", ...)\` catches it like any other tagged error. A typical app does not catch it. The program fails at startup with a clear message. This is much better than a start with \`NaN\` as the port. Here we catch it, so we can print 3 cases in 1 run.
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
      after: `Note: \`attempt\` takes a \`Config.Config<unknown>\`. A Config is an effect. You can pass it, map it, and catch its error like any effect. An absent key reports "Expected string" at that path, because the schema got no value. Use \`Config.withDefault\` when an absent key is acceptable.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use the constructor that gives the type that you need: `Config.number`, `Config.int`, `Config.boolean`, `Config.port`.",
      dont: "Do not read every value with `Config.string` and convert it at the place of use.",
      why: "A string converted at the place of use gives `\"8080\" + 1 = \"80801\"` or `NaN`, and the compiler does not see the problem."
    },
    {
      do: "Add `Config.withDefault(value)` to the description of an optional key.",
      dont: "Do not write `?? value` after the read, in each file that reads the key.",
      why: "Without a default on the description, an absent key fails with `ConfigError`, and a default in many files is soon different in each file."
    },
    {
      do: "Use `Config.option` when the program must act differently when a key is absent.",
      dont: "Do not use an empty string as a default to mean \"not set\".",
      why: "`Option.none()` cannot be confused with a real value, and the type makes you decide what \"not set\" means."
    },
    {
      do: "Write `Config.string(\"host\").pipe(Config.nested(\"db\"))` for a key in a group.",
      dont: "Do not write `Config.string(\"db.host\")`.",
      why: "The key is 1 path segment; a dot in the key does not make a path, and the read fails with `ConfigError`."
    },
    {
      do: "Provide `ConfigProvider.layer(ConfigProvider.fromUnknown({...}))` in tests and in this playground.",
      dont: "Do not set `process.env.X` in a test.",
      why: "A change to `process.env` leaks into other tests, and the default provider reads the real environment."
    },
    {
      do: "Put the error type in the annotation: `Effect.Effect<Settings, Config.ConfigError>`.",
      dont: "Do not annotate an effect that reads config as `Effect.Effect<Settings>`.",
      why: "Each `Config` is an `Effect<A, ConfigError>`, and an annotation with `never` as the error type does not compile."
    },
    {
      do: "Combine descriptions with `Config.all` and get the type with `Config.Success<typeof AppConfig>`.",
      dont: "Do not write an interface by hand and read each key in a different function.",
      why: "A hand-written interface and the descriptions become different over time, and 1 `Config.all` reads the full object in 1 step."
    }
  ],
  challenges: [
    {
      id: "configuration-c1",
      title: "String arithmetic",
      task: `The program must print \`next port: 8081\`, but it prints \`next port: 80801\`. Change the description. Do not change the arithmetic.`,
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
        "What type does Config.string give? What does + do with that type?",
        "The description decides the type. Ask for a number.",
        "Use Config.number(\"PORT\"). Config.port also works."
      ],
      explanation: `\`Config.string\` gives a \`string\`. In JavaScript, \`"8080" + 1\` joins the 2 values into 1 string. This is the classic \`process.env\` bug. TypeScript cannot find it, because \`string + number\` is permitted. \`Config.number\` moves the parse into the description. Now \`port\` is a \`number\`, and the same expression adds. The rule: use the description that produces the type that you need. Do not parse a config string at the place of use.`
    },
    {
      id: "configuration-c2",
      title: "Crash on an absent key",
      task: `\`RETRIES\` is optional. When it is not set, the value must be \`3\`. Now the program crashes with a \`ConfigError\`. Make it print \`retries: 3\`. Do not add \`RETRIES\` to the provider.`,
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
        "An absent key is an error, unless the description says what to do.",
        "Lesson 3 shows 2 combinators for an absent key. You want a fixed fallback value.",
        "Pipe the description through Config.withDefault(3)."
      ],
      explanation: `A plain \`Config.int("RETRIES")\` means "RETRIES is required". The provider does not have it. The read fails with \`ConfigError\`, and \`runSync\` throws. \`Config.withDefault(3)\` changes the description to "RETRIES, or 3 when absent". The default is in 1 place, next to the description of the key. It is not at each place of use. A value that is present but not an integer still fails. That is correct.`
    },
    {
      id: "configuration-c3",
      title: "The annotation without the error",
      task: `The annotation of \`loadSettings\` says that it cannot fail, but a config read can fail. The program does not compile. Change the type annotation so that the program compiles and prints the line below. Do not remove the annotation. Do not catch the error.`,
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
        "Effect<Settings> is the short form of Effect<Settings, never, never>. What does never say about errors?",
        "A Config<A> is an Effect<A, ConfigError>. When you yield it, ConfigError is in the error channel.",
        "Change the annotation to Effect.Effect<Settings, Config.ConfigError>."
      ],
      explanation: `Each \`Config\` that you yield is an \`Effect<A, ConfigError>\`. The error type of the generator is \`ConfigError\`. The annotation \`Effect<Settings>\` says \`never\`, and the compiler rejects the difference. The annotation \`Effect<Settings, Config.ConfigError>\` is correct. Every caller now sees that the load can fail. The caller must catch the error or let it go to the top. At run time, the program works in both versions. This bug exists only in the types, and that is where you want to find it.`
    },
    {
      id: "configuration-c4",
      title: "A key with a dot is not a path",
      task: `The host is inside the \`db\` group, but the program fails with a \`ConfigError\`. Change the description so that the program prints \`db host: db.internal\`.`,
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
        "Read the error. The read looked for a top-level key with the name \"db.host\".",
        "A description reads a path of segments. Lesson 4 shows how to add a segment in front.",
        "Use Config.string(\"host\").pipe(Config.nested(\"db\"))."
      ],
      explanation: `The key that you give to \`Config.string\` is 1 path segment. It is not an expression with dots. \`"db.host"\` looked for a top-level key with a dot in its name. \`Config.nested("db")\` adds a segment in front. The path becomes \`["db", "host"]\`. The object provider finds the nested object, and the env provider reads \`DB_HOST\`. A path with segments is what permits 1 description to work with both sources.`
    },
    {
      id: "configuration-c5",
      title: "Print an Option",
      task: `\`REGION\` is optional. The program must print \`region: us-east\` when the key is set, and \`region: (none)\` when it is not set. It prints something else. Change how the value becomes text. Keep \`Config.option\`.`,
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
        "You must unwrap an Option. Option.getOrElse takes a fallback function.",
        "Use Option.getOrElse(r, () => \"(none)\")."
      ],
      explanation: `\`Config.option\` produces an \`Option<string>\`: \`Some(value)\` or \`None\`. When you add an Option to a string, JavaScript calls its \`toString\`. That is not the text that you want. \`Option.getOrElse\` unwraps the value, with a fallback for the \`None\` case. Use \`Option.match\` when the 2 cases need different behavior. The type made you decide what "not set" means. It did not let \`undefined\` go into the output.`
    },
    {
      id: "configuration-c6",
      title: "Not every number is a port",
      task: `\`PORT\` is set to \`70000\`. This is not a valid port. The program must reject the value and print the error message below, but it starts. Change the description. The output must be exactly:

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
        "Lesson 2 lists a description that knows the valid range of a port.",
        "Use Config.port(\"PORT\")."
      ],
      explanation: `\`Config.number\` checks only "is this a number". The value 70000 passes, and the app fails later when it opens the socket. \`Config.port\` is \`Config.schema(an integer from 1 to 65535, key)\`. The range check runs at load time, and the error names the key. When a value has a domain rule, put the rule in the description. The goal is to fail 1 time, early, with a message that says what is wrong and where.`
    }
  ],
  problems: [
    {
      id: "configuration-p1",
      title: "Application config, 2 environments",
      spec: `
Describe the config of an application 1 time and load it from 2 different sources.

Build \`AppConfig\` with \`Config.all\`. Its value must have this shape:

- \`name\`: a string from the key \`APP_NAME\`
- \`mode\`: 1 of \`"dev" | "prod"\` from the key \`MODE\`, default \`"dev"\`
- \`db\`: a group under the prefix \`db\` with \`host\` (a string) and \`port\` (a port, default \`5432\`)
- \`cache\`: an \`Option<string>\` from the key \`CACHE_URL\`

Write \`show(c)\`. It must return \`<name> mode=<mode> db=<host>:<port> cache=<url or off>\`. Write \`program\`. It must yield \`AppConfig\` and print \`show\`. Run it with these 2 providers, in this order:

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
        "Config.all takes a record of descriptions and gives 1 description for the full record. A Config.all can be a field of another Config.all.",
        "Put Config.nested(\"db\") on the inner Config.all. Put Config.withDefault on the fields that have defaults.",
        "Config.Success<typeof AppConfig> gives the type for show. Option.getOrElse converts the cache field."
      ]
    },
    {
      id: "configuration-p2",
      title: "Validate at startup, report clearly",
      spec: `
Write a startup check. It reads worker values from environment-style variables under the prefix \`WORKER\`, and it reports each outcome on 1 line.

- \`WorkerConfig\`: a \`Config.all\` of \`mode\` (\`Config.literals(["fast", "safe"], "MODE")\`), \`count\` (\`Config.int("COUNT")\`), and \`verbose\` (\`Config.boolean("VERBOSE")\` with the default \`false\`), nested under \`WORKER\`.
- \`check(label, env)\`: makes \`ConfigProvider.fromEnv({ env })\`, runs \`WorkerConfig.parse(provider)\`, and returns a string. On success, the string is \`<label>: ok mode=<mode> count=<count> verbose=<verbose>\`. On \`ConfigError\`, the string is \`<label>: <first line of e.message>\`. The first line is the text before the first newline.
- Run \`check\` for these 3 cases, in this order, and print each result:
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
        "Config.nested(\"WORKER\") on the Config.all makes the env provider read WORKER_MODE, WORKER_COUNT, and WORKER_VERBOSE.",
        "config.parse(provider) returns an Effect<A, ConfigError>. Map the success into a string. Then use catchTag(\"ConfigError\", ...) to make the error string.",
        "e.message.split(\"\\n\")[0] gives the first line of the message."
      ]
    }
  ],
  recall: [
    {
      q: "What is `Config.number(\"PORT\")` before you yield it?",
      a: "A description of a read. The read has not happened. The description is also an `Effect<number, ConfigError>`. `yield*` does the read through the current `ConfigProvider`."
    },
    {
      q: "What is the type of `Config.option(Config.string(\"REGION\"))`, and what do you get when the key is absent?",
      a: "`Config<Option<string>>`. An absent key gives `Option.none()`. A present key gives `Option.some(value)`. A present key with a bad value still fails with `ConfigError`."
    },
    {
      q: "How do you give a program fixed config in a test, without a change to `process.env`?",
      a: "Provide `ConfigProvider.layer(ConfigProvider.fromUnknown({ ... }))`. For environment-style names, use `ConfigProvider.fromEnv({ env: { ... } })`. The descriptions do not change. Only the provider changes."
    },
    {
      q: "Which function do you use to read `DB_HOST` and `DB_PORT` as 1 object?",
      a: "`Config.all({ host: Config.string(\"HOST\"), port: Config.port(\"PORT\") }).pipe(Config.nested(\"DB\"))`. `Config.all` combines descriptions into a struct. `Config.nested` adds the `DB` prefix to every path inside."
    },
    {
      q: "What is inside a `ConfigError`?",
      a: "`_tag: \"ConfigError\"` and a `cause`. The cause is a `SchemaError` (an absent key, or a value that did not match the schema, with the key path) or a `SourceError` (the provider cannot read its source). Catch it with `Effect.catchTag(\"ConfigError\", ...)`, or let the program fail at startup."
    },
    {
      q: "Does `Config.withDefault(3)` rescue a value like `RETRIES=three`?",
      a: "No. A default applies only when the key is absent. A key with a bad value still fails. Bad input is never replaced without an error."
    }
  ]
}

export default section
