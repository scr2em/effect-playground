import type { Section } from "../types.ts"

const section: Section = {
  id: "scheduling",
  title: "Scheduling",
  order: 8,
  summary: "Retry, repeat, and time out work with a Schedule: a value that describes when to try again.",
  intro: `
**The problem.** Every codebase has a retry loop like this one, and every one of them is a little wrong:

\`\`\`ts
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error("gave up")
}
\`\`\`

Is \`retries = 3\` three attempts or three retries? Nobody remembers. The delay is fixed, so a hundred clients hitting a struggling server all come back at the same second. It retries a \`404\` as eagerly as a network blip. The \`setTimeout\` cannot be cancelled, so a user who navigated away still burns three more requests. And the policy is welded to the loop: you cannot test it, reuse it for a different function, or add a timeout without rewriting it.

### The shift

Today you think of retrying as **a loop that waits**. Effect asks you to think of it as **a value that describes when to try again**. That value is a \`Schedule\`. A schedule knows two things: how long to wait before the next attempt, and whether there should be a next attempt at all. It is data, so you build it once, compose it with \`pipe\`, and hand it to \`Effect.retry\` or \`Effect.repeat\`. The same \`Schedule\` works for retrying a failing effect, repeating a successful one, and polling a job status.

Because the waiting goes through Effect's clock, it is interruptible: cancel the parent and the retry stops mid-sleep. Because the effect being retried is a description, "try again" means "run the description again", with no closures or flags to reset. Attempt counting, backoff, jitter, and "only retry these errors" become one line each.

| Function | Runs the effect again when... | Reach for it when |
|---|---|---|
| \`Effect.retry(effect, policy)\` | It **failed** | Transient errors: network, locks, rate limits |
| \`Effect.repeat(effect, policy)\` | It **succeeded** | Polling, heartbeats, "do this N times" |
| \`Effect.schedule(effect, schedule)\` | It succeeded, ignoring its value | Periodic work where the result does not matter |
| \`Effect.timeout(effect, duration)\` | Never, it stops the effect instead | Anything that might hang |

In this section every program counts attempts in a \`Ref\` and prints the count, never the elapsed time, so the output is the same on every machine.
`,
  lessons: [
    {
      id: "scheduling-l1",
      title: "Retry with a count",
      explain: `
Start with the simplest policy: try again a fixed number of times. In plain TypeScript this needs a loop, a counter, and a rethrow:

\`\`\`ts
let lastError
for (let i = 0; i < 3; i++) {
  try { return await flaky() } catch (e) { lastError = e }
}
throw lastError
\`\`\`

With Effect, \`Effect.retry(effect, { times: 2 })\` does the same thing, and the name is precise: \`times\` is the number of **retries**, on top of the first attempt. \`times: 2\` means at most three runs. If the last retry still fails, that failure is what you get back.

The effect being retried is a description, so "run it again" needs no reset logic. The \`Ref\` here is only a counter so we can print how many attempts happened.
`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  // Fails on the first two calls, succeeds on the third
  const flaky = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (n < 3) return yield* Effect.fail("connection reset")
    return "payload"
  })

  // times: 2 means one attempt plus up to two retries
  const result = yield* flaky.pipe(Effect.retry({ times: 2 }))
  console.log("result:", result)
  console.log("attempts:", yield* Ref.get(attempts))

  // times: 1 is one retry too few for this task
  yield* Ref.set(attempts, 0)
  const outcome = yield* flaky.pipe(Effect.retry({ times: 1 }), Effect.result)
  console.log("with times 1:", outcome._tag, "after", yield* Ref.get(attempts), "attempts")
})

Effect.runPromise(program)
`,
      expectedOutput: `result: payload
attempts: 3
with times 1: Failure after 2 attempts`,
      after: `Notice \`times: 2\` gave three attempts. Every counting API in this section works the same way: the first run is free, the schedule only decides about the runs after it. Try \`times: 0\`: exactly one attempt, no retries.`
    },
    {
      id: "scheduling-l2",
      title: "A Schedule is a value",
      explain: `
\`{ times: 2 }\` is a shortcut. The real thing behind it is a \`Schedule\`, a value you can store in a variable, pass to functions, and compose. Its type is \`Schedule<Output, Input>\`: \`Output\` is what it produces at each step (a count or a delay), \`Input\` is what it looks at (the error, for retries).

| Constructor | Waits | Stops on its own? |
|---|---|---|
| \`Schedule.recurs(n)\` | Nothing | After \`n\` recurrences |
| \`Schedule.spaced("1 second")\` | Same delay every time | Never |
| \`Schedule.exponential("1 second")\` | 1s, 2s, 4s, 8s... | Never |
| \`Schedule.fibonacci("1 second")\` | 1s, 2s, 3s, 5s, 8s... | Never |
| \`Schedule.forever\` | Nothing | Never |

"Never stops" sounds dangerous, and it is. \`Schedule.upTo({ times: n })\` caps any schedule. \`Schedule.tap\` lets you look at each decision: the attempt number and the delay the schedule **computed**. That delay comes from the schedule's formula, not from a clock, so printing it is deterministic.
`,
      code: `import { Duration, Effect, Ref, Schedule } from "effect"

// A schedule is data. Building it runs nothing.
const backoff = Schedule.exponential("1 millis").pipe(
  Schedule.upTo({ times: 3 }),          // at most 3 recurrences, then stop
  Schedule.tap((meta) =>                // observe each decision the schedule makes
    Effect.sync(() => console.log("retry", meta.attempt, "after", Duration.toMillis(meta.duration), "ms"))
  )
)

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const alwaysFails = Effect.gen(function* () {
    yield* Ref.update(attempts, (n) => n + 1)
    return yield* Effect.fail("still down")
  })

  const outcome = yield* alwaysFails.pipe(Effect.retry(backoff), Effect.result)
  console.log(outcome._tag, "after", yield* Ref.get(attempts), "attempts")
})

Effect.runPromise(program)
`,
      expectedOutput: `retry 1 after 1 ms
retry 2 after 2 ms
retry 3 after 4 ms
Failure after 4 attempts`,
      after: `The schedule was built at the top of the file and only used at the bottom. Swap \`Schedule.exponential\` for \`Schedule.fibonacci("1 millis")\` and the delays become 1, 2, 3. Remove \`upTo\` and the program never ends, because exponential never stops on its own.`
    },
    {
      id: "scheduling-l3",
      title: "Composing schedules",
      explain: `
Real policies combine several rules: "back off exponentially, but give up after 5 retries, and add some randomness so clients do not stampede". Each rule is a schedule, and combinators merge them.

| Combinator | Continues while... | Delay used |
|---|---|---|
| \`Schedule.max([a, b])\` | **Both** still continue | The longer one |
| \`Schedule.min([a, b])\` | **Either** still continues | The shorter one |
| \`Schedule.upTo({ times, duration })\` | Under the limit | Unchanged |
| \`Schedule.jittered\` | Unchanged | Multiplied by a random 0.8 to 1.2 |

\`max\` is the one for "backoff with a cap on attempts": exponential keeps going forever, \`recurs(2)\` stops after two, so together they stop after two. \`min\` is the one for "backoff but never wait longer than X": pair exponential with \`spaced("5 seconds")\` and the shorter delay wins once exponential grows past it.

The payoff of a schedule being a value: the policy below is defined once and applied to two unrelated tasks.
`,
      code: `import { Effect, Ref, Schedule } from "effect"

// One policy, defined once: exponential backoff, at most 2 retries, jittered
const policy = Schedule.max([
  Schedule.exponential("1 millis"),   // 1 ms, 2 ms, 4 ms...
  Schedule.recurs(2)                  // ...but stop after 2 recurrences
]).pipe(Schedule.jittered)            // randomize each delay so clients spread out

// A task that fails until attempt number succeedAt
const makeTask = (name: string, succeedAt: number) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const task = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      if (n < succeedAt) return yield* Effect.fail(name + " unavailable")
      return name + " ok"
    })
    const outcome = yield* task.pipe(Effect.retry(policy), Effect.result)
    console.log(name + ":", outcome._tag, "after", yield* Ref.get(attempts), "attempts")
  })

const program = Effect.gen(function* () {
  yield* makeTask("database", 99)   // never recovers: policy gives up
  yield* makeTask("cache", 2)       // recovers on attempt 2
})

Effect.runPromise(program)
`,
      expectedOutput: `database: Failure after 3 attempts
cache: Success after 2 attempts`,
      after: `\`jittered\` changes the delays randomly but never the number of attempts, which is why the output is stable. Change \`max\` to \`min\`: now the policy continues while **either** schedule continues, and exponential never stops, so "database" retries forever. That is the difference between the two.`
    },
    {
      id: "scheduling-l4",
      title: "Retry only what is worth retrying",
      explain: `
Retrying a \`404\` three times with backoff wastes seconds and hides a bug. A retry policy should look at the error and decide. Effect gives two ways.

The **options form** takes a \`while\` or \`until\` predicate over the error next to \`times\`: \`Effect.retry(effect, { times: 5, while: (e) => e._tag === "Unavailable" })\`. Retrying stops as soon as the predicate says no, even with attempts left.

The **schedule form** uses \`Schedule.while\`, which receives the schedule's metadata; the error is \`meta.input\`. A plain \`Schedule.recurs(5)\` does not know what its input is (the type is \`unknown\`), so \`Effect.retry\` accepts a builder function: \`Effect.retry(($) => $(schedule).pipe(...))\`. The \`$\` helper stamps the effect's error type onto the schedule so \`input._tag\` type checks.

Tagged errors make both forms readable, and they are the errors you will have in real code anyway.
`,
      code: `import { Data, Effect, Ref, Schedule } from "effect"

class Unavailable extends Data.TaggedError("Unavailable")<{}> {}
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: number }> {}

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  const fetchUser = (id: number) =>
    Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      if (id === 404) return yield* new NotFound({ id })       // permanent: do not retry
      if (n < 3) return yield* new Unavailable()               // transient: retry
      return "user-" + id
    })

  // Options form: keep retrying while the error is transient
  const a = yield* fetchUser(1).pipe(
    Effect.retry({ times: 5, while: (e) => e._tag === "Unavailable" })
  )
  console.log(a, "after", yield* Ref.get(attempts), "attempts")

  // Schedule form: $ gives the schedule the effect's error type, so input._tag compiles
  yield* Ref.set(attempts, 0)
  const b = yield* fetchUser(404).pipe(
    Effect.retry(($) =>
      $(Schedule.recurs(5)).pipe(Schedule.while(({ input }) => input._tag === "Unavailable"))
    ),
    Effect.result
  )
  console.log(b._tag, "after", yield* Ref.get(attempts), "attempt")
})

Effect.runPromise(program)
`,
      expectedOutput: `user-1 after 3 attempts
Failure after 1 attempt`,
      after: `The \`NotFound\` call failed after one attempt even though the policy allowed five. Try removing the \`while\` from the options form and calling \`fetchUser(404)\` with it: six attempts, all pointless. The predicate is what turns "retry" into "retry sensibly".`
    },
    {
      id: "scheduling-l5",
      title: "Repeat: the same schedule for success",
      explain: `
\`Effect.retry\` runs again after a **failure**. \`Effect.repeat\` runs again after a **success**, with the exact same schedule values. That covers polling, heartbeats, and "do this five times".

Two things to know. First, the counting rule is the same: the effect runs once, then the schedule decides about extra runs, so \`Schedule.recurs(2)\` means three runs. Second, \`repeat\` returns the **schedule's output**, not the effect's last value. For \`recurs\` and \`spaced\` that is the number of recurrences.

\`Effect.schedule\` is the sibling for work whose result you ignore, with one twist: it asks the schedule **before** the first run as well, so \`Schedule.recurs(2)\` means exactly two runs. Think of \`repeat\` as "run, then maybe again" and \`schedule\` as "run on this timetable".

For polling, the options form has \`until\` and \`while\` over the **success value**: \`Effect.repeat(check, { until: (s) => s === "done", schedule: Schedule.spaced("1 second") })\` keeps checking until the status says done, and returns that final status.
`,
      code: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  // repeat: one run plus 2 recurrences. The result is the schedule's output.
  const ticks = yield* Ref.make(0)
  const output = yield* Ref.update(ticks, (n) => n + 1).pipe(Effect.repeat(Schedule.recurs(2)))
  console.log("ran", yield* Ref.get(ticks), "times, schedule output", output)

  // schedule: the timetable is consulted before the first run too, so upTo 2 means 2 runs
  const heartbeat = Effect.sync(() => console.log("tick"))
  yield* heartbeat.pipe(Effect.schedule(Schedule.forever.pipe(Schedule.upTo({ times: 2 }))))

  // Polling: repeat until the value says stop, waiting between checks
  const polls = yield* Ref.make(0)
  const checkJob = Ref.updateAndGet(polls, (n) => n + 1).pipe(
    Effect.map((n) => (n < 3 ? "pending" : "done"))
  )
  const status = yield* checkJob.pipe(
    Effect.repeat({ until: (s) => s === "done", schedule: Schedule.spaced("1 millis") })
  )
  console.log("job", status, "after", yield* Ref.get(polls), "polls")
})

Effect.runPromise(program)
`,
      expectedOutput: `ran 3 times, schedule output 2
tick
tick
job done after 3 polls`,
      after: `Notice the two counts: \`repeat\` with \`recurs(2)\` ran three times, \`schedule\` with \`upTo({ times: 2 })\` ran twice. If the repeated effect fails, \`repeat\` stops and passes the failure on; it never retries. That is the whole difference: \`retry\` reacts to failure, \`repeat\` to success. Try swapping \`until\` for \`while\` in the polling example: it stops after the first "pending".`
    },
    {
      id: "scheduling-l6",
      title: "Timeouts, and retry with timeout",
      explain: `
A timeout is the opposite of a retry: instead of running the effect again, it stops the effect. When the deadline wins, the effect is **interrupted**, not left running in the background like an abandoned Promise.

| Function | On timeout | Type of the result |
|---|---|---|
| \`Effect.timeout(d)\` | Fails with \`TimeoutError\` | \`Effect<A, E \\| TimeoutError>\` |
| \`Effect.timeoutOption(d)\` | Succeeds with \`Option.none()\` | \`Effect<Option<A>, E>\` |
| \`Effect.timeoutOrElse({ duration, orElse })\` | Runs the fallback | \`Effect<A \\| B, E \\| E2>\` |

\`TimeoutError\` is a tagged error, so \`Effect.catchTag("TimeoutError", ...)\` handles it like any other. If you forget to handle it, it stays in the type.

Combining retry and timeout is where order matters. \`timeout\` **inside** \`retry\` gives each attempt its own budget: a hung attempt is cut off and retried. \`timeout\` **outside** \`retry\` puts one deadline over the whole sequence of attempts. Both are valid, they mean different things, and \`pipe\` makes the choice visible.
`,
      code: `import { Effect, Option, Ref } from "effect"

const slow = Effect.sleep("50 millis").pipe(Effect.as("slow answer"))
const fast = Effect.succeed("fast answer")

const program = Effect.gen(function* () {
  console.log(yield* fast.pipe(Effect.timeout("10 millis")))

  const b = yield* slow.pipe(
    Effect.timeout("2 millis"),
    Effect.catchTag("TimeoutError", () => Effect.succeed("timed out"))
  )
  console.log(b)

  const c = yield* slow.pipe(Effect.timeoutOption("2 millis"))
  console.log(Option.isNone(c) ? "none" : "some")

  const d = yield* slow.pipe(
    Effect.timeoutOrElse({ duration: "2 millis", orElse: () => Effect.succeed("cached answer") })
  )
  console.log(d)

  // timeout INSIDE retry: every attempt gets 2 ms, then the next attempt starts
  const attempts = yield* Ref.make(0)
  const e = yield* Ref.update(attempts, (n) => n + 1).pipe(
    Effect.andThen(slow),
    Effect.timeout("2 millis"),
    Effect.retry({ times: 2 }),
    Effect.catchTag("TimeoutError", () => Effect.succeed("gave up"))
  )
  console.log(e, "after", yield* Ref.get(attempts), "attempts")
})

Effect.runPromise(program)
`,
      expectedOutput: `fast answer
timed out
none
cached answer
gave up after 3 attempts`,
      after: `Move \`Effect.timeout("2 millis")\` below \`Effect.retry({ times: 2 })\`. Now the 2 ms covers all attempts together, the first one is interrupted, and the count drops to 1. Same functions, different order, different program.`
    }
  ],
  challenges: [
    {
      id: "scheduling-c1",
      title: "One too many",
      task: `The service allows exactly **three** calls per request before it blocks you. The program makes four. Change the retry policy so the task runs exactly three times and prints \`attempts: 3\`.`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const alwaysFails = Effect.gen(function* () {
    yield* Ref.update(attempts, (n) => n + 1)
    return yield* Effect.fail("unavailable")
  })

  yield* alwaysFails.pipe(Effect.retry({ times: 3 }), Effect.ignore)
  console.log("attempts:", yield* Ref.get(attempts))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const alwaysFails = Effect.gen(function* () {
    yield* Ref.update(attempts, (n) => n + 1)
    return yield* Effect.fail("unavailable")
  })

  yield* alwaysFails.pipe(Effect.retry({ times: 2 }), Effect.ignore)
  console.log("attempts:", yield* Ref.get(attempts))
})

Effect.runPromise(program)
`,
      expectedOutput: `attempts: 3`,
      hints: [
        "Does times count attempts or retries?",
        "Lesson 1: the first run is free, times only counts the runs after it.",
        "Use times: 2."
      ],
      explanation: `\`times\` is the number of **retries**. The first attempt always happens, then up to \`times\` more, so \`times: 3\` is four runs. This is the off-by-one that hand-written loops get wrong in both directions. Effect's rule is consistent everywhere: \`recurs(n)\`, \`upTo({ times: n })\`, and \`times: n\` all mean "n runs after the first".`
    },
    {
      id: "scheduling-c2",
      title: "Wrong tool",
      task: `The task fails twice and then succeeds, but the program reports a failure after a single attempt. The policy is fine; the function applying it is not. Make it print \`payload after 3 attempts\`.`,
      code: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const flaky = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (n < 3) return yield* Effect.fail("connection reset")
    return "payload"
  })

  const outcome = yield* flaky.pipe(Effect.repeat(Schedule.recurs(5)), Effect.result)
  if (outcome._tag === "Success") {
    console.log("payload after", yield* Ref.get(attempts), "attempts")
  } else {
    console.log("failed after", yield* Ref.get(attempts), "attempt")
  }
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const flaky = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (n < 3) return yield* Effect.fail("connection reset")
    return "payload"
  })

  const outcome = yield* flaky.pipe(Effect.retry(Schedule.recurs(5)), Effect.result)
  if (outcome._tag === "Success") {
    console.log("payload after", yield* Ref.get(attempts), "attempts")
  } else {
    console.log("failed after", yield* Ref.get(attempts), "attempt")
  }
})

Effect.runPromise(program)
`,
      expectedOutput: `payload after 3 attempts`,
      hints: [
        "One function runs again after success, another runs again after failure. Which is this task?",
        "Lesson 5 ends with the distinction: repeat reacts to success, retry reacts to failure.",
        "Replace Effect.repeat with Effect.retry."
      ],
      explanation: `\`Effect.repeat\` only recurs after a **success**. The first attempt failed, so \`repeat\` stopped and passed the failure through; the schedule never got a say. \`Effect.retry\` is the one that recurs after a failure. They accept the same schedules, which is exactly why mixing them up compiles fine and only shows at runtime.`
    },
    {
      id: "scheduling-c3",
      title: "The timeout that is not in the type",
      task: `\`loadProfile\` promises it cannot fail, but the timeout it applies adds a failure the annotation does not admit, so the file does not compile. Keep the annotation and the timeout. Handle the timeout so the function returns \`"cached profile"\` when the deadline wins, and the program prints exactly that.`,
      code: `import { Effect } from "effect"

const fetchProfile = Effect.sleep("50 millis").pipe(Effect.as("fresh profile"))

const loadProfile = (): Effect.Effect<string> =>
  fetchProfile.pipe(Effect.timeout("2 millis"))

Effect.runPromise(loadProfile()).then(console.log)
`,
      solution: `import { Effect } from "effect"

const fetchProfile = Effect.sleep("50 millis").pipe(Effect.as("fresh profile"))

const loadProfile = (): Effect.Effect<string> =>
  fetchProfile.pipe(
    Effect.timeout("2 millis"),
    Effect.catchTag("TimeoutError", () => Effect.succeed("cached profile"))
  )

Effect.runPromise(loadProfile()).then(console.log)
`,
      expectedOutput: `cached profile`,
      hints: [
        "Read the type error: what error type does Effect.timeout add to the channel?",
        "TimeoutError is a tagged error. Lesson 6 handles it with a catch that matches on the tag.",
        "Add Effect.catchTag(\"TimeoutError\", () => Effect.succeed(\"cached profile\")) after the timeout."
      ],
      explanation: `\`Effect.timeout\` turns "took too long" into a typed failure, \`TimeoutError\`, in the error channel. The annotation \`Effect.Effect<string>\` says the error type is \`never\`, so the compiler refuses. This is the point: a timeout is a way the function can fail, and callers must know. \`catchTag("TimeoutError", ...)\` removes that one error from the type and supplies the fallback, so the annotation becomes true again. A hand-written \`Promise.race\` with a timer would have hidden this entirely.`
    },
    {
      id: "scheduling-c4",
      title: "The schedule does not know its input",
      task: `The policy should retry only \`Unavailable\` errors, but the file does not compile: inside \`Schedule.while\`, \`input\` has no known type. Fix the way the schedule is passed to \`Effect.retry\` so it learns the effect's error type. The program should print \`NotFound after 1 attempt\`.`,
      code: `import { Data, Effect, Ref, Schedule } from "effect"

class Unavailable extends Data.TaggedError("Unavailable")<{}> {}
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: number }> {}

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const fetchUser = (id: number) =>
    Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      if (id === 404) return yield* new NotFound({ id })
      if (n < 3) return yield* new Unavailable()
      return "user-" + id
    })

  const outcome = yield* fetchUser(404).pipe(
    Effect.retry(
      Schedule.recurs(5).pipe(Schedule.while(({ input }) => input._tag === "Unavailable"))
    ),
    Effect.result
  )
  const label = outcome._tag === "Success" ? outcome.success : outcome.failure._tag
  console.log(label, "after", yield* Ref.get(attempts), "attempt")
})

Effect.runPromise(program)
`,
      solution: `import { Data, Effect, Ref, Schedule } from "effect"

class Unavailable extends Data.TaggedError("Unavailable")<{}> {}
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: number }> {}

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const fetchUser = (id: number) =>
    Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      if (id === 404) return yield* new NotFound({ id })
      if (n < 3) return yield* new Unavailable()
      return "user-" + id
    })

  const outcome = yield* fetchUser(404).pipe(
    Effect.retry(($) =>
      $(Schedule.recurs(5)).pipe(Schedule.while(({ input }) => input._tag === "Unavailable"))
    ),
    Effect.result
  )
  const label = outcome._tag === "Success" ? outcome.success : outcome.failure._tag
  console.log(label, "after", yield* Ref.get(attempts), "attempt")
})

Effect.runPromise(program)
`,
      expectedOutput: `NotFound after 1 attempt`,
      hints: [
        "Schedule.recurs(5) on its own accepts any input, so input is unknown and has no _tag.",
        "Lesson 4 shows a builder form of Effect.retry that receives a $ helper.",
        "Write Effect.retry(($) => $(Schedule.recurs(5)).pipe(Schedule.while(...)))."
      ],
      explanation: `A schedule has an \`Input\` type parameter. \`Schedule.recurs(5)\` is written for any input, so \`Input\` is \`unknown\`, and \`unknown._tag\` is a type error. The builder form of \`Effect.retry\` hands you \`$\`, which stamps the effect's error type (\`Unavailable | NotFound\`) onto the schedule before you pipe it. \`Schedule.setInputType<Unavailable | NotFound>()\` does the same by hand. Either way, the compiler now checks that your predicate matches the errors this effect can actually produce.`
    },
    {
      id: "scheduling-c5",
      title: "No cap",
      task: `The policy hammers the service until it finally answers on the 50th call. Requirements say: back off, but give up after **3 retries**. Change the schedule so the program prints \`gave up after 4 attempts\`.`,
      code: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const flaky = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (n < 50) return yield* Effect.fail("unavailable")
    return "ok"
  })

  const policy = Schedule.spaced("1 millis")

  const outcome = yield* flaky.pipe(Effect.retry(policy), Effect.result)
  const count = yield* Ref.get(attempts)
  console.log(outcome._tag === "Success" ? "ok after" : "gave up after", count, "attempts")
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const flaky = Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (n) => n + 1)
    if (n < 50) return yield* Effect.fail("unavailable")
    return "ok"
  })

  const policy = Schedule.spaced("1 millis").pipe(Schedule.upTo({ times: 3 }))

  const outcome = yield* flaky.pipe(Effect.retry(policy), Effect.result)
  const count = yield* Ref.get(attempts)
  console.log(outcome._tag === "Success" ? "ok after" : "gave up after", count, "attempts")
})

Effect.runPromise(program)
`,
      expectedOutput: `gave up after 4 attempts`,
      hints: [
        "Schedule.spaced never stops on its own. Something has to cap it.",
        "Lesson 2 and 3 show two ways: a combinator that limits recurrences, or max with recurs.",
        "Pipe the schedule into Schedule.upTo({ times: 3 }), or use Schedule.max([Schedule.spaced(\"1 millis\"), Schedule.recurs(3)])."
      ],
      explanation: `\`spaced\`, \`exponential\`, and \`fibonacci\` describe **delays**, not limits; they recur forever. A limit is a separate rule you compose in. \`upTo({ times: 3 })\` allows three recurrences (four attempts total). \`Schedule.max([spaced, recurs(3)])\` reads the same way: continue only while both agree, and \`recurs(3)\` stops agreeing after three. Keeping delay and limit as separate values is what makes policies reusable: swap the delay, keep the cap.`
    },
    {
      id: "scheduling-c6",
      title: "Timeout in the wrong place",
      task: `Each call should get its own 2 ms budget and be retried up to twice, so three attempts happen before giving up. Right now only one attempt happens. Reorder the pipeline so it prints \`gave up, attempts: 3\`.`,
      code: `import { Effect, Ref } from "effect"

const slow = Effect.sleep("50 millis").pipe(Effect.as("answer"))

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  const result = yield* Ref.update(attempts, (n) => n + 1).pipe(
    Effect.andThen(slow),
    Effect.retry({ times: 2 }),
    Effect.timeout("2 millis"),
    Effect.catchTag("TimeoutError", () => Effect.succeed("gave up"))
  )
  console.log(result + ", attempts:", yield* Ref.get(attempts))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const slow = Effect.sleep("50 millis").pipe(Effect.as("answer"))

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  const result = yield* Ref.update(attempts, (n) => n + 1).pipe(
    Effect.andThen(slow),
    Effect.timeout("2 millis"),
    Effect.retry({ times: 2 }),
    Effect.catchTag("TimeoutError", () => Effect.succeed("gave up"))
  )
  console.log(result + ", attempts:", yield* Ref.get(attempts))
})

Effect.runPromise(program)
`,
      expectedOutput: `gave up, attempts: 3`,
      hints: [
        "Which effect does the timeout wrap: one attempt, or the whole retry loop?",
        "pipe reads top to bottom. Whatever comes before timeout is what the deadline covers.",
        "Put Effect.timeout(\"2 millis\") before Effect.retry({ times: 2 })."
      ],
      explanation: `In the broken order, \`retry\` wraps \`slow\`, and then \`timeout\` wraps the retrying effect. The 2 ms deadline covers all attempts together, so the first 50 ms attempt is interrupted and there is never a second one. Nothing failed, so \`retry\` had nothing to retry. With \`timeout\` first, each attempt is its own effect that fails with \`TimeoutError\` after 2 ms, and \`retry\` sees that failure and runs another. Same functions; the pipe order is the semantics.`
    },
    {
      id: "scheduling-c7",
      title: "Poll until, not while",
      task: `The poller should keep checking until the job reports \`done\`, but it stops after the very first check. Fix the repeat options so the program prints \`job done after 3 polls\`.`,
      code: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  const polls = yield* Ref.make(0)
  const checkJob = Ref.updateAndGet(polls, (n) => n + 1).pipe(
    Effect.map((n) => (n < 3 ? "pending" : "done"))
  )

  const status = yield* checkJob.pipe(
    Effect.repeat({ while: (s) => s === "done", schedule: Schedule.spaced("1 millis") })
  )
  console.log("job", status, "after", yield* Ref.get(polls), "polls")
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function* () {
  const polls = yield* Ref.make(0)
  const checkJob = Ref.updateAndGet(polls, (n) => n + 1).pipe(
    Effect.map((n) => (n < 3 ? "pending" : "done"))
  )

  const status = yield* checkJob.pipe(
    Effect.repeat({ until: (s) => s === "done", schedule: Schedule.spaced("1 millis") })
  )
  console.log("job", status, "after", yield* Ref.get(polls), "polls")
})

Effect.runPromise(program)
`,
      expectedOutput: `job done after 3 polls`,
      hints: [
        "Read the predicate as a sentence: repeat while the status is done. Is that what you want?",
        "There are two option names for a stop condition. One continues when true, the other stops when true.",
        "Change while to until."
      ],
      explanation: `\`while\` keeps repeating as long as the predicate is true; the first status is \`"pending"\`, so \`"pending" === "done"\` is false and repeating ends at once. \`until\` is the mirror image: keep going **until** the predicate is true. Both exist because each reads naturally for a different condition; pick the one that makes the sentence true. The same pair exists on \`Effect.retry\` for errors.`
    }
  ],
  problems: [
    {
      id: "scheduling-p1",
      title: "Resilient user fetch",
      spec: `
Build \`fetchUser(id)\` on top of the fake API given in the starter, then wrap it with a retry policy:

- \`api(id)\` fails with \`Unavailable\` on the first two calls for any id, then succeeds with a name. It fails with \`NotFound\` for id \`404\` every time.
- The policy: exponential backoff starting at \`"1 millis"\`, at most **3 retries**, and only for \`Unavailable\` errors. Use \`Schedule.max\` or \`Schedule.upTo\` for the cap, and the \`$\` builder form of \`Effect.retry\` (or the \`while\` option) for the filter.
- \`loadUser(id)\` runs the call with the policy, counts attempts in its own \`Ref\`, and prints one line per id in this exact format. On success print the name, on failure print the error's \`_tag\`.

\`\`\`
user 1: Ada (attempts: 3)
user 404: NotFound (attempts: 1)
\`\`\`

Call \`loadUser(1)\` then \`loadUser(404)\`.
`,
      starter: `import { Data, Effect, Ref, Schedule } from "effect"

class Unavailable extends Data.TaggedError("Unavailable")<{}> {}
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: number }> {}

// Fake API: Unavailable for the first two calls of each id, NotFound for 404
const makeApi = Effect.gen(function* () {
  const calls = yield* Ref.make<Record<number, number>>({})
  return (id: number) =>
    Effect.gen(function* () {
      const n = yield* Ref.modify(calls, (c) => [(c[id] ?? 0) + 1, { ...c, [id]: (c[id] ?? 0) + 1 }])
      if (id === 404) return yield* new NotFound({ id })
      if (n <= 2) return yield* new Unavailable()
      return "Ada"
    })
})

// TODO: policy = exponential backoff, at most 3 retries, only for Unavailable

// TODO: loadUser(api, id): count attempts in a Ref, retry with the policy, print the line

const program = Effect.gen(function* () {
  const api = yield* makeApi
  // TODO: loadUser(api, 1) then loadUser(api, 404)
})

Effect.runPromise(program)
`,
      solution: `import { Data, Effect, Ref, Schedule } from "effect"

class Unavailable extends Data.TaggedError("Unavailable")<{}> {}
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: number }> {}

// Fake API: Unavailable for the first two calls of each id, NotFound for 404
const makeApi = Effect.gen(function* () {
  const calls = yield* Ref.make<Record<number, number>>({})
  return (id: number) =>
    Effect.gen(function* () {
      const n = yield* Ref.modify(calls, (c) => [(c[id] ?? 0) + 1, { ...c, [id]: (c[id] ?? 0) + 1 }])
      if (id === 404) return yield* new NotFound({ id })
      if (n <= 2) return yield* new Unavailable()
      return "Ada"
    })
})

type Api = (id: number) => Effect.Effect<string, Unavailable | NotFound>

const backoff = Schedule.max([Schedule.exponential("1 millis"), Schedule.recurs(3)])

const loadUser = (api: Api, id: number) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const outcome = yield* Ref.update(attempts, (n) => n + 1).pipe(
      Effect.andThen(api(id)),
      Effect.retry(($) => $(backoff).pipe(Schedule.while(({ input }) => input._tag === "Unavailable"))),
      Effect.result
    )
    const label = outcome._tag === "Success" ? outcome.success : outcome.failure._tag
    console.log("user " + id + ": " + label + " (attempts: " + (yield* Ref.get(attempts)) + ")")
  })

const program = Effect.gen(function* () {
  const api = yield* makeApi
  yield* loadUser(api, 1)
  yield* loadUser(api, 404)
})

Effect.runPromise(program)
`,
      expectedOutput: `user 1: Ada (attempts: 3)
user 404: NotFound (attempts: 1)`,
      hints: [
        "Schedule.max([Schedule.exponential(\"1 millis\"), Schedule.recurs(3)]) is the capped backoff from lesson 3.",
        "Count attempts by piping Ref.update(attempts, n => n + 1) into Effect.andThen(api(id)) before the retry.",
        "Effect.retry(($) => $(backoff).pipe(Schedule.while(({ input }) => input._tag === \"Unavailable\"))) gives the schedule the error type; Effect.result lets you print either outcome."
      ]
    },
    {
      id: "scheduling-p2",
      title: "Job poller with a deadline",
      spec: `
Build \`pollJob(name, check)\`, where \`check\` is an Effect that returns \`"pending"\` or \`"done"\`.

- Poll with \`Effect.repeat\`, waiting \`"1 millis"\` between checks, until the status is \`"done"\`. Count the polls in a \`Ref\`.
- Put a \`"20 millis"\` timeout around the whole polling loop. A job that never finishes must not hang the program.
- Print \`<name>: done after <n> polls\` on success and \`<name>: timed out\` when the deadline wins.

The starter provides two checks: \`build\` becomes done on its third check; \`deploy\` is pending forever. Exact output:

\`\`\`
build: done after 3 polls
deploy: timed out
\`\`\`
`,
      starter: `import { Effect, Ref, Schedule } from "effect"

// build is done on its 3rd check; deploy is never done
const makeChecks = Effect.gen(function* () {
  const buildChecks = yield* Ref.make(0)
  const build = Ref.updateAndGet(buildChecks, (n) => n + 1).pipe(Effect.map((n) => (n >= 3 ? "done" : "pending")))
  const deploy = Effect.succeed("pending")
  return { build, deploy }
})

// TODO: pollJob(name, check): repeat until "done" with 1 ms spacing, 20 ms overall timeout, print the line

const program = Effect.gen(function* () {
  const checks = yield* makeChecks
  // TODO: pollJob("build", checks.build) then pollJob("deploy", checks.deploy)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref, Schedule } from "effect"

// build is done on its 3rd check; deploy is never done
const makeChecks = Effect.gen(function* () {
  const buildChecks = yield* Ref.make(0)
  const build = Ref.updateAndGet(buildChecks, (n) => n + 1).pipe(Effect.map((n) => (n >= 3 ? "done" : "pending")))
  const deploy = Effect.succeed("pending")
  return { build, deploy }
})

const pollJob = (name: string, check: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const outcome = yield* Ref.update(polls, (n) => n + 1).pipe(
      Effect.andThen(check),
      Effect.repeat({ until: (s) => s === "done", schedule: Schedule.spaced("1 millis") }),
      Effect.timeout("20 millis"),
      Effect.result
    )
    if (outcome._tag === "Success") {
      console.log(name + ": done after " + (yield* Ref.get(polls)) + " polls")
    } else {
      console.log(name + ": timed out")
    }
  })

const program = Effect.gen(function* () {
  const checks = yield* makeChecks
  yield* pollJob("build", checks.build)
  yield* pollJob("deploy", checks.deploy)
})

Effect.runPromise(program)
`,
      expectedOutput: `build: done after 3 polls
deploy: timed out`,
      hints: [
        "Count polls by piping Ref.update(polls, n => n + 1) into Effect.andThen(check); that counted effect is what you repeat.",
        "Effect.repeat({ until: (s) => s === \"done\", schedule: Schedule.spaced(\"1 millis\") }) is the polling loop from lesson 5.",
        "Effect.timeout(\"20 millis\") goes after repeat so it covers the whole loop; Effect.result turns the TimeoutError into a value you can print."
      ]
    },
    {
      id: "scheduling-p3",
      title: "Batch with a per-item budget",
      spec: `
Process a batch of items where each item gets its own time budget and one retry.

- \`work(item)\` is given: it sleeps for the item's delay in milliseconds and returns \`"ok"\`. Item \`b\` is slow.
- For each item: apply a \`"10 millis"\` timeout to \`work(item)\`, then retry it once (\`times: 1\`), then turn a \`TimeoutError\` into the string \`"timed out"\` with \`Effect.catchTag\`.
- Count every call to \`work\` in one shared \`Ref\`.
- Use \`Effect.forEach\` over the items and print \`<item>: <result>\` per item, then \`attempts: <n>\`.

Exact output:

\`\`\`
a: ok
b: timed out
c: ok
attempts: 4
\`\`\`
`,
      starter: `import { Effect, Ref } from "effect"

const delays: Record<string, number> = { a: 1, b: 50, c: 1 }   // milliseconds
const items = ["a", "b", "c"]

const work = (item: string) => Effect.sleep(delays[item]!).pipe(Effect.as("ok"))

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  // TODO: process(item): count the attempt, run work(item) with a 10 ms timeout,
  //       retry once, map TimeoutError to "timed out"

  // TODO: Effect.forEach over items, print "<item>: <result>" for each

  console.log("attempts:", yield* Ref.get(attempts))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const delays: Record<string, number> = { a: 1, b: 50, c: 1 }   // milliseconds
const items = ["a", "b", "c"]

const work = (item: string) => Effect.sleep(delays[item]!).pipe(Effect.as("ok"))

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  const process = (item: string) =>
    Ref.update(attempts, (n) => n + 1).pipe(
      Effect.andThen(work(item)),
      Effect.timeout("10 millis"),        // each attempt gets its own budget
      Effect.retry({ times: 1 }),         // one retry per item
      Effect.catchTag("TimeoutError", () => Effect.succeed("timed out"))
    )

  yield* Effect.forEach(items, (item) =>
    process(item).pipe(Effect.tap((result) => Effect.sync(() => console.log(item + ": " + result)))))

  console.log("attempts:", yield* Ref.get(attempts))
})

Effect.runPromise(program)
`,
      expectedOutput: `a: ok
b: timed out
c: ok
attempts: 4`,
      hints: [
        "Build the per-item pipeline in the order: count, work, timeout, retry, catchTag. Order matters (lesson 6).",
        "Ref.update(attempts, n => n + 1).pipe(Effect.andThen(work(item))) makes the count part of what gets retried.",
        "Effect.forEach(items, (item) => process(item).pipe(Effect.tap(...))) runs them in order; a and c take 1 attempt, b takes 2."
      ]
    }
  ],
  recall: [
    {
      q: "How many times does `Effect.retry(task, { times: 3 })` run `task` if it always fails?",
      a: "Four. The first attempt always happens; `times` counts the retries after it. `Schedule.recurs(3)` and `Schedule.upTo({ times: 3 })` follow the same rule."
    },
    {
      q: "What is the difference between `Effect.retry` and `Effect.repeat`?",
      a: "`retry` runs the effect again after a **failure** and stops on success. `repeat` runs it again after a **success** and stops on failure. Both accept the same `Schedule` values."
    },
    {
      q: "Which combinator would you reach for to say \"exponential backoff, but give up after 5 retries\"?",
      a: "`Schedule.max([Schedule.exponential(\"100 millis\"), Schedule.recurs(5)])`, or `Schedule.exponential(\"100 millis\").pipe(Schedule.upTo({ times: 5 }))`. `max` continues only while both schedules continue; `recurs(5)` stops after five."
    },
    {
      q: "What would the type of `Effect.succeed(\"x\").pipe(Effect.timeout(\"1 second\"))` be?",
      a: "`Effect<string, TimeoutError>`. `timeout` adds `Cause.TimeoutError` to the error channel. `timeoutOption` would give `Effect<Option<string>, never>` instead."
    },
    {
      q: "You want to retry `Unavailable` errors but fail fast on `NotFound`. What are the two ways to express that?",
      a: "The options form: `Effect.retry(effect, { times: 5, while: (e) => e._tag === \"Unavailable\" })`. Or the schedule form with the builder: `Effect.retry(($) => $(Schedule.recurs(5)).pipe(Schedule.while(({ input }) => input._tag === \"Unavailable\")))`. The `$` helper gives the schedule the effect's error type."
    },
    {
      q: "`slow.pipe(Effect.retry({ times: 2 }), Effect.timeout(\"1 second\"))` versus `slow.pipe(Effect.timeout(\"1 second\"), Effect.retry({ times: 2 }))`: what changes?",
      a: "In the first, one deadline covers all three attempts together; when it fires the whole retry loop is interrupted. In the second, each attempt gets its own second, a slow attempt fails with `TimeoutError`, and `retry` runs the next one. Per-attempt budget needs `timeout` inside `retry`."
    }
  ]
}

export default section
