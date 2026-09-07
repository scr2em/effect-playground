import type { Section } from "../types.ts"

const section: Section = {
  id: "state-management",
  title: "State Management",
  order: 9,
  summary: "Ref, SynchronizedRef, SubscriptionRef, and TxRef: shared state with atomic updates instead of mutable variables.",
  intro: `
**The problem.** A shared variable and concurrency do not mix, and the bug hides behind any \`await\`:

\`\`\`ts
let count = 0
await Promise.all(items.map(async () => {
  const current = count
  await saveToDb()       // any pause here...
  count = current + 1    // ...and every task writes the same stale value
}))
console.log(count)       // 1, not 100
\`\`\`

Every task read \`0\`, paused, and wrote \`1\`. Ninety-nine updates vanished, no error was thrown, and the code looks perfectly reasonable. When you then want to *react* to the count changing, you reach for an \`EventEmitter\`, and now you have a second system with its own listeners to leak and its own ordering surprises.

### The shift

Today you think of state as **a variable you mutate** and of change notification as **an emitter bolted on the side**. Effect asks you to think of state as **a value held in a container whose every operation is an Effect**. You do not write \`count = count + 1\`; you describe an update, \`Ref.update(count, (n) => n + 1)\`, and that update is applied as one atomic step. Read, modify, and write can no longer be pulled apart by a pause, because there is no pause inside a pure function.

Because reads and updates are Effects, they compose with everything else you have learned: run them concurrently, retry them, interrupt them, scope them to a service. And when the update itself needs to be an Effect, or you need to watch changes, or you need to update several values together, there is a container built for exactly that job.

| Container | Update is... | Reach for it when |
|---|---|---|
| \`let\` | Read, pause, write | Never for state shared across fibers |
| \`Ref\` | A pure function, atomic | A counter, a cache, a list of recorded calls |
| \`SynchronizedRef\` | An Effect, serialized under a lock | The new value comes from a fetch or a computation that can fail |
| \`SubscriptionRef\` | Like \`Ref\`, plus a stream of changes | Something must react to every change: status, progress, config |
| \`TxRef\` + \`Effect.tx\` | Several refs changed all-or-nothing | Money, inventory, anything where two values must stay consistent |

This section starts with the lost-update bug, fixes it with \`Ref\`, then climbs the table one row at a time.
`,
  lessons: [
    {
      id: "state-management-l1",
      title: "Lost updates, then Ref",
      explain: `
The program below runs the bug from the intro first, inside Effect, so you can see that fibers have the same problem as Promises. One hundred fibers each read a plain \`let\`, pause for a millisecond, and write back. They all read \`0\`, so the final value is \`1\`.

Then the same work with a \`Ref\`. \`Ref.make(0)\` creates the container (it is an Effect, so you \`yield*\` it). \`Ref.update(ref, f)\` applies \`f\` to the current value and stores the result as one atomic step. There is no way for another fiber to sneak in between the read and the write, because from the outside there is only one operation.

\`Ref.get\` reads the current value. Like everything else here, it is an Effect until you run it.
`,
      code: `import { Effect, Ref } from "effect"

const ids = Array.from({ length: 100 }, (_, i) => i)

const program = Effect.gen(function* () {
  // A plain variable: read, pause, write. Every fiber reads 0 before any of them writes.
  let plain = 0
  yield* Effect.forEach(ids, () =>
    Effect.gen(function* () {
      const current = plain
      yield* Effect.sleep("1 millis")
      plain = current + 1
    }), { concurrency: "unbounded", discard: true })
  console.log("let:", plain)

  // A Ref: update is one atomic step. Nothing can slip in between read and write.
  const ref = yield* Ref.make(0)
  yield* Effect.forEach(ids, () => Ref.update(ref, (n) => n + 1), { concurrency: "unbounded", discard: true })
  console.log("Ref:", yield* Ref.get(ref))
})

Effect.runPromise(program)
`,
      expectedOutput: `let: 1
Ref: 100`,
      after: `The Ref version has no \`sleep\`, on purpose: \`update\` takes a plain function, so there is no place to pause between read and write. That restriction is the guarantee. Lesson 4 shows what to do when the update itself must wait for something.`
    },
    {
      id: "state-management-l2",
      title: "The Ref toolkit",
      explain: `
\`Ref\` has a small family of operations. They differ only in what they give back.

| Operation | Does | Returns |
|---|---|---|
| \`Ref.get(ref)\` | Read | Current value |
| \`Ref.set(ref, a)\` | Replace | \`void\` |
| \`Ref.update(ref, f)\` | Apply \`f\` | \`void\` |
| \`Ref.updateAndGet(ref, f)\` | Apply \`f\` | The **new** value |
| \`Ref.getAndUpdate(ref, f)\` | Apply \`f\` | The **old** value |
| \`Ref.modify(ref, f)\` | \`f\` returns \`[result, newValue]\` | The \`result\` |

\`modify\` is the general one: in a single atomic step you compute both a value to hand back and the value to store. "Take one from stock and tell me whether it worked" is a \`modify\`. If you wrote it as \`get\`, check, \`set\`, two fibers could both see one item left and both take it.
`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const stock = yield* Ref.make(3)

  // modify: decide AND update in one atomic step. Returns the decision.
  const take = Ref.modify(stock, (n) => (n > 0 ? [true, n - 1] : [false, n]))

  console.log("take:", yield* take)
  console.log("take:", yield* take)
  console.log("getAndUpdate old:", yield* Ref.getAndUpdate(stock, (n) => n + 5))
  console.log("updateAndGet new:", yield* Ref.updateAndGet(stock, (n) => n - 1))

  yield* Ref.set(stock, 0)
  console.log("take:", yield* take)
  console.log("left:", yield* Ref.get(stock))
})

Effect.runPromise(program)
`,
      expectedOutput: `take: true
take: true
getAndUpdate old: 1
updateAndGet new: 5
take: false
left: 0`,
      after: `\`take\` is defined once and run three times; each run re-reads the current stock. Try swapping the tuple in \`modify\` to \`[n - 1, true]\`: the compiler rejects it, because the second element must be the stored type, \`number\`.`
    },
    {
      id: "state-management-l3",
      title: "State that belongs to something",
      explain: `
In plain TypeScript, private state lives in a class:

\`\`\`ts
class IdGenerator {
  private counter = 0
  next() { return "order-" + ++this.counter }
}
\`\`\`

The Effect shape is a factory: an Effect that creates a \`Ref\` and returns functions that close over it. Whoever runs the factory gets their own instance; running it twice gives two independent counters. This is the pattern behind every stateful service in later sections.

The same trick makes tests honest. A fake mailer that records every call in a \`Ref<Array<string>>\` lets a test assert "exactly two emails were sent, to these people" without a mocking library. Since the record is a \`Ref\`, it is safe even when the code under test sends concurrently.
`,
      code: `import { Effect, Ref } from "effect"

// A factory: the Ref is created once, the returned Effect closes over it
const makeIdGenerator = (prefix: string) =>
  Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    return {
      next: Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map((n) => prefix + "-" + n))
    }
  })

// A fake for tests: records calls instead of sending anything
const makeFakeMailer = Effect.gen(function* () {
  const sent = yield* Ref.make<Array<string>>([])
  return {
    send: (to: string) => Ref.update(sent, (list) => [...list, to]),
    sentTo: Ref.get(sent)
  }
})

const program = Effect.gen(function* () {
  const orders = yield* makeIdGenerator("order")
  const users = yield* makeIdGenerator("user")   // a second, independent counter
  console.log(yield* orders.next, yield* orders.next, yield* users.next)

  const mailer = yield* makeFakeMailer
  yield* mailer.send("ada@example.com")
  yield* mailer.send("lin@example.com")
  const sent = yield* mailer.sentTo
  console.log("sent", sent.length, "emails:", sent.join(", "))
})

Effect.runPromise(program)
`,
      expectedOutput: `order-1 order-2 user-1
sent 2 emails: ada@example.com, lin@example.com`,
      after: `\`orders.next\` is a single Effect value run twice, and it produced two different ids, because the Ref it closes over changed in between. Move \`Ref.make(0)\` inside \`next\` and every call would start from a fresh zero. Where you create the Ref decides how long the state lives.`
    },
    {
      id: "state-management-l4",
      title: "SynchronizedRef: when the update is an Effect",
      explain: `
\`Ref.update\` takes a pure function. What if the new value comes from an Effect, say a price lookup or a call that can fail? You cannot \`yield*\` inside \`update\`. The tempting workaround is \`get\`, run the Effect, \`set\`. That is three steps again, and the lost-update bug is back the moment the middle step pauses.

\`SynchronizedRef\` exists for this. \`SynchronizedRef.updateEffect(ref, f)\` takes a function that returns an Effect and runs the whole read-effect-write under a lock. Other updaters wait their turn. \`modifyEffect\` is the \`modify\` version. The pure operations, \`get\`, \`set\`, \`update\`, \`modify\`, are all still there.

The cost is that updates are serialized, one at a time, which is the point: an effectful update that could interleave is an update that can be lost.
`,
      code: `import { Effect, Ref, SynchronizedRef } from "effect"

const ids = Array.from({ length: 100 }, (_, i) => i)

// A lookup that takes time, like fetching the next value from a service
const lookupNext = (n: number) => Effect.sleep("1 millis").pipe(Effect.as(n + 1))

const program = Effect.gen(function* () {
  // Ref: get, then an Effect, then set. Three steps, so updates are lost again.
  const ref = yield* Ref.make(0)
  yield* Effect.forEach(ids, () =>
    Effect.gen(function* () {
      const current = yield* Ref.get(ref)
      const next = yield* lookupNext(current)
      yield* Ref.set(ref, next)
    }), { concurrency: "unbounded", discard: true })
  console.log("Ref get/set:", yield* Ref.get(ref))

  // SynchronizedRef.updateEffect: the whole read-effect-write runs under a lock
  const sref = yield* SynchronizedRef.make(0)
  yield* Effect.forEach(ids, () => SynchronizedRef.updateEffect(sref, lookupNext), {
    concurrency: "unbounded",
    discard: true
  })
  console.log("SynchronizedRef:", yield* SynchronizedRef.get(sref))
})

Effect.runPromise(program)
`,
      expectedOutput: `Ref get/set: 1
SynchronizedRef: 100`,
      after: `The second half takes longer than the first, because one hundred 1 ms lookups now happen one after another instead of all at once. That is the trade: correctness costs the parallelism you were not allowed to have anyway. If the lookup can fail, the failure comes out of \`updateEffect\` and the stored value stays unchanged.`
    },
    {
      id: "state-management-l5",
      title: "SubscriptionRef: state you can watch",
      explain: `
Sometimes state is not only read, it is **watched**: a job status, an upload's progress, a config value that hot-reloads. \`SubscriptionRef\` is a \`Ref\` that also exposes \`SubscriptionRef.changes(ref)\`, a \`Stream\` that emits the current value first and then every new value as it is set.

An observer is a stream pipeline: \`Stream.tap\` to react, \`Stream.takeUntil\` to decide when to stop watching, \`Stream.runDrain\` to run it to completion. Fork it with \`Effect.forkChild\` so it runs beside the writer, and \`Fiber.join\` it at the end.

One subtlety. A stream subscribes when it starts running, and a forked fiber does not start before the parent continues. Writes made before the subscription are not replayed. The \`Deferred\` in the program is a one-shot signal: the observer completes it on its first value, and the writer waits for it before writing. No handshake, and you would see only the last value.
`,
      code: `import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect"

const program = Effect.gen(function* () {
  const status = yield* SubscriptionRef.make("idle")
  const subscribed = yield* Deferred.make<void>()

  // The observer: every value, starting with the current one, until "done"
  const observer = yield* SubscriptionRef.changes(status).pipe(
    Stream.tap((s) => Effect.sync(() => console.log("status:", s))),
    Stream.tap(() => Deferred.succeed(subscribed, void 0)),   // signal: I am listening
    Stream.takeUntil((s) => s === "done"),
    Stream.runDrain,
    Effect.forkChild
  )

  yield* Deferred.await(subscribed)   // do not write before the observer is attached
  yield* SubscriptionRef.set(status, "loading")
  yield* SubscriptionRef.update(status, (s) => (s === "loading" ? "saving" : s))
  yield* SubscriptionRef.set(status, "done")

  yield* Fiber.join(observer)
  console.log("observer finished, final:", yield* SubscriptionRef.get(status))
})

Effect.runPromise(program)
`,
      expectedOutput: `status: idle
status: loading
status: saving
status: done
observer finished, final: done`,
      after: `"idle" was printed even though nothing set it: \`changes\` starts with the current value, so a late subscriber still learns the present state. Delete the \`Deferred.await\` line and run again: the observer attaches after all three writes and prints only "done".`
    },
    {
      id: "state-management-l6",
      title: "TxRef and Effect.tx: several values, one change",
      explain: `
A bank transfer touches two balances. If the debit lands and the credit does not, money vanished. \`Ref\` cannot help: each Ref is atomic on its own, but two Refs together are not.

\`TxRef\` is a transactional ref. Its operations look like \`Ref\`'s, with a twist: inside \`Effect.tx(...)\`, every read and write is recorded in a journal and committed together only when the body finishes. If the body fails, nothing is written, including writes that already happened earlier in the body. If another transaction commits a conflicting change first, this one is retried from the start with fresh reads. That is why the program can run 70 transfers concurrently, each with a pause inside, and still lose nothing.

A single \`TxRef.get\` or \`TxRef.set\` outside \`Effect.tx\` is a tiny transaction of its own. \`Effect.tx\` is what groups several operations into one.
`,
      code: `import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const alice = yield* TxRef.make(100)
  const bob = yield* TxRef.make(0)
  const transfers = yield* TxRef.make(0)

  const transfer = (from: TxRef.TxRef<number>, to: TxRef.TxRef<number>, amount: number) =>
    Effect.tx(Effect.gen(function* () {
      yield* TxRef.update(transfers, (n) => n + 1)     // written first...
      const balance = yield* TxRef.get(from)
      if (balance < amount) return yield* Effect.fail("insufficient funds")   // ...discarded on failure
      yield* Effect.sleep("1 millis")                   // a pause, so concurrent transfers overlap
      yield* TxRef.set(from, balance - amount)
      yield* TxRef.update(to, (n) => n + amount)
    }))

  const report = (label: string) =>
    Effect.gen(function* () {
      const [a, b, t] = yield* Effect.all([TxRef.get(alice), TxRef.get(bob), TxRef.get(transfers)])
      console.log(label + ": alice " + a + ", bob " + b + ", transfers " + t)
    })

  yield* transfer(alice, bob, 30)
  yield* report("after 30")

  const outcome = yield* transfer(alice, bob, 500).pipe(Effect.result)
  yield* report("after 500 (" + outcome._tag + ")")

  // 70 concurrent transfers of 1. Conflicts retry; money is neither created nor lost.
  yield* Effect.forEach(Array.from({ length: 70 }), () => transfer(alice, bob, 1), {
    concurrency: "unbounded",
    discard: true
  })
  yield* report("after 70 x 1")
})

Effect.runPromise(program)
`,
      expectedOutput: `after 30: alice 70, bob 30, transfers 1
after 500 (Failure): alice 70, bob 30, transfers 1
after 70 x 1: alice 0, bob 100, transfers 71`,
      after: `The failed transfer incremented \`transfers\` and then failed, and the count stayed at 1: the write was rolled back with the rest of the transaction. Remove the \`Effect.tx\` wrapper and run again: with the pause inside, concurrent transfers read stale balances and the totals stop adding up to 100.`
    }
  ],
  challenges: [
    {
      id: "state-management-c1",
      title: "Read, pause, write",
      task: `Fifty fibers each do some work (the \`sleep\` stands in for it and must stay) and then count themselves. The counter ends at \`1\`. Fix the counting so it prints \`counted: 50\`.`,
      code: `import { Effect, Ref } from "effect"

const ids = Array.from({ length: 50 }, (_, i) => i)

const program = Effect.gen(function* () {
  const counter = yield* Ref.make(0)

  yield* Effect.forEach(ids, () =>
    Effect.gen(function* () {
      const current = yield* Ref.get(counter)
      yield* Effect.sleep("1 millis")          // the work
      yield* Ref.set(counter, current + 1)
    }), { concurrency: "unbounded", discard: true })

  console.log("counted:", yield* Ref.get(counter))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const ids = Array.from({ length: 50 }, (_, i) => i)

const program = Effect.gen(function* () {
  const counter = yield* Ref.make(0)

  yield* Effect.forEach(ids, () =>
    Effect.gen(function* () {
      yield* Effect.sleep("1 millis")          // the work
      yield* Ref.update(counter, (n) => n + 1)
    }), { concurrency: "unbounded", discard: true })

  console.log("counted:", yield* Ref.get(counter))
})

Effect.runPromise(program)
`,
      expectedOutput: `counted: 50`,
      hints: [
        "Between the get and the set, what do the other 49 fibers see?",
        "A Ref is only atomic if the read and the write are one operation. Lesson 2 has a table of those.",
        "Do the work first, then Ref.update(counter, (n) => n + 1)."
      ],
      explanation: `\`Ref.get\` then \`Ref.set\` is two operations with a pause between them, which is the exact shape of the lost-update bug from lesson 1, only with a Ref standing in for the \`let\`. A Ref does not make bad patterns safe; it makes the safe pattern available. \`Ref.update\` reads and writes in one atomic step, so fifty fibers produce fifty increments no matter how they interleave. The work moves outside the update, where it belongs.`
    },
    {
      id: "state-management-c2",
      title: "An update that waits",
      task: `The total should be built by adding each item's price, and the price comes from a lookup that takes time. The file does not compile: the update function returns an Effect where a plain number is expected. Fix it with the operation made for effectful updates. The program should print \`total: 6\`.`,
      code: `import { Effect, SynchronizedRef } from "effect"

const lookupPrice = (item: string) =>
  Effect.sleep("1 millis").pipe(Effect.as(item.length))

const program = Effect.gen(function* () {
  const total = yield* SynchronizedRef.make(0)

  yield* Effect.forEach(["ab", "cd", "ef"], (item) =>
    SynchronizedRef.update(total, (sum) => lookupPrice(item).pipe(Effect.map((price) => sum + price))),
    { concurrency: "unbounded", discard: true })

  console.log("total:", yield* SynchronizedRef.get(total))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, SynchronizedRef } from "effect"

const lookupPrice = (item: string) =>
  Effect.sleep("1 millis").pipe(Effect.as(item.length))

const program = Effect.gen(function* () {
  const total = yield* SynchronizedRef.make(0)

  yield* Effect.forEach(["ab", "cd", "ef"], (item) =>
    SynchronizedRef.updateEffect(total, (sum) => lookupPrice(item).pipe(Effect.map((price) => sum + price))),
    { concurrency: "unbounded", discard: true })

  console.log("total:", yield* SynchronizedRef.get(total))
})

Effect.runPromise(program)
`,
      expectedOutput: `total: 6`,
      hints: [
        "Read the type error: update wants a function that returns a number, and yours returns an Effect of a number.",
        "SynchronizedRef has a second family of operations for exactly this. Lesson 4 names it.",
        "Replace SynchronizedRef.update with SynchronizedRef.updateEffect."
      ],
      explanation: `\`update\` takes a pure function \`(A) => A\`. Returning an \`Effect<number>\` where a \`number\` is expected is a type error, and that error is the guard rail: a pure update cannot pause, so it cannot lose updates. \`updateEffect\` takes \`(A) => Effect<A>\` and runs the whole thing under the ref's lock, so the three lookups are serialized and each one adds to the real current sum. With a plain \`Ref\` the compiler would have pushed you toward get-then-set, and the bug from lesson 4.`
    },
    {
      id: "state-management-c3",
      title: "Off by one id",
      task: `\`nextId\` should hand out \`1\`, \`2\`, \`3\`, but it hands out \`0\`, \`1\`, \`2\`. The counter is stored correctly; what is returned is not. Fix \`modify\` so the program prints \`ids: 1 2 3\`.`,
      code: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const counter = yield* Ref.make(0)
  const nextId = Ref.modify(counter, (n) => [n, n + 1])

  const a = yield* nextId
  const b = yield* nextId
  const c = yield* nextId
  console.log("ids:", a, b, c)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const counter = yield* Ref.make(0)
  const nextId = Ref.modify(counter, (n) => [n + 1, n + 1])

  const a = yield* nextId
  const b = yield* nextId
  const c = yield* nextId
  console.log("ids:", a, b, c)
})

Effect.runPromise(program)
`,
      expectedOutput: `ids: 1 2 3`,
      hints: [
        "modify returns a pair. Which element is handed back to you, and which one is stored?",
        "Lesson 2: the first element is the result, the second is the new value. The result here is the old n.",
        "Return [n + 1, n + 1], or use Ref.updateAndGet(counter, (n) => n + 1)."
      ],
      explanation: `\`Ref.modify\` takes \`(current) => [result, newValue]\`. The code stored \`n + 1\` correctly but returned \`n\`, the value **before** the increment, which is what \`getAndUpdate\` does. Returning \`n + 1\` in both positions gives the value **after**, which is \`updateAndGet\`. Both are fine designs; the bug was mixing them. When the result and the stored value are the same, \`updateAndGet\` says so more clearly than \`modify\`.`
    },
    {
      id: "state-management-c4",
      title: "A fresh Ref every call",
      task: `The generator is supposed to produce increasing ids, but every call returns \`1\`. The Ref is created in the wrong place. Restructure \`makeIdGenerator\` so the program prints \`1 2 3\`.`,
      code: `import { Effect, Ref } from "effect"

const makeIdGenerator = Effect.succeed({
  next: Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    return yield* Ref.updateAndGet(counter, (n) => n + 1)
  })
})

const program = Effect.gen(function* () {
  const gen = yield* makeIdGenerator
  console.log(yield* gen.next, yield* gen.next, yield* gen.next)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const makeIdGenerator = Effect.gen(function* () {
  const counter = yield* Ref.make(0)
  return {
    next: Ref.updateAndGet(counter, (n) => n + 1)
  }
})

const program = Effect.gen(function* () {
  const gen = yield* makeIdGenerator
  console.log(yield* gen.next, yield* gen.next, yield* gen.next)
})

Effect.runPromise(program)
`,
      expectedOutput: `1 2 3`,
      hints: [
        "Ref.make is an Effect. Every time next runs, what does it run first?",
        "Lesson 3: create the Ref once in a factory Effect, and let next close over it.",
        "Make makeIdGenerator an Effect.gen that yields Ref.make(0) once and returns { next: Ref.updateAndGet(counter, ...) }."
      ],
      explanation: `\`Ref.make(0)\` is a description of "create a new Ref". It lives inside \`next\`, so every run of \`next\` creates a fresh Ref at zero, increments it to one, and throws it away. Moving \`Ref.make\` into the factory means it runs once, when \`makeIdGenerator\` is run, and \`next\` closes over that single Ref. The rule from lesson 3: where you \`yield*\` the \`Ref.make\` is where the state's lifetime begins.`
    },
    {
      id: "state-management-c5",
      title: "The observer that arrives late",
      task: `The observer should print every progress value, \`0\` through \`3\`, but it only prints the last one. The observer attaches after the writes happen. Add the handshake so the program prints all four lines and then \`finished\`.`,
      code: `import { Effect, Fiber, Stream, SubscriptionRef } from "effect"

const program = Effect.gen(function* () {
  const progress = yield* SubscriptionRef.make(0)

  const observer = yield* SubscriptionRef.changes(progress).pipe(
    Stream.tap((n) => Effect.sync(() => console.log("progress:", n))),
    Stream.takeUntil((n) => n === 3),
    Stream.runDrain,
    Effect.forkChild
  )

  yield* SubscriptionRef.set(progress, 1)
  yield* SubscriptionRef.set(progress, 2)
  yield* SubscriptionRef.set(progress, 3)

  yield* Fiber.join(observer)
  console.log("finished")
})

Effect.runPromise(program)
`,
      solution: `import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect"

const program = Effect.gen(function* () {
  const progress = yield* SubscriptionRef.make(0)
  const subscribed = yield* Deferred.make<void>()

  const observer = yield* SubscriptionRef.changes(progress).pipe(
    Stream.tap((n) => Effect.sync(() => console.log("progress:", n))),
    Stream.tap(() => Deferred.succeed(subscribed, void 0)),
    Stream.takeUntil((n) => n === 3),
    Stream.runDrain,
    Effect.forkChild
  )

  yield* Deferred.await(subscribed)
  yield* SubscriptionRef.set(progress, 1)
  yield* SubscriptionRef.set(progress, 2)
  yield* SubscriptionRef.set(progress, 3)

  yield* Fiber.join(observer)
  console.log("finished")
})

Effect.runPromise(program)
`,
      expectedOutput: `progress: 0
progress: 1
progress: 2
progress: 3
finished`,
      hints: [
        "forkChild returns before the child has started. When does the stream actually subscribe?",
        "Lesson 5 uses a Deferred: the observer completes it on its first value, the writer awaits it before writing.",
        "Add a Deferred.make<void>(), a Stream.tap(() => Deferred.succeed(subscribed, void 0)) in the observer, and yield* Deferred.await(subscribed) before the first set."
      ],
      explanation: `A forked fiber is scheduled, not started. The parent keeps going, performs all three writes synchronously, and only then does the observer's stream subscribe, at which point the current value is already \`3\`. \`changes\` emits the current value on subscription but never replays the past. The \`Deferred\` turns "I am subscribed" into a signal the writer can wait for. This is the general rule for any producer and consumer on separate fibers: do not assume the consumer is ready until it has told you.`
    },
    {
      id: "state-management-c6",
      title: "Money out of thin air",
      task: `Fifty concurrent transfers of 1 should move 50 from alice to bob and leave the total at 100. Instead the total grows. The transfer reads and writes the refs as separate steps. Make it one atomic change so the program prints \`alice 50, bob 50, total 100\`.`,
      code: `import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const alice = yield* TxRef.make(100)
  const bob = yield* TxRef.make(0)

  const transfer = Effect.gen(function* () {
    const balance = yield* TxRef.get(alice)
    yield* Effect.sleep("1 millis")
    yield* TxRef.set(alice, balance - 1)
    yield* TxRef.update(bob, (n) => n + 1)
  })

  yield* Effect.forEach(Array.from({ length: 50 }), () => transfer, { concurrency: "unbounded", discard: true })

  const [a, b] = yield* Effect.all([TxRef.get(alice), TxRef.get(bob)])
  console.log("alice " + a + ", bob " + b + ", total " + (a + b))
})

Effect.runPromise(program)
`,
      solution: `import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const alice = yield* TxRef.make(100)
  const bob = yield* TxRef.make(0)

  const transfer = Effect.tx(Effect.gen(function* () {
    const balance = yield* TxRef.get(alice)
    yield* Effect.sleep("1 millis")
    yield* TxRef.set(alice, balance - 1)
    yield* TxRef.update(bob, (n) => n + 1)
  }))

  yield* Effect.forEach(Array.from({ length: 50 }), () => transfer, { concurrency: "unbounded", discard: true })

  const [a, b] = yield* Effect.all([TxRef.get(alice), TxRef.get(bob)])
  console.log("alice " + a + ", bob " + b + ", total " + (a + b))
})

Effect.runPromise(program)
`,
      expectedOutput: `alice 50, bob 50, total 100`,
      hints: [
        "A TxRef operation on its own is a one-step transaction. What groups several steps into one?",
        "Lesson 6 wraps the whole transfer body in a single call.",
        "Wrap the Effect.gen in Effect.tx(...)."
      ],
      explanation: `Without \`Effect.tx\`, each \`TxRef\` call is its own tiny transaction. Fifty fibers read \`100\`, pause, and each writes \`99\`, while each credits bob by one: the debit is lost, the credit is not, and money appears. Inside \`Effect.tx\` the read is recorded in a journal; when a transfer tries to commit after another one changed \`alice\`, the conflict is detected and the transaction restarts with a fresh read. Every transfer eventually commits against the true balance, so the total is conserved. \`Ref\` could not express this at all, because atomicity across two Refs is exactly what \`Ref\` lacks.`
    }
  ],
  problems: [
    {
      id: "state-management-p1",
      title: "Inventory reservations",
      spec: `
Build a tiny inventory on top of a \`Ref<Record<string, number>>\` starting at \`{ apple: 3, pear: 2 }\`.

- \`reserve(item, qty)\` uses \`Ref.modify\` to check and update in one atomic step. If enough stock exists, subtract \`qty\` and return \`"ok"\`; otherwise leave the stock unchanged and return \`"out of stock"\`.
- Process the requests \`[["apple", 2], ["pear", 1], ["apple", 2], ["apple", 1]]\` in order and print one line per request, then the final stock.

Exact output:

\`\`\`
reserve apple x2: ok
reserve pear x1: ok
reserve apple x2: out of stock
reserve apple x1: ok
stock: apple=0 pear=1
\`\`\`
`,
      starter: `import { Effect, Ref } from "effect"

const requests: Array<[string, number]> = [["apple", 2], ["pear", 1], ["apple", 2], ["apple", 1]]

const program = Effect.gen(function* () {
  const stock = yield* Ref.make<Record<string, number>>({ apple: 3, pear: 2 })

  // TODO: reserve(item, qty) with Ref.modify: returns "ok" or "out of stock"

  // TODO: loop over requests, print "reserve <item> x<qty>: <result>"

  // TODO: print "stock: apple=<n> pear=<n>"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Ref } from "effect"

const requests: Array<[string, number]> = [["apple", 2], ["pear", 1], ["apple", 2], ["apple", 1]]

const program = Effect.gen(function* () {
  const stock = yield* Ref.make<Record<string, number>>({ apple: 3, pear: 2 })

  const reserve = (item: string, qty: number) =>
    Ref.modify(stock, (s) => {
      const have = s[item] ?? 0
      return have >= qty
        ? ["ok", { ...s, [item]: have - qty }]
        : ["out of stock", s]
    })

  for (const [item, qty] of requests) {
    const result = yield* reserve(item, qty)
    console.log("reserve " + item + " x" + qty + ": " + result)
  }

  const final = yield* Ref.get(stock)
  console.log("stock: apple=" + final.apple + " pear=" + final.pear)
})

Effect.runPromise(program)
`,
      expectedOutput: `reserve apple x2: ok
reserve pear x1: ok
reserve apple x2: out of stock
reserve apple x1: ok
stock: apple=0 pear=1`,
      hints: [
        "Ref.modify(stock, (s) => [result, newStock]) lets you decide and update in one step (lesson 2).",
        "Return [\"ok\", { ...s, [item]: have - qty }] when there is enough, and [\"out of stock\", s] otherwise.",
        "A plain for...of loop with yield* inside the generator is fine for sequential requests."
      ]
    },
    {
      id: "state-management-p2",
      title: "Progress reporter",
      spec: `
Process three files and report progress through a \`SubscriptionRef<number>\`.

- \`processFile(name)\` is given: it sleeps briefly and returns.
- Start an observer with \`SubscriptionRef.changes\` that prints \`progress: <n>/3\` for every value, including the initial \`0\`, and stops after \`3\`. Fork it, and use a \`Deferred\` handshake so no update is missed.
- Process the files in order with \`Effect.forEach\`, incrementing the ref after each one.
- Join the observer, then print \`all files processed\`.

Exact output:

\`\`\`
progress: 0/3
progress: 1/3
progress: 2/3
progress: 3/3
all files processed
\`\`\`
`,
      starter: `import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect"

const files = ["a.txt", "b.txt", "c.txt"]
const processFile = (name: string) => Effect.sleep("1 millis")

const program = Effect.gen(function* () {
  const progress = yield* SubscriptionRef.make(0)

  // TODO: Deferred handshake + forked observer printing "progress: <n>/3", stopping at 3

  // TODO: await the handshake, then process the files, incrementing progress after each

  // TODO: join the observer and print "all files processed"
})

Effect.runPromise(program)
`,
      solution: `import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect"

const files = ["a.txt", "b.txt", "c.txt"]
const processFile = (name: string) => Effect.sleep("1 millis")

const program = Effect.gen(function* () {
  const progress = yield* SubscriptionRef.make(0)
  const subscribed = yield* Deferred.make<void>()

  const observer = yield* SubscriptionRef.changes(progress).pipe(
    Stream.tap((n) => Effect.sync(() => console.log("progress: " + n + "/" + files.length))),
    Stream.tap(() => Deferred.succeed(subscribed, void 0)),
    Stream.takeUntil((n) => n === files.length),
    Stream.runDrain,
    Effect.forkChild
  )

  yield* Deferred.await(subscribed)
  yield* Effect.forEach(files, (name) =>
    processFile(name).pipe(Effect.andThen(SubscriptionRef.update(progress, (n) => n + 1))))

  yield* Fiber.join(observer)
  console.log("all files processed")
})

Effect.runPromise(program)
`,
      expectedOutput: `progress: 0/3
progress: 1/3
progress: 2/3
progress: 3/3
all files processed`,
      hints: [
        "Copy the observer shape from lesson 5: changes, tap to print, tap to complete the Deferred, takeUntil, runDrain, forkChild.",
        "Effect.forEach(files, (name) => processFile(name).pipe(Effect.andThen(SubscriptionRef.update(progress, n => n + 1)))) processes in order.",
        "Deferred.await(subscribed) must come before the forEach, and Fiber.join(observer) before the final log."
      ]
    },
    {
      id: "state-management-p3",
      title: "Bank ledger",
      spec: `
Model three accounts as \`TxRef<number>\` values: Ada \`100\`, Lin \`50\`, Sam \`0\`.

- \`transfer(from, to, amount)\` is one \`Effect.tx\` transaction. It fails with the string \`"insufficient funds"\` if \`from\` has less than \`amount\`, otherwise debits and credits. Put an \`Effect.sleep("1 millis")\` between the read and the writes so concurrent transfers overlap.
- Run \`Ada -> Lin 30\` and \`Lin -> Sam 100\` one after another, printing \`ok\` or the error message for each using \`Effect.result\`.
- Then run 20 concurrent \`Ada -> Sam 1\` transfers with \`Effect.forEach\` and \`concurrency: "unbounded"\`, and print \`done\`.
- Finally print the balances and their total.

Exact output:

\`\`\`
Ada -> Lin 30: ok
Lin -> Sam 100: insufficient funds
Ada -> Sam 1 x 20: done
Ada=50 Lin=80 Sam=20 total=150
\`\`\`
`,
      starter: `import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const ada = yield* TxRef.make(100)
  const lin = yield* TxRef.make(50)
  const sam = yield* TxRef.make(0)

  // TODO: transfer(from, to, amount): Effect.tx, fail with "insufficient funds", sleep 1 ms between read and writes

  // TODO: Ada -> Lin 30, Lin -> Sam 100, printing "ok" or the error

  // TODO: 20 concurrent Ada -> Sam 1, then print "Ada -> Sam 1 x 20: done"

  // TODO: print "Ada=<n> Lin=<n> Sam=<n> total=<n>"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, TxRef } from "effect"

const program = Effect.gen(function* () {
  const ada = yield* TxRef.make(100)
  const lin = yield* TxRef.make(50)
  const sam = yield* TxRef.make(0)

  const transfer = (from: TxRef.TxRef<number>, to: TxRef.TxRef<number>, amount: number) =>
    Effect.tx(Effect.gen(function* () {
      const balance = yield* TxRef.get(from)
      if (balance < amount) return yield* Effect.fail("insufficient funds")
      yield* Effect.sleep("1 millis")
      yield* TxRef.set(from, balance - amount)
      yield* TxRef.update(to, (n) => n + amount)
    }))

  const attempt = (label: string, tx: Effect.Effect<void, string>) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(tx)
      console.log(label + ": " + (outcome._tag === "Success" ? "ok" : outcome.failure))
    })

  yield* attempt("Ada -> Lin 30", transfer(ada, lin, 30))
  yield* attempt("Lin -> Sam 100", transfer(lin, sam, 100))

  yield* Effect.forEach(Array.from({ length: 20 }), () => transfer(ada, sam, 1), {
    concurrency: "unbounded",
    discard: true
  })
  console.log("Ada -> Sam 1 x 20: done")

  const [a, l, s] = yield* Effect.all([TxRef.get(ada), TxRef.get(lin), TxRef.get(sam)])
  console.log("Ada=" + a + " Lin=" + l + " Sam=" + s + " total=" + (a + l + s))
})

Effect.runPromise(program)
`,
      expectedOutput: `Ada -> Lin 30: ok
Lin -> Sam 100: insufficient funds
Ada -> Sam 1 x 20: done
Ada=50 Lin=80 Sam=20 total=150`,
      hints: [
        "The transfer body is lesson 6's: get, check, sleep, set, update, all inside Effect.tx.",
        "Effect.result(tx) gives a Result; outcome._tag === \"Success\" means ok, otherwise outcome.failure is the message.",
        "Effect.all([TxRef.get(ada), TxRef.get(lin), TxRef.get(sam)]) reads all three balances at the end."
      ]
    }
  ],
  recall: [
    {
      q: "Why does a `let` shared across fibers lose updates, and why does `Ref.update` not?",
      a: "With `let`, read and write are separate steps; any pause between them lets other fibers read the same stale value. `Ref.update(ref, f)` applies `f` and stores the result as one atomic operation, and `f` is a pure function, so there is no pause for anyone to slip into."
    },
    {
      q: "What would the type of `Ref.modify(ref, (n) => [n > 0, n - 1])` be, for `ref: Ref<number>`?",
      a: "`Effect<boolean>`. `modify` takes `(A) => [B, A]`, returns the `B` (here the boolean), and stores the `A` (here `n - 1`)."
    },
    {
      q: "Which container would you reach for when the new value comes from an HTTP call?",
      a: "`SynchronizedRef` with `updateEffect` or `modifyEffect`. The update function returns an Effect, and the read-effect-write runs under a lock so concurrent updates are serialized instead of lost. A plain `Ref` cannot run an Effect inside `update`."
    },
    {
      q: "What does `SubscriptionRef.changes(ref)` emit first, and what does it never emit?",
      a: "It emits the current value first, then every new value as it is set. It never replays values set before the stream subscribed, which is why a forked observer needs a handshake (a `Deferred`) before the writer starts."
    },
    {
      q: "What does `Effect.tx` add on top of individual `TxRef` operations?",
      a: "Grouping. Each `TxRef.get`/`set`/`update` on its own is a one-step transaction. `Effect.tx(body)` records every read and write in the body in a journal and commits them together: a failure discards all of them, and a conflicting commit by another transaction restarts this one with fresh reads."
    },
    {
      q: "Where should `Ref.make` be called so that a service's state lives as long as the service?",
      a: "Once, in the factory Effect that builds the service, before returning the functions that use it. If `Ref.make` sits inside one of those functions, every call creates a fresh Ref and the state resets each time."
    }
  ]
}

export default section
