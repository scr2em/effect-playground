import type { Section } from "../types.ts"

const section: Section = {
  id: "observability",
  title: "Observability",
  order: 5,
  summary: "Logs, spans, and metrics are effects. They carry their context with them.",
  intro: `
**The problem.** After an incident, you must find out what happened. In plain TypeScript, the answer is \`console.log\` in every function. Each line builds its own context by hand:

\`\`\`ts
async function chargeCard(order: Order) {
  console.log(\`[\${new Date().toISOString()}] [INFO] charge order \${order.id} for user \${order.userId}\`)
  const result = await gateway.charge(order)
  console.log(\`[\${new Date().toISOString()}] [INFO] charged order \${order.id} for user \${order.userId} in \${Date.now() - start}ms\`)
}
\`\`\`

Every line repeats the order id and the user id. If you forget one, that line is useless when you search for the order. You measure time with \`Date.now()\` by hand. Later, the team adds a global APM agent. The agent does not know which request a function call belongs to. That context is in local variables, and the agent cannot see it.

### The shift

Today you think of a log line as text that a function prints. In Effect, a log line, a span, and a metric update are effects. They run inside a fiber. A fiber is the unit that runs an effect, and it carries context with it. When you write \`Effect.annotateLogs(handler, { requestId })\`, every log line inside \`handler\` gets \`requestId\`. This includes log lines in functions that \`handler\` calls. You do not pass the id around. When you put an effect inside \`Effect.withSpan("charge")\`, every span inside it becomes a child span. The trace tree is the same as the call tree.

The logger, the tracer, and the metric registry are services. This is the benefit: you can change the logger to a JSON logger in production, to a silent logger in tests, or to a plain logger in this playground. You do not change one \`Effect.log\` call. To export spans to OpenTelemetry, you provide one layer at the edge of the app.

| Task | Plain TypeScript | Effect |
|---|---|---|
| Write a log line | \`console.log("...")\` with manual format | \`Effect.logInfo("...")\`, the \`Logger\` service sets the format |
| Add context | Pass ids into every function | \`Effect.annotateLogs\` one time, all inner code gets it |
| Measure an operation | \`Date.now()\` before and after | \`Effect.withSpan("name")\`, child spans are automatic |
| Count events | A module-level \`let count = 0\` | \`Metric.counter("name")\`, read it with \`Metric.value\` |
| Change the backend | Change every call site | Provide a different layer |

Note: the default logger prints a timestamp and a fiber id on every line. This output changes on every run. Lesson 1 builds a small logger with stable output, and all other lessons use it. That is also the first lesson: the logger is a service that you own.
`,
  lessons: [
    {
      id: "observability-l1",
      title: "Replace the logger",
      explain: `
\`Effect.log\` and the related functions do not print. They send a log event to the \`Logger\` services that are installed. The default logger prints a line like this:

\`\`\`
[13:42:07.118] INFO (#12): starting v1
\`\`\`

The timestamp and the fiber number change on every run. You cannot compare this output in a test or in this playground. The first thing to learn is that you can replace the logger.

\`Logger.make\` takes a function. The function gets the log event. The event has a \`message\` (an array, because \`Effect.log("a", 1)\` accepts more than 1 value), a \`logLevel\`, the \`fiber\`, a \`cause\`, and a \`date\`. Our logger builds a short string and prints it with \`console.log\`.

\`Logger.layer([plain])\` is a layer. It replaces the current set of loggers with the loggers in the list. Provide it around the program. Every \`Effect.log\` inside the program now goes to \`plain\` only. The program did not change.
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
      after: `Remove the line \`Effect.provide(Logger.layer([plain]))\` and run again. The same 4 lines appear, but the default logger prints them with timestamps. Add \`{ mergeWithExisting: true }\` as the second argument of \`Logger.layer\`. Now both loggers print. The program did not change. Only the service changed.`
    },
    {
      id: "observability-l2",
      title: "Log levels and the minimum level",
      explain: `
Every log call has a level. This table lists the levels from the most severe to the least severe:

| Function | Level | Shown by default? |
|---|---|---|
| \`Effect.logFatal\` | Fatal | yes |
| \`Effect.logError\` | Error | yes |
| \`Effect.logWarning\` | Warn | yes |
| \`Effect.logInfo\` / \`Effect.log\` | Info | yes |
| \`Effect.logDebug\` | Debug | no |
| \`Effect.logTrace\` | Trace | no |

The limit is a fiber-local value with the name \`References.MinimumLogLevel\`. The default is \`"Info"\`. This is why debug lines do not appear. In Effect v4, a value of this type is a \`Context.Reference\`. A reference is a service with a default value. You change it for one part of the program with \`Effect.provideService\`. In a layer, you use \`Layer.succeed\`.

The filter runs before the logger. A filtered line has almost no cost. You can keep \`logDebug\` calls in the code and turn them on only when you need them.
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
      after: `In v3, the name of this function was \`Logger.withMinimumLogLevel\`. In v4, the minimum level is a reference. You can also read it: \`const level = yield* References.MinimumLogLevel\`. Add this line to \`work\` and print the level.`
    },
    {
      id: "observability-l3",
      title: "Annotations travel with the fiber",
      explain: `
In plain TypeScript, you pass a request id into every function to get it into every log line. In Effect, you use \`Effect.annotateLogs\`. It attaches key/value pairs to one part of the program. Every log event inside that part gets the pairs. The depth of the call does not matter.

The annotations are in a reference with the name \`References.CurrentLogAnnotations\`. Our logger reads the annotations from the fiber that sent the event, with \`fiber.getRef(...)\`. A production logger, for example the JSON logger, prints the annotations as fields. This is what makes structured logs searchable.

Nested \`annotateLogs\` calls merge. The inner part sees the outer keys and its own keys. When the part ends, the annotations are removed. Nothing goes to the next request.
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
      after: `Note: the line "done with 2 items" does not have \`userId\`. That annotation belonged to the \`loadCart\` part, and that part has ended. If an annotation must stay until the end of the current scope, use \`Effect.annotateLogsScoped\`.`
    },
    {
      id: "observability-l4",
      title: "Log spans: how long has this part run?",
      explain: `
\`Effect.withLogSpan(effect, "label")\` marks a part of the program with a label and a start time. Every log line inside that part shows how long the part has run. This is a cheap way to find slow steps without a full trace setup. A production logger prints it as \`label=12ms\`.

We cannot show real milliseconds here. Our logger prints only the labels. The labels are in \`References.CurrentLogSpans\` as \`[label, startTime]\` pairs, newest first. We reverse the list to read from outer to inner.

Compare this with lesson 3. Annotations are values that you attach. Log spans are timers that you start. Both travel with the fiber, and both are removed when their part ends. Lesson 5 covers trace spans. A trace span is the same idea, but for a tracer instead of a logger.
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
      after: `Replace \`plain\` with \`Logger.consoleLogFmt\`, one of the built-in loggers, and look at the output. You see fields like \`request=3ms db=1ms\` with real durations, and a timestamp. This is why the expected output does not use it.`
    },
    {
      id: "observability-l5",
      title: "Trace spans nest like your calls",
      explain: `
A **span** is a unit of work in a trace. It has a name, a start time, and an end time. \`Effect.withSpan(effect, "name")\` makes a span around an effect. The span ends when the effect ends. This is true when the effect succeeds, fails, or is interrupted. Every span made inside becomes a **child** of it, because the fiber carries the current span. A trace viewer can show \`checkout > charge > gateway\` as a tree, and you do not connect parent ids by hand.

A span has **attributes**. You can set them when you make the span, with \`{ attributes: { ... } }\`. You can also set them later from inside the span, with \`Effect.annotateCurrentSpan\`.

\`Effect.currentSpan\` gives the active span. We use it to print the name of the span, the name of its parent, and its attributes. This output is stable. In a real app you do not read spans yourself. You provide a tracer layer, for example the OTLP tracer from \`effect/unstable/observability\`, and every span is exported. Note: \`currentSpan\` fails with \`NoSuchElementError\` when no span is active. Its error type is not \`never\`.
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
      after: `\`Effect.fn("name")\` is a short form. It puts the body of a function inside a span with the name of the function. This is the usual way to trace service methods. Replace the \`checkout\` definition with \`Effect.fn("checkout")(function* () { ... })\` and call \`checkout()\`.`
    },
    {
      id: "observability-l6",
      title: "Metrics: counter, gauge, histogram",
      explain: `
A log tells you what happened one time. A metric tells you how often and how much, at low cost, over time. Effect has a small set of metric types:

| Metric | Records | \`update\` does | Use it for |
|---|---|---|---|
| \`Metric.counter\` | A total | Adds the input | Requests served, errors seen |
| \`Metric.gauge\` | 1 current value | Replaces the value (\`modify\` adds) | Queue length, memory in use |
| \`Metric.histogram\` | A distribution in buckets | Records 1 observation | Latency, payload size |
| \`Metric.frequency\` | A count for each string | Adds 1 to that string | Status codes, error tags |

You make a metric with a name. A description and attributes are optional. \`Metric.update(metric, value)\` records a value. \`Metric.value(metric)\` reads the current state, and we print that state. Metrics are registered in the \`Metric.MetricRegistry\` reference. An exporter layer can find all of them by name.

The state of a histogram has \`count\`, \`min\`, \`max\`, \`sum\`, and \`buckets\`. For each upper limit that you gave, a bucket holds the number of observations that are equal to or below that limit.
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
      after: `The bucket counts are cumulative. The value 30 ms is at or below 50, and also at or below 100. The value 300 ms is above every limit, so it appears only in \`count\` and \`sum\`. Add \`yield* Metric.dump\` and print the result. It shows every registered metric as a table.`
    }
  ],
  dosAndDonts: [
    {
      do: "Provide `Logger.layer([...])` 1 time, at the edge of the app.",
      dont: "Do not format log lines by hand with `console.log` inside effects.",
      why: "A hand-made line has no level, no annotations, and no span, and you cannot change its destination without a change to the code."
    },
    {
      do: "Write `yield* Effect.logInfo(...)` for every log call.",
      dont: "Do not write `Effect.logInfo(...)` on its own line without `yield*`.",
      why: "A log call is an effect; without `yield*` the effect is made and dropped, and nothing prints."
    },
    {
      do: "Change the minimum level with `Effect.provideService(References.MinimumLogLevel, \"Debug\")` for the part that you debug.",
      dont: "Do not remove `logDebug` calls when you do not see them.",
      why: "The default minimum level is `\"Info\"`; the debug lines are filtered, not lost, and a filtered line has almost no cost."
    },
    {
      do: "Put `Effect.annotateLogs({ requestId })` on the full handler.",
      dont: "Do not add the request id to each message string.",
      why: "An annotation on the handler reaches every log line inside, and also the lines from the functions that the handler calls."
    },
    {
      do: "Catch the `NoSuchElementError` of `Effect.currentSpan`, for example with `Effect.orElseSucceed`.",
      dont: "Do not give `Effect.currentSpan` the type `Effect<Span>`.",
      why: "When no span is active, `currentSpan` fails, and an annotation with `never` as the error type does not compile."
    },
    {
      do: "Use `Metric.modify` to add to a gauge.",
      dont: "Do not use `Metric.update` when you want to add to a gauge.",
      why: "On a gauge, `update` replaces the current value, so `update(queue, -2)` sets the queue size to `-2`."
    },
    {
      do: "Give `Effect.track` a metric that accepts an `Exit`, for example `Metric.withConstantInput(1)`.",
      dont: "Do not pass a plain `Counter<number>` to `Effect.track`.",
      why: "`Effect.track` records the `Exit` of the effect, and a counter of numbers does not accept an `Exit`, so the program does not compile."
    }
  ],
  challenges: [
    {
      id: "observability-c1",
      title: "The silent log",
      task: `Only the first 2 lines appear. The warning is absent. Change the program so that all 3 log lines print, in this order.`,
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
        "A log call is an effect. What happens to an effect that you make but do not run?",
        "Compare the 3 log lines in the generator. 1 of them is different.",
        "Put yield* in front of Effect.logWarning."
      ],
      explanation: `\`Effect.logWarning("...")\` makes a description of a log event. It does not log. Without \`yield*\`, the description is made and then dropped. Nothing happens. This is the same rule as in Getting Started: an effect is a value, and only a run function does the work. This is the most common log bug in Effect code, because \`console.log\` has an immediate side effect and \`Effect.log\` does not.`
    },
    {
      id: "observability-c2",
      title: "The absent debug line",
      task: `The program must print the debug line, but the line is filtered out. Change the configuration of the program, not the log call, so that all 3 lines print.`,
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
        "The default minimum log level is Info. Debug is below Info.",
        "The minimum level is a reference in the References module. Lesson 2 shows how to change a reference.",
        "Add Effect.provideService(References.MinimumLogLevel, \"Debug\") to the pipe."
      ],
      explanation: `The runtime drops log events below \`References.MinimumLogLevel\` before a logger sees them. The default is \`"Info"\`. \`Effect.provideService\` changes the reference for that part of the program only. This is what you want: verbose in one subsystem, quiet in the others. The log call was correct. The configuration around it was not.`
    },
    {
      id: "observability-c3",
      title: "The annotation in the wrong place",
      task: `Both log lines must have \`requestId=r-9\`, but only the second line has it. Move the annotation so that the full request is annotated.`,
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
        "annotateLogs applies to the effect that it wraps, and only to that effect.",
        "Which effect is wrapped now? Which effect must be wrapped?",
        "Move .pipe(Effect.annotateLogs({ requestId })) from the single log call to the full Effect.gen."
      ],
      explanation: `\`Effect.annotateLogs\` marks one part of the program. It annotates every log event inside the effect that it wraps, and nothing outside. When you wrap only the "saving" call, the part is 1 line wide. When you wrap the generator, the part is the full request. Every line inside gets \`requestId\`, and this includes calls to other functions. Put an annotation at the boundary where the context becomes known. This is usually the point where a request or a job starts.`
    },
    {
      id: "observability-c4",
      title: "currentSpan can fail",
      task: `\`spanName\` must be an \`Effect<string>\` that gives the name of the current span, or \`"no span"\` when there is no span. The program does not compile. Change \`spanName\` only. Do not change its type annotation or the program below it.`,
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
        "Read the type error. What is the error type of Effect.currentSpan?",
        "Effect<string> means that the error type is never. Something must catch the NoSuchElementError.",
        "Add Effect.orElseSucceed(() => \"no span\") after the map. Effect.catch with Effect.succeed also works."
      ],
      explanation: `The type of \`Effect.currentSpan\` is \`Effect<Span, NoSuchElementError>\`. It fails when no span is active. The annotation \`Effect<string>\` says that it cannot fail, so the compiler rejects it. \`orElseSucceed\` catches the error and makes the annotation true. The "outside" call has no span. It now gets the fallback text and does not crash. The type system found a real crash before it happened.`
    },
    {
      id: "observability-c5",
      title: "Set or add?",
      task: `The gauge must end at \`5\` (7 items arrived, 2 items were processed), but it prints \`-2\`. Change the second metric call.`,
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
        "Lesson 6 has a table. Which function adds to a gauge and does not replace the value?",
        "Use Metric.modify(queue, -2)."
      ],
      explanation: `A gauge holds 1 current value. \`Metric.update\` sets the value, so \`update(queue, -2)\` set the queue size to \`-2\`. \`Metric.modify\` adds to the current value. This is the operation "1 item left the queue" that you wanted. For a counter, both functions add. The difference is visible only on a gauge.`
    },
    {
      id: "observability-c6",
      title: "Track an effect with a counter",
      task: `\`Effect.track\` must add 1 to \`runs\` each time \`job\` runs, but the program does not compile. Change the counter definition so that the program prints \`runs: 3\`.`,
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
        "Effect.track sends the Exit of the effect into the metric. A counter wants a number.",
        "You need a metric that ignores its input and always records 1.",
        "Pipe the counter through Metric.withConstantInput(1)."
      ],
      explanation: `\`Effect.track(metric)\` records the \`Exit\` of the effect into the metric. The input type of the metric must accept an \`Exit\`. A plain \`Counter<number>\` accepts numbers, and the compiler says so. \`Metric.withConstantInput(1)\` makes a metric that accepts any input and always records \`1\`. This is the shape for "count how many times this ran". The alternative is \`Effect.track(runs, (exit) => 1)\`, where you map the exit yourself. That form is useful when you count only failures.`
    }
  ],
  problems: [
    {
      id: "observability-p1",
      title: "Structured request log",
      spec: `
Build a small request pipeline with structured logs and a counter.

1. Write a logger \`plain\` with \`Logger.make\`. It must print \`<LEVEL> <message> <key>=<value>...\`. LEVEL is the log level in upper case. The message parts are joined with spaces. The annotations (from \`References.CurrentLogAnnotations\`) follow in insertion order, each as \` key=value\`.
2. Write \`handle(requestId, path)\` as an \`Effect.gen\`. It must log \`"handling"\` at Info, add 1 to the counter \`served\`, and log \`"unknown path"\` at Warn when \`path\` is not \`"/"\` and not \`"/health"\`. Annotate the full handler with \`{ requestId, path }\`.
3. \`program\` must call \`handle\` for \`("r-1", "/")\`, \`("r-2", "/admin")\`, \`("r-3", "/health")\` in this order. Then it must print \`served: <count>\` with \`console.log\`.

Run the program with the \`plain\` logger provided. Exact output:

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
        "The logger gets { logLevel, message, fiber }. Read the annotations with fiber.getRef(References.CurrentLogAnnotations).",
        "Annotate the generator that handle returns with Effect.annotateLogs({ requestId, path }). The key order of the object gives the output order.",
        "Use Metric.update(served, 1) inside the handler and Metric.value(served) at the end."
      ]
    },
    {
      id: "observability-p2",
      title: "Traced checkout with a price histogram",
      spec: `
Trace a checkout and measure the item prices.

1. Write \`enter\`, an effect that reads \`Effect.currentSpan\` and prints \`enter <name> (parent: <parentName or none>)\`. If the parent is an external span, print \`external\`.
2. Write \`priceItem(name, price)\`. It must record \`price\` into the histogram \`prices\` (boundaries \`[10, 50]\`), then run \`enter\`. Wrap it in a span with the name \`price:<name>\`.
3. Write \`checkout\`. It must run \`enter\`, then \`priceItem\` for \`("book", 12)\`, \`("pen", 3)\`, \`("desk", 180)\`, then print \`items: <count> total: <sum>\` from \`Metric.value(prices)\`. Wrap it in a span with the name \`checkout\`.

Exact output:

\`\`\`
enter checkout (parent: none)
enter price:book (parent: checkout)
enter price:pen (parent: checkout)
enter price:desk (parent: checkout)
items: 3 total: 195
buckets: [[10,1],[50,2]]
\`\`\`

The last line is \`JSON.stringify\` of the \`buckets\` of the histogram.
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
        "span.parent is an Option<AnySpan>. Option.match with onNone and onSome covers both cases. Check p._tag === \"Span\" before you read p.name.",
        "Put Effect.withSpan(\"price:\" + name) on the generator that priceItem returns. Then the span exists when enter runs inside it.",
        "The histogram state has count, sum, and buckets. 3 is at or below 10. 3 and 12 are at or below 50. 180 is above both limits."
      ]
    }
  ],
  recall: [
    {
      q: "Why does `Effect.log` print nothing by itself, and what decides the format?",
      a: "`Effect.log` sends a log event to the current set of `Logger` services. The loggers decide the format and the destination. `Logger.layer([...])` replaces that set. The option `{ mergeWithExisting: true }` adds to it."
    },
    {
      q: "What is the type of `Effect.currentSpan`, and why is it not `Effect<Span>`?",
      a: "`Effect<Span, NoSuchElementError>`. There can be no active span. Effect shows that failure in the error channel. It does not return `undefined`."
    },
    {
      q: "How do you show `Effect.logDebug` lines in v4?",
      a: "Change the `References.MinimumLogLevel` reference for the part of the program: `Effect.provideService(References.MinimumLogLevel, \"Debug\")`. In a layer, use `Layer.succeed(References.MinimumLogLevel, \"Debug\")`. The default is `\"Info\"`."
    },
    {
      q: "Which function do you use to attach a `requestId` to every log line in a handler, and also to the lines from the functions that the handler calls?",
      a: "`Effect.annotateLogs(handler, { requestId })`. The annotations travel with the fiber. The inner calls get them, and you do not pass the id as an argument."
    },
    {
      q: "What is the difference between `Metric.update` and `Metric.modify` on a gauge?",
      a: "`update` sets the gauge to the given value. `modify` adds the value to the current value. On a counter, both functions add."
    },
    {
      q: "How does a span know its parent?",
      a: "The fiber carries the current span. `Effect.withSpan` reads it, makes a child span, and makes the child the current span for the wrapped effect. When the effect ends, the span is closed and the parent is the current span again."
    }
  ]
}

export default section
