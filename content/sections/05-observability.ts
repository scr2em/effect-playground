import type { Section } from "../types.ts"

const section: Section = {
  id: "observability",
  title: "Observability",
  order: 5,
  summary: "Logs, spans, and metrics as effects that carry their context with them.",
  intro: `
**The problem.** Production code needs to answer "what happened?" after the fact. In plain TypeScript that turns into \`console.log\` sprinkled through every function, each line hand-assembling its own context:

\`\`\`ts
async function chargeCard(order: Order) {
  console.log(\`[\${new Date().toISOString()}] [INFO] charging order \${order.id} for user \${order.userId}\`)
  const result = await gateway.charge(order)
  console.log(\`[\${new Date().toISOString()}] [INFO] charged order \${order.id} for user \${order.userId} in \${Date.now() - start}ms\`)
}
\`\`\`

Every line repeats the order id and user id. Forget one and that log line is useless when you grep for the order. Timing is done with \`Date.now()\` by hand. And when the team later "adds observability", tracing and metrics are bolted on with a global APM agent that has no idea which request a given function call belongs to, because that context lives in closures and local variables the agent cannot see.

### The shift

Today you think of logging as **printing strings from inside a function**. Effect asks you to think of a log line, a span, and a metric update as **effects that run inside a fiber**, and the fiber carries context with it. When you write \`Effect.annotateLogs(handler, { requestId })\`, every log line inside \`handler\`, at any depth, gets \`requestId\` attached without you passing it around. When you wrap an effect in \`Effect.withSpan("charge")\`, every span created inside it becomes a child, so the trace tree mirrors your call tree.

The logger, the tracer, and the metric registry are all services. That is the payoff: swap the logger for a JSON logger in production, a silent one in tests, or a plain one in this playground, without touching a single \`Effect.log\` call. Export spans to OpenTelemetry by providing one layer at the edge of the app.

| Concern | Plain TypeScript | Effect |
|---|---|---|
| Log a line | \`console.log("...")\` with manual formatting | \`Effect.logInfo("...")\`, format decided by the \`Logger\` service |
| Attach context | Pass ids into every function and interpolate them | \`Effect.annotateLogs\` once, inherited by everything inside |
| Time an operation | \`Date.now()\` before and after | \`Effect.withSpan("name")\`, nested automatically |
| Count things | A module-level \`let count = 0\` | \`Metric.counter("name")\`, read with \`Metric.value\` |
| Change the backend | Rewrite call sites | Provide a different layer |

One practical note for this playground: the default logger prints a timestamp and a fiber id on every line, so its output changes on every run. The first lesson builds a small deterministic logger and uses it everywhere after that. That is also the first real lesson: the logger is a service you own.
`,
  lessons: [
    {
      id: "observability-l1",
      title: "Replacing the logger",
      explain: `
\`Effect.log\` and its siblings do not print anything themselves. They send a log event to whatever \`Logger\` services are currently installed. The default logger prints a line like this:

\`\`\`
[13:42:07.118] INFO (#12): starting v1
\`\`\`

That timestamp and fiber number make output impossible to compare in a test or in this playground. So the very first thing to learn is that the logger is replaceable.

\`Logger.make\` takes a function that receives the log event: the \`message\` (an array, because \`Effect.log("a", 1)\` accepts several values), the \`logLevel\`, the \`fiber\`, a \`cause\`, and a \`date\`. Our logger builds a short string and prints it with \`console.log\`.

\`Logger.layer([plain])\` is a layer that **replaces** the current set of loggers with the ones you list. Provide it around the program and every \`Effect.log\` inside now goes to \`plain\` only. Nothing inside the program changed.
`,
      code: `import { Effect, Logger } from "effect"

// A Logger is a service. This one prints only the level and the message,
// so the output is stable from run to run.
const plain = Logger.make<unknown, void>(({ logLevel, message }) => {
  const text = Array.isArray(message) ? message.join(" ") : String(message)
  console.log("[" + logLevel + "] " + text)
})

const program = Effect.gen(function* () {
  yield* Effect.log("starting", "v1")       // Effect.log uses the Info level
  yield* Effect.logInfo("loaded 3 users")
  yield* Effect.logWarning("cache miss")
  yield* Effect.logError("payment declined")
})

// Logger.layer([...]) REPLACES the default loggers with the ones listed
Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      expectedOutput: `[Info] starting v1
[Info] loaded 3 users
[Warn] cache miss
[Error] payment declined`,
      after: `Remove the \`Effect.provide(Logger.layer([plain]))\` line and run again. The same four lines appear, but from the default logger, with timestamps. Add \`{ mergeWithExisting: true }\` as a second argument to \`Logger.layer\` and you get both. The program never changed, only the service.`
    },
    {
      id: "observability-l2",
      title: "Log levels and the minimum level",
      explain: `
Every log call has a level. From most to least severe:

| Function | Level | Shown by default? |
|---|---|---|
| \`Effect.logFatal\` | Fatal | yes |
| \`Effect.logError\` | Error | yes |
| \`Effect.logWarning\` | Warn | yes |
| \`Effect.logInfo\` / \`Effect.log\` | Info | yes |
| \`Effect.logDebug\` | Debug | no |
| \`Effect.logTrace\` | Trace | no |

The cut-off is a fiber-local setting called \`References.MinimumLogLevel\`. Its default is \`"Info"\`, which is why debug lines vanish. In Effect v4 this kind of setting is a \`Context.Reference\`: a service with a default value, which you override for a region of the program with \`Effect.provideService\` (or with \`Layer.succeed\` when building layers).

The filter is applied before the logger is called, so a filtered line costs almost nothing. This is how you keep \`logDebug\` calls in the code and turn them on only when you need them.
`,
      code: `import { Effect, Logger, References } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message }) => {
  console.log("[" + logLevel + "] " + (Array.isArray(message) ? message.join(" ") : String(message)))
})

const work = Effect.gen(function* () {
  yield* Effect.logDebug("query plan: index scan")
  yield* Effect.logInfo("found 2 rows")
  yield* Effect.logWarning("slow query")
})

const runAt = (level: "Debug" | "Info" | "Warn") => {
  console.log("-- minimum " + level)
  Effect.runSync(
    work.pipe(
      Effect.provideService(References.MinimumLogLevel, level),  // override the reference for this region
      Effect.provide(Logger.layer([plain]))
    )
  )
}

runAt("Info")   // the default: Debug is hidden
runAt("Debug")  // everything
runAt("Warn")   // only Warn and above
`,
      expectedOutput: `-- minimum Info
[Info] found 2 rows
[Warn] slow query
-- minimum Debug
[Debug] query plan: index scan
[Info] found 2 rows
[Warn] slow query
-- minimum Warn
[Warn] slow query`,
      after: `The v3 name for this was \`Logger.withMinimumLogLevel\`. In v4 the setting is a plain reference, which means you can also read it: \`const level = yield* References.MinimumLogLevel\`. Try adding that line to \`work\` and printing it.`
    },
    {
      id: "observability-l3",
      title: "Annotations travel with the fiber",
      explain: `
The plain TypeScript way to get a request id into every log line is to pass it into every function. The Effect way is \`Effect.annotateLogs\`. It attaches key/value pairs to a region of the program, and every log event inside that region, however deep the call, sees them.

Annotations live in another reference, \`References.CurrentLogAnnotations\`. Our logger reads it from the fiber that emitted the event with \`fiber.getRef(...)\`. Real loggers such as the JSON logger print them as fields, which is what makes structured logging searchable.

Nested \`annotateLogs\` calls merge: the inner region sees the outer keys plus its own. When the region ends, the annotations are gone. Nothing leaks to the next request.
`,
      code: `import { Effect, Logger, References } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
  const text = Array.isArray(message) ? message.join(" ") : String(message)
  // Read the annotations of the fiber that logged
  const annotations = fiber.getRef(References.CurrentLogAnnotations)
  const extra = Object.entries(annotations).map(([k, v]) => " " + k + "=" + String(v)).join("")
  console.log("[" + logLevel + "] " + text + extra)
})

// loadCart knows nothing about request ids, yet its log lines will carry one
const loadCart = (userId: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("loading cart")
    return ["book", "pen"]
  }).pipe(Effect.annotateLogs("userId", userId))   // inner region adds userId

const handle = (requestId: string, userId: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("request received")
    const items = yield* loadCart(userId)
    yield* Effect.logInfo("done with " + items.length + " items")
  }).pipe(Effect.annotateLogs({ requestId }))      // outer region adds requestId

const program = Effect.gen(function* () {
  yield* handle("r-1", "ada")
  yield* handle("r-2", "lin")
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      expectedOutput: `[Info] request received requestId=r-1
[Info] loading cart requestId=r-1 userId=ada
[Info] done with 2 items requestId=r-1
[Info] request received requestId=r-2
[Info] loading cart requestId=r-2 userId=lin
[Info] done with 2 items requestId=r-2`,
      after: `Notice "done with 2 items" does not carry \`userId\`: that annotation belonged to the \`loadCart\` region, which has ended. If you need an annotation to last until the end of the surrounding scope instead of a single effect, \`Effect.annotateLogsScoped\` does that.`
    },
    {
      id: "observability-l4",
      title: "Log spans: how long has this been going on?",
      explain: `
\`Effect.withLogSpan(effect, "label")\` marks a region with a label and a start time. Every log line inside then reports how long the region has been running, which is the cheap way to spot slow steps without a full tracing setup. A real logger prints it as \`label=12ms\`.

We cannot show real milliseconds here, so our logger prints only the labels. They are stored in \`References.CurrentLogSpans\` as \`[label, startTime]\` pairs, newest first, so we reverse them to read outer to inner.

Compare this with lesson 3: annotations are values you attach, log spans are timers you start. Both travel with the fiber and both disappear when their region ends. The next lesson covers real tracing spans, which are the same idea for a tracer instead of a logger.
`,
      code: `import { Effect, Logger, References } from "effect"

const plain = Logger.make<unknown, void>(({ message, fiber }) => {
  const text = Array.isArray(message) ? message.join(" ") : String(message)
  // Each entry is [label, startTimestamp]; a real logger would print the elapsed ms
  const labels = fiber.getRef(References.CurrentLogSpans).map(([label]) => label).reverse()
  console.log(text + (labels.length ? "  spans: " + labels.join(" > ") : ""))
})

const query = Effect.logInfo("running query").pipe(Effect.withLogSpan("db"))

const handler = Effect.gen(function* () {
  yield* Effect.logInfo("start")
  yield* query
  yield* Effect.logInfo("respond")
}).pipe(Effect.withLogSpan("request"))

const program = Effect.gen(function* () {
  yield* Effect.logInfo("boot")   // no span active here
  yield* handler
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      expectedOutput: `boot
start  spans: request
running query  spans: request > db
respond  spans: request`,
      after: `Swap \`plain\` for \`Logger.consoleLogFmt\` (one of the built-in loggers) and look at the output: you will see \`request=3ms db=1ms\` style fields with real durations, plus a timestamp, which is why it is not used for the expected output here.`
    },
    {
      id: "observability-l5",
      title: "Tracing spans nest like your calls",
      explain: `
A **span** is a named, timed unit of work in a trace. \`Effect.withSpan(effect, "name")\` creates one around an effect and ends it when the effect finishes, whether it succeeded, failed, or was interrupted. Any span created inside becomes a **child** of it, because the current span is carried by the fiber. That is how a trace viewer can show \`checkout > charge > gateway\` as a tree without you wiring parent ids by hand.

Spans carry **attributes**. You can set them when creating the span (\`{ attributes: { ... } }\`), or later from inside with \`Effect.annotateCurrentSpan\`.

\`Effect.currentSpan\` gives you the active span. We use it here to print the span's name, its parent's name, and its attributes, which is deterministic. In a real app you would not read spans yourself; you would provide a tracer layer (for example the OTLP tracer from \`effect/unstable/observability\`) and every span is exported automatically. Note that \`currentSpan\` fails with \`NoSuchElementError\` when no span is active, so its error type is not \`never\`.
`,
      code: `import { Effect, Option } from "effect"

// Print where we are in the trace tree
const whereAmI = Effect.gen(function* () {
  const span = yield* Effect.currentSpan
  const parent = Option.match(span.parent, {
    onNone: () => "none",
    onSome: (p) => (p._tag === "Span" ? p.name : "external")
  })
  const attrs = JSON.stringify(Object.fromEntries(span.attributes))
  console.log(span.name + "  parent=" + parent + "  attrs=" + attrs)
})

const charge = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan("amount", 42)   // add an attribute from inside
  yield* whereAmI
}).pipe(Effect.withSpan("charge", { attributes: { gateway: "acme" } }))

const checkout = Effect.gen(function* () {
  yield* whereAmI
  yield* charge          // becomes a child of "checkout" automatically
  yield* whereAmI        // back in "checkout"
}).pipe(Effect.withSpan("checkout", { attributes: { orderId: "o-1" } }))

Effect.runSync(checkout)
`,
      expectedOutput: `checkout  parent=none  attrs={"orderId":"o-1"}
charge  parent=checkout  attrs={"gateway":"acme","amount":42}
checkout  parent=none  attrs={"orderId":"o-1"}`,
      after: `\`Effect.fn("name")\` is a shortcut that wraps a function body in a span named after the function, which is the usual way to trace service methods. Try replacing the \`checkout\` definition with \`Effect.fn("checkout")(function* () { ... })\` and calling \`checkout()\`.`
    },
    {
      id: "observability-l6",
      title: "Metrics: counter, gauge, histogram",
      explain: `
Logs tell you what happened once. Metrics tell you how often and how much, cheaply, over time. Effect has a small family:

| Metric | Records | \`update\` does | Use when |
|---|---|---|---|
| \`Metric.counter\` | A running total | Adds the input | Requests served, errors seen |
| \`Metric.gauge\` | One current value | Replaces the value (\`modify\` adds) | Queue length, memory in use |
| \`Metric.histogram\` | A distribution in buckets | Records one observation | Latency, payload size |
| \`Metric.frequency\` | Counts per string | Increments that string | Status codes, error tags |

A metric is created with a name (and optional description, attributes). \`Metric.update(metric, value)\` records into it. \`Metric.value(metric)\` reads the current state, which is what we print. Metrics are registered in a \`Metric.MetricRegistry\` reference, so an exporter layer can find all of them by name.

For a histogram the state has \`count\`, \`min\`, \`max\`, \`sum\`, and \`buckets\`: for each upper bound you gave, how many observations were at or below it.
`,
      code: `import { Effect, Metric } from "effect"

const requests = Metric.counter("requests_total", { description: "requests served" })
const queueSize = Metric.gauge("queue_size")
const latency = Metric.histogram("latency_ms", { boundaries: [10, 50, 100] })

const program = Effect.gen(function* () {
  yield* Metric.update(requests, 1)
  yield* Metric.update(requests, 4)      // counter: add

  yield* Metric.update(queueSize, 7)     // gauge: set to 7
  yield* Metric.modify(queueSize, -2)    // gauge: add -2, now 5

  for (const ms of [5, 30, 75, 300]) {
    yield* Metric.update(latency, ms)    // histogram: one observation each
  }

  const r = yield* Metric.value(requests)
  const q = yield* Metric.value(queueSize)
  const h = yield* Metric.value(latency)
  console.log("requests:", r.count)
  console.log("queue:", q.value)
  console.log("latency count", h.count, "min", h.min, "max", h.max, "sum", h.sum)
  console.log("buckets", JSON.stringify(h.buckets))   // [upperBound, observationsAtOrBelow]
})

Effect.runSync(program)
`,
      expectedOutput: `requests: 5
queue: 5
latency count 4 min 5 max 300 sum 410
buckets [[10,1],[50,2],[100,3]]`,
      after: `The bucket counts are cumulative: 30 ms is at or below 50, and also at or below 100. The 300 ms observation is above every bound, so it only shows in \`count\` and \`sum\`. Try \`yield* Metric.dump\` and print the result: it renders every registered metric as a table.`
    }
  ],
  challenges: [
    {
      id: "observability-c1",
      title: "The silent log",
      task: `Only the first two lines appear. The warning is missing. Make all three log lines print, in order.`,
      code: `import { Effect, Logger } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message }) => {
  console.log("[" + logLevel + "] " + (Array.isArray(message) ? message.join(" ") : String(message)))
})

const program = Effect.gen(function* () {
  yield* Effect.logInfo("connecting")
  yield* Effect.logInfo("connected")
  Effect.logWarning("using fallback region")
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      solution: `import { Effect, Logger } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message }) => {
  console.log("[" + logLevel + "] " + (Array.isArray(message) ? message.join(" ") : String(message)))
})

const program = Effect.gen(function* () {
  yield* Effect.logInfo("connecting")
  yield* Effect.logInfo("connected")
  yield* Effect.logWarning("using fallback region")
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      expectedOutput: `[Info] connecting
[Info] connected
[Warn] using fallback region`,
      hints: [
        "Logging is an effect. What happens to an effect that is created but never run?",
        "Compare the three log lines in the generator. One of them is different.",
        "Put yield* in front of Effect.logWarning."
      ],
      explanation: `\`Effect.logWarning("...")\` builds a description of a log event; it does not log. Without \`yield*\` the description is created, dropped, and nothing happens. This is the same recipe-versus-meal rule from Getting Started, and it is the most common logging bug in Effect code because \`console.log\` trained us to expect an immediate side effect.`
    },
    {
      id: "observability-c2",
      title: "Where did the debug line go?",
      task: `The program should print the debug line too, but it is filtered out. Change the program's configuration (not the log call) so all three lines print.`,
      code: `import { Effect, Logger } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message }) => {
  console.log("[" + logLevel + "] " + (Array.isArray(message) ? message.join(" ") : String(message)))
})

const program = Effect.gen(function* () {
  yield* Effect.logInfo("importing 3 files")
  yield* Effect.logDebug("file a.csv: 120 rows")
  yield* Effect.logInfo("import finished")
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      solution: `import { Effect, Logger, References } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message }) => {
  console.log("[" + logLevel + "] " + (Array.isArray(message) ? message.join(" ") : String(message)))
})

const program = Effect.gen(function* () {
  yield* Effect.logInfo("importing 3 files")
  yield* Effect.logDebug("file a.csv: 120 rows")
  yield* Effect.logInfo("import finished")
})

Effect.runSync(
  program.pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(Logger.layer([plain]))
  )
)
`,
      expectedOutput: `[Info] importing 3 files
[Debug] file a.csv: 120 rows
[Info] import finished`,
      hints: [
        "The default minimum log level is Info. Debug is below it.",
        "The minimum level is a reference in the References module. Lesson 2 shows how to override one.",
        "Add Effect.provideService(References.MinimumLogLevel, \"Debug\") to the pipe."
      ],
      explanation: `Log events below \`References.MinimumLogLevel\` are dropped before any logger sees them. The default is \`"Info"\`. Overriding the reference with \`Effect.provideService\` changes the threshold for that region of the program only, which is exactly what you want: verbose in one subsystem, quiet elsewhere. The log call itself was correct, the configuration around it was not.`
    },
    {
      id: "observability-c3",
      title: "The annotation that arrived too late",
      task: `Both log lines should carry \`requestId=r-9\`, but only the second one does. Fix the placement of the annotation so the whole request is annotated.`,
      code: `import { Effect, Logger, References } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
  const text = Array.isArray(message) ? message.join(" ") : String(message)
  const annotations = fiber.getRef(References.CurrentLogAnnotations)
  const extra = Object.entries(annotations).map(([k, v]) => " " + k + "=" + String(v)).join("")
  console.log("[" + logLevel + "] " + text + extra)
})

const handle = (requestId: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("validating")
    yield* Effect.logInfo("saving").pipe(Effect.annotateLogs({ requestId }))
  })

Effect.runSync(handle("r-9").pipe(Effect.provide(Logger.layer([plain]))))
`,
      solution: `import { Effect, Logger, References } from "effect"

const plain = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
  const text = Array.isArray(message) ? message.join(" ") : String(message)
  const annotations = fiber.getRef(References.CurrentLogAnnotations)
  const extra = Object.entries(annotations).map(([k, v]) => " " + k + "=" + String(v)).join("")
  console.log("[" + logLevel + "] " + text + extra)
})

const handle = (requestId: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("validating")
    yield* Effect.logInfo("saving")
  }).pipe(Effect.annotateLogs({ requestId }))

Effect.runSync(handle("r-9").pipe(Effect.provide(Logger.layer([plain]))))
`,
      expectedOutput: `[Info] validating requestId=r-9
[Info] saving requestId=r-9`,
      hints: [
        "annotateLogs applies to the effect it wraps, and only that effect.",
        "Which effect is wrapped right now? Which one should be?",
        "Move .pipe(Effect.annotateLogs({ requestId })) from the single log call to the whole Effect.gen."
      ],
      explanation: `\`Effect.annotateLogs\` is a region marker: it annotates every log event inside the effect it wraps and nothing outside. Wrapping only the "saving" call created a region one line wide. Wrapping the generator makes the region the whole request, so every line inside, including calls to other functions, inherits \`requestId\`. Put annotations at the boundary where the context becomes known, usually where a request or job starts.`
    },
    {
      id: "observability-c4",
      title: "currentSpan can fail",
      task: `\`spanName\` is meant to be a safe \`Effect<string>\` that yields the current span's name, or \`"no span"\` when there is none. It does not compile. Fix \`spanName\` without changing its type annotation or the program below it.`,
      code: `import { Effect } from "effect"

const spanName: Effect.Effect<string> = Effect.currentSpan.pipe(
  Effect.map((span) => span.name)
)

const program = Effect.gen(function* () {
  console.log("outside:", yield* spanName)
  console.log("inside:", yield* spanName.pipe(Effect.withSpan("checkout")))
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const spanName: Effect.Effect<string> = Effect.currentSpan.pipe(
  Effect.map((span) => span.name),
  Effect.orElseSucceed(() => "no span")
)

const program = Effect.gen(function* () {
  console.log("outside:", yield* spanName)
  console.log("inside:", yield* spanName.pipe(Effect.withSpan("checkout")))
})

Effect.runSync(program)
`,
      expectedOutput: `outside: no span
inside: checkout`,
      hints: [
        "Read the type error: what is the error type of Effect.currentSpan?",
        "Effect<string> means the error type is never. Something must handle the NoSuchElementError.",
        "Add Effect.orElseSucceed(() => \"no span\") after the map (or Effect.catch with Effect.succeed)."
      ],
      explanation: `\`Effect.currentSpan\` has type \`Effect<Span, NoSuchElementError>\`: it fails when no span is active. The annotation \`Effect<string>\` promises it cannot fail, so the compiler refuses. Handling the error with \`orElseSucceed\` makes the promise true, and the "outside" call, which really has no span, now gets the fallback instead of crashing. The type system caught a real runtime crash before it happened.`
    },
    {
      id: "observability-c5",
      title: "Set or add?",
      task: `The gauge should end at \`5\` (7 items arrived, 2 were processed), but it prints \`-2\`. Fix the second metric call.`,
      code: `import { Effect, Metric } from "effect"

const queue = Metric.gauge("queue_size")

const program = Effect.gen(function* () {
  yield* Metric.update(queue, 7)
  yield* Metric.update(queue, -2)
  const state = yield* Metric.value(queue)
  console.log("queue:", state.value)
})

Effect.runSync(program)
`,
      solution: `import { Effect, Metric } from "effect"

const queue = Metric.gauge("queue_size")

const program = Effect.gen(function* () {
  yield* Metric.update(queue, 7)
  yield* Metric.modify(queue, -2)
  const state = yield* Metric.value(queue)
  console.log("queue:", state.value)
})

Effect.runSync(program)
`,
      expectedOutput: `queue: 5`,
      hints: [
        "For a gauge, update replaces the current value.",
        "Lesson 6 has a table: which function adds to a gauge instead of replacing it?",
        "Use Metric.modify(queue, -2)."
      ],
      explanation: `A gauge holds one current value. \`Metric.update\` sets it, so \`update(queue, -2)\` made the queue size \`-2\`. \`Metric.modify\` adds to the current value, which is the "something left the queue" operation you wanted. For counters both functions add, which is why the difference only shows up on gauges.`
    },
    {
      id: "observability-c6",
      title: "Tracking an effect with a counter",
      task: `\`Effect.track\` should increment \`runs\` by one each time \`job\` runs, but the program does not compile. Fix the counter definition so the program prints \`runs: 3\`.`,
      code: `import { Effect, Metric } from "effect"

const runs = Metric.counter("job_runs")

const job = Effect.succeed("ok").pipe(Effect.track(runs))

const program = Effect.gen(function* () {
  yield* job
  yield* job
  yield* job
  const state = yield* Metric.value(runs)
  console.log("runs:", state.count)
})

Effect.runSync(program)
`,
      solution: `import { Effect, Metric } from "effect"

const runs = Metric.counter("job_runs").pipe(Metric.withConstantInput(1))

const job = Effect.succeed("ok").pipe(Effect.track(runs))

const program = Effect.gen(function* () {
  yield* job
  yield* job
  yield* job
  const state = yield* Metric.value(runs)
  console.log("runs:", state.count)
})

Effect.runSync(program)
`,
      expectedOutput: `runs: 3`,
      hints: [
        "Effect.track feeds the Exit of the effect into the metric. A counter wants a number.",
        "You need a metric whose input is ignored and always counts as 1.",
        "Pipe the counter through Metric.withConstantInput(1)."
      ],
      explanation: `\`Effect.track(metric)\` records the effect's \`Exit\` into the metric, so the metric's input type must accept an \`Exit\`. A plain \`Counter<number>\` accepts numbers, and the compiler says so. \`Metric.withConstantInput(1)\` builds a metric that accepts any input and always records \`1\`, which is the "count how many times this ran" shape. The alternative is \`Effect.track(runs, (exit) => 1)\`, where you map the exit yourself, useful when you want to count only failures.`
    }
  ],
  problems: [
    {
      id: "observability-p1",
      title: "Structured request log",
      spec: `
Build a small request pipeline with structured logs and a counter.

1. Write a logger \`plain\` with \`Logger.make\` that prints \`<LEVEL> <message> <key>=<value>...\` where LEVEL is the log level upper-cased, message parts are joined with spaces, and annotations (from \`References.CurrentLogAnnotations\`) are appended in insertion order, each as \` key=value\`.
2. Write \`handle(requestId, path)\`: an \`Effect.gen\` that logs \`"handling"\` at Info, increments the counter \`served\` by 1, and logs \`"unknown path"\` at Warn when \`path\` is not \`"/"\` or \`"/health"\`. Annotate the whole handler with \`{ requestId, path }\`.
3. \`program\` handles \`("r-1", "/")\`, \`("r-2", "/admin")\`, \`("r-3", "/health")\` in order, then prints \`served: <count>\` with \`console.log\`.

Run with the \`plain\` logger provided. Exact output:

\`\`\`
INFO handling requestId=r-1 path=/
INFO handling requestId=r-2 path=/admin
WARN unknown path requestId=r-2 path=/admin
INFO handling requestId=r-3 path=/health
served: 3
\`\`\`
`,
      starter: `import { Effect, Logger, Metric, References } from "effect"

const served = Metric.counter("served")

// TODO: plain logger printing "<LEVEL> <message> key=value..."
const plain = Logger.make<unknown, void>((options) => {
  throw new Error("TODO")
})

// TODO: handle(requestId, path)

const program = Effect.gen(function* () {
  // TODO: handle the three requests, then print "served: <count>"
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      solution: `import { Effect, Logger, Metric, References } from "effect"

const served = Metric.counter("served")

const plain = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
  const text = Array.isArray(message) ? message.join(" ") : String(message)
  const annotations = fiber.getRef(References.CurrentLogAnnotations)
  const extra = Object.entries(annotations).map(([k, v]) => " " + k + "=" + String(v)).join("")
  console.log(logLevel.toUpperCase() + " " + text + extra)
})

const handle = (requestId: string, path: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("handling")
    yield* Metric.update(served, 1)
    if (path !== "/" && path !== "/health") {
      yield* Effect.logWarning("unknown path")
    }
  }).pipe(Effect.annotateLogs({ requestId, path }))

const program = Effect.gen(function* () {
  yield* handle("r-1", "/")
  yield* handle("r-2", "/admin")
  yield* handle("r-3", "/health")
  const state = yield* Metric.value(served)
  console.log("served: " + state.count)
})

Effect.runSync(program.pipe(Effect.provide(Logger.layer([plain]))))
`,
      expectedOutput: `INFO handling requestId=r-1 path=/
INFO handling requestId=r-2 path=/admin
WARN unknown path requestId=r-2 path=/admin
INFO handling requestId=r-3 path=/health
served: 3`,
      hints: [
        "The logger receives { logLevel, message, fiber }. Annotations come from fiber.getRef(References.CurrentLogAnnotations).",
        "Annotate the generator returned by handle with Effect.annotateLogs({ requestId, path }); the object key order gives you the output order.",
        "Metric.update(served, 1) inside the handler, Metric.value(served) at the end."
      ]
    },
    {
      id: "observability-p2",
      title: "Traced checkout with a price histogram",
      spec: `
Trace a checkout and measure item prices.

1. Write \`enter\`: an effect that reads \`Effect.currentSpan\` and prints \`enter <name> (parent: <parentName or none>)\`. If the parent is an external span print \`external\`.
2. Write \`priceItem(name, price)\`: records \`price\` into the histogram \`prices\` (boundaries \`[10, 50]\`), runs \`enter\`, and is wrapped in a span named \`price:<name>\`.
3. Write \`checkout\`: runs \`enter\`, then \`priceItem\` for \`("book", 12)\`, \`("pen", 3)\`, \`("desk", 180)\`, then prints \`items: <count> total: <sum>\` from \`Metric.value(prices)\`. Wrap it in a span named \`checkout\`.

Exact output:

\`\`\`
enter checkout (parent: none)
enter price:book (parent: checkout)
enter price:pen (parent: checkout)
enter price:desk (parent: checkout)
items: 3 total: 195
buckets: [[10,1],[50,2]]
\`\`\`

The last line is \`JSON.stringify\` of the histogram's \`buckets\`.
`,
      starter: `import { Effect, Metric, Option } from "effect"

const prices = Metric.histogram("item_price", { boundaries: [10, 50] })

// TODO: enter prints "enter <span> (parent: <parent or none>)"

// TODO: priceItem(name, price) records the price, runs enter, in span "price:<name>"

const checkout = Effect.gen(function* () {
  // TODO
}).pipe(Effect.withSpan("checkout"))

Effect.runSync(checkout)
`,
      solution: `import { Effect, Metric, Option } from "effect"

const prices = Metric.histogram("item_price", { boundaries: [10, 50] })

const enter = Effect.gen(function* () {
  const span = yield* Effect.currentSpan
  const parent = Option.match(span.parent, {
    onNone: () => "none",
    onSome: (p) => (p._tag === "Span" ? p.name : "external")
  })
  console.log("enter " + span.name + " (parent: " + parent + ")")
})

const priceItem = (name: string, price: number) =>
  Effect.gen(function* () {
    yield* Metric.update(prices, price)
    yield* enter
  }).pipe(Effect.withSpan("price:" + name))

const checkout = Effect.gen(function* () {
  yield* enter
  yield* priceItem("book", 12)
  yield* priceItem("pen", 3)
  yield* priceItem("desk", 180)
  const state = yield* Metric.value(prices)
  console.log("items: " + state.count + " total: " + state.sum)
  console.log("buckets: " + JSON.stringify(state.buckets))
}).pipe(Effect.withSpan("checkout"))

Effect.runSync(checkout)
`,
      expectedOutput: `enter checkout (parent: none)
enter price:book (parent: checkout)
enter price:pen (parent: checkout)
enter price:desk (parent: checkout)
items: 3 total: 195
buckets: [[10,1],[50,2]]`,
      hints: [
        "span.parent is an Option<AnySpan>. Option.match with onNone / onSome handles both cases; check p._tag === \"Span\" before reading p.name.",
        "Effect.withSpan(\"price:\" + name) goes on the generator returned by priceItem, so the span exists when enter runs inside it.",
        "Histogram state has count, sum, and buckets. 3 is at or below 10; 3 and 12 are at or below 50; 180 is above both."
      ]
    }
  ],
  recall: [
    {
      q: "Why does `Effect.log` print nothing by itself in a custom setup, and what decides the format?",
      a: "`Effect.log` emits a log event to the current set of `Logger` services. The loggers decide the format and destination. `Logger.layer([...])` replaces that set, `{ mergeWithExisting: true }` adds to it."
    },
    {
      q: "What would the type of `Effect.currentSpan` be, and why is it not `Effect<Span>`?",
      a: "`Effect<Span, NoSuchElementError>`. There may be no active span, and Effect makes that failure visible in the error channel instead of returning `undefined`."
    },
    {
      q: "How do you show `Effect.logDebug` lines in v4?",
      a: "Override the `References.MinimumLogLevel` reference for the region you care about: `Effect.provideService(References.MinimumLogLevel, \"Debug\")`, or `Layer.succeed(References.MinimumLogLevel, \"Debug\")` in a layer. The default is `\"Info\"`."
    },
    {
      q: "Which function would you reach for to attach a `requestId` to every log line in a handler, including lines logged by functions it calls?",
      a: "`Effect.annotateLogs(handler, { requestId })`. Annotations travel with the fiber, so nested calls inherit them without being passed the id."
    },
    {
      q: "What is the difference between `Metric.update` and `Metric.modify` on a gauge?",
      a: "`update` sets the gauge to the given value; `modify` adds the value to the current one. On a counter both add."
    },
    {
      q: "How do spans know their parent?",
      a: "The current span is carried by the fiber. `Effect.withSpan` reads it, creates a child, and makes the child current for the wrapped effect. When the effect ends the span is closed and the parent becomes current again."
    }
  ]
}

export default section
