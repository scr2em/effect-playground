import type { Section } from "../types.ts"

const section: Section = {
  id: "concurrency",
  title: "Concurrency",
  order: 12,
  summary: "Fibers, structured concurrency with limits, racing and timeouts, interruption, and the coordination primitives Deferred, Queue, PubSub, and Semaphore.",
  intro: `
**The problem.** Concurrency in plain TypeScript is three separate tools that do not know about each other. To fetch six users, at most two at a time, with a 1 second cap, and to cancel the rest when one fails, you write something like this:

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

Look at what leaks. \`Promise.all\` rejects on the first failure, but the other five requests keep running: nobody cancels them. The \`AbortController\` only works if every function down the stack remembers to pass \`signal\` along. \`pLimit\` is a separate object that has no idea a timeout happened. And if a cancelled request was halfway through writing a file, no cleanup runs. Each piece is fine alone. Together they leak work, leak errors, and leak resources.

### The shift

Today you think of concurrent work as **Promises that you start and then hope to collect**. A Promise has no owner: once created it runs until it settles, whatever happens around it. Effect asks you to think in **fibers with owners**. A fiber is a lightweight thread of execution that the Effect runtime schedules on the single JavaScript thread. Every fiber is forked *by* another fiber, and by default it lives no longer than its parent. When the parent ends, its children are interrupted. When one of several concurrent tasks fails, its siblings are interrupted. When a race is won, the losers are interrupted. Interruption runs finalizers, so a cancelled task cleans up after itself.

This is called *structured concurrency*: the tree of running work matches the tree of your code. The payoff is that concurrency becomes an option you pass, not a library you glue on. \`Effect.all(tasks, { concurrency: 2 })\` limits, collects in order, fails fast, and cancels the rest, in one line, and the compiler still knows the error type.

| You reach for... | In plain TS | In Effect |
|---|---|---|
| Run many, collect all | \`Promise.all\` | \`Effect.all\` / \`Effect.forEach\` with \`{ concurrency }\` |
| Limit how many at once | \`p-limit\` | the \`concurrency\` option, or a \`Semaphore\` |
| First one wins | \`Promise.race\` | \`Effect.race\` / \`Effect.raceAll\`, losers interrupted |
| Give up after a while | \`setTimeout\` + \`AbortController\` | \`Effect.timeout\` / \`Effect.timeoutOption\` |
| Cancel work | \`AbortSignal\` threaded by hand | \`Fiber.interrupt\`, automatic for children |
| Hand a value to a waiter once | a captured \`resolve\` | \`Deferred\` |
| Producer/consumer buffer | array + manual polling | \`Queue\` with backpressure |
| Broadcast to many listeners | \`EventEmitter\` | \`PubSub\` |

In this section you will fork fibers and watch them interleave, run work with limits, race and time out, interrupt safely, and coordinate fibers with the four primitives above.
`,
  lessons: [
    {
      id: "concurrency-l1",
      title: "Fibers: fork, interleave, join",
      explain: `
A fiber is a lightweight thread that the Effect runtime schedules. There is still one JavaScript thread, so fibers do not run at the same instant. Instead they take turns: a fiber runs until it *yields* (at a \`sleep\`, an async boundary, or an explicit \`Effect.yieldNow\`), and then another fiber gets a turn. This is called cooperative scheduling.

\`Effect.forkChild(effect)\` starts \`effect\` in a new fiber and returns a \`Fiber\` handle right away. The new fiber does not run yet: it waits until the current fiber yields. \`Fiber.join(fiber)\` suspends until the fiber finishes and hands you its success value, or fails with its error.

Below, two workers each print three steps and yield after each one. The parent forks both, prints, then joins. Watch how the lines interleave one step at a time.
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
      after: `Notice that the parent's line prints before any worker step, even though both forks came first. Forking only schedules the work. Try removing \`yield* Effect.yieldNow\`: each worker now runs all three steps in one turn, so you get A 1, 2, 3 then B 1, 2, 3.`
    },
    {
      id: "concurrency-l2",
      title: "Fiber.await gives an Exit, Fiber.interrupt stops a fiber",
      explain: `
\`Fiber.join\` is convenient but it re-raises the fiber's failure in your own fiber. When you want to *inspect* what happened instead, use \`Fiber.await\`. It never fails: it hands you the fiber's \`Exit\`, a \`Success\` with a value or a \`Failure\` with a \`Cause\`.

| Function | Waits? | On fiber failure |
|---|---|---|
| \`Fiber.join(f)\` | Yes | Fails the caller with the same error |
| \`Fiber.await(f)\` | Yes | Succeeds with \`Exit.Failure\` |
| \`Fiber.interrupt(f)\` | Yes, until the fiber has stopped | Returns \`void\` |

\`Fiber.interrupt\` asks a fiber to stop and waits until it has. The fiber's finalizers run, including any \`Effect.onInterrupt\` handler. Afterwards its Exit is a Failure whose Cause has a reason tagged \`"Interrupt"\`, not \`"Fail"\`. Interruption is a third kind of outcome, separate from success and error.
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
      after: `The cleanup line appears *before* \`Fiber.interrupt\` returns, because interrupt waits for finalizers. Try replacing \`Fiber.await(bad)\` with \`Fiber.join(bad)\`: the whole program now fails with "disk full", because join propagates.`
    },
    {
      id: "concurrency-l3",
      title: "Who owns a fiber: forkChild, forkScoped, forkDetach",
      explain: `
Every fiber has an owner, and the owner decides when it dies. This is the heart of structured concurrency. Three fork functions give three lifetimes:

| Function | Fiber dies when... | Use when |
|---|---|---|
| \`Effect.forkChild\` | its parent fiber finishes | background work that only matters while the parent runs |
| \`Effect.forkScoped\` | the enclosing \`Scope\` closes | work tied to a resource, like a heartbeat while a connection is open |
| \`Effect.forkDetach\` | it finishes on its own | work that must outlive the caller; you own the cleanup |

The parent-finishes-first case surprises people. If you \`forkChild\` a task and the parent returns before the task is done, the task is interrupted. In plain TypeScript the Promise would keep running with nobody watching it. In Effect, "nobody watching it" is not allowed unless you say so with \`forkDetach\`.

The program below runs the same ticker under each lifetime. Only the detached one gets to finish.
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
      after: `Try deleting the final \`Fiber.join(detached)\`. The program ends before "detached finished" can print, and the fiber is abandoned. \`forkDetach\` gives you freedom and takes away the safety net at the same time.`
    },
    {
      id: "concurrency-l4",
      title: "Effect.all and forEach with a concurrency limit",
      explain: `
Most concurrency does not need manual forking. \`Effect.all\` and \`Effect.forEach\` run a collection of effects and collect the results **in input order**, however the work finished. In plain TypeScript you would combine \`Promise.all\` with a limiter:

\`\`\`ts
const limit = pLimit(2)
const users = await Promise.all(ids.map((id) => limit(() => fetchUser(id))))
\`\`\`

In Effect the limit is an option:

| Option | Meaning |
|---|---|
| no option | one at a time, in order |
| \`{ concurrency: 2 }\` | at most 2 in flight |
| \`{ concurrency: "unbounded" }\` | everything at once |
| \`{ discard: true }\` | do not collect results, return \`void\` |

The program proves the limit instead of trusting it. A \`Ref\` counts how many fake requests are in flight, and another records the highest count seen. Each configuration runs the same six requests.
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
      after: `The results are in the same order in all three runs. Effect keeps the position of each input even when a later request finishes first. Try \`{ concurrency: 3 }\`: the max becomes 3 and the order stays the same.`
    },
    {
      id: "concurrency-l5",
      title: "Racing and timeouts: the loser is interrupted",
      explain: `
\`Effect.race(a, b)\` runs both and returns the first **success**. \`Effect.raceAll([...])\` does the same for a list. The moment a winner is known, the other fibers are interrupted, and their finalizers run. In plain TypeScript, \`Promise.race\` returns the first settled value but the losers keep running to the end.

A timeout is a race against a clock, and it comes in flavours:

| Function | On timeout | Type of result |
|---|---|---|
| \`Effect.timeout(eff, "5 millis")\` | fails with \`TimeoutError\` | \`Effect<A, E \\| TimeoutError>\` |
| \`Effect.timeoutOption(eff, "5 millis")\` | succeeds with \`Option.none()\` | \`Effect<Option<A>, E>\` |
| \`Effect.timeoutOrElse(eff, { duration, orElse })\` | runs the fallback | \`Effect<A \\| B, E \\| E2>\` |

In every case the slow effect is interrupted when time runs out. The program below attaches an \`onInterrupt\` finalizer to each fake request so you can see the losers being cancelled. For \`raceAll\` the losers are collected into a \`Ref\` and printed sorted, because two fibers interrupted at the same moment have no fixed order.
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
      after: `The cancelled list is already filled when the next line prints: the race does not return until the losers have finished cleaning up. Try \`Effect.race(Effect.fail("boom"), request("mirror-us", 5))\`: a fast failure does not win, \`race\` waits for the success. \`Effect.raceFirst\` is the variant where any completion, even a failure, ends the race.`
    },
    {
      id: "concurrency-l6",
      title: "Interruption: cooperative, cleanup-safe, and not an error",
      explain: `
Interruption is how Effect cancels work. Three facts make it safe to rely on:

1. **It is cooperative.** A fiber is only interrupted at a yield point. Synchronous code between yields always completes.
2. **Finalizers run.** \`Effect.onInterrupt\`, \`Effect.ensuring\`, and \`acquireRelease\` finalizers all execute before the interrupted fiber is considered done.
3. **It is a separate outcome.** The Cause has a reason tagged \`"Interrupt"\`. \`Cause.hasFails\` is false, so error handlers like \`catch\` do not see it as an error.

Sometimes a block must never be cut in half, such as writing a header and then a body. Wrap it in \`Effect.uninterruptible\`. An interrupt request arriving during that block waits until the block finishes, then takes effect at the next yield.

The last part shows the structured-concurrency rule in \`Effect.all\`: when one sibling fails, the others are interrupted, and the overall result is the failure.
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
      after: `"write body" printed even though the interrupt arrived at 2ms, during the 10ms sleep inside the uninterruptible block. Remove \`Effect.uninterruptible\` and only "write header" survives. Be careful with this tool: an uninterruptible infinite loop can never be stopped.`
    },
    {
      id: "concurrency-l7",
      title: "Coordinating fibers: Deferred and Queue",
      explain: `
Forking is easy. Getting fibers to *talk* is where plain TypeScript gets messy: you capture a \`resolve\` function in a closure, or you push into an array and poll it. Effect gives typed primitives instead.

A \`Deferred<A, E>\` is a one-shot cell. Any number of fibers can \`Deferred.await\` it and suspend. Exactly one \`Deferred.succeed\` (or \`fail\`) wakes them all with the same value. A second completion is ignored and returns \`false\`.

A \`Queue<A>\` carries many values from producers to consumers. \`Queue.bounded(n)\` has a capacity: when it is full, \`Queue.offer\` suspends the producer until a consumer takes something. This is backpressure, and it is what stops a fast producer from filling memory. \`Queue.end\` signals that no more values are coming, so consumers taking from an ended, empty queue fail with \`Done\` and can stop.

In the program, watch the producer print "queue full" before each offer that has to wait.
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
      after: `Change \`Queue.bounded<number, Cause.Done>(2)\` to \`Queue.unbounded<number, Cause.Done>()\` (keep the \`Cause.Done\` type argument, \`Queue.end\` needs it). The producer never waits and offers all five instantly. Bounded queues trade a little producer speed for a guarantee about memory.`
    },
    {
      id: "concurrency-l8",
      title: "PubSub and Semaphore, and which primitive to reach for",
      explain: `
Two more primitives complete the toolbox.

A \`PubSub<A>\` broadcasts. Every subscriber receives every message published after it subscribed, unlike a Queue where each value goes to exactly one taker. \`PubSub.subscribe\` needs a \`Scope\`, so the subscription is released when the scope closes; wrap the code in \`Effect.scoped\`.

A \`Semaphore\` holds a fixed number of permits. \`Semaphore.withPermits(sem, 1)(effect)\` waits for a permit, runs the effect, and gives the permit back, even on failure or interruption. It is the tool for "at most N of *this specific thing* at once", such as a database with a small connection pool, no matter how the callers are structured.

| Primitive | Reach for it when |
|---|---|
| \`Deferred\` | one fiber must wait for a single value or signal from another |
| \`Queue\` | work items flow from producers to consumers, each item handled once |
| \`PubSub\` | several listeners must all see every event |
| \`Semaphore\` | a shared resource allows only N users at a time, across unrelated callers |
| \`concurrency\` option | you only need to limit one \`forEach\`/\`all\` call |
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
      after: `The \`Effect.all\` call is unbounded, yet only two queries run at once. The limit lives with the resource, so a second unrelated \`Effect.all\` elsewhere that also calls \`query\` would share the same two permits. Try \`Semaphore.make(1)\` to serialize every query.`
    }
  ],
  challenges: [
    {
      id: "concurrency-c1",
      title: "A Fiber is not a value",
      task: `The program should print \`total: 21\` but it does not compile. The fiber is forked, but its result is never collected. Fix it without changing the \`console.log\` line.`,
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
        "Read the type error: what is the type of result? It is a handle, not a number.",
        "Forking returns a Fiber. Something has to wait for the fiber and unwrap its value.",
        "Keep the fiber in a variable, then yield* Fiber.join(fiber) to get the number."
      ],
      explanation: `\`Effect.forkChild\` succeeds with a \`Fiber<number, never>\`, a handle to running work, not the number itself. Adding 1 to a handle is meaningless, so TypeScript refuses. \`Fiber.join\` is the bridge: it waits for the fiber and gives you its success value, or fails with its error. In Effect v4 a Fiber is not itself yieldable, so \`yield* fiber\` does not work either; the join must be explicit. This is the same shape as challenge 1 in Getting Started, one level up: forgetting \`yield*\` leaves you with an Effect, forgetting \`join\` leaves you with a Fiber.`
    },
    {
      id: "concurrency-c2",
      title: "The option that does nothing",
      task: `The six lookups should run at most three at a time and the program should print \`max in flight: 3\`. It does not compile, and if it did, it would print \`1\`. Fix the option passed to \`Effect.forEach\`.`,
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
        "The type error lists the option names forEach accepts.",
        "Lesson 4 has a table of options. Which key sets how many run at once?",
        "Replace parallel: 3 with concurrency: 3."
      ],
      explanation: `\`forEach\` only knows the keys \`concurrency\` and \`discard\`. Because the options are a typed object, an unknown key is a compile error rather than a silently ignored setting. That matters: without the type check this program would have run sequentially, printed \`1\`, and looked like a working limiter. Plain \`p-limit\` style helpers would never have told you.`
    },
    {
      id: "concurrency-c3",
      title: "The email that was never sent",
      task: `The handler should print \`request handled\` and then \`email sent\`, but the second line never appears. Fix the program so the email is actually sent, keeping the order of the two lines.`,
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
        "The parent returns right after printing, so the child is interrupted before its 10ms sleep ends.",
        "Keep the fiber handle and yield* Fiber.join(fiber) after the console.log."
      ],
      explanation: `\`forkChild\` ties the child's life to the parent. \`handleRequest\` printed its line and returned immediately, so the runtime interrupted \`sendEmail\` mid-sleep. Joining after the log keeps the order of the output and makes the parent wait. \`Effect.forkDetach\` would also let the email finish, but then nothing would wait for it and the process could end first; it is the right tool only when something else owns the fiber's lifetime.`
    },
    {
      id: "concurrency-c4",
      title: "A timeout is an error until you handle it",
      task: `\`priceWithTimeout\` is declared as an Effect that cannot fail, but the timeout makes that untrue and the program does not compile. Without changing the type annotation, make a timeout fall back to \`cached price\` so the program prints \`price: cached price\`.`,
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
        "Lesson 5 shows two ways: catch the TimeoutError by tag, or use the timeoutOrElse variant with a fallback.",
        "Pipe the timeout into Effect.catchTag(\"TimeoutError\", () => Effect.succeed(\"cached price\"))."
      ],
      explanation: `\`Effect.timeout\` widens the error type to \`E | TimeoutError\`. The annotation \`Effect.Effect<string>\` claims \`never\`, so the assignment fails to compile, which is exactly the point: a timeout is a real outcome and someone must decide what happens. \`catchTag("TimeoutError", ...)\` handles precisely that case and brings the error channel back to \`never\`. \`Effect.timeoutOrElse(slowLookup, { duration: "5 millis", orElse: () => Effect.succeed("cached price") })\` is the same idea in one call. Either way the slow lookup is interrupted when the timeout fires.`
    },
    {
      id: "concurrency-c5",
      title: "Never leave a half-written record",
      task: `A record is only valid with both a header and a body. The writer gets interrupted after 2ms, in the middle of the two write steps, and leaves a half-written record. Make the two write steps interruption-proof, so the output is \`write header\`, \`write body\`, \`writer stopped\`. The writer must still be interruptible after the record is complete.`,
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
        "Interruption happens at yield points. The sleep between header and body is one.",
        "Lesson 6 shows a wrapper that makes a block run fully or not at all.",
        "Wrap the header, the sleep, and the body in Effect.uninterruptible(Effect.gen(...)). Leave the 50ms sleep outside it."
      ],
      explanation: `\`Effect.uninterruptible\` marks a region where interruption is postponed. The request arrives at 2ms, during the first sleep, but it is only honoured at the next yield point *after* the region, which is the 50ms sleep. So both writes complete and "archived" never prints. Keeping the long sleep outside the region is important: if the whole writer were uninterruptible, \`Fiber.interrupt\` would have to wait the full 60ms and the caller could never cancel it.`
    },
    {
      id: "concurrency-c6",
      title: "A limit that limits nothing",
      task: `The database pool must allow at most 2 concurrent queries, so the program should print \`max concurrent: 2\`. It prints \`5\`. Fix the code so the semaphore actually limits the queries.`,
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
        "How many semaphores exist while the five queries run?",
        "Semaphore.make builds a new semaphore each time it runs. Where is it being run?",
        "Create the semaphore once, outside query, and let every query share it."
      ],
      explanation: `\`Semaphore.make(2)\` is an Effect that *creates* a semaphore when run. Running it inside \`query\` means each of the five queries gets its own brand-new pool with two free permits, so nobody ever waits. A semaphore only limits fibers that share the same instance. Creating it once at the top and closing over it is the fix. The same mistake is common with \`Ref.make\` and \`Queue.make\`: constructors are effects, and where you run them decides how many you get.`
    },
    {
      id: "concurrency-c7",
      title: "The fast failure that won the race",
      task: `We want the first *successful* answer from two servers. The primary fails after 2ms, the backup answers after 20ms. The program should print \`backup answered\`, but it fails with \`primary down\` instead. Fix the race.`,
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
        "There are two racing functions. One ends the race on any completion, the other on the first success.",
        "raceFirst treats the fast failure as the winner and interrupts the backup.",
        "Use Effect.race instead of Effect.raceFirst."
      ],
      explanation: `\`Effect.raceFirst\` returns whichever effect *finishes* first, success or failure, and interrupts the other. Since the primary failed at 2ms, that failure became the result. \`Effect.race\` keeps waiting after an early failure and only settles on the first success; it fails only if both sides fail. Pick by asking: is a fast failure an answer (\`raceFirst\`), or should it be ignored while another attempt might succeed (\`race\`)?`
    },
    {
      id: "concurrency-c8",
      title: "A scoped fiber needs a scope",
      task: `The heartbeat should run while the request is handled and stop when it is done. The program does not compile because a requirement is missing at the point where it is run. Fix the last line only, so the output is \`heartbeat started\`, \`request done\`, \`heartbeat stopped\`.`,
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
      explanation: `\`Effect.forkScoped\` ties the fiber to the nearest \`Scope\`, so its type becomes \`Effect<void, never, Scope>\`. \`runPromise\` only accepts effects whose requirements are \`never\`, and the compiler stopped you from running an effect whose cleanup had nowhere to go. \`Effect.scoped\` creates a scope, runs the program inside it, and closes the scope on exit; closing the scope interrupts the heartbeat, which runs its finalizer. The type system turned "who stops the heartbeat?" into a question you had to answer before the program could run.`
    }
  ],
  problems: [
    {
      id: "concurrency-p1",
      title: "Worker pool draining a queue",
      spec: `
Build a pool of 3 workers that process 6 jobs from a bounded queue.

1. Create \`Queue.bounded<Job, Cause.Done>(10)\` where \`Job = { id: number }\`. Offer jobs 1 to 6 with \`Queue.offerAll\`, then call \`Queue.end\` so workers know when to stop.
2. \`worker(n)\` loops: take a job, "process" it by sleeping 5ms, and push the string \`"job-<id> -> <id * 2>"\` into the shared \`results\` Ref. While processing, count in-flight workers with the \`busy\`/\`maxBusy\` refs the same way lesson 4 does. When \`Queue.take\` fails with \`Done\`, the worker stops. Use \`Effect.forever\` plus \`Effect.catchTag("Done", ...)\`.
3. Run 3 workers with \`Effect.forEach\` and \`concurrency: "unbounded"\`, then print the results **sorted**, one per line, followed by a summary line.

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
        "Queue.end after offerAll is fine: the queued jobs stay available, and take fails with Done only once they are gone.",
        "Write one iteration as an Effect.gen, then pipe it through Effect.forever and Effect.catchTag(\"Done\", () => Effect.void).",
        "Effect.forEach([1, 2, 3], worker, { concurrency: \"unbounded\", discard: true }) runs the pool and waits for all three to stop."
      ]
    },
    {
      id: "concurrency-p2",
      title: "First responder wins, losers clean up",
      spec: `
Query four mirrors at once and use the first successful answer. Every mirror that was still running when the winner arrived must be cancelled, and you must be able to prove it.

1. \`mirror(name, ms)\` sleeps \`ms\` and succeeds with \`name\`. Attach \`Effect.onInterrupt\` so that a cancelled mirror appends its name to a shared \`cancelled\` Ref.
2. \`broken\` is a mirror that fails after 1ms with \`"backup offline"\`. It must not decide the race.
3. Race \`mirror("eu", 60)\`, \`mirror("us", 5)\`, \`mirror("asia", 40)\`, and \`broken\` with \`Effect.raceAll\`.
4. Print the winner, then the cancelled names **sorted** and joined with \`", "\`.

Exact output:

\`\`\`
winner: us
cancelled: asia, eu
\`\`\`

The failed mirror is not in the cancelled list: it finished on its own, it was not interrupted.
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
        "raceAll waits for the first success; a fast failure is skipped. raceFirst would have returned the failure instead.",
        "Losers are cleaned up before raceAll returns, so reading the Ref right after the race is safe. Sort before printing."
      ]
    },
    {
      id: "concurrency-p3",
      title: "Rate-limited batch downloader",
      spec: `
Download six files with at most 2 downloads in flight, no matter how the downloads are launched.

1. \`files\` is the fixed list \`[["a.txt", 3], ["b.txt", 5], ["c.txt", 2], ["d.txt", 8], ["e.txt", 1], ["f.txt", 4]]\` of \`[name, bytes]\`.
2. Create a \`Semaphore\` with 2 permits. \`download(name, bytes)\` runs under one permit: it increments \`inFlight\`, records the maximum in \`maxInFlight\`, sleeps 5ms, decrements \`inFlight\`, and returns \`bytes\`.
3. Launch all six with \`Effect.forEach\` and \`concurrency: "unbounded"\` so the semaphore, not the option, is the limiter. Results must come back in input order.
4. Print one line per file in input order, then the total, then the maximum concurrency observed.

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
        "Semaphore.make(2) once, then Semaphore.withPermits(limiter, 1)(effect) around the body of download.",
        "Effect.forEach keeps results in input order, so sizes[i] belongs to files[i].",
        "Ref.updateAndGet gives you the new count in one step; use it to update maxInFlight with Math.max."
      ]
    }
  ],
  recall: [
    {
      q: "What is a fiber, and how can two fibers interleave on a single JavaScript thread?",
      a: "A fiber is a lightweight thread of execution managed by the Effect runtime. Fibers are cooperative: a fiber runs until it yields (a `sleep`, an async step, or `Effect.yieldNow`), then another fiber gets a turn. Only one fiber runs at any instant, but their steps interleave at yield points."
    },
    {
      q: "What happens to a fiber started with `Effect.forkChild` if its parent finishes first?",
      a: "It is interrupted. A child's lifetime is bounded by its parent. Use `Fiber.join` or `Fiber.await` to make the parent wait, `Effect.forkScoped` to tie it to a `Scope` instead, or `Effect.forkDetach` when it must outlive the parent (then you own its cleanup)."
    },
    {
      q: "What would the type of `Effect.forkChild(Effect.fail(\"x\") as Effect.Effect<number, string>)` be?",
      a: "`Effect<Fiber<number, string>, never, never>`. Forking itself never fails and needs nothing; the success value is a handle whose own value/error types are those of the forked effect. `Fiber.join` on it gives back `Effect<number, string>`."
    },
    {
      q: "Which function would you reach for to allow at most 3 concurrent calls to a database, when the calls come from many unrelated places in the program?",
      a: "A `Semaphore` with 3 permits, wrapping each call in `Semaphore.withPermits(sem, 1)`. The `concurrency` option only limits one `forEach`/`all` call; a shared semaphore limits the resource itself, whoever calls it."
    },
    {
      q: "What is the difference between `Effect.race` and `Effect.raceFirst`?",
      a: "`race` returns the first *success* and ignores earlier failures (it fails only when both fail). `raceFirst` returns whichever *completes* first, success or failure. In both cases the other fiber is interrupted."
    },
    {
      q: "How does `Effect.timeout` differ from `Effect.timeoutOption`, and what happens to the slow effect?",
      a: "`timeout` fails with a `TimeoutError` (added to the error type, so you must handle it, for example with `catchTag(\"TimeoutError\", ...)`). `timeoutOption` succeeds with `Option.none()` instead. In both cases the slow effect is interrupted when the time runs out."
    },
    {
      q: "Is interruption an error? How does it show up in a `Cause`?",
      a: "No. It is a third outcome next to success and failure. The `Cause` has a reason tagged `\"Interrupt\"`, `Cause.hasFails` is false, and ordinary error handlers do not catch it. Finalizers such as `onInterrupt` and `ensuring` still run. `Effect.uninterruptible` postpones interruption until a block has finished."
    },
    {
      q: "Deferred, Queue, or PubSub: which one for (a) waking one fiber when a config is loaded, (b) five events that three listeners must all receive, (c) work items that each get handled once?",
      a: "(a) `Deferred`: a one-shot value shared by all awaiters. (b) `PubSub`: broadcast, every subscriber gets every message. (c) `Queue`: each item goes to exactly one taker, with backpressure if bounded."
    }
  ]
}

export default section
