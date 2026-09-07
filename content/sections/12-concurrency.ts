import type { Section } from "../types.ts"

const section: Section = {
  id: "concurrency",
  title: "Concurrency",
  order: 12,
  summary: "Fibers, structured concurrency with limits, racing and timeouts, interruption, and the coordination primitives Deferred, Queue, PubSub, and Semaphore.",
  intro: `
**The problem.** Concurrency in plain TypeScript is 3 separate tools that do not know about each other. You want to fetch 6 users, at most 2 at a time, with a limit of 1 second. You also want to cancel the rest when 1 fetch fails. You write code like this:

\`\`\`ts
const controller = new AbortController()
const limit = pLimit(2)                       // a hand-rolled or npm queue
const timer = setTimeout(() => controller.abort(), 1000)
try {
  const users = await Promise.all(
    ids.map((id) => limit(() => fetchUser(id, controller.signal)))
  )
} finally {
  clearTimeout(timer)
}
\`\`\`

Look at what this code does not do. \`Promise.all\` rejects on the first failure, but the other 5 requests continue to run. Nobody cancels them. The \`AbortController\` only works if every function down the stack passes \`signal\` along. \`pLimit\` is a separate object, and it does not know that a timeout happened. If a cancelled request was in the middle of a file write, no cleanup runs. Each piece is correct alone. Together they lose work, lose errors, and lose resources.

### The shift

Today you think of concurrent work as **Promises that you start and then collect**. A Promise has no owner. After you create it, it runs until it settles, whatever happens around it. Effect asks you to think in **fibers with owners**. A fiber is a lightweight thread of execution. The Effect runtime schedules the fibers on the single JavaScript thread.

A fiber always starts from another fiber, its parent. By default, a fiber lives no longer than its parent. When the parent ends, the runtime interrupts its children. When 1 of several concurrent tasks fails, the runtime interrupts its siblings. When a race has a winner, the runtime interrupts the other fibers. An interrupt runs the finalizers, so a cancelled task runs its own cleanup.

The name for this is *structured concurrency*: the tree of active work matches the tree of your code. The result is that concurrency becomes an option that you pass, not a library that you add. \`Effect.all(tasks, { concurrency: 2 })\` limits the work, collects the results in order, stops at the first failure, and cancels the rest. It does this in 1 line, and the compiler still knows the error type.

| You need to... | In plain TS | In Effect |
|---|---|---|
| Run many, collect all | \`Promise.all\` | \`Effect.all\` / \`Effect.forEach\` with \`{ concurrency }\` |
| Limit how many run at once | \`p-limit\` | the \`concurrency\` option, or a \`Semaphore\` |
| Use the first result | \`Promise.race\` | \`Effect.race\` / \`Effect.raceAll\`, the runtime interrupts the other fibers |
| Stop after a time limit | \`setTimeout\` + \`AbortController\` | \`Effect.timeout\` / \`Effect.timeoutOption\` |
| Cancel work | \`AbortSignal\` passed by hand | \`Fiber.interrupt\`, automatic for children |
| Give a value to a waiter once | a captured \`resolve\` | \`Deferred\` |
| Producer/consumer buffer | array + a manual poll loop | \`Queue\` with backpressure |
| Broadcast to many listeners | \`EventEmitter\` | \`PubSub\` |

In this section you will:

1. Fork fibers and watch them interleave.
2. Run work with limits.
3. Race effects and set timeouts.
4. Interrupt fibers safely.
5. Coordinate fibers with the 4 primitives above.
`,
  lessons: [
    {
      id: "concurrency-l1",
      title: "Fibers: fork, interleave, join",
      explain: `
A fiber is a lightweight thread that the Effect runtime schedules. There is still 1 JavaScript thread, so fibers do not run at the same instant. They take turns. A fiber runs until it *yields* (at a \`sleep\`, an async boundary, or an explicit \`Effect.yieldNow\`). Then another fiber gets a turn. The name for this is cooperative scheduling.

\`Effect.forkChild(effect)\` starts \`effect\` in a new fiber and returns a \`Fiber\` handle immediately. The new fiber does not run yet. It waits until the current fiber yields. \`Fiber.join(fiber)\` suspends until the fiber finishes. Then it gives you the success value, or it fails with the error of the fiber.

In the program below, 2 workers each print 3 steps and yield after each step. The parent forks both workers, prints a line, and then joins them. Watch how the lines interleave 1 step at a time.
`,
      code: `import { Effect, Fiber } from "effect"

const worker = (name: string) =>
  Effect.gen(function* () {
    for (let i = 1; i <= 3; i++) {
      console.log(name, "step", i)
      yield* Effect.yieldNow   // give the other fibers a turn
    }
    return name + " done"
  })

const program = Effect.gen(function* () {
  // forkChild starts the work in a new fiber and returns immediately
  const a = yield* Effect.forkChild(worker("A"))
  const b = yield* Effect.forkChild(worker("B"))
  console.log("parent: both forked, neither has run yet")

  // join waits for the fiber and gives back its success value
  const resultA = yield* Fiber.join(a)
  const resultB = yield* Fiber.join(b)
  console.log(resultA, "/", resultB)
})

Effect.runPromise(program)
`,
      expectedOutput: `parent: both forked, neither has run yet
A step 1
B step 1
A step 2
B step 2
A step 3
B step 3
A done / B done`,
      after: `The line of the parent prints before any worker step, although both forks came first. A fork only schedules the work. Try to remove \`yield* Effect.yieldNow\`. Each worker then runs all 3 steps in 1 turn, so you get A 1, 2, 3 and then B 1, 2, 3.`
    },
    {
      id: "concurrency-l2",
      title: "Fiber.await gives an Exit, Fiber.interrupt stops a fiber",
      explain: `
\`Fiber.join\` is convenient, but it raises the failure of the fiber again in your own fiber. When you want to *inspect* the result instead, use \`Fiber.await\`. It never fails. It gives you the \`Exit\` of the fiber: a \`Success\` with a value, or a \`Failure\` with a \`Cause\`.

| Function | Waits? | On fiber failure |
|---|---|---|
| \`Fiber.join(f)\` | Yes | Fails the caller with the same error |
| \`Fiber.await(f)\` | Yes | Succeeds with \`Exit.Failure\` |
| \`Fiber.interrupt(f)\` | Yes, until the fiber has stopped | Returns \`void\` |

\`Fiber.interrupt\` asks a fiber to stop and waits until it has stopped. The finalizers of the fiber run, which includes any \`Effect.onInterrupt\` handler. Afterwards, the Exit of the fiber is a Failure. Its Cause has a reason with the tag \`"Interrupt"\`, not \`"Fail"\`. An interrupt is a third kind of outcome, separate from success and failure.
`,
      code: `import { Cause, Effect, Exit, Fiber } from "effect"

const slowJob = Effect.gen(function* () {
  yield* Effect.sleep("50 millis")
  return "report ready"
}).pipe(Effect.onInterrupt(() => Effect.sync(() => console.log("slowJob: cleaning up"))))

const program = Effect.gen(function* () {
  const ok = yield* Effect.forkChild(Effect.succeed(42))
  const bad = yield* Effect.forkChild(Effect.fail("disk full"))
  const slow = yield* Effect.forkChild(slowJob)

  // await never throws: it hands you the Exit to inspect
  const exit1 = yield* Fiber.await(ok)
  const exit2 = yield* Fiber.await(bad)
  console.log(exit1._tag, Exit.isSuccess(exit1) ? exit1.value : "")
  console.log(exit2._tag, Exit.isFailure(exit2) ? Cause.squash(exit2.cause) : "")

  // interrupt asks the fiber to stop and waits until it has stopped
  yield* Effect.sleep("5 millis")
  yield* Fiber.interrupt(slow)
  const exit3 = yield* Fiber.await(slow)
  const reasons = Exit.isFailure(exit3) ? exit3.cause.reasons.map((r) => r._tag).join(",") : ""
  console.log(exit3._tag, "reason:", reasons)
})

Effect.runPromise(program)
`,
      expectedOutput: `Success 42
Failure disk full
slowJob: cleaning up
Failure reason: Interrupt`,
      after: `The cleanup line appears *before* \`Fiber.interrupt\` returns, because interrupt waits for the finalizers. Try to replace \`Fiber.await(bad)\` with \`Fiber.join(bad)\`. The whole program then fails with "disk full", because join passes the failure on.`
    },
    {
      id: "concurrency-l3",
      title: "Who owns a fiber: forkChild, forkScoped, forkDetach",
      explain: `
Every fiber has an owner, and the owner decides when the fiber stops. This is the core of structured concurrency. 3 fork functions give 3 lifetimes:

| Function | The fiber stops when... | Use when |
|---|---|---|
| \`Effect.forkChild\` | its parent fiber finishes | background work that is only useful while the parent runs |
| \`Effect.forkScoped\` | the enclosing \`Scope\` closes | work tied to a resource, such as a heartbeat while a connection is open |
| \`Effect.forkDetach\` | it finishes on its own | work that must continue after the caller. You own the cleanup |

The case where the parent finishes first surprises people. If you \`forkChild\` a task and the parent returns before the task is done, the runtime interrupts the task. In plain TypeScript, the Promise continues to run with nobody to watch it. In Effect, "nobody watches it" is not permitted unless you say so with \`forkDetach\`.

The program below runs the same ticker under each lifetime. Only the detached ticker finishes.
`,
      code: `import { Effect, Fiber } from "effect"

const ticker = (name: string) =>
  Effect.gen(function* () {
    console.log(name, "started")
    yield* Effect.sleep("30 millis")
    console.log(name, "finished")
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => console.log(name, "interrupted"))))

// 1. A child dies with its parent. The parent returns after 5ms, long before 30ms.
const parent = Effect.gen(function* () {
  yield* Effect.forkChild(ticker("child"))
  yield* Effect.sleep("5 millis")
  console.log("parent finished first")
})

const program = Effect.gen(function* () {
  const parentFiber = yield* Effect.forkChild(parent)
  yield* Fiber.join(parentFiber)

  // 2. A scoped fiber dies when the scope closes
  yield* Effect.scoped(Effect.gen(function* () {
    yield* Effect.forkScoped(ticker("scoped"))
    yield* Effect.sleep("5 millis")
    console.log("leaving scope")
  }))

  // 3. A detached fiber has no owner: we must join it ourselves or it leaks
  const detached = yield* Effect.forkDetach(ticker("detached"))
  yield* Effect.sleep("5 millis")
  console.log("parent moving on, detached still runs")
  yield* Fiber.join(detached)
})

Effect.runPromise(program)
`,
      expectedOutput: `child started
parent finished first
child interrupted
scoped started
leaving scope
scoped interrupted
detached started
parent moving on, detached still runs
detached finished`,
      after: `Try to delete the final \`Fiber.join(detached)\`. The program ends before "detached finished" can print, and the fiber is abandoned. Note: \`forkDetach\` gives you freedom, and at the same time it removes the safety of an owner.`
    },
    {
      id: "concurrency-l4",
      title: "Effect.all and forEach with a concurrency limit",
      explain: `
Most concurrency does not need a manual fork. \`Effect.all\` and \`Effect.forEach\` run a collection of effects and collect the results **in input order**, in whatever order the work finished. In plain TypeScript you combine \`Promise.all\` with a limiter:

\`\`\`ts
const limit = pLimit(2)
const users = await Promise.all(ids.map((id) => limit(() => fetchUser(id))))
\`\`\`

In Effect the limit is an option:

| Option | Meaning |
|---|---|
| no option | 1 at a time, in order |
| \`{ concurrency: 2 }\` | at most 2 active at once |
| \`{ concurrency: "unbounded" }\` | everything at once |
| \`{ discard: true }\` | do not collect the results, return \`void\` |

The program proves the limit. It does not trust the option. A \`Ref\` counts the number of active fake requests. Another \`Ref\` records the highest count seen. Each configuration runs the same 6 requests.
`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)

  // A fake request that records how many copies of itself run at once
  const fetchUser = (id: number) =>
    Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(inFlight, (n) => n - 1)
      return "user-" + id
    })

  const ids = [1, 2, 3, 4, 5, 6]

  const sequential = yield* Effect.forEach(ids, fetchUser)                     // one at a time
  console.log("sequential", sequential.join(","), "max:", yield* Ref.get(maxInFlight))

  yield* Ref.set(maxInFlight, 0)
  const limited = yield* Effect.forEach(ids, fetchUser, { concurrency: 2 })      // at most two
  console.log("limited   ", limited.join(","), "max:", yield* Ref.get(maxInFlight))

  yield* Ref.set(maxInFlight, 0)
  const all = yield* Effect.all(ids.map(fetchUser), { concurrency: "unbounded" }) // everything
  console.log("unbounded ", all.join(","), "max:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      expectedOutput: `sequential user-1,user-2,user-3,user-4,user-5,user-6 max: 1
limited    user-1,user-2,user-3,user-4,user-5,user-6 max: 2
unbounded  user-1,user-2,user-3,user-4,user-5,user-6 max: 6`,
      after: `The results are in the same order in all 3 runs. Effect keeps the position of each input, also when a later request finishes first. Try \`{ concurrency: 3 }\`. The maximum becomes 3, and the order stays the same.`
    },
    {
      id: "concurrency-l5",
      title: "Racing and timeouts: the loser is interrupted",
      explain: `
\`Effect.race(a, b)\` runs both effects and returns the first **success**. \`Effect.raceAll([...])\` does the same for a list. As soon as a winner is known, the runtime interrupts the other fibers, and their finalizers run. A fiber that did not finish first is called a loser. In plain TypeScript, \`Promise.race\` returns the first settled value, but the losers continue to run to the end.

A timeout is a race against a clock. There are 3 variants:

| Function | On timeout | Type of result |
|---|---|---|
| \`Effect.timeout(eff, "5 millis")\` | fails with \`TimeoutError\` | \`Effect<A, E \\| TimeoutError>\` |
| \`Effect.timeoutOption(eff, "5 millis")\` | succeeds with \`Option.none()\` | \`Effect<Option<A>, E>\` |
| \`Effect.timeoutOrElse(eff, { duration, orElse })\` | runs the fallback | \`Effect<A \\| B, E \\| E2>\` |

In every case, the runtime interrupts the slow effect when the time runs out. The program below attaches an \`onInterrupt\` finalizer to each fake request, so you can see the cancelled losers. For \`raceAll\`, the program collects the losers in a \`Ref\` and prints them in sorted order. 2 fibers that the runtime interrupts at the same moment have no fixed order.
`,
      code: `import { Effect, Option, Ref } from "effect"

const program = Effect.gen(function* () {
  const cancelled = yield* Ref.make<Array<string>>([])

  // A fake request that records when it is cancelled
  const request = (name: string, ms: number) =>
    Effect.sleep(ms).pipe(                   // a plain number means milliseconds
      Effect.as(name),
      Effect.onInterrupt(() => Ref.update(cancelled, (list) => [...list, name]))
    )

  // race: first success wins, the other one is interrupted
  const winner = yield* Effect.race(request("mirror-eu", 50), request("mirror-us", 5))
  console.log("winner:", winner, "| cancelled:", yield* Ref.get(cancelled))

  // raceAll: same for a list
  yield* Ref.set(cancelled, [])
  const fastest = yield* Effect.raceAll([request("a", 40), request("b", 5), request("c", 60)])
  console.log("fastest:", fastest, "| cancelled:", (yield* Ref.get(cancelled)).sort())

  // timeoutOption: None on timeout, and the slow work is interrupted
  yield* Ref.set(cancelled, [])
  const maybe = yield* Effect.timeoutOption(request("report", 50), "5 millis")
  console.log("timed out:", Option.isNone(maybe), "| cancelled:", yield* Ref.get(cancelled))

  // timeout: a typed TimeoutError that you can catch by its tag
  const value = yield* Effect.timeout(request("report", 50), "5 millis").pipe(
    Effect.catchTag("TimeoutError", () => Effect.succeed("fallback"))
  )
  console.log("value:", value)
})

Effect.runPromise(program)
`,
      expectedOutput: `winner: mirror-us | cancelled: [ "mirror-eu" ]
fastest: b | cancelled: [ "a", "c" ]
timed out: true | cancelled: [ "report" ]
value: fallback`,
      after: `The cancelled list is already full when the next line prints. The race does not return until the losers have finished their cleanup. Try \`Effect.race(Effect.fail("boom"), request("mirror-us", 5))\`. A fast failure does not win. \`race\` waits for the success. \`Effect.raceFirst\` is the variant where any completion, also a failure, ends the race.`
    },
    {
      id: "concurrency-l6",
      title: "Interruption: cooperative, cleanup-safe, and not an error",
      explain: `
An interrupt is how Effect cancels work. 3 facts make it safe to depend on:

1. **It is cooperative.** The runtime interrupts a fiber only at a yield point. Synchronous code between yields always completes.
2. **Finalizers run.** \`Effect.onInterrupt\`, \`Effect.ensuring\`, and \`acquireRelease\` finalizers all run before the interrupted fiber counts as done.
3. **It is a separate outcome.** The Cause has a reason with the tag \`"Interrupt"\`. \`Cause.hasFails\` is false, so error handlers such as \`catch\` do not see it as an error.

Sometimes a block must never stop in the middle, for example a header write followed by a body write. Wrap the block in \`Effect.uninterruptible\`. An interrupt request that arrives during that block waits until the block finishes. Then it takes effect at the next yield point.

The last part shows the structured-concurrency rule in \`Effect.all\`. When 1 sibling fails, the runtime interrupts the other siblings, and the overall result is the failure.
`,
      code: `import { Cause, Effect, Exit, Fiber } from "effect"

const saveFile = Effect.gen(function* () {
  // This block runs fully or not at all: interruption waits for it
  yield* Effect.uninterruptible(Effect.gen(function* () {
    console.log("write header")
    yield* Effect.sleep("10 millis")
    console.log("write body")
  }))
  yield* Effect.sleep("50 millis")     // interruptible again: this is where we get stopped
  console.log("never printed")
}).pipe(Effect.onInterrupt(() => Effect.sync(() => console.log("saveFile: closing handle"))))

const program = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(saveFile)
  yield* Effect.sleep("2 millis")
  yield* Fiber.interrupt(fiber)         // arrives during the uninterruptible block
  const exit = yield* Fiber.await(fiber)
  console.log("interrupted:", Exit.hasInterrupts(exit))

  // Interrupting yourself: the Cause says Interrupt, not Fail
  const self = yield* Effect.exit(Effect.gen(function* () {
    yield* Effect.interrupt
    return "unreachable"
  }))
  if (Exit.isFailure(self)) {
    const tags = self.cause.reasons.map((r) => r._tag).join(",")
    console.log("reasons:", tags, "| hasFails:", Cause.hasFails(self.cause))
  }

  // In Effect.all one failure interrupts the siblings
  const exit2 = yield* Effect.exit(Effect.all([
    Effect.sleep("50 millis").pipe(Effect.onInterrupt(() => Effect.sync(() => console.log("sibling cancelled")))),
    Effect.sleep("5 millis").pipe(Effect.andThen(Effect.fail("bad input")))
  ], { concurrency: "unbounded" }))
  console.log(exit2._tag, Exit.isFailure(exit2) ? Cause.squash(exit2.cause) : "")
})

Effect.runPromise(program)
`,
      expectedOutput: `write header
write body
saveFile: closing handle
interrupted: true
reasons: Interrupt | hasFails: false
sibling cancelled
Failure bad input`,
      after: `"write body" printed although the interrupt arrived at 2 ms, during the 10 ms sleep inside the uninterruptible block. Remove \`Effect.uninterruptible\`, and only "write header" prints. Caution: an uninterruptible infinite loop can never stop.`
    },
    {
      id: "concurrency-l7",
      title: "Coordinating fibers: Deferred and Queue",
      explain: `
A fork is easy. Communication between fibers is where plain TypeScript becomes difficult. You capture a \`resolve\` function in a closure, or you push into an array and poll it. Effect gives you typed primitives instead.

A \`Deferred<A, E>\` is a cell that you complete 1 time. Any number of fibers can \`Deferred.await\` it and suspend. Exactly 1 \`Deferred.succeed\` (or \`fail\`) wakes all of them with the same value. The cell ignores a second completion and returns \`false\`.

A \`Queue<A>\` carries many values from producers to consumers. \`Queue.bounded(n)\` has a capacity. When the queue is full, \`Queue.offer\` suspends the producer until a consumer takes a value. This is backpressure, and it prevents that a fast producer fills the memory. \`Queue.end\` signals that no more values come. A consumer that takes from an ended, empty queue fails with \`Done\`, and it can stop.

In the program, watch the producer print "queue full" before each offer that must wait.
`,
      code: `import { Cause, Deferred, Effect, Fiber, Queue } from "effect"

const program = Effect.gen(function* () {
  // Deferred: a one-shot signal. The server waits, the parent completes it.
  const configReady = yield* Deferred.make<string>()
  const server = yield* Effect.forkChild(Effect.gen(function* () {
    console.log("server: waiting for config")
    const config = yield* Deferred.await(configReady)   // suspends here
    console.log("server: started with", config)
  }))
  yield* Effect.sleep("5 millis")
  yield* Deferred.succeed(configReady, "port=8080")
  yield* Fiber.join(server)

  // Queue: capacity 2, so the producer is slowed down to the consumer's pace
  const jobs = yield* Queue.bounded<number, Cause.Done>(2)

  const producer = yield* Effect.forkChild(Effect.gen(function* () {
    for (const n of [1, 2, 3, 4, 5]) {
      if (yield* Queue.isFull(jobs)) console.log("producer: queue full, waiting")
      yield* Queue.offer(jobs, n)                        // suspends while full
      console.log("producer: offered", n)
    }
    yield* Queue.end(jobs)                               // no more jobs
  }))

  const consumer = yield* Effect.forkChild(Effect.gen(function* () {
    const seen: Array<number> = []
    yield* Effect.gen(function* () {
      seen.push(yield* Queue.take(jobs))
      yield* Effect.sleep("5 millis")                    // a slow consumer
    }).pipe(Effect.forever, Effect.catchTag("Done", () => Effect.void))
    return seen
  }))

  yield* Fiber.join(producer)
  console.log("consumer got", (yield* Fiber.join(consumer)).join(","))
})

Effect.runPromise(program)
`,
      expectedOutput: `server: waiting for config
server: started with port=8080
producer: offered 1
producer: offered 2
producer: queue full, waiting
producer: offered 3
producer: queue full, waiting
producer: offered 4
producer: queue full, waiting
producer: offered 5
consumer got 1,2,3,4,5`,
      after: `Change \`Queue.bounded<number, Cause.Done>(2)\` to \`Queue.unbounded<number, Cause.Done>()\`. Keep the \`Cause.Done\` type argument, because \`Queue.end\` needs it. The producer never waits and offers all 5 values immediately. A bounded queue costs a little producer speed and gives a guarantee about memory.`
    },
    {
      id: "concurrency-l8",
      title: "PubSub and Semaphore, and which primitive to use",
      explain: `
2 more primitives complete the set.

A \`PubSub<A>\` broadcasts. Every subscriber receives every message that the publisher sends after the subscription. In a Queue, each value goes to exactly 1 taker. \`PubSub.subscribe\` needs a \`Scope\`, so the runtime releases the subscription when the scope closes. Wrap the code in \`Effect.scoped\`.

A \`Semaphore\` holds a fixed number of permits. \`Semaphore.withPermits(sem, 1)(effect)\` waits for a permit, runs the effect, and gives the permit back. It gives the permit back also on failure or interrupt. Use it for "at most N of *this specific resource* at once", such as a database with a small connection pool. The structure of the callers does not matter.

| Primitive | Use it when |
|---|---|
| \`Deferred\` | 1 fiber must wait for a single value or signal from another fiber |
| \`Queue\` | work items flow from producers to consumers, and each item is processed 1 time |
| \`PubSub\` | several listeners must all see every event |
| \`Semaphore\` | a shared resource permits only N users at a time, across unrelated callers |
| \`concurrency\` option | you only need to limit 1 \`forEach\`/\`all\` call |
`,
      code: `import { Effect, PubSub, Ref, Semaphore } from "effect"

const program = Effect.gen(function* () {
  // PubSub: every subscriber sees every message
  yield* Effect.scoped(Effect.gen(function* () {
    const events = yield* PubSub.unbounded<string>()
    const audit = yield* PubSub.subscribe(events)      // released when the scope closes
    const mailer = yield* PubSub.subscribe(events)
    yield* PubSub.publish(events, "order:created")
    yield* PubSub.publish(events, "order:paid")
    console.log("audit  saw", yield* PubSub.take(audit), yield* PubSub.take(audit))
    console.log("mailer saw", yield* PubSub.take(mailer), yield* PubSub.take(mailer))
  }))

  // Semaphore: at most 2 database queries at once, whoever calls
  const dbPool = yield* Semaphore.make(2)
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)

  const query = (sql: string) =>
    Semaphore.withPermits(dbPool, 1)(Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(inFlight, (n) => n - 1)
      return sql + " ok"
    }))

  // Launch everything at once; the semaphore, not the option, enforces the limit
  const results = yield* Effect.all(
    ["select 1", "select 2", "select 3", "select 4", "select 5"].map(query),
    { concurrency: "unbounded" }
  )
  console.log(results.join(" | "))
  console.log("max concurrent queries:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      expectedOutput: `audit  saw order:created order:paid
mailer saw order:created order:paid
select 1 ok | select 2 ok | select 3 ok | select 4 ok | select 5 ok
max concurrent queries: 2`,
      after: `The \`Effect.all\` call is unbounded, but only 2 queries run at once. The limit lives with the resource. A second, unrelated \`Effect.all\` elsewhere that also calls \`query\` shares the same 2 permits. Try \`Semaphore.make(1)\` to run every query 1 at a time.`
    },
    {
      id: "concurrency-l9",
      title: "Semaphore in depth: mutex, weighted permits, skip when busy",
      explain: `
A \`Semaphore\` has 3 more uses that the last lesson did not show.

**1. A mutex.** A semaphore with 1 permit is a lock. Only 1 fiber at a time can run the code inside \`withPermits\`. Use it when you must read a value, wait, and write it back, and the value lives outside a \`Ref\`. Examples are a file, a plain variable from old code, or a client library that is not safe for concurrent calls.

**2. Weighted permits.** A fiber can take more than 1 permit. A job that costs 3 permits waits until 3 permits are free at the same time. This lets a large job and small jobs share 1 pool. The runtime gives the permits back when the job ends, also on failure or interrupt.

**3. Skip when busy.** \`withPermitsIfAvailable\` does not wait. If the permits are free, it runs the effect and returns \`Option.some(result)\`. If they are not free, it returns \`Option.none()\` at once. Use it for work that must not pile up, for example a metric flush or a cache refresh that is already in progress.

| Call | Waits? | Result type | Use it when |
|---|---|---|---|
| \`withPermits(sem, n)(effect)\` | Yes | \`A\` | The work must run, and it must wait its turn |
| \`withPermitsIfAvailable(sem, n)(effect)\` | No | \`Option<A>\` | The work is optional if another fiber already does it |
| \`take(sem, n)\` and \`release(sem, n)\` | Yes | \`number\` | Manual control. Caution: a failure between the 2 calls keeps the permit |
`,
      code: `import { Effect, Option, Ref, Semaphore } from "effect"

const program = Effect.gen(function* () {
  // 1. Mutex: 1 permit protects a read-wait-write on a plain variable
  let balance = 100
  const lock = yield* Semaphore.make(1)
  const withdraw = (amount: number) =>
    Semaphore.withPermits(lock, 1)(Effect.gen(function* () {
      const current = balance
      yield* Effect.sleep("1 millis")       // without the lock, other fibers run here
      balance = current - amount
    }))
  yield* Effect.forEach([10, 20, 30], withdraw, { concurrency: "unbounded", discard: true })
  console.log("balance:", balance)          // 40. Without the lock: 90, 80, or 70

  // 2. Weighted permits: "big" needs 3 of 4 slots, so it waits for "small-a" to end
  const slots = yield* Semaphore.make(4)
  const order = yield* Ref.make<Array<string>>([])
  const job = (name: string, cost: number, ms: number) =>
    Semaphore.withPermits(slots, cost)(
      Effect.sleep(ms).pipe(Effect.andThen(Ref.update(order, (xs) => [...xs, name])))
    )
  yield* Effect.all(
    [job("small-a", 1, 5), job("small-b", 1, 25), job("big", 3, 1)],
    { concurrency: "unbounded" }
  )
  console.log("finish order:", (yield* Ref.get(order)).join(", "))

  // 3. Skip when busy: the second flush finds no permit and returns none at once
  const flushLock = yield* Semaphore.make(1)
  const flush = Semaphore.withPermitsIfAvailable(flushLock, 1)(
    Effect.sleep("5 millis").pipe(Effect.as("flushed"))
  )
  const [first, second] = yield* Effect.all([flush, flush], { concurrency: "unbounded" })
  console.log("first:", Option.getOrElse(first, () => "skipped"), "| second:", Option.getOrElse(second, () => "skipped"))
})

Effect.runPromise(program)
`,
      expectedOutput: `balance: 40
finish order: small-a, big, small-b
first: flushed | second: skipped`,
      after: `Notice that "big" ends before "small-b" although "big" started last. It waited only until 3 permits were free, not until the pool was empty. Try to change the cost of "big" to 4. Now it must wait for both small jobs, and the order changes. Then remove the lock in part 1: the balance is wrong because the 3 fibers read 100 at the same time.`
    }
  ],
  dosAndDonts: [
    {
      do: "Keep the \`Fiber\` handle from \`Effect.forkChild\` and call \`Fiber.join\` or \`Fiber.await\` on it.",
      dont: "Do not fork a child and return from the parent before the child is done.",
      why: "The runtime interrupts a child when its parent finishes, so the work of the child never completes."
    },
    {
      do: "Pass \`{ concurrency: n }\` to \`Effect.forEach\` or \`Effect.all\` to limit the number of active effects.",
      dont: "Do not fork each effect by hand and collect the fibers yourself.",
      why: "The option limits, collects in order, and interrupts the other effects on failure, and the manual version must do all of this itself."
    },
    {
      do: "Use a \`Semaphore\` when the limit belongs to a resource that many unrelated callers use.",
      dont: "Do not create the semaphore with \`Semaphore.make\` inside the function that uses it.",
      why: "Each run creates a new semaphore with free permits, so no caller waits and the limit does nothing."
    },
    {
      do: "Use \`Effect.race\` when you want the first success, and \`Effect.raceFirst\` when any completion ends the race.",
      dont: "Do not use \`Effect.raceFirst\` for a fallback between servers.",
      why: "A fast failure wins \`raceFirst\`, and the runtime interrupts the server that can still answer."
    },
    {
      do: "Process the \`TimeoutError\` from \`Effect.timeout\` with \`catchTag\`, or use \`Effect.timeoutOption\` or \`timeoutOrElse\`.",
      dont: "Do not annotate an effect with a timeout as an \`Effect\` with an error type of \`never\`.",
      why: "A timeout is a real outcome, and the compiler rejects the annotation until the code decides what happens."
    },
    {
      do: "Wrap only the steps that must complete together in \`Effect.uninterruptible\`.",
      dont: "Do not make a whole fiber with long waits uninterruptible.",
      why: "\`Fiber.interrupt\` must wait until the block finishes, and an uninterruptible infinite loop can never stop."
    },
    {
      do: "Use \`Queue.bounded\` for a producer and a consumer, and call \`Queue.end\` when the producer is done.",
      dont: "Do not use an unbounded queue for a fast producer and a slow consumer.",
      why: "An unbounded queue accepts every value, so a fast producer fills the memory."
    },
    {
      do: "Run a program that uses \`Effect.forkScoped\` inside \`Effect.scoped\`.",
      dont: "Do not give an effect with a \`Scope\` requirement to \`Effect.runPromise\`.",
      why: "The requirement is not \`never\`, so the program does not compile, and nothing closes the scope that stops the fiber."
    }
  ],
  challenges: [
    {
      id: "concurrency-c1",
      title: "A Fiber is not a value",
      task: `The program must print \`total: 21\`, but it does not compile. The program forks the fiber, but it never collects the result. Fix it. Do not change the \`console.log\` line.`,
      code: `import { Effect, Fiber } from "effect"

const compute = Effect.gen(function* () {
  yield* Effect.sleep("2 millis")
  return 20
})

const program = Effect.gen(function* () {
  const result = yield* Effect.forkChild(compute)
  console.log("total:", result + 1)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Fiber } from "effect"

const compute = Effect.gen(function* () {
  yield* Effect.sleep("2 millis")
  return 20
})

const program = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(compute)
  const result = yield* Fiber.join(fiber)
  console.log("total:", result + 1)
})

Effect.runPromise(program)
`,
      expectedOutput: `total: 21`,
      hints: [
        "Read the type error. What is the type of result? It is a handle, not a number.",
        "A fork returns a Fiber. Something must wait for the fiber and unwrap its value.",
        "Keep the fiber in a variable. Then yield* Fiber.join(fiber) to get the number."
      ],
      explanation: `\`Effect.forkChild\` succeeds with a \`Fiber<number, never>\`. This is a handle to active work, not the number itself. Addition of 1 to a handle has no meaning, so TypeScript rejects it. \`Fiber.join\` does this work: it waits for the fiber and gives you the success value, or it fails with the error. In Effect v4 a Fiber is not itself yieldable, so \`yield* fiber\` does not work either. The join must be explicit. This is the same shape as challenge 1 in Getting Started, 1 level up. If you forget \`yield*\`, you hold an Effect. If you forget \`join\`, you hold a Fiber.`
    },
    {
      id: "concurrency-c2",
      title: "The option that does nothing",
      task: `The 6 lookups must run at most 3 at a time, and the program must print \`max in flight: 3\`. It does not compile. Without the type check, it prints \`1\`. Fix the option that the program passes to \`Effect.forEach\`.`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)

  const lookup = (id: number) =>
    Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(inFlight, (n) => n - 1)
      return id
    })

  yield* Effect.forEach([1, 2, 3, 4, 5, 6], lookup, { parallel: 3 })
  console.log("max in flight:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)

  const lookup = (id: number) =>
    Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(inFlight, (n) => n - 1)
      return id
    })

  yield* Effect.forEach([1, 2, 3, 4, 5, 6], lookup, { concurrency: 3 })
  console.log("max in flight:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      expectedOutput: `max in flight: 3`,
      hints: [
        "The type error lists the option names that forEach accepts.",
        "Lesson 4 has a table of options. Which key sets how many run at once?",
        "Replace parallel: 3 with concurrency: 3."
      ],
      explanation: `\`forEach\` only knows the keys \`concurrency\` and \`discard\`. The options are a typed object, so an unknown key is a compile error, not a setting that the runtime ignores. This is important. Without the type check, this program runs sequentially, prints \`1\`, and looks like a limiter that works. A plain \`p-limit\` style helper never tells you this.`
    },
    {
      id: "concurrency-c3",
      title: "The email that was never sent",
      task: `The handler must print \`request handled\` and then \`email sent\`, but the second line never appears. Fix the program so that it sends the email. Keep the order of the 2 lines.`,
      code: `import { Effect, Fiber } from "effect"

const sendEmail = Effect.gen(function* () {
  yield* Effect.sleep("10 millis")
  console.log("email sent")
})

const handleRequest = Effect.gen(function* () {
  yield* Effect.forkChild(sendEmail)
  console.log("request handled")
})

Effect.runPromise(handleRequest)
`,
      solution: `import { Effect, Fiber } from "effect"

const sendEmail = Effect.gen(function* () {
  yield* Effect.sleep("10 millis")
  console.log("email sent")
})

const handleRequest = Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(sendEmail)
  console.log("request handled")
  yield* Fiber.join(fiber)
})

Effect.runPromise(handleRequest)
`,
      expectedOutput: `request handled
email sent`,
      hints: [
        "Who owns the sendEmail fiber, and what happens to it when the owner finishes? See lesson 3.",
        "The parent returns directly after it prints, so the runtime interrupts the child before its 10 ms sleep ends.",
        "Keep the fiber handle, and yield* Fiber.join(fiber) after the console.log."
      ],
      explanation: `\`forkChild\` ties the life of the child to the parent. \`handleRequest\` printed its line and returned immediately, so the runtime interrupted \`sendEmail\` during its sleep. A join after the log keeps the order of the output and makes the parent wait. \`Effect.forkDetach\` also lets the email finish. But then nothing waits for it, and the process can end first. \`forkDetach\` is only correct when a different owner controls the lifetime of the fiber.`
    },
    {
      id: "concurrency-c4",
      title: "A timeout is an error until you handle it",
      task: `\`priceWithTimeout\` is declared as an Effect that cannot fail. The timeout makes this false, and the program does not compile. Do not change the type annotation. Make the program return \`cached price\` on a timeout, so that it prints \`price: cached price\`.`,
      code: `import { Effect } from "effect"

const slowLookup = Effect.sleep("50 millis").pipe(Effect.as("fresh price"))

const priceWithTimeout: Effect.Effect<string> = Effect.timeout(slowLookup, "5 millis")

const program = Effect.gen(function* () {
  const price = yield* priceWithTimeout
  console.log("price:", price)
})

Effect.runPromise(program)
`,
      solution: `import { Effect } from "effect"

const slowLookup = Effect.sleep("50 millis").pipe(Effect.as("fresh price"))

const priceWithTimeout: Effect.Effect<string> = Effect.timeout(slowLookup, "5 millis").pipe(
  Effect.catchTag("TimeoutError", () => Effect.succeed("cached price"))
)

const program = Effect.gen(function* () {
  const price = yield* priceWithTimeout
  console.log("price:", price)
})

Effect.runPromise(program)
`,
      expectedOutput: `price: cached price`,
      hints: [
        "Read the type error: the error channel is not never. Which error did timeout add?",
        "Lesson 5 shows 2 ways: catch the TimeoutError by its tag, or use the timeoutOrElse variant with a fallback.",
        "Pipe the timeout into Effect.catchTag(\"TimeoutError\", () => Effect.succeed(\"cached price\"))."
      ],
      explanation: `\`Effect.timeout\` makes the error type wider: \`E | TimeoutError\`. The annotation \`Effect.Effect<string>\` claims \`never\`, so the assignment does not compile. This is the intent: a timeout is a real outcome, and someone must decide what happens. \`catchTag("TimeoutError", ...)\` processes exactly that case and makes the error channel \`never\` again. \`Effect.timeoutOrElse(slowLookup, { duration: "5 millis", orElse: () => Effect.succeed("cached price") })\` is the same idea in 1 call. In both cases the runtime interrupts the slow lookup when the time runs out.`
    },
    {
      id: "concurrency-c5",
      title: "Never leave a half-written record",
      task: `A record is only valid with both a header and a body. The runtime interrupts the writer after 2 ms, between the 2 write steps, and leaves a half-written record. Make the 2 write steps safe from interrupts. The output must be \`write header\`, \`write body\`, \`writer stopped\`. The writer must still be interruptible after the record is complete.`,
      code: `import { Effect, Fiber } from "effect"

const writeRecord = Effect.gen(function* () {
  console.log("write header")
  yield* Effect.sleep("10 millis")
  console.log("write body")
  yield* Effect.sleep("50 millis")
  console.log("archived")
})

const program = Effect.gen(function* () {
  const writer = yield* Effect.forkChild(writeRecord)
  yield* Effect.sleep("2 millis")
  yield* Fiber.interrupt(writer)
  console.log("writer stopped")
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Fiber } from "effect"

const writeRecord = Effect.gen(function* () {
  yield* Effect.uninterruptible(Effect.gen(function* () {
    console.log("write header")
    yield* Effect.sleep("10 millis")
    console.log("write body")
  }))
  yield* Effect.sleep("50 millis")
  console.log("archived")
})

const program = Effect.gen(function* () {
  const writer = yield* Effect.forkChild(writeRecord)
  yield* Effect.sleep("2 millis")
  yield* Fiber.interrupt(writer)
  console.log("writer stopped")
})

Effect.runPromise(program)
`,
      expectedOutput: `write header
write body
writer stopped`,
      hints: [
        "An interrupt happens at a yield point. The sleep between the header and the body is 1.",
        "Lesson 6 shows a wrapper that makes a block run fully or not at all.",
        "Wrap the header, the sleep, and the body in Effect.uninterruptible(Effect.gen(...)). Leave the 50 ms sleep outside it."
      ],
      explanation: `\`Effect.uninterruptible\` marks a region where the runtime postpones an interrupt. The request arrives at 2 ms, during the first sleep. But the runtime applies it only at the next yield point *after* the region, which is the 50 ms sleep. Both writes complete, and "archived" never prints. Note: keep the long sleep outside the region. If the whole writer is uninterruptible, \`Fiber.interrupt\` must wait the full 60 ms, and the caller can never cancel it.`
    },
    {
      id: "concurrency-c6",
      title: "A limit that limits nothing",
      task: `The database pool must permit at most 2 concurrent queries, so the program must print \`max concurrent: 2\`. It prints \`5\`. Fix the code so that the semaphore limits the queries.`,
      code: `import { Effect, Ref, Semaphore } from "effect"

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)

  const query = (id: number) =>
    Effect.gen(function* () {
      const pool = yield* Semaphore.make(2)
      return yield* Semaphore.withPermits(pool, 1)(Effect.gen(function* () {
        const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
        yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
        yield* Effect.sleep("5 millis")
        yield* Ref.update(inFlight, (n) => n - 1)
        return id
      }))
    })

  yield* Effect.all([1, 2, 3, 4, 5].map(query), { concurrency: "unbounded" })
  console.log("max concurrent:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref, Semaphore } from "effect"

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)
  const pool = yield* Semaphore.make(2)

  const query = (id: number) =>
    Semaphore.withPermits(pool, 1)(Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(inFlight, (n) => n - 1)
      return id
    }))

  yield* Effect.all([1, 2, 3, 4, 5].map(query), { concurrency: "unbounded" })
  console.log("max concurrent:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      expectedOutput: `max concurrent: 2`,
      hints: [
        "How many semaphores exist while the 5 queries run?",
        "Semaphore.make builds a new semaphore each time it runs. Where does the program run it?",
        "Create the semaphore once, outside query, and let every query share it."
      ],
      explanation: `\`Semaphore.make(2)\` is an Effect that *creates* a semaphore when it runs. When you run it inside \`query\`, each of the 5 queries gets its own new pool with 2 free permits, so no query waits. A semaphore only limits the fibers that share the same instance. Create it once at the top, and let \`query\` refer to it. The same mistake is common with \`Ref.make\` and \`Queue.make\`. Constructors are effects, and the place where you run them decides how many objects you get.`
    },
    {
      id: "concurrency-c7",
      title: "The fast failure that won the race",
      task: `We want the first *successful* answer from 2 servers. The primary server fails after 2 ms. The backup server answers after 20 ms. The program must print \`backup answered\`, but it fails with \`primary down\`. Fix the race.`,
      code: `import { Effect } from "effect"

const primary = Effect.sleep("2 millis").pipe(Effect.andThen(Effect.fail("primary down")))
const backup = Effect.sleep("20 millis").pipe(Effect.as("backup answered"))

const program = Effect.gen(function* () {
  const answer = yield* Effect.raceFirst(primary, backup)
  console.log(answer)
})

Effect.runPromise(program)
`,
      solution: `import { Effect } from "effect"

const primary = Effect.sleep("2 millis").pipe(Effect.andThen(Effect.fail("primary down")))
const backup = Effect.sleep("20 millis").pipe(Effect.as("backup answered"))

const program = Effect.gen(function* () {
  const answer = yield* Effect.race(primary, backup)
  console.log(answer)
})

Effect.runPromise(program)
`,
      expectedOutput: `backup answered`,
      hints: [
        "There are 2 race functions. One ends the race on any completion. The other ends it on the first success.",
        "raceFirst treats the fast failure as the winner and interrupts the backup.",
        "Use Effect.race instead of Effect.raceFirst."
      ],
      explanation: `\`Effect.raceFirst\` returns the effect that *finishes* first, success or failure, and interrupts the other effect. The primary failed at 2 ms, so that failure became the result. \`Effect.race\` continues to wait after an early failure and settles only on the first success. It fails only if both sides fail. Ask this question: is a fast failure an answer (\`raceFirst\`), or must the race ignore it while another attempt can succeed (\`race\`)?`
    },
    {
      id: "concurrency-c8",
      title: "A scoped fiber needs a scope",
      task: `The heartbeat must run while the program processes the request, and stop when the request is done. The program does not compile, because a requirement is missing at the point where you run it. Fix the last line only. The output must be \`heartbeat started\`, \`request done\`, \`heartbeat stopped\`.`,
      code: `import { Effect } from "effect"

const heartbeat = Effect.gen(function* () {
  console.log("heartbeat started")
  yield* Effect.sleep("1 second")
}).pipe(Effect.onInterrupt(() => Effect.sync(() => console.log("heartbeat stopped"))))

const program = Effect.gen(function* () {
  yield* Effect.forkScoped(heartbeat)
  yield* Effect.sleep("5 millis")
  console.log("request done")
})

Effect.runPromise(program)
`,
      solution: `import { Effect } from "effect"

const heartbeat = Effect.gen(function* () {
  console.log("heartbeat started")
  yield* Effect.sleep("1 second")
}).pipe(Effect.onInterrupt(() => Effect.sync(() => console.log("heartbeat stopped"))))

const program = Effect.gen(function* () {
  yield* Effect.forkScoped(heartbeat)
  yield* Effect.sleep("5 millis")
  console.log("request done")
})

Effect.runPromise(Effect.scoped(program))
`,
      expectedOutput: `heartbeat started
request done
heartbeat stopped`,
      hints: [
        "Read the type error on runPromise: the third type parameter of program is not never.",
        "forkScoped adds Scope to the requirements. Something must provide a scope and close it at the end.",
        "Wrap the program: Effect.runPromise(Effect.scoped(program))."
      ],
      explanation: `\`Effect.forkScoped\` ties the fiber to the nearest \`Scope\`, so its type becomes \`Effect<void, never, Scope>\`. \`runPromise\` only accepts effects with requirements of \`never\`. The compiler stopped you from a run of an effect whose cleanup had no place to go. \`Effect.scoped\` creates a scope, runs the program inside it, and closes the scope on exit. When the scope closes, the runtime interrupts the heartbeat, and the heartbeat runs its finalizer. The type system turned "who stops the heartbeat?" into a question that you must answer before the program can run.`
    },
    {
      id: "concurrency-c9",
      title: "The permit that never comes back",
      task: `The first call fails on purpose. After that, the second call never gets a permit and the program prints \`hung\`. Change how the semaphore is used so a failure gives the permit back, and the program prints \`done\` for the second call.`,
      code: `import { Effect, Option, Result, Semaphore } from "effect"

const program = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1)

  const risky = (fail: boolean) =>
    Effect.gen(function* () {
      yield* Semaphore.take(lock, 1)
      if (fail) yield* Effect.fail("boom")
      yield* Semaphore.release(lock, 1)
      return "done"
    })

  const first = yield* Effect.result(risky(true))
  console.log("first:", Result.isFailure(first) ? "failed" : "ok")

  const second = yield* risky(false).pipe(Effect.timeoutOption("50 millis"))
  console.log("second:", Option.isSome(second) ? second.value : "hung")
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Option, Result, Semaphore } from "effect"

const program = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1)

  const risky = (fail: boolean) =>
    Semaphore.withPermits(lock, 1)(Effect.gen(function* () {
      if (fail) yield* Effect.fail("boom")
      return "done"
    }))

  const first = yield* Effect.result(risky(true))
  console.log("first:", Result.isFailure(first) ? "failed" : "ok")

  const second = yield* risky(false).pipe(Effect.timeoutOption("50 millis"))
  console.log("second:", Option.isSome(second) ? second.value : "hung")
})

Effect.runPromise(program)
`,
      expectedOutput: `first: failed
second: done`,
      hints: [
        "Follow the permit in the failing call. Which line runs after Effect.fail? None.",
        "Manual take and release is not safe when the code between them can fail or be interrupted.",
        "Wrap the body in Semaphore.withPermits(lock, 1)(...) and remove take and release."
      ],
      explanation: `\`Effect.fail\` stops the generator at once, so the \`release\` line never runs and the only permit stays taken. Every later caller waits forever. \`withPermits\` acquires the permit, runs the effect, and gives the permit back in a finalizer. The finalizer runs on success, on failure, and on interrupt. This is the same rule as \`acquireRelease\` in Resource Management: put the release next to the acquire, and let the runtime run it.`
    }
  ],
  problems: [
    {
      id: "concurrency-p1",
      title: "Worker pool draining a queue",
      spec: `
Build a pool of 3 workers that process 6 jobs from a bounded queue.

1. Create \`Queue.bounded<Job, Cause.Done>(10)\`, where \`Job = { id: number }\`. Offer jobs 1 to 6 with \`Queue.offerAll\`. Then call \`Queue.end\`, so that the workers know when to stop.
2. \`worker(n)\` loops: it takes a job, "processes" it with a sleep of 5 ms, and pushes the string \`"job-<id> -> <id * 2>"\` into the shared \`results\` Ref. During the process step, count the active workers with the \`busy\`/\`maxBusy\` refs in the same way as lesson 4. When \`Queue.take\` fails with \`Done\`, the worker stops. Use \`Effect.forever\` plus \`Effect.catchTag("Done", ...)\`.
3. Run 3 workers with \`Effect.forEach\` and \`concurrency: "unbounded"\`. Then print the results **sorted**, 1 per line, and then a summary line.

Exact output:

\`\`\`
job-1 -> 2
job-2 -> 4
job-3 -> 6
job-4 -> 8
job-5 -> 10
job-6 -> 12
processed 6 jobs, max busy workers: 3
\`\`\`
`,
      starter: `import { Cause, Effect, Queue, Ref } from "effect"

type Job = { id: number }

const program = Effect.gen(function* () {
  const results = yield* Ref.make<Array<string>>([])
  const busy = yield* Ref.make(0)
  const maxBusy = yield* Ref.make(0)

  // TODO: create the bounded queue, offer jobs 1..6, then end it

  const worker = (n: number) =>
    Effect.gen(function* () {
      // TODO: loop: take a job, sleep 5ms, record "job-<id> -> <id * 2>"
      // TODO: stop when take fails with Done
    })

  // TODO: run 3 workers concurrently and wait for all of them

  // TODO: print sorted results, then the summary line
})

Effect.runPromise(program)
`,
      solution: `import { Cause, Effect, Queue, Ref } from "effect"

type Job = { id: number }

const program = Effect.gen(function* () {
  const results = yield* Ref.make<Array<string>>([])
  const busy = yield* Ref.make(0)
  const maxBusy = yield* Ref.make(0)

  const jobs = yield* Queue.bounded<Job, Cause.Done>(10)
  yield* Queue.offerAll(jobs, [1, 2, 3, 4, 5, 6].map((id) => ({ id })))
  yield* Queue.end(jobs)

  const worker = (n: number) =>
    Effect.gen(function* () {
      const job = yield* Queue.take(jobs)                 // fails with Done when the queue is drained
      const now = yield* Ref.updateAndGet(busy, (b) => b + 1)
      yield* Ref.update(maxBusy, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(results, (list) => [...list, "job-" + job.id + " -> " + job.id * 2])
      yield* Ref.update(busy, (b) => b - 1)
    }).pipe(
      Effect.forever,
      Effect.catchTag("Done", () => Effect.void)
    )

  yield* Effect.forEach([1, 2, 3], worker, { concurrency: "unbounded", discard: true })

  const lines = (yield* Ref.get(results)).sort()
  for (const line of lines) console.log(line)
  console.log("processed", lines.length, "jobs, max busy workers:", yield* Ref.get(maxBusy))
})

Effect.runPromise(program)
`,
      expectedOutput: `job-1 -> 2
job-2 -> 4
job-3 -> 6
job-4 -> 8
job-5 -> 10
job-6 -> 12
processed 6 jobs, max busy workers: 3`,
      hints: [
        "Queue.end after offerAll is correct: the queued jobs stay available, and take fails with Done only after they are gone.",
        "Write 1 iteration as an Effect.gen. Then pipe it through Effect.forever and Effect.catchTag(\"Done\", () => Effect.void).",
        "Effect.forEach([1, 2, 3], worker, { concurrency: \"unbounded\", discard: true }) runs the pool and waits until all 3 workers stop."
      ]
    },
    {
      id: "concurrency-p2",
      title: "First responder wins, losers clean up",
      spec: `
Query 4 mirrors at once and use the first successful answer. The runtime must cancel every mirror that still runs when the winner arrives, and you must prove it.

1. \`mirror(name, ms)\` sleeps \`ms\` and succeeds with \`name\`. Attach \`Effect.onInterrupt\`, so that a cancelled mirror adds its name to a shared \`cancelled\` Ref.
2. \`broken\` is a mirror that fails after 1 ms with \`"backup offline"\`. It must not decide the race.
3. Race \`mirror("eu", 60)\`, \`mirror("us", 5)\`, \`mirror("asia", 40)\`, and \`broken\` with \`Effect.raceAll\`.
4. Print the winner. Then print the cancelled names **sorted** and joined with \`", "\`.

Exact output:

\`\`\`
winner: us
cancelled: asia, eu
\`\`\`

The failed mirror is not in the cancelled list. It finished on its own, and the runtime did not interrupt it.
`,
      starter: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const cancelled = yield* Ref.make<Array<string>>([])

  // TODO: mirror(name, ms) succeeds with name after ms, records itself on interrupt
  const mirror = (name: string, ms: number) => Effect.succeed(name)

  // TODO: broken fails with "backup offline" after 1ms

  // TODO: race all four, print "winner: <name>"
  // TODO: print "cancelled: <sorted names joined by ', '>"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const cancelled = yield* Ref.make<Array<string>>([])

  const mirror = (name: string, ms: number) =>
    Effect.sleep(ms).pipe(                   // a plain number means milliseconds
      Effect.as(name),
      Effect.onInterrupt(() => Ref.update(cancelled, (list) => [...list, name]))
    )

  const broken = Effect.sleep("1 millis").pipe(Effect.andThen(Effect.fail("backup offline")))

  // raceAll ignores early failures and interrupts the losers once a success arrives
  const winner = yield* Effect.raceAll([mirror("eu", 60), mirror("us", 5), mirror("asia", 40), broken])
  console.log("winner:", winner)

  const names = (yield* Ref.get(cancelled)).sort()
  console.log("cancelled:", names.join(", "))
})

Effect.runPromise(program)
`,
      expectedOutput: `winner: us
cancelled: asia, eu`,
      hints: [
        "Build mirror with Effect.sleep(...).pipe(Effect.as(name), Effect.onInterrupt(...)). The finalizer is an Effect, so Ref.update works directly.",
        "raceAll waits for the first success. It skips a fast failure. raceFirst returns the failure instead.",
        "The losers finish their cleanup before raceAll returns, so a read of the Ref directly after the race is safe. Sort before you print."
      ]
    },
    {
      id: "concurrency-p3",
      title: "Rate-limited batch downloader",
      spec: `
Download 6 files with at most 2 active downloads, independent of how the program starts the downloads.

1. \`files\` is the fixed list \`[["a.txt", 3], ["b.txt", 5], ["c.txt", 2], ["d.txt", 8], ["e.txt", 1], ["f.txt", 4]]\` of \`[name, bytes]\`.
2. Create a \`Semaphore\` with 2 permits. \`download(name, bytes)\` runs under 1 permit. It increments \`inFlight\`, records the maximum in \`maxInFlight\`, sleeps 5 ms, decrements \`inFlight\`, and returns \`bytes\`.
3. Start all 6 downloads with \`Effect.forEach\` and \`concurrency: "unbounded"\`, so that the semaphore, not the option, is the limiter. The results must come back in input order.
4. Print 1 line per file in input order, then the total, then the maximum number of concurrent downloads.

Exact output:

\`\`\`
a.txt: 3 bytes
b.txt: 5 bytes
c.txt: 2 bytes
d.txt: 8 bytes
e.txt: 1 bytes
f.txt: 4 bytes
total: 23 bytes
max concurrent downloads: 2
\`\`\`
`,
      starter: `import { Effect, Ref, Semaphore } from "effect"

const files: Array<[string, number]> = [
  ["a.txt", 3], ["b.txt", 5], ["c.txt", 2], ["d.txt", 8], ["e.txt", 1], ["f.txt", 4]
]

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)

  // TODO: create a semaphore with 2 permits

  // TODO: download(name, bytes) under one permit, tracking inFlight / maxInFlight
  const download = (name: string, bytes: number) => Effect.succeed(bytes)

  // TODO: run all downloads with concurrency "unbounded", keep input order
  // TODO: print "<name>: <bytes> bytes" per file, "total: <sum> bytes", and the max line
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref, Semaphore } from "effect"

const files: Array<[string, number]> = [
  ["a.txt", 3], ["b.txt", 5], ["c.txt", 2], ["d.txt", 8], ["e.txt", 1], ["f.txt", 4]
]

const program = Effect.gen(function* () {
  const inFlight = yield* Ref.make(0)
  const maxInFlight = yield* Ref.make(0)
  const limiter = yield* Semaphore.make(2)

  const download = (name: string, bytes: number) =>
    Semaphore.withPermits(limiter, 1)(Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
      yield* Ref.update(maxInFlight, (m) => Math.max(m, now))
      yield* Effect.sleep("5 millis")
      yield* Ref.update(inFlight, (n) => n - 1)
      return bytes
    }))

  // Everything is launched at once; only two get a permit at a time
  const sizes = yield* Effect.forEach(files, ([name, bytes]) => download(name, bytes), {
    concurrency: "unbounded"
  })

  files.forEach(([name], i) => console.log(name + ": " + sizes[i] + " bytes"))
  console.log("total: " + sizes.reduce((a, b) => a + b, 0) + " bytes")
  console.log("max concurrent downloads:", yield* Ref.get(maxInFlight))
})

Effect.runPromise(program)
`,
      expectedOutput: `a.txt: 3 bytes
b.txt: 5 bytes
c.txt: 2 bytes
d.txt: 8 bytes
e.txt: 1 bytes
f.txt: 4 bytes
total: 23 bytes
max concurrent downloads: 2`,
      hints: [
        "Call Semaphore.make(2) once. Then put Semaphore.withPermits(limiter, 1)(effect) around the body of download.",
        "Effect.forEach keeps the results in input order, so sizes[i] belongs to files[i].",
        "Ref.updateAndGet gives you the new count in 1 step. Use it to update maxInFlight with Math.max."
      ]
    }
  ],
  recall: [
    {
      q: "What is a fiber, and how can 2 fibers interleave on a single JavaScript thread?",
      a: "A fiber is a lightweight thread of execution that the Effect runtime manages. Fibers are cooperative. A fiber runs until it yields (a `sleep`, an async step, or `Effect.yieldNow`). Then another fiber gets a turn. Only 1 fiber runs at any instant, but their steps interleave at the yield points."
    },
    {
      q: "What happens to a fiber that starts with `Effect.forkChild` if its parent finishes first?",
      a: "The runtime interrupts it. The parent limits the lifetime of a child. Use `Fiber.join` or `Fiber.await` to make the parent wait. Use `Effect.forkScoped` to tie the fiber to a `Scope` instead. Use `Effect.forkDetach` when the fiber must continue after the parent (then you own its cleanup)."
    },
    {
      q: "What is the type of `Effect.forkChild(Effect.fail(\"x\") as Effect.Effect<number, string>)`?",
      a: "`Effect<Fiber<number, string>, never, never>`. The fork itself never fails and needs nothing. The success value is a handle, and its own value and error types are those of the forked effect. `Fiber.join` on it gives back `Effect<number, string>`."
    },
    {
      q: "Which function permits at most 3 concurrent calls to a database, when the calls come from many unrelated places in the program?",
      a: "A `Semaphore` with 3 permits. Wrap each call in `Semaphore.withPermits(sem, 1)`. The `concurrency` option only limits 1 `forEach`/`all` call. A shared semaphore limits the resource itself, for every caller."
    },
    {
      q: "What is the difference between `Effect.race` and `Effect.raceFirst`?",
      a: "`race` returns the first *success* and ignores earlier failures (it fails only when both fail). `raceFirst` returns the effect that *completes* first, success or failure. In both cases the runtime interrupts the other fiber."
    },
    {
      q: "How does `Effect.timeout` differ from `Effect.timeoutOption`, and what happens to the slow effect?",
      a: "`timeout` fails with a `TimeoutError`. The error type includes it, so you must process it, for example with `catchTag(\"TimeoutError\", ...)`. `timeoutOption` succeeds with `Option.none()` instead. In both cases the runtime interrupts the slow effect when the time runs out."
    },
    {
      q: "Is an interrupt an error? How does it appear in a `Cause`?",
      a: "No. It is a third outcome, next to success and failure. The `Cause` has a reason with the tag `\"Interrupt\"`, `Cause.hasFails` is false, and ordinary error handlers do not catch it. Finalizers such as `onInterrupt` and `ensuring` still run. `Effect.uninterruptible` postpones an interrupt until a block has finished."
    },
    {
      q: "Deferred, Queue, or PubSub: which one do you use in each case? (a) 1 fiber waits for a config load. (b) 3 listeners must all receive 5 events. (c) Each work item gets processed 1 time.",
      a: "(a) `Deferred`: a value that you set 1 time, and that all waiters share. (b) `PubSub`: broadcast, every subscriber gets every message. (c) `Queue`: each item goes to exactly 1 taker, with backpressure if the queue is bounded."
    }
  ]
}

export default section
