import type { Section } from "../types.ts"

const section: Section = {
  id: "state-management",
  title: "State Management",
  order: 9,
  summary: "Ref, SynchronizedRef, SubscriptionRef, and TxRef: shared state with atomic updates instead of mutable variables.",
  intro: `
**The problem.** A shared variable and concurrency do not work together. The error hides behind any \`await\`:

\`\`\`ts
let count = 0
await Promise.all(items.map(async () => {
  const current = count
  await saveToDb()       // any pause here...
  count = current + 1    // ...and every task writes the same stale value
}))
console.log(count)       // 1, not 100
\`\`\`

Each task read \`0\`, paused, and wrote \`1\`. The program lost 99 updates. It threw no error, and the code looks correct. Later you want to react when the count changes. You add an \`EventEmitter\`. Now you have a second system, with listeners that can leak and with its own order problems.

### The shift

Today you think of state as a variable that you change. You think of change notification as an emitter that you add next to the variable. In Effect, state is a value inside a container. Each operation on the container is an effect. You do not write \`count = count + 1\`. You describe an update, \`Ref.update(count, (n) => n + 1)\`, and Effect applies that update as 1 atomic step. Atomic means that no other fiber can act between the read and the write. A pure function has no pause, so nothing can separate the read from the write.

Reads and updates are effects, so they combine with all the tools from the earlier sections. You can run them concurrently, retry them, interrupt them, and give them the lifetime of a service. Some cases need more: the update is an effect, something must react to each change, or several values must change together. Each case has its own container.

| Container | The update is... | Use it when |
|---|---|---|
| \`let\` | Read, pause, write | Never for state that fibers share |
| \`Ref\` | A pure function, applied as 1 atomic step | A counter, a cache, a list of recorded calls |
| \`SynchronizedRef\` | An effect, run under a lock | The new value comes from a fetch or from a computation that can fail |
| \`SubscriptionRef\` | The same as \`Ref\`, plus a stream of changes | Something must react to each change: a status, a progress value, a config |
| \`TxRef\` + \`Effect.tx\` | Several refs change together, or not at all | Money, inventory, any 2 values that must stay consistent |

This section starts with the lost update error. It corrects the error with \`Ref\`. Then it goes through the table, 1 row at a time.
`,
  lessons: [
    {
      id: "state-management-l1",
      title: "Lost updates, then Ref",
      explain: `
The program below first runs the error from the intro inside Effect. Fibers have the same problem as Promises. 100 fibers each read a plain \`let\`, pause for 1 millisecond, and write the value back. All of them read \`0\`, so the final value is \`1\`.

Then the program does the same work with a \`Ref\`. \`Ref.make(0)\` makes the container. It is an effect, so you \`yield*\` it. \`Ref.update(ref, f)\` applies \`f\` to the current value and stores the result as 1 atomic step. No other fiber can act between the read and the write, because from the outside there is only 1 operation.

\`Ref.get\` reads the current value. Like each operation here, it is an effect until you run it.
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
      after: `Note: the Ref version has no \`sleep\`. That is intentional. \`update\` accepts a plain function, so there is no place for a pause between the read and the write. That limit is the guarantee. Lesson 4 shows what to do when the update itself must wait.`
    },
    {
      id: "state-management-l2",
      title: "The Ref operations",
      explain: `
\`Ref\` has a small set of operations. They differ only in the value that they return.

| Operation | Does | Returns |
|---|---|---|
| \`Ref.get(ref)\` | Reads | The current value |
| \`Ref.set(ref, a)\` | Replaces | \`void\` |
| \`Ref.update(ref, f)\` | Applies \`f\` | \`void\` |
| \`Ref.updateAndGet(ref, f)\` | Applies \`f\` | The **new** value |
| \`Ref.getAndUpdate(ref, f)\` | Applies \`f\` | The **old** value |
| \`Ref.modify(ref, f)\` | \`f\` returns \`[result, newValue]\` | The \`result\` |

\`modify\` is the general operation. In 1 atomic step, you compute a value to return and a value to store. "Take 1 item from the stock and tell me if it worked" is a \`modify\`. If you write it as \`get\`, a check, and \`set\`, 2 fibers can both see 1 item and both take it.
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
      after: `The program defines \`take\` 1 time and runs it 3 times. Each run reads the current stock again. Change the pair in \`modify\` to \`[n - 1, true]\`: the compiler rejects it. The second element must have the stored type, \`number\`.`
    },
    {
      id: "state-management-l3",
      title: "State that belongs to a service",
      explain: `
In plain TypeScript, private state lives in a class:

\`\`\`ts
class IdGenerator {
  private counter = 0
  next() { return "order-" + ++this.counter }
}
\`\`\`

The Effect form is a factory. A factory is an effect that makes a \`Ref\` and returns functions that use it. Each run of the factory gives a new instance. If you run it 2 times, you get 2 independent counters. Each stateful service in the later sections uses this pattern.

The same pattern makes tests exact. A fake mailer records each call in a \`Ref<Array<string>>\`. A test can then check "exactly 2 emails, to these addresses" without a mock library. The record is a \`Ref\`, so it is safe when the code under test sends emails concurrently.
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
      after: `\`orders.next\` is 1 effect value. The program runs it 2 times and gets 2 different ids, because the Ref changed between the runs. Move \`Ref.make(0)\` inside \`next\`: each call then starts from a new zero. The place where you make the Ref decides how long the state lives.`
    },
    {
      id: "state-management-l4",
      title: "SynchronizedRef: when the update is an effect",
      explain: `
\`Ref.update\` accepts a pure function. What if the new value comes from an effect, for example a price lookup or a call that can fail? You cannot \`yield*\` inside \`update\`. A common workaround is \`get\`, then run the effect, then \`set\`. That is 3 steps again. The lost update error returns as soon as the middle step pauses.

\`SynchronizedRef\` exists for this case. \`SynchronizedRef.updateEffect(ref, f)\` accepts a function that returns an effect. It runs the full sequence, read, effect, write, under a lock. A lock permits 1 fiber at a time; the other fibers wait. \`modifyEffect\` is the \`modify\` version. The pure operations \`get\`, \`set\`, \`update\`, and \`modify\` also exist.

Note: the updates run 1 at a time. That is the intent. An effectful update that can interleave is an update that can be lost.
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
      after: `The second half takes more time than the first half. 100 lookups of 1 ms now run 1 after the other, not all at the same time. That is the cost of a correct result. If the lookup fails, \`updateEffect\` fails with that error, and the stored value does not change.`
    },
    {
      id: "state-management-l5",
      title: "SubscriptionRef: state that you can watch",
      explain: `
Some state is not only read; something must **watch** it. Examples: a job status, an upload progress value, a config value that reloads. \`SubscriptionRef\` is a \`Ref\` with 1 more operation, \`SubscriptionRef.changes(ref)\`. This returns a \`Stream\`. The stream first emits the current value, and then each new value when it is set.

An observer is a stream pipeline:

- \`Stream.tap\` reacts to each value.
- \`Stream.takeUntil\` decides when to stop.
- \`Stream.runDrain\` runs the stream to the end.

Fork the observer with \`Effect.forkChild\`, so that it runs next to the writer. Join it with \`Fiber.join\` at the end.

Note: a stream subscribes when it starts to run, and a forked fiber does not start before the parent continues. The stream does not replay writes that happened before the subscription. The \`Deferred\` in the program is a signal that completes 1 time. The observer completes it on its first value. The writer waits for it before the first write. Without this signal, the observer sees only the last value.
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
      after: `The program printed "idle", but no write set that value. \`changes\` starts with the current value, so a late observer still gets the present state. Remove the \`Deferred.await\` line and run the program again: the observer subscribes after the 3 writes and prints only "done".`
    },
    {
      id: "state-management-l6",
      title: "TxRef and Effect.tx: several values, 1 change",
      explain: `
A bank transfer changes 2 balances. If the debit is stored and the credit is not, the money is lost. \`Ref\` cannot prevent this. Each Ref is atomic by itself, but 2 Refs together are not.

\`TxRef\` is a transactional ref. Its operations look like the \`Ref\` operations, with 1 difference. Inside \`Effect.tx(...)\`, Effect records each read and write in a journal. It stores the writes only when the body completes. If the body fails, Effect stores nothing, not even the writes that happened earlier in the body. If another transaction changes one of the same values first, this transaction starts again with new reads. For this reason, the program can run 70 transfers concurrently, each with a pause inside, and lose nothing.

A single \`TxRef.get\` or \`TxRef.set\` outside \`Effect.tx\` is a small transaction by itself. \`Effect.tx\` puts several operations into 1 transaction.
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
      after: `The failed transfer increased \`transfers\` and then failed. The count stayed at 1: Effect discarded that write together with the rest of the transaction. Remove the \`Effect.tx\` call and run the program again. With the pause inside, concurrent transfers read old balances, and the sum is no longer 100.`
    }
  ],
  dosAndDonts: [
    {
      do: "Keep state that fibers share in a \`Ref\`.",
      dont: "Do not share a \`let\` variable between fibers.",
      why: "A pause between the read and the write lets other fibers write old values, and updates are lost."
    },
    {
      do: "Use \`Ref.update\` or \`Ref.modify\` for a change that depends on the current value.",
      dont: "Do not call \`Ref.get\`, compute a new value, and then call \`Ref.set\`.",
      why: "The read and the write are 2 steps, so 2 fibers can read the same value and 1 update is lost."
    },
    {
      do: "Return \`[result, newValue]\` from \`Ref.modify\`, in that order.",
      dont: "Do not return \`[newValue, result]\`.",
      why: "The first element goes to the caller and the second element is stored, so a swap stores the wrong value or does not compile."
    },
    {
      do: "Call \`Ref.make\` 1 time, in the factory effect that builds the service.",
      dont: "Do not call \`Ref.make\` inside the function that uses the ref.",
      why: "Each call then makes a new ref with the initial value, and the state resets on each call."
    },
    {
      do: "Use \`SynchronizedRef.updateEffect\` when the new value comes from an effect.",
      dont: "Do not use \`Ref.get\`, then an effect, then \`Ref.set\` for an effectful update.",
      why: "The effect between the read and the write pauses, and concurrent updates are lost."
    },
    {
      do: "Wait for a \`Deferred\` signal from the observer before you write to a \`SubscriptionRef\`.",
      dont: "Do not write directly after \`Effect.forkChild\` of the observer.",
      why: "The forked fiber has not subscribed yet, and \`changes\` does not replay earlier values, so the observer misses them."
    },
    {
      do: "Wrap several \`TxRef\` operations in 1 \`Effect.tx\` call.",
      dont: "Do not run \`TxRef.get\` and \`TxRef.set\` on 2 refs as separate calls.",
      why: "Each call is its own transaction, so a pause between them lets another transfer read old balances, and the totals become wrong."
    }
  ],
  challenges: [
    {
      id: "state-management-c1",
      title: "Read, pause, write",
      task: `50 fibers each do some work and then add 1 to a counter. The \`sleep\` represents the work and must stay. The counter ends at \`1\`. Change the counter update so that the program prints \`counted: 50\`.`,
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
        "What do the other 49 fibers see between the get and the set?",
        "A Ref is only atomic when the read and the write are 1 operation. Lesson 2 has a table of those operations.",
        "Do the work first, then call Ref.update(counter, (n) => n + 1)."
      ],
      explanation: `\`Ref.get\` and then \`Ref.set\` are 2 operations with a pause between them. That is the exact form of the lost update error from lesson 1, with a Ref in place of the \`let\`. A Ref does not make a bad pattern safe. It makes the safe pattern available. \`Ref.update\` reads and writes in 1 atomic step, so 50 fibers make 50 increments in any order. The work moves before the update, where it belongs.`
    },
    {
      id: "state-management-c2",
      title: "An update that waits",
      task: `The program must add the price of each item to the total. The price comes from a lookup that takes time. The file does not compile: the update function returns an effect, but the operation expects a plain number. Use the operation that is made for effectful updates. The program must print \`total: 6\`.`,
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
        "Read the type error. update expects a function that returns a number. Your function returns an effect of a number.",
        "SynchronizedRef has a second set of operations for this case. Lesson 4 names it.",
        "Replace SynchronizedRef.update with SynchronizedRef.updateEffect."
      ],
      explanation: `\`update\` accepts a pure function \`(A) => A\`. Your function returns an \`Effect<number>\` where a \`number\` is expected. That is a type error, and the error protects you: a pure update cannot pause, so it cannot lose updates. \`updateEffect\` accepts \`(A) => Effect<A>\` and runs the full sequence under the lock of the ref. The 3 lookups run 1 after the other, and each one adds to the real current sum. With a plain \`Ref\`, the compiler pushes you to get-then-set, and to the error from lesson 4.`
    },
    {
      id: "state-management-c3",
      title: "Off by 1 id",
      task: `\`nextId\` must give \`1\`, \`2\`, \`3\`. It gives \`0\`, \`1\`, \`2\`. The stored counter is correct; the returned value is not. Change the \`modify\` call so that the program prints \`ids: 1 2 3\`.`,
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
        "modify returns a pair. Which element does the caller get, and which element is stored?",
        "Lesson 2: the first element is the result, the second element is the new value. The result here is the old n.",
        "Return [n + 1, n + 1], or use Ref.updateAndGet(counter, (n) => n + 1)."
      ],
      explanation: `\`Ref.modify\` accepts \`(current) => [result, newValue]\`. The code stored \`n + 1\` correctly, but it returned \`n\`, the value **before** the increment. That is what \`getAndUpdate\` does. When you return \`n + 1\` in both positions, the caller gets the value **after** the increment. That is what \`updateAndGet\` does. Both designs are valid; the error was the mix. When the result and the stored value are the same, \`updateAndGet\` says it more clearly than \`modify\`.`
    },
    {
      id: "state-management-c4",
      title: "A new Ref on each call",
      task: `The generator must give ids that increase, but each call returns \`1\`. The program makes the Ref in the wrong place. Change the structure of \`makeIdGenerator\` so that the program prints \`1 2 3\`.`,
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
        "Ref.make is an effect. What does next run first on each call?",
        "Lesson 3: make the Ref 1 time in a factory effect, and let next use that Ref.",
        "Make makeIdGenerator an Effect.gen that yields Ref.make(0) 1 time and returns { next: Ref.updateAndGet(counter, ...) }."
      ],
      explanation: `\`Ref.make(0)\` is a description of "make a new Ref". It is inside \`next\`, so each run of \`next\` makes a new Ref at zero, increases it to 1, and discards it. When you move \`Ref.make\` into the factory, it runs 1 time, when the program runs \`makeIdGenerator\`. \`next\` then uses that single Ref. The rule from lesson 3: the place where you \`yield*\` the \`Ref.make\` is the place where the lifetime of the state starts.`
    },
    {
      id: "state-management-c5",
      title: "The observer that starts too late",
      task: `The observer must print each progress value from \`0\` to \`3\`. It prints only the last value, because it subscribes after the writes. Add the signal from lesson 5 so that the program prints all 4 lines and then \`finished\`.`,
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
        "forkChild returns before the child fiber starts. When does the stream subscribe?",
        "Lesson 5 uses a Deferred. The observer completes it on its first value. The writer waits for it before the first write.",
        "Add Deferred.make<void>(), add Stream.tap(() => Deferred.succeed(subscribed, void 0)) to the observer, and put yield* Deferred.await(subscribed) before the first set."
      ],
      explanation: `Effect schedules a forked fiber; it does not start it at once. The parent continues, does the 3 writes without a pause, and only then does the stream of the observer subscribe. At that moment the current value is \`3\`. \`changes\` emits the current value on subscription, but it never replays earlier values. The \`Deferred\` changes "I am subscribed" into a signal that the writer can wait for. This is the general rule for a producer and a consumer on separate fibers. Do not assume that the consumer is ready before it tells you.`
    },
    {
      id: "state-management-c6",
      title: "Money that appears from nothing",
      task: `50 concurrent transfers of 1 must move 50 from alice to bob. The total must stay at 100. Instead, the total increases. The transfer reads and writes the refs as separate steps. Make the transfer 1 atomic change so that the program prints \`alice 50, bob 50, total 100\`.`,
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
        "A TxRef operation by itself is a transaction with 1 step. Which function puts several steps into 1 transaction?",
        "Lesson 6 wraps the full transfer body in 1 call.",
        "Wrap the Effect.gen in Effect.tx(...)."
      ],
      explanation: `Without \`Effect.tx\`, each \`TxRef\` call is a small transaction by itself. 50 fibers read \`100\`, pause, and each one writes \`99\`. Each one also adds 1 to bob. The debit is lost, the credit is not, and money appears. Inside \`Effect.tx\`, Effect records the read in a journal. A transfer can try to store its writes after another transfer changed \`alice\`. Effect then detects the conflict and starts the transaction again with a new read. Each transfer stores its writes against the true balance in the end, so the total does not change. \`Ref\` cannot express this, because \`Ref\` has no atomic operation across 2 refs.`
    }
  ],
  problems: [
    {
      id: "state-management-p1",
      title: "Inventory reservations",
      spec: `
Build a small inventory on top of a \`Ref<Record<string, number>>\` that starts at \`{ apple: 3, pear: 2 }\`.

- \`reserve(item, qty)\` uses \`Ref.modify\` to check and update in 1 atomic step. If the stock is sufficient, subtract \`qty\` and return \`"ok"\`. If not, keep the stock unchanged and return \`"out of stock"\`.
- Process the requests \`[["apple", 2], ["pear", 1], ["apple", 2], ["apple", 1]]\` in order. Print 1 line per request, then the final stock.

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
        "Ref.modify(stock, (s) => [result, newStock]) lets you decide and update in 1 step (lesson 2).",
        "Return [\"ok\", { ...s, [item]: have - qty }] when the stock is sufficient, and [\"out of stock\", s] when it is not.",
        "A plain for...of loop with yield* inside the generator is correct for sequential requests."
      ]
    },
    {
      id: "state-management-p2",
      title: "Progress reporter",
      spec: `
Process 3 files and report the progress through a \`SubscriptionRef<number>\`.

- \`processFile(name)\` is given. It sleeps for a short time and returns.
- Start an observer with \`SubscriptionRef.changes\`. It prints \`progress: <n>/3\` for each value, with the initial \`0\` included, and stops after \`3\`. Fork it. Use a \`Deferred\` signal so that the observer misses no update.
- Process the files in order with \`Effect.forEach\`. Add 1 to the ref after each file.
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
        "Copy the observer form from lesson 5: changes, tap to print, tap to complete the Deferred, takeUntil, runDrain, forkChild.",
        "Effect.forEach(files, (name) => processFile(name).pipe(Effect.andThen(SubscriptionRef.update(progress, n => n + 1)))) processes the files in order.",
        "Put Deferred.await(subscribed) before the forEach, and Fiber.join(observer) before the final log."
      ]
    },
    {
      id: "state-management-p3",
      title: "Bank ledger",
      spec: `
Model 3 accounts as \`TxRef<number>\` values: Ada \`100\`, Lin \`50\`, Sam \`0\`.

- \`transfer(from, to, amount)\` is 1 \`Effect.tx\` transaction. It fails with the string \`"insufficient funds"\` if \`from\` holds less than \`amount\`. If not, it debits \`from\` and credits \`to\`. Put an \`Effect.sleep("1 millis")\` between the read and the writes, so that concurrent transfers overlap.
- Run \`Ada -> Lin 30\` and then \`Lin -> Sam 100\`. Print \`ok\` or the error message for each one. Use \`Effect.result\`.
- Then run 20 concurrent \`Ada -> Sam 1\` transfers with \`Effect.forEach\` and \`concurrency: "unbounded"\`. Print \`done\`.
- At the end, print the balances and their total.

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
        "The transfer body is the one from lesson 6: get, check, sleep, set, update, all inside Effect.tx.",
        "Effect.result(tx) gives a Result. outcome._tag === \"Success\" means ok. In the other case, outcome.failure is the message.",
        "Effect.all([TxRef.get(ada), TxRef.get(lin), TxRef.get(sam)]) reads all 3 balances at the end."
      ]
    }
  ],
  recall: [
    {
      q: "Why does a `let` that fibers share lose updates, and why does `Ref.update` not?",
      a: "With `let`, the read and the write are separate steps. A pause between them lets other fibers read the same old value. `Ref.update(ref, f)` applies `f` and stores the result as 1 atomic operation. `f` is a pure function, so there is no pause where another fiber can act."
    },
    {
      q: "What is the type of `Ref.modify(ref, (n) => [n > 0, n - 1])`, for `ref: Ref<number>`?",
      a: "`Effect<boolean>`. `modify` accepts `(A) => [B, A]`. It returns the `B` (here the boolean) and stores the `A` (here `n - 1`)."
    },
    {
      q: "Which container do you use when the new value comes from an HTTP call?",
      a: "`SynchronizedRef` with `updateEffect` or `modifyEffect`. The update function returns an effect. The read, the effect, and the write run under a lock, so concurrent updates run 1 at a time and are not lost. A plain `Ref` cannot run an effect inside `update`."
    },
    {
      q: "What does `SubscriptionRef.changes(ref)` emit first, and what does it never emit?",
      a: "It emits the current value first, then each new value when it is set. It never replays values that were set before the stream subscribed. That is why a forked observer needs a signal (a `Deferred`) before the writer starts."
    },
    {
      q: "What does `Effect.tx` add on top of the single `TxRef` operations?",
      a: "It puts them into 1 transaction. Each `TxRef.get`, `set`, or `update` by itself is a transaction with 1 step. `Effect.tx(body)` records each read and write in the body in a journal and stores them together. A failure discards all of them. If another transaction changes one of the same values first, this transaction starts again with new reads."
    },
    {
      q: "Where must you call `Ref.make` so that the state of a service lives as long as the service?",
      a: "1 time, in the factory effect that builds the service, before it returns the functions that use the Ref. If `Ref.make` is inside one of those functions, each call makes a new Ref, and the state resets on each call."
    }
  ]
}

export default section
