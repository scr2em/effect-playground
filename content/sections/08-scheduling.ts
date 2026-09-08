import type { Section } from "../types.ts"

const section: Section = {
  id: "scheduling",
  title: "Scheduling",
  order: 8,
  summary: "Retry, repeat, and time out work with a Schedule: a value that describes when to try again.",
  intro: `
**The problem.** Many codebases contain a retry loop like this one. Each one has small errors:

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

Is \`retries = 3\` 3 attempts or 3 retries? The code does not say. The delay is fixed, so 100 clients that hit a slow server all return at the same second. The loop retries a \`404\` in the same way as a network error. You cannot cancel the \`setTimeout\`, so a user who left the page still causes 3 more requests.

The policy is part of the loop. You cannot test it, use it for a different function, or add a timeout without a rewrite.

### The shift

Today you think of a retry as a loop that waits. In Effect, a retry policy is a value. The value describes when to try again. This value is a \`Schedule\`. A schedule knows 2 things: how long to wait before the next attempt, and if there is a next attempt at all.

A schedule is data. You build it once, you combine it with \`pipe\`, and you give it to \`Effect.retry\` or \`Effect.repeat\`. The same \`Schedule\` works for 3 tasks: retry an effect that fails, repeat an effect that succeeds, and poll a job status.

The wait goes through the Effect clock, so you can interrupt it. If you interrupt the parent fiber, the retry stops in the middle of the wait. The effect that you retry is a description, so "try again" means "run the description again". There are no closures or flags to reset. Attempt limits, backoff, jitter, and "retry only these errors" each take 1 line.

| Function | Runs the effect again when... | Use it when |
|---|---|---|
| \`Effect.retry(effect, policy)\` | It **fails** | The error is temporary: network, locks, rate limits |
| \`Effect.repeat(effect, policy)\` | It **succeeds** | You poll, you send heartbeats, or you do a task N times |
| \`Effect.schedule(effect, schedule)\` | It succeeds; the value is ignored | The work is periodic and the result does not matter |
| \`Effect.timeout(effect, duration)\` | Never; it stops the effect | The effect can hang |

In this section, each program counts attempts in a \`Ref\` and prints the count. It never prints the elapsed time, so the output is the same on each machine.
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

In Effect, \`Effect.retry(effect, { times: 2 })\` does the same work. The name is precise: \`times\` is the number of **retries** after the first attempt. \`times: 2\` means a maximum of 3 runs. If the last retry also fails, you get that failure back.

The effect that you retry is a description, so a new run needs no reset logic. The \`Ref\` in this program is only a counter. We use it to print the number of attempts.
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
      after: `Note: \`times: 2\` gave 3 attempts. Each count in this section works in the same way. The first run always happens. The schedule only decides about the runs after it. Change the value to \`times: 0\`: the effect runs 1 time, with no retries.`
    },
    {
      id: "scheduling-l2",
      title: "A Schedule is a value",
      explain: `
\`{ times: 2 }\` is a short form. The full form is a \`Schedule\`. A schedule is a value that you can hold in a variable, pass to a function, and combine with other schedules. Its type is \`Schedule<Output, Input>\`. \`Output\` is the value that the schedule produces at each step, for example a count or a delay. \`Input\` is the value that the schedule examines, for example the error when you retry.

| Constructor | Waits | Stops by itself? |
|---|---|---|
| \`Schedule.recurs(n)\` | No wait | After \`n\` recurrences |
| \`Schedule.spaced("1 second")\` | The same delay each time | No |
| \`Schedule.exponential("1 second")\` | 1s, 2s, 4s, 8s... | No |
| \`Schedule.fibonacci("1 second")\` | 1s, 2s, 3s, 5s, 8s... | No |
| \`Schedule.forever\` | No wait | No |

Caution: a schedule that does not stop by itself can run forever. \`Schedule.upTo({ times: n })\` puts a limit on any schedule.

\`Schedule.tap\` shows you each decision: the attempt number and the delay that the schedule **computed**. The delay comes from a formula in the schedule, not from a clock. That is why it is safe to print it.
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
      after: `The program builds the schedule at the top of the file and uses it at the bottom. Replace \`Schedule.exponential\` with \`Schedule.fibonacci("1 millis")\`: the delays become 1, 2, 3. Remove \`upTo\`: the program never ends, because an exponential schedule does not stop by itself.`
    },
    {
      id: "scheduling-l3",
      title: "Combine schedules",
      explain: `
A real policy combines several rules. One example: use exponential backoff, and stop after 5 retries. Also add a random part to each delay, so that clients do not retry at the same moment. Each rule is a schedule. Combinators merge them.

| Combinator | Continues while... | Delay that it uses |
|---|---|---|
| \`Schedule.max([a, b])\` | **Both** schedules continue | The longer one |
| \`Schedule.min([a, b])\` | **One** of the schedules continues | The shorter one |
| \`Schedule.upTo({ times, duration })\` | The limit is not reached | Not changed |
| \`Schedule.jittered\` | Not changed | Multiplied by a random number from 0.8 to 1.2 |

Use \`max\` for "backoff with a limit on attempts". An exponential schedule continues forever. \`recurs(2)\` stops after 2 recurrences. Together they stop after 2. Use \`min\` for "backoff, but never wait longer than X". Pair an exponential schedule with \`spaced("5 seconds")\`: when the exponential delay becomes longer than 5 seconds, the shorter delay wins.

A schedule is a value, so you define a policy 1 time and apply it to many tasks. The program below applies 1 policy to 2 different tasks.
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
      after: `\`jittered\` changes the delays at random, but it does not change the number of attempts. That is why the output is stable. Change \`max\` to \`min\`: the policy now continues while **one** schedule continues. The exponential schedule never stops, so the "database" task retries forever. That is the difference between the 2 combinators.`
    },
    {
      id: "scheduling-l4",
      title: "Retry only the errors that are temporary",
      explain: `
A retry of a \`404\` with backoff wastes seconds and hides a bug. A retry policy must examine the error and decide. Effect gives you 2 ways.

The **options form** accepts a \`while\` or \`until\` predicate on the error, next to \`times\`. Example: \`Effect.retry(effect, { times: 5, while: (e) => e._tag === "Unavailable" })\`. When the predicate returns \`false\`, the retry stops, even if attempts remain.

The **schedule form** uses \`Schedule.while\`. This function receives the schedule metadata. The error is in \`meta.input\`. A plain \`Schedule.recurs(5)\` does not know its input type; the type is \`unknown\`. For this reason, \`Effect.retry\` also accepts a builder function: \`Effect.retry(($) => $(schedule).pipe(...))\`. The \`$\` helper puts the error type of the effect on the schedule, so \`input._tag\` compiles.

Tagged errors make both forms easy to read. Real code uses tagged errors in any case.
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
      after: `The \`NotFound\` call failed after 1 attempt. The policy permitted 5 attempts, but the predicate stopped it. Remove the \`while\` option and call \`fetchUser(404)\` with the options form: the program makes 6 attempts, and each one fails. The predicate is what makes a retry useful.`
    },
    {
      id: "scheduling-l5",
      title: "Repeat: the same schedule after success",
      explain: `
\`Effect.retry\` runs the effect again after a **failure**. \`Effect.repeat\` runs the effect again after a **success**. Both accept the same schedule values. \`repeat\` is the tool for polls, heartbeats, and "do this 5 times".

Two rules apply. First, the count rule is the same: the effect runs 1 time, then the schedule decides about more runs. \`Schedule.recurs(2)\` means 3 runs. Second, \`repeat\` returns the **output of the schedule**, not the last value of the effect. For \`recurs\` and \`spaced\`, the output is the number of recurrences.

\`Effect.schedule\` is a related function for work whose result you ignore. It has 1 difference: it asks the schedule **before** the first run also. With \`Effect.schedule\`, \`Schedule.recurs(2)\` means exactly 2 runs. Think of \`repeat\` as "run, then possibly run again" and of \`schedule\` as "run on this timetable".

For a poll, the options form has \`until\` and \`while\` on the **success value**. Example: \`Effect.repeat(check, { until: (s) => s === "done", schedule: Schedule.spaced("1 second") })\`. This runs \`check\` until the status is done, and returns that final status.
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
      after: `Note the 2 counts: \`repeat\` with \`recurs(2)\` ran 3 times, and \`schedule\` with \`upTo({ times: 2 })\` ran 2 times. If the effect fails, \`repeat\` stops and returns the failure. It never retries. That is the full difference: \`retry\` reacts to a failure, \`repeat\` reacts to a success. Change \`until\` to \`while\` in the poll: it stops after the first "pending".`
    },
    {
      id: "scheduling-l6",
      title: "Timeouts, and retry with a timeout",
      explain: `
A timeout is the opposite of a retry. It does not run the effect again; it stops the effect. When the time limit wins, Effect **interrupts** the effect. The effect does not continue in the background like an abandoned Promise.

| Function | On timeout | Type of the result |
|---|---|---|
| \`Effect.timeout(d)\` | Fails with \`TimeoutError\` | \`Effect<A, E \\| TimeoutError>\` |
| \`Effect.timeoutOption(d)\` | Succeeds with \`Option.none()\` | \`Effect<Option<A>, E>\` |
| \`Effect.timeoutOrElse({ duration, orElse })\` | Runs the fallback effect | \`Effect<A \\| B, E \\| E2>\` |

\`TimeoutError\` is a tagged error. \`Effect.catchTag("TimeoutError", ...)\` catches it like any other tagged error. If you do not catch it, it stays in the error type.

When you combine a retry and a timeout, the order is important. A \`timeout\` **inside** the \`retry\` gives each attempt its own time limit. Effect stops an attempt that hangs and then retries. A \`timeout\` **outside** the \`retry\` puts 1 time limit on all attempts together. Both orders are valid, but they mean different things. The \`pipe\` order shows which one you chose.
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
      after: `Move \`Effect.timeout("2 millis")\` below \`Effect.retry({ times: 2 })\`. The 2 ms limit now applies to all attempts together. Effect interrupts the first attempt, and the count becomes 1. The functions are the same, but the order makes a different program.`
    }
,
    {
      id: "scheduling-l7",
      title: "Jitter and cron",
      explain: `
This lesson adds 2 tools: a random delay and a calendar.

**Jitter.** 100 clients lose a connection at the same second. Each client retries with the same backoff. All 100 return at the same moment, and the server fails again. The name for this is a retry storm. \`Schedule.jittered\` multiplies each delay by a random factor between 0.8 and 1.2, so the clients spread out. Jitter changes only the delay. The number of attempts, the limit, and the output of the schedule stay the same. The program prints the attempt number from \`Schedule.tap\`, not the delay, because the delay is random.

**Cron.** A cron expression describes points in time on a calendar, for example "02:00 every day". The \`Cron\` module parses and tests expressions. An expression has 6 fields: second, minute, hour, day of month, month, and day of week. Note: with 5 fields, the seconds field is 0. Give a time zone as the second argument. Without it, the expression uses the local time zone of the machine.

| Function | Does | Returns |
|---|---|---|
| \`Cron.parse(text, tz)\` | parses the text | \`Result<Cron, CronParseError>\` |
| \`Cron.parseUnsafe(text, tz)\` | parses the text | \`Cron\`, or it throws |
| \`Cron.match(cron, date)\` | tests 1 date | \`boolean\` |
| \`Cron.next(cron, date)\` | finds the first match after the date | \`Date\` |
| \`Schedule.cron(cron)\` | makes a schedule from the cron | \`Schedule<Duration>\` |

\`Schedule.cron\` reads the clock and waits until the next match. The delay depends on the real time, so the program does not run this schedule. It only shows that the schedule is a value. Give it to \`Effect.schedule\` in a real service.
`,
      code: `import { Cron, Effect, Ref, Result, Schedule } from "effect"

// jittered: the schedule multiplies each delay by a random factor from 0.8 to 1.2
const policy = Schedule.exponential("1 millis").pipe(
  Schedule.upTo({ times: 3 }),
  Schedule.jittered,
  Schedule.tap((meta) => Effect.sync(() => console.log("retry", meta.attempt)))
)

const program = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)
  const alwaysFails = Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(Effect.fail("down")))
  const outcome = yield* alwaysFails.pipe(Effect.retry(policy), Effect.result)
  console.log(outcome._tag, "after", yield* Ref.get(attempts), "attempts")

  // cron: 6 fields = second minute hour day month weekday. Here: 02:00:00 every day, UTC.
  const nightly = Cron.parseUnsafe("0 0 2 * * *", "UTC")
  console.log("02:00 matches:", Cron.match(nightly, "2024-03-10T02:00:00Z"))
  console.log("02:30 matches:", Cron.match(nightly, "2024-03-10T02:30:00Z"))
  console.log("next after 10 Mar 05:00:", Cron.next(nightly, "2024-03-10T05:00:00Z").toISOString())

  // A bad expression is a value too: parse returns a Result, it does not throw
  console.log("parse '* * bad':", Result.isFailure(Cron.parse("* * bad")) ? "Failure" : "Success")

  // Schedule.cron turns a Cron into a Schedule. Its delay is the time until the next match.
  const nightlyPolicy = Schedule.cron(nightly)
  console.log("schedule:", Schedule.isSchedule(nightlyPolicy))
})

Effect.runPromise(program)
`,
      expectedOutput: `retry 1
retry 2
retry 3
Failure after 4 attempts
02:00 matches: true
02:30 matches: false
next after 10 Mar 05:00: 2024-03-11T02:00:00.000Z
parse '* * bad': Failure
schedule: true`,
      after: `Remove \`Schedule.jittered\`: the output is the same, because jitter changes only the delays. Change the expression to \`"0 30 2 * * 1-5"\`, which means 02:30 on Monday to Friday. The 10 March 2024 is a Sunday, so the next match is Monday 11 March at 02:30, and the 02:00 test becomes \`false\`.`
    }
  ],
  dosAndDonts: [
    {
      do: "Count \`times\` as the retries after the first attempt.",
      dont: "Do not count \`times\` as the total number of attempts.",
      why: "\`times: 3\` runs the effect 4 times, and a service with a limit of 3 calls blocks the client."
    },
    {
      do: "Put a limit on \`spaced\`, \`exponential\`, and \`fibonacci\` with \`Schedule.upTo\`, or with \`Schedule.max\` and \`Schedule.recurs\`.",
      dont: "Do not use a delay schedule by itself.",
      why: "A delay schedule does not stop, so a service that never recovers makes the program retry forever."
    },
    {
      do: "Use \`Effect.retry\` to run again after a failure and \`Effect.repeat\` to run again after a success.",
      dont: "Do not use \`Effect.repeat\` to retry an effect that fails.",
      why: "\`repeat\` stops on the first failure, so the schedule makes no decision and the error goes to the caller."
    },
    {
      do: "Filter the errors with the \`while\` option or with \`Schedule.while\`, and retry only the temporary errors.",
      dont: "Do not retry each error.",
      why: "A retry of a \`NotFound\` error wastes each attempt and hides a bug in the caller."
    },
    {
      do: "Use the builder form, \`Effect.retry(($) => $(schedule).pipe(...))\`, when \`Schedule.while\` reads \`input\`.",
      dont: "Do not pipe \`Schedule.while\` onto a schedule that has no input type.",
      why: "The input type is \`unknown\`, so \`input._tag\` does not compile."
    },
    {
      do: "Catch \`TimeoutError\` with \`Effect.catchTag\`, or use \`Effect.timeoutOption\` or \`Effect.timeoutOrElse\`.",
      dont: "Do not declare a return type without \`TimeoutError\` after \`Effect.timeout\`.",
      why: "\`timeout\` adds \`TimeoutError\` to the error channel, and the compiler rejects a type that does not include it."
    },
    {
      do: "Put \`Effect.timeout\` before \`Effect.retry\` in the pipe when each attempt needs its own time limit.",
      dont: "Do not put the timeout after the retry when each attempt needs its own time limit.",
      why: "A timeout after the retry applies to all attempts together, so Effect interrupts the first slow attempt and no retry happens."
    },
    {
      do: "Test a cron expression with \`Cron.next\` on a fixed date before you give it to \`Schedule.cron\`.",
      dont: "Do not count the fields of a cron expression from memory.",
      why: "With 6 fields the first field is the second, so \`0 2 * * * *\` runs every hour at minute 2, not at 02:00."
    }
  ],
  challenges: [
    {
      id: "scheduling-c1",
      title: "One attempt too many",
      task: `The service permits exactly 3 calls per request. After that, it blocks the client. This program makes 4 calls. Change the retry policy so that the task runs exactly 3 times and the program prints \`attempts: 3\`.`,
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
        "Does times count the attempts or the retries?",
        "Lesson 1: the first run always happens. The value of times only counts the runs after it.",
        "Use times: 2."
      ],
      explanation: `\`times\` is the number of **retries**. The first attempt always happens, and then a maximum of \`times\` more attempts follow. \`times: 3\` is 4 runs. Loops that people write by hand get this count wrong in both directions. The rule in Effect is the same in each place: \`recurs(n)\`, \`upTo({ times: n })\`, and \`times: n\` all mean "n runs after the first run".`
    },
    {
      id: "scheduling-c2",
      title: "Wrong function",
      task: `The task fails 2 times and then succeeds. The program reports a failure after 1 attempt. The policy is correct; the function that applies it is not. Change the program so that it prints \`payload after 3 attempts\`.`,
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
        "One function runs the effect again after a success. Another runs it again after a failure. Which one does this task need?",
        "Lesson 5 ends with the difference: repeat reacts to a success, retry reacts to a failure.",
        "Replace Effect.repeat with Effect.retry."
      ],
      explanation: `\`Effect.repeat\` only runs the effect again after a **success**. The first attempt failed, so \`repeat\` stopped and returned the failure. The schedule made no decision. \`Effect.retry\` is the function that runs the effect again after a failure. The 2 functions accept the same schedules. That is why the wrong function compiles, and the error only shows when you run the program.`
    },
    {
      id: "scheduling-c3",
      title: "The timeout that is not in the type",
      task: `\`loadProfile\` declares that it cannot fail. The timeout that it applies adds a failure, and the declared type does not include it. The file does not compile. Keep the type and the timeout. Catch the timeout so that the function returns \`"cached profile"\` when the time limit wins. The program must print exactly that text.`,
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
        "Read the type error. Which error type does Effect.timeout add to the error channel?",
        "TimeoutError is a tagged error. Lesson 6 catches it with a function that matches on the tag.",
        "Add Effect.catchTag(\"TimeoutError\", () => Effect.succeed(\"cached profile\")) after the timeout."
      ],
      explanation: `\`Effect.timeout\` changes "too slow" into a typed failure, \`TimeoutError\`, in the error channel. The type \`Effect.Effect<string>\` says that the error type is \`never\`. The compiler rejects the difference. This is the value of the error type: a timeout is a way in which the function can fail, and callers must know about it. \`catchTag("TimeoutError", ...)\` removes that 1 error from the type and supplies the fallback value. The declared type is true again. A \`Promise.race\` with a timer hides this failure completely.`
    },
    {
      id: "scheduling-c4",
      title: "The schedule does not know its input",
      task: `The policy must retry only \`Unavailable\` errors. The file does not compile: inside \`Schedule.while\`, \`input\` has no known type. Change how the program passes the schedule to \`Effect.retry\`, so that the schedule gets the error type of the effect. The program must print \`NotFound after 1 attempt\`.`,
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
        "Schedule.recurs(5) by itself accepts any input. The input type is unknown, and unknown has no _tag.",
        "Lesson 4 shows a builder form of Effect.retry. The builder receives a $ helper.",
        "Write Effect.retry(($) => $(Schedule.recurs(5)).pipe(Schedule.while(...)))."
      ],
      explanation: `A schedule has an \`Input\` type parameter. \`Schedule.recurs(5)\` accepts any input, so \`Input\` is \`unknown\`. The expression \`unknown._tag\` is a type error. The builder form of \`Effect.retry\` gives you \`$\`. This helper puts the error type of the effect, \`Unavailable | NotFound\`, on the schedule before you pipe it. \`Schedule.setInputType<Unavailable | NotFound>()\` does the same by hand. With either form, the compiler checks that your predicate matches the errors that this effect can produce.`
    },
    {
      id: "scheduling-c5",
      title: "No limit",
      task: `The policy calls the service again and again until the service answers on the 50th call. The requirement is different: use backoff, but stop after **3 retries**. Change the schedule so that the program prints \`gave up after 4 attempts\`.`,
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
        "Schedule.spaced does not stop by itself. Add a rule that stops it.",
        "Lessons 2 and 3 show 2 ways: a combinator that limits the recurrences, or max together with recurs.",
        "Pipe the schedule into Schedule.upTo({ times: 3 }), or use Schedule.max([Schedule.spaced(\"1 millis\"), Schedule.recurs(3)])."
      ],
      explanation: `\`spaced\`, \`exponential\`, and \`fibonacci\` describe **delays**, not limits. They continue forever. A limit is a separate rule that you add. \`upTo({ times: 3 })\` permits 3 recurrences, which is 4 attempts in total. \`Schedule.max([spaced, recurs(3)])\` means the same: continue only while both schedules continue, and \`recurs(3)\` stops after 3. The delay and the limit are separate values. That is what makes a policy reusable: you can change the delay and keep the limit.`
    },
    {
      id: "scheduling-c6",
      title: "Timeout in the wrong place",
      task: `Each call must get its own time limit of 2 ms, with a maximum of 2 retries. That means 3 attempts before the program gives up. At the moment, only 1 attempt happens. Change the order of the pipeline so that the program prints \`gave up, attempts: 3\`.`,
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
        "Which effect does the timeout wrap: 1 attempt, or the full retry loop?",
        "Read the pipe from top to bottom. The time limit applies to all the steps before the timeout.",
        "Put Effect.timeout(\"2 millis\") before Effect.retry({ times: 2 })."
      ],
      explanation: `In the wrong order, \`retry\` wraps \`slow\`, and then \`timeout\` wraps the retry. The 2 ms limit applies to all attempts together. Effect interrupts the first 50 ms attempt, and a second attempt never starts. No failure occurred, so \`retry\` had nothing to retry. With \`timeout\` first, each attempt is its own effect. It fails with \`TimeoutError\` after 2 ms, \`retry\` sees that failure, and it runs the next attempt. The functions are the same; the pipe order defines what the program does.`
    },
    {
      id: "scheduling-c7",
      title: "Poll until, not while",
      task: `The poll must continue until the job reports \`done\`. It stops after the first check. Change the repeat options so that the program prints \`job done after 3 polls\`.`,
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
        "Read the predicate as a sentence: repeat while the status is done. Is that the requirement?",
        "There are 2 option names for a stop condition. One continues when the predicate is true. The other stops when it is true.",
        "Change while to until."
      ],
      explanation: `\`while\` continues the repeat while the predicate is true. The first status is \`"pending"\`, so \`"pending" === "done"\` is false and the repeat stops at once. \`until\` is the opposite: continue **until** the predicate is true. Both options exist because each one reads well for a different condition. Pick the option that makes the sentence true. \`Effect.retry\` has the same pair of options for errors.`
    }
,
    {
      id: "scheduling-c8",
      title: "The report that ran every hour",
      task: `The report must run 1 time per day, at 02:00 UTC. The program prints 2 runs that are 1 hour apart. Fix the cron expression. The program must print the next run as \`2024-03-11T02:00:00.000Z\` and the run after it as \`2024-03-12T02:00:00.000Z\`.`,
      code: `import { Cron } from "effect"

// The report must run once per day at 02:00 UTC
const report = Cron.parseUnsafe("0 2 * * * *", "UTC")

const start = "2024-03-10T05:00:00Z"
const first = Cron.next(report, start)
console.log("next run:", first.toISOString())
console.log("after that:", Cron.next(report, first).toISOString())
`,
      solution: `import { Cron } from "effect"

// The report must run once per day at 02:00 UTC
const report = Cron.parseUnsafe("0 0 2 * * *", "UTC")

const start = "2024-03-10T05:00:00Z"
const first = Cron.next(report, start)
console.log("next run:", first.toISOString())
console.log("after that:", Cron.next(report, first).toISOString())
`,
      expectedOutput: `next run: 2024-03-11T02:00:00.000Z
after that: 2024-03-12T02:00:00.000Z`,
      hints: [
        "Count the fields in the expression. Lesson 7 lists what each of the 6 fields means.",
        "With 6 fields, the first field is the second, not the minute. \"0 2\" means second 0 and minute 2, and the hour field is *.",
        "Write \"0 0 2 * * *\": second 0, minute 0, hour 2."
      ],
      explanation: `A 6-field expression starts with the seconds field. \`0 2 * * * *\` means second 0, minute 2, every hour, so the next match after 05:00 is 05:02. \`0 0 2 * * *\` means second 0, minute 0, hour 2, so it matches 1 time per day. The 5-field form \`0 2 * * *\` gives the same result, because the seconds field is 0 by default. Test an expression with \`Cron.next\` on a fixed date before you give it to \`Schedule.cron\`.`
    }
  ],
  problems: [
    {
      id: "scheduling-p1",
      title: "User fetch with a retry policy",
      spec: `
Build \`loadUser(api, id)\` on top of the fake API in the starter. Add a retry policy:

- \`api(id)\` fails with \`Unavailable\` on the first 2 calls for any id, then succeeds with a name. For id \`404\`, it fails with \`NotFound\` each time.
- The policy: exponential backoff that starts at \`"1 millis"\`, a maximum of **3 retries**, and only for \`Unavailable\` errors. Use \`Schedule.max\` or \`Schedule.upTo\` for the limit. Use the \`$\` builder form of \`Effect.retry\` (or the \`while\` option) for the error filter.
- \`loadUser(api, id)\` runs the call with the policy, counts the attempts in its own \`Ref\`, and prints 1 line per id in this exact format. On success, print the name. On failure, print the \`_tag\` of the error.

\`\`\`
user 1: Ada (attempts: 3)
user 404: NotFound (attempts: 1)
\`\`\`

Call \`loadUser(api, 1)\` and then \`loadUser(api, 404)\`.
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
        "Schedule.max([Schedule.exponential(\"1 millis\"), Schedule.recurs(3)]) is the backoff with a limit from lesson 3.",
        "To count the attempts, pipe Ref.update(attempts, n => n + 1) into Effect.andThen(api(id)) before the retry.",
        "Effect.retry(($) => $(backoff).pipe(Schedule.while(({ input }) => input._tag === \"Unavailable\"))) gives the schedule the error type. Effect.result lets you print both outcomes."
      ]
    },
    {
      id: "scheduling-p2",
      title: "Job poll with a time limit",
      spec: `
Build \`pollJob(name, check)\`. \`check\` is an effect that returns \`"pending"\` or \`"done"\`.

- Poll with \`Effect.repeat\`. Wait \`"1 millis"\` between checks. Stop when the status is \`"done"\`. Count the polls in a \`Ref\`.
- Put a \`"20 millis"\` timeout around the full poll loop. A job that never completes must not block the program.
- Print \`<name>: done after <n> polls\` on success. Print \`<name>: timed out\` when the time limit wins.

The starter gives 2 checks. \`build\` becomes done on its third check. \`deploy\` stays pending forever. Exact output:

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
        "To count the polls, pipe Ref.update(polls, n => n + 1) into Effect.andThen(check). Repeat that counted effect.",
        "Effect.repeat({ until: (s) => s === \"done\", schedule: Schedule.spaced(\"1 millis\") }) is the poll loop from lesson 5.",
        "Put Effect.timeout(\"20 millis\") after the repeat, so that it applies to the full loop. Effect.result changes the TimeoutError into a value that you can print."
      ]
    },
    {
      id: "scheduling-p3",
      title: "Batch with a time limit per item",
      spec: `
Process a batch of items. Each item gets its own time limit and 1 retry.

- \`work(item)\` is given. It sleeps for the delay of the item, in milliseconds, and returns \`"ok"\`. Item \`b\` is slow.
- For each item: apply a \`"10 millis"\` timeout to \`work(item)\`, then retry it 1 time (\`times: 1\`), then change a \`TimeoutError\` into the string \`"timed out"\` with \`Effect.catchTag\`.
- Count each call to \`work\` in 1 shared \`Ref\`.
- Use \`Effect.forEach\` over the items. Print \`<item>: <result>\` for each item, then \`attempts: <n>\`.

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
        "Build the pipeline for 1 item in this order: count, work, timeout, retry, catchTag. The order is important (lesson 6).",
        "Ref.update(attempts, n => n + 1).pipe(Effect.andThen(work(item))) makes the count a part of the effect that you retry.",
        "Effect.forEach(items, (item) => process(item).pipe(Effect.tap(...))) runs the items in order. Items a and c take 1 attempt each. Item b takes 2."
      ]
    }
  ],
  recall: [
    {
      q: "How many times does `Effect.retry(task, { times: 3 })` run `task` if it always fails?",
      a: "4 times. The first attempt always happens. `times` counts the retries after it. `Schedule.recurs(3)` and `Schedule.upTo({ times: 3 })` use the same rule."
    },
    {
      q: "What is the difference between `Effect.retry` and `Effect.repeat`?",
      a: "`retry` runs the effect again after a **failure** and stops on a success. `repeat` runs the effect again after a **success** and stops on a failure. Both accept the same `Schedule` values."
    },
    {
      q: "Which combinator do you use for \"exponential backoff, but stop after 5 retries\"?",
      a: "`Schedule.max([Schedule.exponential(\"100 millis\"), Schedule.recurs(5)])`, or `Schedule.exponential(\"100 millis\").pipe(Schedule.upTo({ times: 5 }))`. `max` continues only while both schedules continue. `recurs(5)` stops after 5 recurrences."
    },
    {
      q: "What is the type of `Effect.succeed(\"x\").pipe(Effect.timeout(\"1 second\"))`?",
      a: "`Effect<string, TimeoutError>`. `timeout` adds `Cause.TimeoutError` to the error channel. `timeoutOption` gives `Effect<Option<string>, never>` instead."
    },
    {
      q: "You must retry `Unavailable` errors and fail at once on `NotFound`. What are the 2 ways to write that?",
      a: "The options form: `Effect.retry(effect, { times: 5, while: (e) => e._tag === \"Unavailable\" })`. The schedule form with the builder: `Effect.retry(($) => $(Schedule.recurs(5)).pipe(Schedule.while(({ input }) => input._tag === \"Unavailable\")))`. The `$` helper gives the schedule the error type of the effect."
    },
    {
      q: "`slow.pipe(Effect.retry({ times: 2 }), Effect.timeout(\"1 second\"))` and `slow.pipe(Effect.timeout(\"1 second\"), Effect.retry({ times: 2 }))`: what is the difference?",
      a: "In the first pipe, 1 time limit applies to all 3 attempts together. When the limit wins, Effect interrupts the full retry loop. In the second pipe, each attempt gets its own second. A slow attempt fails with `TimeoutError`, and `retry` runs the next attempt. For a time limit per attempt, put `timeout` inside `retry`."
    },
    {
      q: "Why do you add `Schedule.jittered` to a retry policy, and what does it change in the output of a program?",
      a: "Many clients that fail at the same time retry at the same time and overload the server again. `jittered` multiplies each delay by a random factor between 0.8 and 1.2, so the retries spread out. It changes only the delays. The number of attempts and the output of the schedule stay the same."
    }
  ]
}

export default section
