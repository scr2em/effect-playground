import type { Section } from "../types.ts"

const section: Section = {
  id: "testing",
  title: "Testing",
  order: 15,
  summary: "Provide a test layer instead of a module mock, record calls in a Ref, control time with TestClock, and assert on typed failures.",
  intro: `
**The problem.** A test for plain TypeScript code that talks to the outside world must work around the code. You replace modules, and you wait for real time:

\`\`\`ts
jest.mock("./mailer")                       // replaces every import of mailer, everywhere
jest.useFakeTimers()
await service.sendReminder()
jest.advanceTimersByTime(24 * 60 * 60 * 1000)
expect(mailer.send).toHaveBeenCalledWith("ada@example.com")
\`\`\`

\`jest.mock\` selects a module by file path. If you move the file, the test breaks. The fake timers only replace \`setTimeout\`. A retry that uses a Promise-based sleep library still waits for real seconds. The type of \`sendReminder\` does not show which modules it uses. You find the modules to mock when you run the test and read the stack trace.

### The shift

Today you think of a test as the real program plus patches from the outside. In Effect, a test is the same program with different services. The code under test asks for a \`Mailer\` in its \`R\` type parameter. In production you provide \`Mailer.layer\`. In a test you provide a layer built from a \`Ref\`, and the layer records every call. You patch nothing, because the code did not import the mailer. The mailer was a parameter.

Time works the same way. \`Effect.sleep\`, \`Effect.timeout\`, \`Effect.retry\`, and every schedule read the \`Clock\` service. Provide \`TestClock.layer()\` and the clock stops. \`TestClock.adjust("24 hours")\` moves the clock forward. Every sleep that is due before that time completes, in order, at once. A retry with exponential backoff that waits 1 minute in production completes in 1 millisecond in the test, with the same result every time.

The result is that tests are plain programs. The playground has no test runner, so the tests in this section print their results. Every lesson defines a small \`assertEqual(label, actual, expected)\` function. It prints \`PASS label\` or \`FAIL label got ...\`. The last lesson shows the same tests with \`@effect/vitest\`.

| Need | Plain TS test | Effect test |
|---|---|---|
| Replace a dependency | \`jest.mock("./path")\` | Provide a different \`Layer\` |
| Check which calls were made | \`jest.fn()\` spy | A \`Ref\` inside the fake service |
| Skip a 24 hour wait | Fake timers (only for \`setTimeout\`) | \`TestClock.adjust("24 hours")\` (for all time-based code) |
| Capture log output | Spy on \`console.log\` | \`TestConsole.layer\` and \`TestConsole.logLines\` |
| Assert on a failure | \`expect(...).rejects.toThrow\` | \`Effect.flip\`, \`Effect.result\`, \`Effect.exit\` |
| Test runner | Jest or Vitest | \`@effect/vitest\` with \`it.effect\` |
`,
  lessons: [
    {
      id: "testing-l1",
      title: "Same program, different layer",
      explain: `
This lesson shows the core idea. A service is declared with \`Context.Service\`. Its live layer talks to the real world. Its test layer returns fixed data. The program under test asks for the service. It does not know which layer it gets.

In plain TypeScript, the equivalent is a repository interface and a constructor parameter. The idea is the same. The difference is that Effect puts the requirement in the type. \`greeting(1)\` has the type \`Effect<string, never, UserRepo>\`. The compiler does not let you run it until you provide a layer for \`UserRepo\`. You cannot forget a dependency. A test cannot use the real database by accident, because there is no hidden import.

The \`assertEqual\` function compares values with \`JSON.stringify\`, so arrays and objects work too. Every lesson in this section uses it.
`,
      code: `import { Context, Effect, Layer } from "effect"

// A tiny assertion helper: the playground has no test runner, so tests print.
const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// The service the code under test depends on
class UserRepo extends Context.Service<UserRepo, {
  readonly findName: (id: number) => Effect.Effect<string>
}>()("UserRepo") {
  // "Live" would hit a database. Here it only pretends, so we can see it being skipped.
  static readonly layer = Layer.succeed(UserRepo, {
    findName: (id) => Effect.sync(() => {
      console.log("(live) querying the database for user " + id)
      return "user-" + id
    })
  })
  // The test layer returns fixed data. No database, no network, no mocks.
  static readonly layerTest = Layer.succeed(UserRepo, {
    findName: (id) => Effect.succeed(id === 1 ? "Ada" : "Unknown")
  })
}

// The code under test. It does not know which layer it will get.
const greeting = (id: number) =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const name = yield* repo.findName(id)
    return "Hello, " + name + "!"
  })

const test = Effect.gen(function* () {
  assertEqual("greets a known user", yield* greeting(1), "Hello, Ada!")
  assertEqual("greets an unknown user", yield* greeting(2), "Hello, Unknown!")
})

// Same program, two worlds: swap the layer, nothing else changes.
Effect.runSync(test.pipe(Effect.provide(UserRepo.layerTest)))
console.log(Effect.runSync(greeting(7).pipe(Effect.provide(UserRepo.layer))))
`,
      expectedOutput: `PASS greets a known user
PASS greets an unknown user
(live) querying the database for user 7
Hello, user-7!`,
      after: `Note: \`greeting\` is written once and runs with both layers. Remove the \`Effect.provide(UserRepo.layerTest)\` call. The program does not compile, because \`test\` still requires a \`UserRepo\`. The compiler tells you to provide a fake.`
    },
    {
      id: "testing-l2",
      title: "Record calls with a Ref",
      explain: `
Fixed data is half of a fake. The other half is a record of what the code under test did. In Jest you use \`jest.fn()\` and read \`mock.calls\`. In Effect you make a \`Ref\`. A \`Ref\` is a mutable cell that fibers can share safely. The fake service adds an entry to the \`Ref\` on each call.

The steps are:

1. In the test, write \`const sent = yield* Ref.make<Array<string>>([])\`.
2. Build the fake layer in the test with \`Layer.succeed\`. The fake closes over \`sent\`.
3. Run the code under test with \`Effect.provide(layerTest)\`.
4. Read \`Ref.get(sent)\` and assert on the recorded calls.

The test builds the layer, so each test gets a new record. There is no shared state to reset between tests. The code under test, \`sendNewsletter\`, does not know that it is observed.
`,
      code: `import { Context, Effect, Layer, Ref } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, subject: string) => Effect.Effect<void>
}>()("Mailer") {}

interface User { readonly email: string; readonly active: boolean }

// Code under test: only active users get the newsletter
const sendNewsletter = (users: ReadonlyArray<User>) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer
    for (const user of users) {
      if (user.active) yield* mailer.send(user.email, "Newsletter")
    }
  })

const test = Effect.gen(function* () {
  // The recording: a Ref holding every call the fake received
  const sent = yield* Ref.make<Array<string>>([])
  const layerTest = Layer.succeed(Mailer, {
    send: (to) => Ref.update(sent, (list) => [...list, to])
  })

  yield* sendNewsletter([
    { email: "ada@example.com", active: true },
    { email: "bob@example.com", active: false },
    { email: "lin@example.com", active: true }
  ]).pipe(Effect.provide(layerTest))

  const calls = yield* Ref.get(sent)
  assertEqual("sends to active users only", calls, ["ada@example.com", "lin@example.com"])
  assertEqual("sends exactly two emails", calls.length, 2)
})

Effect.runSync(test)
`,
      expectedOutput: `PASS sends to active users only
PASS sends exactly two emails`,
      after: `The fake \`send\` ignores \`subject\`. Change the fake to record \`to + ": " + subject\`, and change the expected array. A fake records only the data that the test checks.`
    },
    {
      id: "testing-l3",
      title: "TestClock: a 7 second backoff in 0 seconds",
      explain: `
This retry waits 1 second, then 2 seconds, then 4 seconds between attempts. With a real clock the test takes 7 seconds. The result also changes between runs, because a real clock is not exact.

\`TestClock\` from \`effect/testing\` replaces the \`Clock\` service. Every \`Effect.sleep\` waits for virtual time. \`retry\`, \`timeout\`, \`repeat\`, and schedules are built on \`sleep\`, so they wait for virtual time too. Virtual time moves only when you call \`TestClock.adjust\`.

The 3 steps are always the same:

| Step | Call | Reason |
|---|---|---|
| 1. Fork | \`Effect.forkChild(effect)\` | The effect starts and stops at its first sleep. If you do not fork, the test stops instead. |
| 2. Advance | \`TestClock.adjust("10 seconds")\` | Every sleep due in the window completes, in order. A sleep that starts during the window is included. One adjust covers a full backoff sequence. |
| 3. Join | \`Fiber.join(fiber)\` | Get the result. The fiber is already complete. |

Provide the clock with \`Effect.provide(TestClock.layer())\`. Note: \`layer\` is a function, because it accepts options. Write the parentheses.
`,
      code: `import { Clock, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// A flaky call: fails three times, then succeeds
const makeFlaky = (attempts: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (x) => x + 1)
    if (n <= 3) return yield* Effect.fail("connection reset")
    return "payload"
  })

// Backoff: wait 1s, 2s, 4s between attempts (7 seconds of sleeping in total)
const withBackoff = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.retry(effect, Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 })))

const test = Effect.gen(function* () {
  const attempts = yield* Ref.make(0)

  // 1. Fork: the retry starts, hits the first failure, and goes to sleep on the TestClock
  const fiber = yield* Effect.forkChild(withBackoff(makeFlaky(attempts)))
  // 2. Move virtual time forward. Every sleep due within 10s wakes up, in order.
  yield* TestClock.adjust("10 seconds")
  // 3. Join: the fiber has long finished
  const result = yield* Fiber.join(fiber)

  assertEqual("eventually succeeds", result, "payload")
  assertEqual("took four attempts", yield* Ref.get(attempts), 4)
  assertEqual("virtual clock advanced 10s", yield* Clock.currentTimeMillis, 10_000)
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      expectedOutput: `PASS eventually succeeds
PASS took four attempts
PASS virtual clock advanced 10s`,
      after: `The program completes in milliseconds, but \`Clock.currentTimeMillis\` reports 10 seconds. The test clock starts at 0 and moves only when you adjust it. Change the flaky call to fail 4 times. The total backoff becomes 15 seconds, which is more than the 10 seconds you advance. \`Fiber.join\` then waits forever, and after 1 real second the TestClock logs a warning. Adjust by 15 seconds to correct this.`
    },
    {
      id: "testing-l4",
      title: "TestConsole: capture output",
      explain: `
Code that reports to the user often writes log lines. A spy on the global \`console.log\` is fragile and adds noise to the test output. Effect has its own \`Console\` service. You use it with \`Console.log\` and \`Console.error\` from \`"effect"\`. The \`effect/testing\` module has a \`TestConsole\` layer that replaces the service with an in-memory recorder.

Provide \`TestConsole.layer\`. It is a value, not a function. Then:

- \`Console.log(...)\` calls do not print. The recorder stores them.
- \`TestConsole.logLines\` returns all stored log lines as an array.
- \`TestConsole.errorLines\` does the same for \`Console.error\`.

Note: this works only for code that logs through the service. A direct \`console.log\` call writes to the terminal, and \`TestConsole\` does not see it. This is one more reason to use \`Console.log\` in library code. The \`assertEqual\` function below uses the global \`console.log\` on purpose. Its output must reach the real terminal.
`,
      code: `import { Console, Effect } from "effect"
import { TestConsole } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// Code under test: it logs through Effect's Console service, not the global console
const transfer = (from: string, to: string, amount: number) =>
  Effect.gen(function* () {
    if (amount <= 0) {
      yield* Console.error("rejected transfer of " + amount)
      return false
    }
    yield* Console.log("transfer " + amount + " from " + from + " to " + to)
    return true
  })

const test = Effect.gen(function* () {
  const ok = yield* transfer("ada", "lin", 50)
  const rejected = yield* transfer("ada", "lin", -5)

  // Nothing above reached the real terminal. It was captured here:
  const logs = yield* TestConsole.logLines
  const errors = yield* TestConsole.errorLines

  assertEqual("returns true for a valid transfer", ok, true)
  assertEqual("returns false for a bad amount", rejected, false)
  assertEqual("logs the transfer", logs, ["transfer 50 from ada to lin"])
  assertEqual("reports the rejection", errors, ["rejected transfer of -5"])
})

Effect.runSync(test.pipe(Effect.provide(TestConsole.layer)))
`,
      expectedOutput: `PASS returns true for a valid transfer
PASS returns false for a bad amount
PASS logs the transfer
PASS reports the rejection`,
      after: `Remove the \`Effect.provide(TestConsole.layer)\` call. The 2 messages now print to the terminal. \`TestConsole.logLines\` reads the live console, which records nothing, so 2 assertions fail. The layer is what turns output into data.`
    },
    {
      id: "testing-l5",
      title: "Test failures: flip, result, exit",
      explain: `
Half of the interesting behavior is in the error channel, so you need a direct way to assert on it. In plain TypeScript you write \`try { ...; fail() } catch (e) { expect(e).toBeInstanceOf(...) }\`. Effect gives 3 tools. Each one turns a failure into a value that you can inspect:

| Tool | Turns \`Effect<A, E>\` into | Use it when |
|---|---|---|
| \`Effect.flip\` | \`Effect<E, A>\` | You expect a failure and want the error as the success value. This is the shortest form. |
| \`Effect.result\` | \`Effect<Result<A, E>, never>\` | You want to branch on both outcomes without a throw. |
| \`Effect.exit\` | \`Effect<Exit<A, E>, never>\` | You also want to see defects and interrupts. \`Result\` does not include them. |

A defect is an unexpected error, for example a bug or an \`Effect.die\`. With a \`Schema.TaggedError\`, the assertion is 1 line: compare \`error._tag\`. \`flip\` keeps the type of the error, so TypeScript knows that \`error.missing\` exists.
`,
      code: `import { Effect, Exit, Result, Schema } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  missing: Schema.Number
}) {}

// Code under test
const withdraw = (balance: number, amount: number) =>
  amount > balance
    ? Effect.fail(new InsufficientFunds({ missing: amount - balance }))
    : Effect.succeed(balance - amount)

const test = Effect.gen(function* () {
  // flip: the error becomes the success value, so yield* hands it to you
  const error = yield* Effect.flip(withdraw(10, 25))
  assertEqual("fails with InsufficientFunds", error._tag, "InsufficientFunds")
  assertEqual("reports the missing amount", error.missing, 15)

  // result: both outcomes as a plain Result value, nothing thrown either way
  const ok = yield* Effect.result(withdraw(10, 4))
  assertEqual("succeeds when funds allow", Result.isSuccess(ok) ? ok.success : "no", 6)

  // exit: like result, but also catches defects (bugs) and interruptions
  const exit = yield* Effect.exit(Effect.die("unexpected null"))
  assertEqual("a defect is a failure exit", Exit.isFailure(exit), true)
})

Effect.runSync(test)
`,
      expectedOutput: `PASS fails with InsufficientFunds
PASS reports the missing amount
PASS succeeds when funds allow
PASS a defect is a failure exit`,
      after: `Caution: if the effect succeeds, \`flip\` makes it fail with the success value, and the test stops. Try \`Effect.flip(withdraw(10, 4))\`. This is correct for "I expect this to fail". Use \`result\` when both outcomes are acceptable.`
    },
    {
      id: "testing-l6",
      title: "The full pattern, and the same test in @effect/vitest",
      explain: `
The lesson below combines all the parts: a fake service with a \`Ref\`, a forked fiber, and 2 \`TestClock.adjust\` calls. The 2 calls check the state before and after a 24 hour deadline.

In a real repository you do not print \`PASS\`. You use \`@effect/vitest\`. It adds \`it.effect\` to Vitest. \`it.effect\` runs an effect as a test, provides \`TestClock\` for you, and reports failures in the normal way. The test below, in that style:

\`\`\`ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

describe("scheduleReminder", () => {
  it.effect("sends after 24 hours", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<Array<string>>([])
      const layerTest = Layer.succeed(Notifier, { notify: (m) => Ref.update(received, (l) => [...l, m]) })
      const fiber = yield* Effect.forkChild(scheduleReminder("renew").pipe(Effect.provide(layerTest)))
      yield* TestClock.adjust("24 hours")
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* Ref.get(received), ["Reminder: renew"])
    }))
})
\`\`\`

Three points:

- \`it.effect\` provides the test clock, so you do not write \`Effect.provide(TestClock.layer())\`.
- \`it.live\` is the variant with the real clock.
- \`layer(MyLayer)("name", (it) => ...)\` builds 1 shared layer for a full \`describe\` block. Use it for expensive fakes.

All the patterns in this section stay the same. Only the assertion function and the runner change.
`,
      code: `import { Context, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class Notifier extends Context.Service<Notifier, {
  readonly notify: (message: string) => Effect.Effect<void>
}>()("Notifier") {}

// Code under test: remind after 24 hours
const scheduleReminder = (task: string) =>
  Effect.gen(function* () {
    const notifier = yield* Notifier
    yield* Effect.sleep("24 hours")
    yield* notifier.notify("Reminder: " + task)
  })

const test = Effect.gen(function* () {
  const received = yield* Ref.make<Array<string>>([])
  const layerTest = Layer.succeed(Notifier, {
    notify: (message) => Ref.update(received, (list) => [...list, message])
  })

  const fiber = yield* Effect.forkChild(scheduleReminder("renew passport").pipe(Effect.provide(layerTest)))

  yield* TestClock.adjust("23 hours")
  assertEqual("nothing sent before the deadline", yield* Ref.get(received), [])

  yield* TestClock.adjust("1 hour")
  yield* Fiber.join(fiber)
  assertEqual("reminder sent at 24 hours", yield* Ref.get(received), ["Reminder: renew passport"])
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      expectedOutput: `PASS nothing sent before the deadline
PASS reminder sent at 24 hours`,
      after: `Two adjust calls let you assert on the middle of a timeline. Fake timers make this difficult. Change the first adjust to "24 hours". The first assertion fails, because the reminder was already sent. When time is a service, you control it exactly.`
    }
  ],
  dosAndDonts: [
    {
      do: "Build the fake layer inside the test with `Layer.succeed` and provide it with `Effect.provide`.",
      dont: "Do not replace modules with `jest.mock` or edit a shared object between tests.",
      why: "A module mock breaks when a file moves, and shared state makes 1 test change the result of another test."
    },
    {
      do: "Record calls in a `Ref` with `Ref.update(ref, (list) => [...list, call])`.",
      dont: "Do not write `Ref.set(ref, [call])` in a fake.",
      why: "`Ref.set` replaces the full list, so only the last call stays and the assertion on order fails."
    },
    {
      do: "Fork the effect with `Effect.forkChild`, then call `TestClock.adjust`, then `Fiber.join`.",
      dont: "Do not run the effect directly and call `TestClock.adjust` after it.",
      why: "The effect waits on its sleep before `adjust` runs, so the test never continues."
    },
    {
      do: "Provide the clock with `Effect.provide(TestClock.layer())` at the edge of the test.",
      dont: "Do not call `TestClock.adjust` without the layer.",
      why: "Without the layer, `adjust` runs against the live clock, which has no `adjust` method, and the test fails with a defect."
    },
    {
      do: "Log with `Console.log` from `\"effect\"` in the code under test.",
      dont: "Do not use the global `console.log` in code that a test must observe.",
      why: "`TestConsole.logLines` sees only calls that go through the `Console` service, so a global call is not captured."
    },
    {
      do: "Use `Effect.flip` to get an expected error as the success value, then compare `error._tag`.",
      dont: "Do not compare `exit._tag` from `Effect.exit` with the tag of your error.",
      why: "The `_tag` of an `Exit` is `\"Success\"` or `\"Failure\"`, and the real error is inside `exit.cause`."
    },
    {
      do: "Use `Effect.result` when the test accepts both outcomes and must branch on them.",
      dont: "Do not use `Effect.flip` on an effect that can succeed in the test.",
      why: "When the effect succeeds, `flip` turns the success into a failure and the test stops with an error."
    },
    {
      do: "In a real repository, use `it.effect` from `@effect/vitest` and `assert.deepStrictEqual`.",
      dont: "Do not provide `TestClock.layer()` inside an `it.effect` test.",
      why: "`it.effect` already provides the test clock, so a second layer replaces it and `TestClock.adjust` moves the wrong clock."
    }
  ],
  challenges: [
    {
      id: "testing-c1",
      title: "No fake was provided",
      task: `The test is correct and the fake layer exists, but the program does not compile. Make it print \`PASS sums the basket\`. Do not change \`basketTotal\` or the test body.`,
      code: `import { Context, Effect, Layer } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class PriceList extends Context.Service<PriceList, {
  readonly priceOf: (sku: string) => Effect.Effect<number>
}>()("PriceList") {
  static readonly layerTest = Layer.succeed(PriceList, {
    priceOf: (sku) => Effect.succeed(sku === "apple" ? 3 : 5)
  })
}

const basketTotal = (skus: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const prices = yield* PriceList
    let total = 0
    for (const sku of skus) total += yield* prices.priceOf(sku)
    return total
  })

const test = Effect.gen(function* () {
  assertEqual("sums the basket", yield* basketTotal(["apple", "pear", "apple"]), 11)
})

Effect.runSync(test)
`,
      solution: `import { Context, Effect, Layer } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class PriceList extends Context.Service<PriceList, {
  readonly priceOf: (sku: string) => Effect.Effect<number>
}>()("PriceList") {
  static readonly layerTest = Layer.succeed(PriceList, {
    priceOf: (sku) => Effect.succeed(sku === "apple" ? 3 : 5)
  })
}

const basketTotal = (skus: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const prices = yield* PriceList
    let total = 0
    for (const sku of skus) total += yield* prices.priceOf(sku)
    return total
  })

const test = Effect.gen(function* () {
  assertEqual("sums the basket", yield* basketTotal(["apple", "pear", "apple"]), 11)
})

Effect.runSync(test.pipe(Effect.provide(PriceList.layerTest)))
`,
      expectedOutput: `PASS sums the basket`,
      hints: [
        "Read the type error. Which type is not assignable to never?",
        "test has the type Effect<void, never, PriceList>. A runner accepts only effects whose R is never.",
        "Provide the fake on the last line: Effect.runSync(test.pipe(Effect.provide(PriceList.layerTest)))."
      ],
      explanation: `\`basketTotal\` requires \`PriceList\`, so \`test\` requires it too. \`Effect.runSync\` accepts only an \`Effect<A, E, never>\`. That is a program with no requirement left. In a Jest test, the same mistake causes a crash at run time deep inside the code. Worse, the test can use the real price service without a warning. Here the compiler asks for the fake before the program runs.`
    },
    {
      id: "testing-c2",
      title: "The fake that loses data",
      task: `The audit fake must record every event in order, but the test prints \`FAIL\`. Correct the fake so that the test passes. Do not change \`checkout\` or the assertion.`,
      code: `import { Context, Effect, Layer, Ref } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class Audit extends Context.Service<Audit, {
  readonly record: (event: string) => Effect.Effect<void>
}>()("Audit") {}

const checkout = (items: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const audit = yield* Audit
    yield* audit.record("checkout started")
    for (const item of items) yield* audit.record("added " + item)
    yield* audit.record("checkout done")
  })

const test = Effect.gen(function* () {
  const events = yield* Ref.make<Array<string>>([])
  const layerTest = Layer.succeed(Audit, {
    record: (event) => Ref.set(events, [event])
  })

  yield* checkout(["book", "pen"]).pipe(Effect.provide(layerTest))

  assertEqual("records every event in order", yield* Ref.get(events), [
    "checkout started",
    "added book",
    "added pen",
    "checkout done"
  ])
})

Effect.runSync(test)
`,
      solution: `import { Context, Effect, Layer, Ref } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class Audit extends Context.Service<Audit, {
  readonly record: (event: string) => Effect.Effect<void>
}>()("Audit") {}

const checkout = (items: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const audit = yield* Audit
    yield* audit.record("checkout started")
    for (const item of items) yield* audit.record("added " + item)
    yield* audit.record("checkout done")
  })

const test = Effect.gen(function* () {
  const events = yield* Ref.make<Array<string>>([])
  const layerTest = Layer.succeed(Audit, {
    record: (event) => Ref.update(events, (list) => [...list, event])
  })

  yield* checkout(["book", "pen"]).pipe(Effect.provide(layerTest))

  assertEqual("records every event in order", yield* Ref.get(events), [
    "checkout started",
    "added book",
    "added pen",
    "checkout done"
  ])
})

Effect.runSync(test)
`,
      expectedOutput: `PASS records every event in order`,
      hints: [
        "Read the FAIL line. How many events are in the list?",
        "Ref.set replaces the full value. You must add to the list that is already there.",
        "Use Ref.update(events, (list) => [...list, event])."
      ],
      explanation: `\`Ref.set\` replaces the value, so only the last event stays in the list. \`Ref.update\` reads the current value, applies your function, and writes the result in 1 step. No event is lost, even when several fibers record at the same time. A fake is real code. It needs the same care as the code under test. The printed \`got [...]\` is the first clue when a fake is wrong.`
    },
    {
      id: "testing-c3",
      title: "Where is the clock?",
      task: `The test forks, adjusts, and joins correctly, but it stops with an error at run time. Make it print \`PASS entry expires after five minutes\`. Do not add real waits.`,
      code: `import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// Code under test: a cache entry expires after 5 minutes
const cachedValue = Effect.gen(function* () {
  yield* Effect.sleep("5 minutes")
  return "expired"
})

const test = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(cachedValue)
  yield* TestClock.adjust("5 minutes")
  assertEqual("entry expires after five minutes", yield* Fiber.join(fiber), "expired")
})

Effect.runPromise(test)
`,
      solution: `import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// Code under test: a cache entry expires after 5 minutes
const cachedValue = Effect.gen(function* () {
  yield* Effect.sleep("5 minutes")
  return "expired"
})

const test = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(cachedValue)
  yield* TestClock.adjust("5 minutes")
  assertEqual("entry expires after five minutes", yield* Fiber.join(fiber), "expired")
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      expectedOutput: `PASS entry expires after five minutes`,
      hints: [
        "The error says that adjust is not a function. Which clock does TestClock.adjust use?",
        "TestClock.adjust gets the Clock service and calls adjust on it. Without the test layer, that service is the live clock.",
        "Provide the clock at the edge: Effect.provide(TestClock.layer()). Write the parentheses."
      ],
      explanation: `\`TestClock.adjust\` does not hold its own clock. It gets the current \`Clock\` service and calls \`adjust\` on it. The live clock has no \`adjust\` method, so the call fails. \`TestClock.layer()\` replaces the service. Now the sleep in \`cachedValue\` and the \`adjust\` in the test use the same virtual clock. This is why the clock is a service and not a global value. The test selects which clock is active.`
    },
    {
      id: "testing-c4",
      title: "Exit is not the error",
      task: `The test must assert that a reservation of an unknown item fails with \`OutOfStock\`. It prints \`FAIL ... got "Failure"\`. Change how the test captures the failure, so that \`error._tag\` is the tag of the error. Keep the assertion line as it is.`,
      code: `import { Effect, Schema } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String
}) {}

const stock: Record<string, number> = { apple: 2 }

const reserve = (sku: string) =>
  (stock[sku] ?? 0) > 0 ? Effect.succeed("reserved " + sku) : Effect.fail(new OutOfStock({ sku }))

const test = Effect.gen(function* () {
  const error = yield* Effect.exit(reserve("durian"))
  assertEqual("fails with OutOfStock", error._tag, "OutOfStock")
})

Effect.runSync(test)
`,
      solution: `import { Effect, Schema } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String
}) {}

const stock: Record<string, number> = { apple: 2 }

const reserve = (sku: string) =>
  (stock[sku] ?? 0) > 0 ? Effect.succeed("reserved " + sku) : Effect.fail(new OutOfStock({ sku }))

const test = Effect.gen(function* () {
  const error = yield* Effect.flip(reserve("durian"))
  assertEqual("fails with OutOfStock", error._tag, "OutOfStock")
})

Effect.runSync(test)
`,
      expectedOutput: `PASS fails with OutOfStock`,
      hints: [
        "\"Failure\" is the tag of an Exit, not the tag of your error. You are 1 level too high.",
        "Lesson 5 has a table. Which tool gives you the error as the success value?",
        "Replace Effect.exit with Effect.flip."
      ],
      explanation: `\`Effect.exit\` puts the outcome in an \`Exit\`. The \`_tag\` of an \`Exit\` is \`"Success"\` or \`"Failure"\`. The \`OutOfStock\` value is inside \`exit.cause\`. \`Effect.flip\` exchanges the 2 channels. The error becomes the value that \`yield*\` returns, with its full type. Use \`exit\` when you must see defects and interrupts. For "this must fail with X", \`flip\` is the direct tool.`
    },
    {
      id: "testing-c5",
      title: "Not visible to TestConsole",
      task: `\`TestConsole\` must capture the greetings, but they print to the terminal and the assertion fails. Correct \`greet\` so that the only output is \`PASS captures both greetings\`.`,
      code: `import { Console, Effect } from "effect"
import { TestConsole } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

const greet = (name: string) =>
  Effect.sync(() => console.log("hello " + name))

const test = Effect.gen(function* () {
  yield* greet("ada")
  yield* greet("lin")
  assertEqual("captures both greetings", yield* TestConsole.logLines, ["hello ada", "hello lin"])
})

Effect.runSync(test.pipe(Effect.provide(TestConsole.layer)))
`,
      solution: `import { Console, Effect } from "effect"
import { TestConsole } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

const greet = (name: string) =>
  Console.log("hello " + name)

const test = Effect.gen(function* () {
  yield* greet("ada")
  yield* greet("lin")
  assertEqual("captures both greetings", yield* TestConsole.logLines, ["hello ada", "hello lin"])
})

Effect.runSync(test.pipe(Effect.provide(TestConsole.layer)))
`,
      expectedOutput: `PASS captures both greetings`,
      hints: [
        "Two greetings print to the real terminal. Which console does greet use?",
        "TestConsole sees only the calls that go through the Console service of Effect.",
        "Replace Effect.sync(() => console.log(...)) with Console.log(...) from \"effect\"."
      ],
      explanation: `The global \`console.log\` is not a service. No layer can replace it. \`TestConsole\` did not see the calls, and the real terminal did. \`Console.log\` from \`"effect"\` is an effect. It asks the current \`Console\` service to print. \`TestConsole.layer\` replaces that service with a recorder. The rule is: application code logs through the service. Only the outer test reporter uses the global console.`
    },
    {
      id: "testing-c6",
      title: "A limit that does not limit",
      task: `The requirement says: a report that takes more than 30 seconds must fail with a \`TimeoutError\`. The test builds a 45 second report and prints \`FAIL\`. Correct the code under test so that the requirement holds and the test prints \`PASS a 45s report is rejected\`. Do not change the test.`,
      code: `import { Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// A slow report: takes 45 seconds to build
const buildReport = Effect.sleep("45 seconds").pipe(Effect.as("report"))

// Requirement: give up on any report slower than 30 seconds
const buildReportWithLimit = buildReport.pipe(Effect.timeout("1 minute"))

const test = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(Effect.result(buildReportWithLimit))
  yield* TestClock.adjust("1 minute")
  const outcome = yield* Fiber.join(fiber)

  assertEqual(
    "a 45s report is rejected",
    Result.isFailure(outcome) ? outcome.failure._tag : "success",
    "TimeoutError"
  )
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      solution: `import { Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

// A slow report: takes 45 seconds to build
const buildReport = Effect.sleep("45 seconds").pipe(Effect.as("report"))

// Requirement: give up on any report slower than 30 seconds
const buildReportWithLimit = buildReport.pipe(Effect.timeout("30 seconds"))

const test = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(Effect.result(buildReportWithLimit))
  yield* TestClock.adjust("1 minute")
  const outcome = yield* Fiber.join(fiber)

  assertEqual(
    "a 45s report is rejected",
    Result.isFailure(outcome) ? outcome.failure._tag : "success",
    "TimeoutError"
  )
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      expectedOutput: `PASS a 45s report is rejected`,
      hints: [
        "The test got \"success\". The 45 second report completed before the limit. Compare the 2 durations.",
        "The comment states the requirement. The timeout value does not match it.",
        "Change Effect.timeout(\"1 minute\") to Effect.timeout(\"30 seconds\")."
      ],
      explanation: `\`TestClock\` exists for this type of bug. With a real clock, the test takes 1 minute, and most people do not write it. With virtual time, the test costs nothing. The comment says 30 seconds and the code says 1 minute, and the test shows the difference at once. \`Effect.timeout\` adds \`TimeoutError\` to the error channel. \`Effect.result\` turns that into a value. One adjust of 1 minute covers both the timeout and the sleep that it interrupts.`
    }
  ],
  problems: [
    {
      id: "testing-p1",
      title: "Test an order service",
      spec: `
\`placeOrder(email, sku)\` is given. It requires 2 services: \`Inventory\` and \`Mailer\`. Write the test side:

1. Write a test \`Inventory\` layer. \`inStock\` is true only for \`"book"\`.
2. In the test, make a \`Ref<Array<string>>\` of recipients. Write a test \`Mailer\` layer that adds \`to\` to the list on every \`send\`.
3. Combine both layers with \`Layer.mergeAll\`. Run 3 checks, in this order:
   - \`placeOrder("ada@example.com", "book")\` succeeds with \`"confirmed"\`
   - \`placeOrder("lin@example.com", "lamp")\` fails with the tag \`"OutOfStock"\` (use \`Effect.flip\`)
   - the recorded recipients are exactly \`["ada@example.com"]\`

The output must be:

\`\`\`
PASS confirms an in-stock order
PASS rejects an out-of-stock order
PASS emails only confirmed orders
\`\`\`
`,
      starter: `import { Context, Effect, Layer, Ref, Schema } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class Inventory extends Context.Service<Inventory, {
  readonly inStock: (sku: string) => Effect.Effect<boolean>
}>()("Inventory") {}

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, body: string) => Effect.Effect<void>
}>()("Mailer") {}

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String
}) {}

// Code under test (do not change)
const placeOrder = (email: string, sku: string) =>
  Effect.gen(function* () {
    const inventory = yield* Inventory
    const mailer = yield* Mailer
    if (!(yield* inventory.inStock(sku))) return yield* Effect.fail(new OutOfStock({ sku }))
    yield* mailer.send(email, "Your " + sku + " is on its way")
    return "confirmed"
  })

// TODO: a test Inventory layer where only "book" is in stock

const test = Effect.gen(function* () {
  // TODO: a Ref that records recipients, and a test Mailer layer that writes to it
  // TODO: combine both layers with Layer.mergeAll
  // TODO: three assertions, in the order given in the spec
})

Effect.runSync(test)
`,
      solution: `import { Context, Effect, Layer, Ref, Schema } from "effect"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class Inventory extends Context.Service<Inventory, {
  readonly inStock: (sku: string) => Effect.Effect<boolean>
}>()("Inventory") {}

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, body: string) => Effect.Effect<void>
}>()("Mailer") {}

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String
}) {}

// Code under test (do not change)
const placeOrder = (email: string, sku: string) =>
  Effect.gen(function* () {
    const inventory = yield* Inventory
    const mailer = yield* Mailer
    if (!(yield* inventory.inStock(sku))) return yield* Effect.fail(new OutOfStock({ sku }))
    yield* mailer.send(email, "Your " + sku + " is on its way")
    return "confirmed"
  })

const inventoryTest = Layer.succeed(Inventory, {
  inStock: (sku) => Effect.succeed(sku === "book")
})

const test = Effect.gen(function* () {
  const sent = yield* Ref.make<Array<string>>([])
  const mailerTest = Layer.succeed(Mailer, {
    send: (to) => Ref.update(sent, (list) => [...list, to])
  })
  const layers = Layer.mergeAll(inventoryTest, mailerTest)

  const confirmed = yield* placeOrder("ada@example.com", "book").pipe(Effect.provide(layers))
  assertEqual("confirms an in-stock order", confirmed, "confirmed")

  const error = yield* Effect.flip(placeOrder("lin@example.com", "lamp")).pipe(Effect.provide(layers))
  assertEqual("rejects an out-of-stock order", error._tag, "OutOfStock")

  assertEqual("emails only confirmed orders", yield* Ref.get(sent), ["ada@example.com"])
})

Effect.runSync(test)
`,
      expectedOutput: `PASS confirms an in-stock order
PASS rejects an out-of-stock order
PASS emails only confirmed orders`,
      hints: [
        "Layer.succeed(Inventory, { inStock: (sku) => Effect.succeed(sku === \"book\") }) is the full fake.",
        "Make the Ref with yield* Ref.make<Array<string>>([]) in the test. Then use it in the Mailer fake.",
        "Layer.mergeAll(inventoryTest, mailerTest) gives 1 layer to provide. Apply flip before provide: Effect.flip(placeOrder(...)).pipe(Effect.provide(layers))."
      ]
    },
    {
      id: "testing-p2",
      title: "A poller under the test clock",
      spec: `
Build \`waitUntilReady(status)\`. \`status\` is an \`Effect<"pending" | "ready">\`. The function checks the status once. If the status is \`"pending"\`, it retries every 5 seconds, at most 3 more times (4 checks in total). Use \`Schedule.spaced\` and \`Schedule.upTo({ times: 3 })\`. The function succeeds with \`"ready"\` or fails with the given \`NotReady\` error.

Also build \`makeStatus(sequence)\`. It returns \`{ status, calls }\`. \`calls\` is a \`Ref<number>\` that counts how many times \`status\` ran. \`status\` returns the next value of \`sequence\`. When the sequence is used up, it returns \`"pending"\`.

Then test it under \`TestClock\`:

- With \`["pending", "pending", "ready"]\`: fork, adjust 10 seconds, join. Assert the result. Assert that the source was asked 3 times. Assert that \`Clock.currentTimeMillis\` is \`10000\`.
- With \`[]\` (never ready): fork with \`Effect.flip\`, adjust 1 minute, join. Assert the error tag. Assert that the source was asked 4 times.

The output must be:

\`\`\`
PASS ready after three checks
PASS asked the source three times
PASS waited 10 seconds
PASS gives up when never ready
PASS checked four times before giving up
\`\`\`
`,
      starter: `import { Clock, Effect, Fiber, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class NotReady extends Schema.TaggedError<NotReady>()("NotReady", {}) {}

type Status = "pending" | "ready"

// TODO: check status now, then every 5 seconds, at most 3 more times.
// Succeed with "ready", otherwise fail with NotReady.
const waitUntilReady = (status: Effect.Effect<Status>): Effect.Effect<"ready", NotReady> =>
  Effect.fail(new NotReady())

// TODO: a status source that replays a fixed sequence and counts calls in a Ref
const makeStatus = (sequence: ReadonlyArray<Status>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const status: Effect.Effect<Status> = Effect.succeed("pending")
    return { status, calls }
  })

const test = Effect.gen(function* () {
  // TODO: fork waitUntilReady, advance the TestClock, join, assert (see spec)
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      solution: `import { Clock, Effect, Fiber, Ref, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"

const assertEqual = <A>(label: string, actual: A, expected: A) =>
  console.log(
    JSON.stringify(actual) === JSON.stringify(expected)
      ? "PASS " + label
      : "FAIL " + label + " got " + JSON.stringify(actual)
  )

class NotReady extends Schema.TaggedError<NotReady>()("NotReady", {}) {}

type Status = "pending" | "ready"

// Code under test: check now, then every 5 seconds, at most 3 more times
const waitUntilReady = (status: Effect.Effect<Status>) =>
  status.pipe(
    Effect.flatMap((s) => (s === "ready" ? Effect.succeed("ready" as const) : Effect.fail(new NotReady()))),
    Effect.retry(Schedule.spaced("5 seconds").pipe(Schedule.upTo({ times: 3 })))
  )

// A status source that replays a fixed sequence and counts how often it was asked
const makeStatus = (sequence: ReadonlyArray<Status>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const status = Ref.updateAndGet(calls, (n) => n + 1).pipe(
      Effect.map((n) => sequence[n - 1] ?? "pending")
    )
    return { status, calls }
  })

const test = Effect.gen(function* () {
  const eventually = yield* makeStatus(["pending", "pending", "ready"])
  const fiber = yield* Effect.forkChild(waitUntilReady(eventually.status))
  yield* TestClock.adjust("10 seconds")
  assertEqual("ready after three checks", yield* Fiber.join(fiber), "ready")
  assertEqual("asked the source three times", yield* Ref.get(eventually.calls), 3)
  assertEqual("waited 10 seconds", yield* Clock.currentTimeMillis, 10_000)

  const never = yield* makeStatus([])
  const failing = yield* Effect.forkChild(Effect.flip(waitUntilReady(never.status)))
  yield* TestClock.adjust("1 minute")
  const error = yield* Fiber.join(failing)
  assertEqual("gives up when never ready", error._tag, "NotReady")
  assertEqual("checked four times before giving up", yield* Ref.get(never.calls), 4)
})

Effect.runPromise(test.pipe(Effect.provide(TestClock.layer())))
`,
      expectedOutput: `PASS ready after three checks
PASS asked the source three times
PASS waited 10 seconds
PASS gives up when never ready
PASS checked four times before giving up`,
      hints: [
        "waitUntilReady is status, then flatMap into succeed or fail, then Effect.retry with the schedule. The retry runs again only on failure, so \"pending\" must be a failure.",
        "For the counter, Ref.updateAndGet(calls, (n) => n + 1) gives the new count. Read the sequence at n - 1 and use \"pending\" as the default.",
        "Always fork before you adjust. For the never-ready case, fork Effect.flip(waitUntilReady(...)). The join then returns the NotReady error as a value."
      ]
    }
  ],
  recall: [
    {
      q: "How do you replace a dependency in an Effect test, and why is `jest.mock` not necessary?",
      a: "You provide a different `Layer` for the service, for example `Effect.provide(Mailer.layerTest)`. The code under test asks for the service through its `R` type parameter. It does not import a module, so there is nothing to patch. The compiler also refuses to run the test until you provide every requirement."
    },
    {
      q: "`withdraw` returns `Effect<number, InsufficientFunds>`. What is the type of `Effect.flip(withdraw(10, 25))`?",
      a: "`Effect<InsufficientFunds, number>`. The 2 channels exchange places. The error becomes the success value, so `yield*` returns it and you can read `error._tag`. If the original effect succeeds, the flipped effect fails with the number."
    },
    {
      q: "Which function do you use to assert that a program logged a specific message?",
      a: "Provide `TestConsole.layer` and read `TestConsole.logLines` (or `errorLines`). It captures only the output that went through `Console.log` from Effect, not the global `console.log`."
    },
    {
      q: "Why must you fork an effect before you call `TestClock.adjust`?",
      a: "A sleep on the test clock waits until virtual time reaches it. If the test runs the effect directly, the test waits and nothing calls `adjust`. When you fork, the effect waits on its sleep while the test moves the clock. `Fiber.join` then gets the result."
    },
    {
      q: "A retry sleeps 1 second, 2 seconds, then 4 seconds. Is 1 call of `TestClock.adjust(\"10 seconds\")` sufficient?",
      a: "Yes. While the clock advances, it completes each due sleep in order and continues. A sleep that starts during the window (the 2 second and 4 second sleeps) is included. Only a sleep that is due after the window waits."
    },
    {
      q: "What is the difference between `Effect.result` and `Effect.exit` in a test?",
      a: "`result` captures a typed failure as `Result.fail` and a success as `Result.succeed`. `exit` also captures defects (`Effect.die`, thrown bugs) and interrupts in `Exit.Failure`. Use `result` for expected failures. Use `exit` when the outcome can be a defect."
    },
    {
      q: "In a real repository, what replaces the printed `PASS` lines?",
      a: "`@effect/vitest`. `it.effect(\"name\", () => Effect.gen(...))` runs the effect as a Vitest test with `TestClock` already provided. `assert.deepStrictEqual` replaces the `assertEqual` function. `it.live` uses the real clock. `layer(L)(\"name\", (it) => ...)` shares 1 layer across a block."
    }
  ]
}

export default section
