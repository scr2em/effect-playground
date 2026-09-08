import type { Section } from "../types.ts"

const section: Section = {
  id: "stream",
  title: "Stream",
  order: 13,
  summary: "A stream is an effect that emits many elements. It is lazy, it has typed errors, and it controls concurrency.",
  intro: `
**The problem.** In plain TypeScript, data that arrives in parts gives you 2 tools. Both tools have problems. The first tool is an array:

\`\`\`ts
const rows = await db.loadAllRows()          // 2 million rows in memory
const top = rows.filter(isPaid).map(total).slice(0, 10)
\`\`\`

You want 10 rows. The program loads 2 million rows into memory. The second tool is an async generator with \`for await\`:

\`\`\`ts
async function* rows() { /* yield 1 row at a time */ }
for await (const row of rows()) { /* ... */ }
\`\`\`

This tool solves the memory problem and nothing else. The generator has no error type. A throw inside the generator stops the loop. You cannot process 3 rows at the same time without manual bookkeeping code. If you \`break\` out of the loop, you must close the connection yourself. You cannot give the loop to another function that adds a retry or a timeout. A loop is not a value.

### The shift

Today you think of a sequence as data that you pull from with a loop. In Effect, a sequence is a value. A \`Stream<A, E, R>\` is an effect that emits 0 or more elements of type \`A\` when you run it. An effect gives 1 result. A stream emits many elements. The 3 type parameters have the same meaning. The stream does nothing until you run it. Its errors are typed. Its requirements are tracked.

Because a stream is a value, you get more. \`Stream.map\` and \`Stream.filter\` work like the array methods, but they process 1 element at a time. \`Stream.take(10)\` stops the stream after 10 elements, so an infinite stream is safe. The part that emits elements is the producer. The part that reads elements is the consumer. The consumer pulls elements from the producer. A slow consumer does not receive more elements than it can process. This property is called backpressure. When the stream ends, fails, or is interrupted, Effect closes the resources that the stream opened.

| | Array | Async generator | Stream |
|---|---|---|---|
| Memory | All elements at once | 1 element at a time | 1 chunk (a small array) at a time |
| Error type | None. The code throws. | None. The generator throws. | Tracked in \`E\` |
| Concurrency | \`Promise.all\` on the full array | Manual code | \`mapEffect(f, { concurrency })\` |
| Stops early | \`slice\` after the full load | \`break\` | \`take\`, \`takeWhile\` |
| Cleanup on stop | Not applicable | \`finally\` in the generator | Automatic |
| Retry, timeout | Manual code | Manual code | \`Stream.retry\`, \`Stream.timeout\` |

In this section you build streams, transform them, run them, and see why laziness is important. The next section, Sink, covers the consumer side.
`,
  lessons: [
    {
      id: "stream-l1",
      title: "A stream is an effect that emits many elements",
      explain: `
You build a stream with a constructor, in the same way that you build an effect. A stream is only a description. Nothing runs until you give the stream to a run function.

| Constructor | Emits | Use when |
|---|---|---|
| \`Stream.make(1, 2, 3)\` | The given elements | You have fixed test data |
| \`Stream.fromIterable(xs)\` | Each element of an array, a Set, or a generator | You have a collection |
| \`Stream.range(1, 5)\` | \`1, 2, 3, 4, 5\`, both ends included | You count |
| \`Stream.fromEffect(eff)\` | 1 element, the result of the effect | You have 1 effect |
| \`Stream.succeed(x)\` / \`Stream.fail(e)\` | 1 element / no element and a failure | You have 1 element or 1 error |
| \`Stream.fromQueue(q)\` | Each element that the program offers to a queue, until \`Queue.end\` | Another part of the program pushes data |

\`Stream.runCollect\` runs a stream and puts all elements into an array. It returns an \`Effect<Array<A>, E, R>\`. You must use \`yield*\` or a run function to get the array. This is the pattern for the full section: a run function changes a stream into an effect.
`,
      code: `import { Cause, Effect, Queue, Stream } from "effect"

// Building a stream does nothing. This tap would print on every element,
// but nothing prints until the stream is run.
const numbers = Stream.range(1, 3).pipe(
  Stream.tap((n) => Effect.sync(() => console.log("producing", n)))
)

const program = Effect.gen(function* () {
  console.log("built, nothing produced yet")

  const collected = yield* Stream.runCollect(numbers)      // now it runs
  console.log("collected", collected)

  console.log("make", yield* Stream.runCollect(Stream.make("a", "b")))
  console.log("fromIterable", yield* Stream.runCollect(Stream.fromIterable(new Set([1, 1, 2]))))
  console.log("fromEffect", yield* Stream.runCollect(Stream.fromEffect(Effect.succeed(42))))

  // A queue is a source that someone else fills. Queue.end tells the stream "no more".
  const queue = yield* Queue.unbounded<string, Cause.Done>()
  yield* Queue.offerAll(queue, ["job-1", "job-2"])
  yield* Queue.end(queue)
  console.log("fromQueue", yield* Stream.runCollect(Stream.fromQueue(queue)))
})

Effect.runPromise(program)
`,
      expectedOutput: `built, nothing produced yet
producing 1
producing 2
producing 3
collected [ 1, 2, 3 ]
make [ "a", "b" ]
fromIterable [ 1, 2 ]
fromEffect [ 42 ]
fromQueue [ "job-1", "job-2" ]`,
      after: `The "producing" lines appear after "built, nothing produced yet". Run \`Stream.runCollect(numbers)\` 2 times. The stream emits its elements again, because the stream is a description. Note: if you remove \`Queue.end\`, the queue stream waits for more elements, and the program does not end.`
    },
    {
      id: "stream-l2",
      title: "Transform elements: the array functions, 1 element at a time",
      explain: `
The common stream functions look like the array methods, and they read the same in a \`pipe\`. The difference: a stream function processes each element when the element arrives. It does not build a new array at each step.

| Stream | Array equivalent | Notes |
|---|---|---|
| \`Stream.map(f)\` | \`.map(f)\` | A pure transformation |
| \`Stream.filter(p)\` | \`.filter(p)\` | A type guard narrows the element type |
| \`Stream.take(n)\` | \`.slice(0, n)\` | Also stops the producer |
| \`Stream.drop(n)\` | \`.slice(n)\` | |
| \`Stream.takeWhile(p)\` | A loop with \`break\` | Stops at the first element that fails the test |
| \`Stream.tap(f)\` | A log call inside \`.map\` | Runs an effect for each element and keeps the element |
| \`Stream.scan(init, f)\` | \`.reduce\`, but it emits each step | The total so far |

\`scan\` has no direct array equivalent. It is a \`reduce\` that emits the accumulator after each element. It also emits the initial value first. With \`scan\`, a stream of amounts becomes a stream of balances.
`,
      code: `import { Effect, Stream } from "effect"

const transactions = Stream.make(50, -20, 30, -5, 100, -60)

const program = Effect.gen(function* () {
  const bigDeposits = yield* transactions.pipe(
    Stream.filter((n) => n > 0),               // keep deposits
    Stream.map((n) => n * 100),                // to cents
    Stream.take(2),                            // first two only
    Stream.runCollect
  )
  console.log("first two deposits in cents", bigDeposits)

  const untilFirstWithdrawal = yield* transactions.pipe(
    Stream.takeWhile((n) => n > 0),
    Stream.runCollect
  )
  console.log("until first withdrawal", untilFirstWithdrawal)

  const balances = yield* transactions.pipe(
    Stream.scan(0, (balance, n) => balance + n),   // emits 0, then every running balance
    Stream.drop(1),                                // skip the initial 0
    Stream.runCollect
  )
  console.log("running balance", balances)
})

Effect.runPromise(program)
`,
      expectedOutput: `first two deposits in cents [ 5000, 3000 ]
until first withdrawal [ 50 ]
running balance [ 50, 30, 60, 55, 155, 95 ]`,
      after: `Remove \`Stream.drop(1)\`. The balance list then starts with the initial \`0\`. \`scan\` always emits the initial value first. This is useful when the initial value is a real state. It is noise when it is not.`
    },
    {
      id: "stream-l3",
      title: "Run a stream: the run functions",
      explain: `
A stream becomes an effect only through a run function. Select the function that matches the result that you want. \`runCollect\` is the most common function. It is also the function that loses the memory benefit, so learn the other functions.

| Function | Result type | Use when |
|---|---|---|
| \`Stream.runCollect\` | \`Effect<Array<A>>\` | You need all elements, and they fit in memory |
| \`Stream.runHead\` | \`Effect<Option<A>>\` | Only the first element is important. Stops early. |
| \`Stream.runLast\` | \`Effect<Option<A>>\` | Only the last element is important |
| \`Stream.runFold(() => init, f)\` | \`Effect<Z>\` | Reduce to 1 value: a sum, a maximum, a Map |
| \`Stream.runForEach(f)\` | \`Effect<void>\` | Do an effect for each element: write, send |
| \`Stream.runDrain\` | \`Effect<void>\` | Run for the side effects in \`tap\`. Ignores the elements. |
| \`Stream.runCount\` | \`Effect<number>\` | Count the elements |

Note: \`runHead\` and \`runLast\` return an \`Option\`, because the stream can be empty. Note: \`runFold\` takes the initial value as a function \`() => init\`, not as a plain value. Each run then starts with a new accumulator, for example a new \`[]\` or a new \`Map\`.
`,
      code: `import { Effect, Option, Stream } from "effect"

const scores = Stream.make(72, 95, 88, 61)

const program = Effect.gen(function* () {
  const first = yield* Stream.runHead(scores)
  console.log("head", Option.getOrElse(first, () => -1))

  const last = yield* Stream.runLast(scores)
  console.log("last", Option.getOrElse(last, () => -1))

  const empty = yield* Stream.runHead(Stream.empty)
  console.log("head of empty", Option.isNone(empty) ? "none" : "some")

  // runFold: the initial value is a function so every run starts fresh
  const best = yield* Stream.runFold(scores, () => 0, (max, n) => Math.max(max, n))
  console.log("best", best)

  console.log("count", yield* Stream.runCount(scores))

  yield* Stream.runForEach(scores, (n) => Effect.sync(() => console.log("grade", n >= 70 ? "pass" : "fail")))

  // runDrain: values are thrown away, only the tap's effect is kept
  yield* scores.pipe(
    Stream.tap((n) => Effect.sync(() => console.log("seen", n))),
    Stream.take(2),
    Stream.runDrain
  )
})

Effect.runPromise(program)
`,
      expectedOutput: `head 72
last 61
head of empty none
best 95
count 4
grade pass
grade pass
grade pass
grade fail
seen 72
seen 95`,
      after: `\`runHead\` stopped after the first element. The stream did not emit the other elements. \`runLast\` pulled all 4 elements. Select the correct run function to prevent work whose result you do not use.`
    },
    {
      id: "stream-l4",
      title: "Pull and laziness: infinite streams are safe",
      explain: `
A stream is pull-based. The consumer asks for the next chunk. The producer computes the chunk and then waits. The producer emits nothing before the consumer asks. 2 results follow from this.

First, an infinite stream is a normal value. \`Stream.iterate(0, (n) => n + 1)\` describes all natural numbers. Add \`Stream.take(5)\`, and the run ends after 5 pulls. If you remove the \`take\`, \`runCollect\` never returns. Caution: an infinite stream must end with \`take\`, \`takeWhile\`, or a run function that stops early, for example \`runHead\`.

Second, an expensive source does only the work that the consumer uses. In the example, \`fetchPage\` counts its calls. When you take 3 elements from pages of 2, the stream calls \`fetchPage\` 2 times, not 4 times.

| Constructor | Ends? | What it does |
|---|---|---|
| \`Stream.iterate(seed, next)\` | Never | Emits \`seed, next(seed), next(next(seed)), ...\` |
| \`Stream.unfold(seed, step)\` | When \`step\` returns \`undefined\` | Like \`iterate\`, but each step is an effect and can stop |
| \`Stream.tick(interval)\` | Never | Emits 1 \`void\` immediately, then 1 \`void\` after each interval |
| \`Stream.fromSchedule(s)\` | When the schedule ends | Emits 1 element for each schedule step, with the delays of the schedule |
| \`Stream.paginate(cursor, fetch)\` | When \`fetch\` returns \`Option.none()\` as the next cursor | Reads paginated APIs. A cursor identifies the next page. |
`,
      code: `import { Effect, Option, Schedule, Stream } from "effect"

// Every natural number. Only a description; nothing is computed here.
const naturals = Stream.iterate(0, (n) => n + 1)

// A fake paginated API: pages of two, four pages. Counts how often it is hit.
let fetches = 0
const pages: Record<number, Array<string>> = { 0: ["a", "b"], 1: ["c", "d"], 2: ["e", "f"], 3: ["g"] }
const fetchPage = (page: number) =>
  Effect.sync(() => {
    fetches++
    const next = page < 3 ? Option.some(page + 1) : Option.none<number>()
    return [pages[page]!, next] as const      // [items on this page, next cursor]
  })

const program = Effect.gen(function* () {
  const squares = yield* naturals.pipe(
    Stream.map((n) => n * n),
    Stream.filter((n) => n % 2 === 0),
    Stream.take(5),                             // without this line the program never ends
    Stream.runCollect
  )
  console.log("first five even squares", squares)

  const ticks = yield* Stream.tick("5 millis").pipe(Stream.take(3), Stream.runCount)
  console.log("ticks", ticks)

  const steps = yield* Stream.fromSchedule(Schedule.recurs(3)).pipe(Stream.runCollect)
  console.log("schedule steps", steps)

  const three = yield* Stream.paginate(0, fetchPage).pipe(Stream.take(3), Stream.runCollect)
  console.log("took", three, "with", fetches, "fetches")

  fetches = 0
  const all = yield* Stream.paginate(0, fetchPage).pipe(Stream.runCollect)
  console.log("took", all, "with", fetches, "fetches")
})

Effect.runPromise(program)
`,
      expectedOutput: `first five even squares [ 0, 4, 16, 36, 64 ]
ticks 3
schedule steps [ 0, 1, 2 ]
took [ "a", "b", "c" ] with 2 fetches
took [ "a", "b", "c", "d", "e", "f", "g" ] with 4 fetches`,
      after: `The \`take(5)\` comes after the \`filter\`. If \`take\` comes first, the filter receives only 5 candidates and emits fewer results. The order in a pipeline is the order of the pulls. Move the \`take\` above the \`filter\` and count the squares.`
    },
    {
      id: "stream-l5",
      title: "Side by side: an async generator and Stream.mapEffect",
      explain: `
This is a common task in plain TypeScript. For a list of ids, call a slow API for each id, keep the results in order, and run at most 3 calls at the same time.

\`\`\`ts
async function* enrich(ids: number[]) {
  // "3 at a time, in order" needs a manual worker pool.
  // Most code uses a serial loop (slow) or Promise.all
  // (no limit; the order depends on the array index only).
  for (const id of ids) yield await fetchUser(id)
}
for await (const user of enrich([1, 2, 3, 4, 5, 6])) console.log(user)
\`\`\`

\`Stream.mapEffect\` is \`map\` for a function that returns an effect. Without options, it runs 1 call at a time. With \`{ concurrency: 3 }\`, it runs 3 calls at the same time and emits the results in the input order. The example counts the maximum number of calls that run at the same time. This number is stable, because each call waits for the same short time.
`,
      code: `import { Effect, Stream } from "effect"

let inFlight = 0
let peak = 0

// A fake API call. Tracks how many are running at the same time.
const fetchUser = (id: number) =>
  Effect.gen(function* () {
    inFlight++
    peak = Math.max(peak, inFlight)
    yield* Effect.sleep("10 millis")
    inFlight--
    return "user-" + id
  })

const ids = Stream.range(1, 6)

const program = Effect.gen(function* () {
  const serial = yield* ids.pipe(Stream.mapEffect(fetchUser), Stream.runCollect)
  console.log("serial    ", serial, "peak", peak)

  peak = 0
  const parallel = yield* ids.pipe(
    Stream.mapEffect(fetchUser, { concurrency: 3 }),   // three at a time, order preserved
    Stream.runCollect
  )
  console.log("concurrent", parallel, "peak", peak)
})

Effect.runPromise(program)
`,
      expectedOutput: `serial     [ "user-1", "user-2", "user-3", "user-4", "user-5", "user-6" ] peak 1
concurrent [ "user-1", "user-2", "user-3", "user-4", "user-5", "user-6" ] peak 3`,
      after: `The results keep their order, although the calls overlap. If the order is not important, add \`unordered: true\` to the options. The stream then emits each result as soon as it is ready. \`Stream.tap\` and \`Stream.flatMap\` accept the same \`concurrency\` option.`
    },
    {
      id: "stream-l6",
      title: "Combine streams: zip, merge, flatMap, grouped",
      explain: `
Real pipelines have more than 1 source, or they must put elements into groups. These functions combine streams or regroup elements.

| Function | Result | Use when |
|---|---|---|
| \`Stream.zip(other)\` | Pairs \`[a, b]\`. Stops at the end of the shorter stream. | 2 streams that line up, for example elements and indexes |
| \`Stream.zipWith(other, f)\` | \`f(a, b)\` for each pair | The same, without the tuple |
| \`Stream.merge(other)\` | The elements of both streams, in arrival order | 2 independent sources, for example 2 queues |
| \`Stream.flatMap(f)\` | Each element of each \`f(a)\` | 1 input element becomes 0 or more output elements |
| \`Stream.grouped(n)\` | Arrays of \`n\` elements. The last array can be shorter. | Batch writes |
| \`Stream.groupedWithin(n, duration)\` | Arrays of \`n\` elements at most, or the elements that arrived in the duration | Batch writes with a time limit |

Note: \`merge\` emits elements in the order in which they become ready. The output order is not guaranteed. The example sorts the merged elements before it prints them. In a real program, do not depend on the order. In \`flatMap\`, return \`Stream.empty\` to remove an element. Return \`Stream.make(x, y)\` to expand an element into 2 elements.
`,
      code: `import { Effect, Stream } from "effect"

const names = Stream.make("ada", "lin", "bo")
const errorsFromA = Stream.make("A1", "A2")
const errorsFromB = Stream.make("B1")

const program = Effect.gen(function* () {
  const numbered = yield* names.pipe(
    Stream.zipWith(Stream.iterate(1, (n) => n + 1), (name, i) => i + ". " + name),
    Stream.runCollect
  )
  console.log("zipWith", numbered)

  const merged = yield* errorsFromA.pipe(Stream.merge(errorsFromB), Stream.runCollect)
  console.log("merge", merged.sort())                 // sorted: merge order is not guaranteed

  const expanded = yield* names.pipe(
    Stream.flatMap((name) => name.length === 3 ? Stream.make(name, name.toUpperCase()) : Stream.empty),
    Stream.runCollect
  )
  console.log("flatMap", expanded)

  const batches = yield* Stream.range(1, 7).pipe(Stream.grouped(3), Stream.runCollect)
  console.log("grouped", batches)

  const pairs = yield* names.pipe(Stream.zip(Stream.make(true, false)), Stream.runCollect)
  console.log("zip stops at the shorter", pairs)
})

Effect.runPromise(program)
`,
      expectedOutput: `zipWith [ "1. ada", "2. lin", "3. bo" ]
merge [ "A1", "A2", "B1" ]
flatMap [ "ada", "ADA", "lin", "LIN" ]
grouped [
  [ 1, 2, 3 ], [ 4, 5, 6 ], [ 7 ]
]
zip stops at the shorter [
  [ "ada", true ], [ "lin", false ]
]`,
      after: `\`zipWith\` with the infinite \`Stream.iterate(1, ...)\` is safe. \`zip\` stops when \`names\` ends, so it pulls only 3 elements from the infinite side. \`Stream.zipWithIndex\` does the same and adds the index for you.`
    },
    {
      id: "stream-l8",
      title: "Streams from the outside: fromQueue, fromPubSub, callback",
      explain: `
The streams so far had their data inside the program: an array, a range, a fake API. Real data comes from the outside: a worker fiber, an event bus, a library that calls your function. 3 constructors connect these sources to a stream.

| Constructor | Source | How the stream ends |
|---|---|---|
| \`Stream.fromQueue(queue)\` | A \`Queue<A, Cause.Done>\`. Any fiber can offer elements. | \`Queue.end(queue)\` |
| \`Stream.fromSubscription(sub)\` | A PubSub subscription. Each subscriber gets each message. | \`Stream.take\`, or the end of the scope |
| \`Stream.fromPubSub(pubsub)\` | The same, but the stream subscribes when it starts | The same |
| \`Stream.callback((queue) => setup)\` | A library with callbacks. \`setup\` registers the callbacks and pushes into the queue. | \`Queue.endUnsafe(queue)\` from a callback |

A queue is the bridge between a producer fiber and a stream. The producer offers elements and then ends the queue. \`Stream.fromQueue\` needs the queue error type \`Cause.Done\`, because the end signal travels in the error channel. A bounded queue gives backpressure: \`Queue.offer\` waits while the queue is full.

A PubSub sends each message to all subscribers. A subscription exists only after \`PubSub.subscribe\`, and this needs a scope. A message that the program publishes before the subscribe does not reach the subscriber. Subscribe first, then publish. Note: \`PubSub.shutdown\` discards the messages that a subscriber has not read yet.

\`Stream.callback\` gives you a queue and expects a setup effect. The setup effect runs when the stream starts. Use \`Effect.acquireRelease\` inside it: the acquire registers the callbacks, and the release removes them. The release runs when the stream ends, for any reason. From a plain callback, use \`Queue.offerUnsafe\` and \`Queue.endUnsafe\`, because a callback cannot yield an effect.
`,
      code: `import { Cause, Effect, PubSub, Queue, Stream } from "effect"

// A fake event source. It calls onEvent 3 times, 1 ms apart, then it calls onDone.
// The returned function stops the source. Most event emitters have this shape.
const listen = (onEvent: (n: number) => void, onDone: () => void) => {
  let count = 0
  const timer = setInterval(() => {
    count++
    onEvent(count)
    if (count === 3) {
      clearInterval(timer)
      onDone()
    }
  }, 1)
  return () => {
    clearInterval(timer)
    console.log("listener removed")
  }
}

// Stream.callback gives you a queue. Push into it from plain callbacks. End it when the source is done.
const events = Stream.callback<number>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => listen((n) => Queue.offerUnsafe(queue, n), () => Queue.endUnsafe(queue))),
    (stop) => Effect.sync(stop)                  // runs when the stream ends, also after take
  )
)

const program = Effect.gen(function* () {
  // 1. A queue. A producer fiber offers, then ends. The stream ends with the queue.
  const queue = yield* Queue.bounded<string, Cause.Done>(2)
  yield* Effect.forkChild(Effect.gen(function* () {
    yield* Queue.offerAll(queue, ["job-1", "job-2", "job-3", "job-4"])   // waits while the queue is full
    yield* Queue.end(queue)
    console.log("producer ended")
  }))
  console.log("queue", yield* Stream.runCollect(Stream.fromQueue(queue)))

  // 2. A PubSub. Subscribe first, in a scope. Then publish. Each subscriber gets each message.
  const pubsub = yield* PubSub.unbounded<string>()
  const seen = yield* Effect.scoped(Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(pubsub)     // removed when the scope closes
    yield* PubSub.publishAll(pubsub, ["login", "click", "logout"])
    return yield* Stream.fromSubscription(subscription).pipe(Stream.take(3), Stream.runCollect)
  }))
  console.log("pubsub", seen)

  // 3. A callback source. The release runs in both cases.
  console.log("callback", yield* Stream.runCollect(events))
  console.log("callback take 2", yield* events.pipe(Stream.take(2), Stream.runCollect))
})

Effect.runPromise(program)
`,
      expectedOutput: `producer ended
queue [ "job-1", "job-2", "job-3", "job-4" ]
pubsub [ "login", "click", "logout" ]
listener removed
callback [ 1, 2, 3 ]
listener removed
callback take 2 [ 1, 2 ]`,
      after: `The "listener removed" line prints also after \`take(2)\`. The release effect runs when the consumer stops, and the third event never fires. Change \`Queue.bounded(2)\` to \`Queue.unbounded()\`. The output is the same, but the producer no longer waits. Remove \`Stream.take(3)\` from the PubSub example. Caution: the subscription never ends by itself, and the program does not stop.`
    },
    {
      id: "stream-l9",
      title: "Resource safety in streams: acquireRelease, ensuring, scoped",
      explain: `
A stream often reads from a resource: a file, a socket, a database cursor. The resource must open when the stream starts. It must close when the stream ends. This includes 3 cases: the stream emits its last element, a \`take\` stops it early, or a step fails.

In plain TypeScript with \`for await\`, the generator must close the resource in a \`finally\` block. If the caller uses \`break\`, the generator runs the \`finally\` only when the loop calls \`return()\`. Many callers forget this.

In Effect, \`Effect.acquireRelease(open, close)\` pairs an open with a close. This effect needs a \`Scope\`. \`Stream.scoped\` gives the stream its own scope for each run. The scope closes when the run ends, in all 3 cases.

| Function | When it runs | Use when |
|---|---|---|
| \`Stream.scoped(Stream.fromEffect(acquireRelease))\` | The close runs when the run ends, in all cases | The stream owns a resource |
| \`Stream.unwrap(effect)\` | The same. \`effect\` returns the stream and can use a scope. | You must open the resource to know what to emit |
| \`Stream.ensuring(finalizer)\` | After the finalizers of the stream, in all cases | Cleanup that does not own a resource, for example a log |
| \`Stream.onEnd(effect)\` | Only when the stream emits its last element | A "done" message |
| \`Stream.onExit((exit) => ...)\` | In all cases, with the \`Exit\` | You must know why the stream ended |

The example runs the same stream 3 times: a complete run, a run with \`take(2)\`, and a run that fails at line 3. Compare the lines that print. "close" prints in all 3 runs. "onEnd" prints only in the first run.
`,
      code: `import { Effect, Stream } from "effect"

// A fake file. acquireRelease pairs the open with the close.
const openFile = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      console.log("open", name)
      return ["l1", "l2", "l3", "l4"]
    }),
    () => Effect.sync(() => console.log("close", name))
  )

// Stream.scoped: the resource lives as long as 1 run of the stream
const lines = Stream.scoped(Stream.fromEffect(openFile("a.txt"))).pipe(
  Stream.flatMap((all) => Stream.fromIterable(all)),
  Stream.tap((line) => Effect.sync(() => console.log("read", line))),
  Stream.ensuring(Effect.sync(() => console.log("ensuring: always"))),
  Stream.onEnd(Effect.sync(() => console.log("onEnd: only after a complete run")))
)

const program = Effect.gen(function* () {
  console.log("--- complete run")
  console.log(yield* Stream.runCollect(lines))

  console.log("--- take(2) stops the stream early")
  console.log(yield* lines.pipe(Stream.take(2), Stream.runCollect))

  console.log("--- a failure in the middle")
  const result = yield* lines.pipe(
    Stream.mapEffect((line) => line === "l3" ? Effect.fail("bad " + line) : Effect.succeed(line)),
    Stream.runCollect,
    Effect.catch((e) => Effect.succeed("failed: " + e))
  )
  console.log(result)
})

Effect.runPromise(program)
`,
      expectedOutput: `--- complete run
open a.txt
read l1
read l2
read l3
read l4
close a.txt
ensuring: always
onEnd: only after a complete run
[ "l1", "l2", "l3", "l4" ]
--- take(2) stops the stream early
open a.txt
read l1
read l2
close a.txt
ensuring: always
[ "l1", "l2" ]
--- a failure in the middle
open a.txt
read l1
read l2
read l3
close a.txt
ensuring: always
failed: bad l3`,
      after: `The order is fixed: the close of the resource, then \`ensuring\`, then \`onEnd\`. Remove \`Stream.scoped\`. The program no longer compiles, because \`Scope\` stays in the \`R\` of the stream. The challenge "The file that closes too late" shows what happens when the caller provides that scope. Replace \`Stream.onEnd\` with \`Stream.onExit\` and print \`exit._tag\` in each of the 3 runs.`
    },
    {
      id: "stream-l10",
      title: "Group, buffer, broadcast",
      explain: `
These functions change the shape of the flow. They do not change the elements.

| Function | What it does | Use when |
|---|---|---|
| \`Stream.groupByKey(f)\` | Emits \`[key, substream]\` for each distinct key | Totals for each customer, files for each day |
| \`Stream.buffer({ capacity })\` | Puts a queue between the producer and the consumer | A fast producer and a slow consumer |
| \`Stream.broadcast(options)\` | 1 source, many consumers. Each consumer sees each element. | 2 reports from 1 read of the data |
| \`Stream.changes\` | Drops an element that is equal to the previous element | Status changes, not status reports |
| \`Stream.scan(init, f)\` | Emits each intermediate state (lesson 2) | A running total |

\`groupByKey\` emits a stream for each key. The groups fill at the same time, while the source runs. The step that reads the groups must run with \`concurrency\`. A group that nobody reads blocks the source. Caution: without \`concurrency\`, the program never ends. The output order is the order of the first element of each key.

Without a buffer, the producer and the consumer take turns. The producer makes 1 element, then the consumer processes it. \`buffer\` lets the producer run ahead, up to \`capacity\` elements. When the buffer is full, the producer waits. This is the same backpressure as a bounded queue.

\`broadcast\` returns an effect that needs a \`Scope\`, because it starts a PubSub. Run the consumers at the same time with \`Effect.all\` and \`concurrency\`. Each consumer subscribes when it starts, and the source runs 1 time.
`,
      code: `import { Effect, Stream } from "effect"

const orders = Stream.make(
  { city: "cairo", total: 10 },
  { city: "oslo", total: 5 },
  { city: "cairo", total: 7 },
  { city: "lima", total: 3 },
  { city: "oslo", total: 1 }
)

const program = Effect.gen(function* () {
  // groupByKey: 1 substream for each key. Reduce each substream to 1 value.
  // The groups fill at the same time, so the step that reads them must run with concurrency.
  const perCity = yield* orders.pipe(
    Stream.groupByKey((order) => order.city),
    Stream.mapEffect(
      ([city, group]) =>
        Stream.runFold(group, () => 0, (sum, order) => sum + order.total).pipe(
          Effect.map((sum) => city + "=" + sum)
        ),
      { concurrency: "unbounded" }
    ),
    Stream.runCollect
  )
  console.log("groupByKey", perCity)

  // buffer: the producer runs ahead of the consumer, up to the capacity
  const produce = (label: string) =>
    Stream.range(1, 3).pipe(
      Stream.rechunk(1),                    // 1 element for each chunk, so each element is 1 step
      Stream.tap((n) => Effect.sync(() => console.log(label, "produced", n)))
    )
  const consume = (label: string) =>
    Stream.runForEach((n: number) => Effect.sync(() => console.log(label, "consumed", n)))
  yield* produce("plain").pipe(consume("plain"))
  yield* produce("buffer").pipe(Stream.buffer({ capacity: 4 }), consume("buffer"))

  // broadcast: 1 source, 2 consumers, each consumer sees each element. It needs a scope.
  const [sum, max] = yield* Effect.scoped(Effect.gen(function* () {
    const shared = yield* Stream.broadcast(Stream.make(3, 1, 4, 1, 5), { capacity: 8 })
    return yield* Effect.all([
      Stream.runFold(shared, () => 0, (a, b) => a + b),
      Stream.runFold(shared, () => 0, (a, b) => Math.max(a, b))
    ], { concurrency: "unbounded" })
  }))
  console.log("broadcast sum", sum, "max", max)

  // changes: drop an element that is equal to the previous element
  const status = Stream.make("ok", "ok", "down", "down", "down", "ok")
  console.log("changes", yield* status.pipe(Stream.changes, Stream.runCollect))
})

Effect.runPromise(program)
`,
      expectedOutput: `groupByKey [ "cairo=17", "oslo=6", "lima=3" ]
plain produced 1
plain consumed 1
plain produced 2
plain consumed 2
plain produced 3
plain consumed 3
buffer produced 1
buffer produced 2
buffer produced 3
buffer consumed 1
buffer consumed 2
buffer consumed 3
broadcast sum 14 max 5
changes [ "ok", "down", "ok" ]`,
      after: `Compare the "plain" lines with the "buffer" lines. With the buffer, all 3 "produced" lines come before the first "consumed" line. Change the capacity to 1 and compare again. Add an order for a new city at the end of \`orders\`. The new key appears at the end of the \`groupByKey\` output. Note: \`Stream.changes\` compares with \`Equal.equals\`, so it also works for structural data such as \`Data.struct\`.`
    },
    {
      id: "stream-l11",
      title: "Time-based operators with TestClock",
      explain: `
Some functions depend on time: \`throttle\`, \`debounce\`, \`timeout\`. A test must not wait for real seconds. Effect reads the time from the \`Clock\` service. \`TestClock\` from \`effect/testing\` is a fake clock. \`TestClock.layer()\` provides it. \`TestClock.adjust(duration)\` moves the clock forward and runs each timer that is now due. No real time passes.

| Function | What it does | Use when |
|---|---|---|
| \`Stream.throttle({ cost, units, duration })\` | Lets \`units\` of cost through in each \`duration\`. The next chunk waits. | A rate limit for an API |
| \`Stream.debounce(duration)\` | Emits the last element when the input is quiet for \`duration\` | A search box |
| \`Stream.timeout(duration)\` | Ends the stream when no element arrives in \`duration\` | A source that can stop without a signal |
| \`Stream.schedule(schedule)\` | Waits for 1 schedule step before each element | A slow replay of events |

The pattern is the same for each function. Fork the stream, because it waits for the clock. Move the clock with \`TestClock.adjust\`. Join the fiber with \`Fiber.join\` to get the result. Note: in v4, a fiber is not an effect. \`yield* fiber\` does not compile. Use \`Fiber.join(fiber)\`.

\`throttle\` works on chunks, not on elements. \`Stream.range\` emits 1 chunk, so the example adds \`Stream.rechunk(1)\` before the throttle. Without it, the throttle sees 1 chunk with a cost of 3. The cost is above \`units\`, and the chunk never passes. The example prints the clock time for each element. The times are exact, because the clock is fake.
`,
      code: `import { Cause, Clock, Effect, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"

// Prints the element with the test-clock time. The time is exact, because the clock is fake.
const stamp = <A>(label: string) => (a: A) =>
  Effect.map(Clock.currentTimeMillis, (ms) => label + " " + ms + "ms " + a)

const program = Effect.gen(function* () {
  // throttle: at most 1 element for each second
  const throttled = yield* Effect.forkChild(
    Stream.range(1, 3).pipe(
      Stream.rechunk(1),                                      // throttle counts chunks, so make each element a chunk
      Stream.throttle({ cost: (chunk) => chunk.length, units: 1, duration: "1 second" }),
      Stream.mapEffect(stamp("throttle")),
      Stream.runCollect
    )
  )
  yield* TestClock.adjust("2 seconds")                        // the fake clock moves 2 seconds at once
  console.log(yield* Fiber.join(throttled))

  // debounce: emit only when the input is quiet for 100 ms
  const keys = yield* Queue.unbounded<string, Cause.Done>()
  const debounced = yield* Effect.forkChild(
    Stream.fromQueue(keys).pipe(Stream.debounce("100 millis"), Stream.runCollect)
  )
  yield* Queue.offerAll(keys, ["k", "ke", "key"])              // 3 keystrokes, no pause
  yield* TestClock.adjust("100 millis")                       // a pause
  yield* Queue.offerAll(keys, ["keyb", "keybo"])
  yield* TestClock.adjust("100 millis")
  yield* Queue.end(keys)
  console.log("debounce", yield* Fiber.join(debounced))

  // timeout: end the stream when no element arrives in 1 second
  const pings = yield* Queue.unbounded<string, Cause.Done>()
  const guarded = yield* Effect.forkChild(
    Stream.fromQueue(pings).pipe(Stream.timeout("1 second"), Stream.runCollect)
  )
  yield* Queue.offer(pings, "ping")
  yield* TestClock.adjust("500 millis")
  yield* Queue.offer(pings, "pong")
  yield* TestClock.adjust("1 second")                         // nothing arrives: the stream ends. The queue never ends.
  console.log("timeout", yield* Fiber.join(guarded))
}).pipe(Effect.provide(TestClock.layer()))

Effect.runPromise(program)
`,
      expectedOutput: `[ "throttle 0ms 1", "throttle 1000ms 2", "throttle 2000ms 3" ]
debounce [ "key", "keybo" ]
timeout [ "ping", "pong" ]`,
      after: `Change the throttle duration to \`"500 millis"\`. The times become 0, 500 and 1000. Change \`TestClock.adjust("2 seconds")\` to \`"1 second"\`. Caution: the program then never ends, because the third element waits for a second that never comes. Remove \`Effect.provide(TestClock.layer())\`. The program still works, but it waits for real seconds. This is the reason to use the fake clock in tests.`
    },
    {
      id: "stream-l7",
      title: "Errors in streams: catch, catchTag, retry",
      explain: `
The \`E\` of a stream works like the \`E\` of an effect. Each element step can fail. The first failure ends the stream. The catch functions mirror the effect functions, but the replacement is a stream. The stream that you return continues the output from the point of the failure.

| Function | What it does |
|---|---|
| \`Stream.catch((e) => replacement)\` | Catches each error and continues with the replacement stream |
| \`Stream.catchTag("Tag", (e) => replacement)\` | Catches 1 tagged error. The other errors stay in \`E\`. |
| \`Stream.retry(schedule)\` | Runs the full stream again from the start after a failure |
| \`Stream.mapError(f)\` | Changes the error type. Does not catch the error. |

Note: \`retry\` starts the stream again, so the stream runs its start-up steps again. This is correct for a source that failed to connect. It is wrong for a source that emitted half of its elements to a consumer that cannot accept duplicates. Use \`Stream.suspend\` when the failure depends on a state that changes between attempts. The flaky source below does this.
`,
      code: `import { Effect, Schedule, Schema, Stream } from "effect"

class Corrupt extends Schema.TaggedError<Corrupt>()("Corrupt", { line: Schema.Number }) {}

// Two good lines, then a failure in the middle of the stream
const lines = Stream.make("ok 1", "ok 2").pipe(
  Stream.concat(Stream.fail(new Corrupt({ line: 3 }))),
  Stream.concat(Stream.make("never reached"))
)

// A source that fails on the first two attempts, then works
let attempts = 0
const flaky = Stream.suspend(() => {
  attempts++
  return attempts < 3 ? Stream.fail("connection refused") : Stream.make("connected on attempt " + attempts)
})

const program = Effect.gen(function* () {
  const recovered = yield* lines.pipe(
    Stream.catchTag("Corrupt", (e) => Stream.make("skipped line " + e.line)),   // E becomes never
    Stream.runCollect
  )
  console.log(recovered)

  const raw = yield* lines.pipe(
    Stream.runCollect,
    Effect.catch((e) => Effect.succeed(["run failed with " + e._tag]))       // or handle after running
  )
  console.log(raw)

  const retried = yield* flaky.pipe(Stream.retry(Schedule.recurs(5)), Stream.runCollect)
  console.log(retried)
})

Effect.runPromise(program)
`,
      expectedOutput: `[ "ok 1", "ok 2", "skipped line 3" ]
[ "run failed with Corrupt" ]
[ "connected on attempt 3" ]`,
      after: `The stream never emits "never reached". A failure ends the stream. The replacement stream replaces the rest of the stream, not only the element that failed. If you need recovery for each element, catch the error inside the \`mapEffect\` function with \`Effect.catch\`. The stream then never fails.`
    }
  ],
  dosAndDonts: [
    {
      do: "End an infinite stream with `Stream.take`, `Stream.takeWhile`, or a run function that stops early, for example `runHead`.",
      dont: "Do not run `Stream.iterate` or `Stream.tick` with `runCollect` and no `take`.",
      why: "The consumer pulls again and again, and the program never ends."
    },
    {
      do: "Consume a stream with a run function (`runCollect`, `runForEach`, `runDrain`) before you give it to `Effect.runPromise`.",
      dont: "Do not pass a `Stream` to `Effect.runPromise`, and do not `yield*` a stream.",
      why: "A stream is not an effect, so the program does not compile and nothing runs."
    },
    {
      do: "Use `Stream.mapEffect` for a function that returns an effect.",
      dont: "Do not use `Stream.map` with a function that returns an effect.",
      why: "`map` gives a `Stream<Effect<A>>`, and the next step receives effects instead of values."
    },
    {
      do: "Give `Stream.runFold` the initial value as a function, `() => init`.",
      dont: "Do not pass a plain object or array as the initial value of `runFold`.",
      why: "A plain mutable value is shared between runs, and the second run starts with the state of the first run."
    },
    {
      do: "Put `Stream.take(n)` after `Stream.filter` when you want `n` matches.",
      dont: "Do not put `take` before `filter`.",
      why: "`take` limits the elements above it, so the filter receives only `n` candidates and emits fewer matches."
    },
    {
      do: "Sort the output of `Stream.merge`, or write code that does not depend on the order.",
      dont: "Do not depend on the element order after `Stream.merge`.",
      why: "`merge` emits elements in arrival order, and the arrival order can be different in each run."
    },
    {
      do: "Catch the error inside the `mapEffect` function with `Effect.catch` when each element must recover.",
      dont: "Do not use `Stream.catch` when the stream must continue after a bad element.",
      why: "A failure ends the stream, and `Stream.catch` replaces the rest of the stream, not the 1 element that failed."
    },
    {
      do: "Give a stream its own resource scope with `Stream.scoped` or `Stream.unwrap`.",
      dont: "Do not put `Effect.acquireRelease` in `Stream.fromEffect` and provide the scope with `Effect.scoped` around the program.",
      why: "The resource closes when the program ends, not when the stream ends, and a `take` keeps the resource open."
    }
  ],
  challenges: [
    {
      id: "stream-c1",
      title: "A stream is not an effect",
      task: `The program must print \`processing 1\`, \`processing 2\`, \`processing 3\`, but it does not compile. Change the last line only.`,
      code: `import { Effect, Stream } from "effect"

const pipeline = Stream.range(1, 3).pipe(
  Stream.tap((n) => Effect.sync(() => console.log("processing", n)))
)

Effect.runPromise(pipeline)
`,
      solution: `import { Effect, Stream } from "effect"

const pipeline = Stream.range(1, 3).pipe(
  Stream.tap((n) => Effect.sync(() => console.log("processing", n)))
)

Effect.runPromise(Stream.runDrain(pipeline))
`,
      expectedOutput: `processing 1
processing 2
processing 3`,
      hints: [
        "Read the type error. The program gives a stream to a function that expects an effect.",
        "Lesson 3 lists the functions that change a stream into an effect.",
        "You want only the side effects. Put the stream in Stream.runDrain before you run it."
      ],
      explanation: `\`Effect.runPromise\` runs effects. A stream is not an effect. A run function must first consume the stream. The run function decides the result: an array, the first element, a count, or nothing. \`runDrain\` is the "nothing" case. It is correct for a pipeline where the useful work happens in \`tap\`. The compiler found the error because \`Stream\` and \`Effect\` are different types, although they have the same 3 type parameters.`
    },
    {
      id: "stream-c2",
      title: "Groups, not windows",
      task: `The writer expects groups of 3: \`[1,2,3]\`, \`[4,5,6]\`, \`[7]\`. The program prints windows that overlap. Change 1 function name.`,
      code: `import { Effect, Stream } from "effect"

const program = Stream.range(1, 7).pipe(
  Stream.sliding(3),
  Stream.runForEach((batch) => Effect.sync(() => console.log("write", JSON.stringify(batch))))
)

Effect.runPromise(program)
`,
      solution: `import { Effect, Stream } from "effect"

const program = Stream.range(1, 7).pipe(
  Stream.grouped(3),
  Stream.runForEach((batch) => Effect.sync(() => console.log("write", JSON.stringify(batch))))
)

Effect.runPromise(program)
`,
      expectedOutput: `write [1,2,3]
write [4,5,6]
write [7]`,
      hints: [
        "Look at the output. Each element appears in up to 3 groups.",
        "sliding gives a moving window. Lesson 6 has the function for groups that do not overlap.",
        "Replace Stream.sliding(3) with Stream.grouped(3)."
      ],
      explanation: `\`sliding(n)\` emits a window of the last \`n\` elements at each step. Use it for moving averages only. \`grouped(n)\` cuts the stream into consecutive groups of \`n\` elements. The last group can be shorter. Both functions return arrays, so the type checker cannot see the difference. Only the output shows the difference.`
    },
    {
      id: "stream-c3",
      title: "map or mapEffect?",
      task: `\`lookupPrice\` returns an effect. The pipeline must print the total \`60\`, but it does not compile. Change the pipeline so that the prices are plain numbers before the sum.`,
      code: `import { Effect, Stream } from "effect"

const prices: Record<string, number> = { apple: 10, pear: 20, fig: 30 }
const lookupPrice = (item: string) => Effect.succeed(prices[item] ?? 0)

const program = Stream.make("apple", "pear", "fig").pipe(
  Stream.map((item) => lookupPrice(item)),
  Stream.runFold(() => 0, (total, price) => total + price)
)

Effect.runPromise(program).then((total) => console.log(total))
`,
      solution: `import { Effect, Stream } from "effect"

const prices: Record<string, number> = { apple: 10, pear: 20, fig: 30 }
const lookupPrice = (item: string) => Effect.succeed(prices[item] ?? 0)

const program = Stream.make("apple", "pear", "fig").pipe(
  Stream.mapEffect((item) => lookupPrice(item)),
  Stream.runFold(() => 0, (total, price) => total + price)
)

Effect.runPromise(program).then((total) => console.log(total))
`,
      expectedOutput: `60`,
      hints: [
        "What is the element type after the map step: a number, or an effect of a number?",
        "This is the map and andThen problem from Getting Started, now for streams.",
        "Use Stream.mapEffect for a function that returns an effect."
      ],
      explanation: `\`Stream.map\` puts the return value of the function into the stream without change. The stream became a \`Stream<Effect<number>>\`, and \`total + price\` tried to add an effect to a number. \`Stream.mapEffect\` runs the effect for each element and emits the result. The stream is then a \`Stream<number>\`. \`mapEffect\` is also the place for \`{ concurrency: n }\` when the lookup is slow.`
    },
    {
      id: "stream-c4",
      title: "take in the wrong place",
      task: `We want the first 4 multiples of 7 from the natural numbers. The program prints fewer. Change the pipeline so that it prints \`[ 0, 7, 14, 21 ]\`. Keep each function. Only the order is wrong.`,
      code: `import { Effect, Stream } from "effect"

const program = Stream.iterate(0, (n) => n + 1).pipe(
  Stream.take(4),
  Stream.filter((n) => n % 7 === 0),
  Stream.runCollect
)

Effect.runPromise(program).then((xs) => console.log(xs))
`,
      solution: `import { Effect, Stream } from "effect"

const program = Stream.iterate(0, (n) => n + 1).pipe(
  Stream.filter((n) => n % 7 === 0),
  Stream.take(4),
  Stream.runCollect
)

Effect.runPromise(program).then((xs) => console.log(xs))
`,
      expectedOutput: `[ 0, 7, 14, 21 ]`,
      hints: [
        "Which 4 numbers reach the filter now?",
        "take limits the stream above it in the pipe. You want to limit the multiples, not the natural numbers.",
        "Exchange the take and the filter."
      ],
      explanation: `The functions apply in pipe order. \`take(4)\` first lets \`0, 1, 2, 3\` through and then ends the stream. The filter sees only these numbers. When the filter comes first, \`take(4)\` counts multiples of 7. It pulls as many natural numbers as it needs and stops after the fourth match. The pull is lazy, so the infinite source is still safe. The stream asks it for 22 numbers only.`
    },
    {
      id: "stream-c5",
      title: "runFold needs a new start",
      task: `The word counter does not compile. Change the call to \`runFold\` so that it prints \`{"a":2,"b":1}\`.`,
      code: `import { Effect, Stream } from "effect"

const words = Stream.make("a", "b", "a")

const program = Stream.runFold(words, {} as Record<string, number>, (counts, w) => {
  counts[w] = (counts[w] ?? 0) + 1
  return counts
})

Effect.runPromise(program).then((counts) => console.log(JSON.stringify(counts)))
`,
      solution: `import { Effect, Stream } from "effect"

const words = Stream.make("a", "b", "a")

const program = Stream.runFold(words, () => ({}) as Record<string, number>, (counts, w) => {
  counts[w] = (counts[w] ?? 0) + 1
  return counts
})

Effect.runPromise(program).then((counts) => console.log(JSON.stringify(counts)))
`,
      expectedOutput: `{"a":2,"b":1}`,
      hints: [
        "Read the type error on the second argument. What does runFold expect there?",
        "Lesson 3: the initial value is a function, so each run starts with a new value.",
        "Change the second argument to () => ({}) as Record<string, number>."
      ],
      explanation: `\`runFold\` takes the initial accumulator as a function \`() => init\`. This is necessary because a stream is a description that you can run many times. With a plain \`{}\`, each run changes the same object. The second run then starts with the counts of the first run. The function form gives each run its own empty object. The same rule applies to \`Sink.reduce\` in the next section.`
    },
    {
      id: "stream-c6",
      title: "The tag that does not exist",
      task: `The stream fails with a \`ParseError\` in the middle. The catch function is in place, but the program does not compile. Change it so that it prints \`[ 1, 2, -1 ]\`.`,
      code: `import { Effect, Schema, Stream } from "effect"

class ParseError extends Schema.TaggedError<ParseError>()("ParseError", { input: Schema.String }) {}

const numbers = Stream.make(1, 2).pipe(
  Stream.concat(Stream.fail(new ParseError({ input: "x" })))
)

const program = numbers.pipe(
  Stream.catchTag("ParseFailure", (e) => Stream.make(-1)),
  Stream.runCollect
)

Effect.runPromise(program).then((xs) => console.log(xs))
`,
      solution: `import { Effect, Schema, Stream } from "effect"

class ParseError extends Schema.TaggedError<ParseError>()("ParseError", { input: Schema.String }) {}

const numbers = Stream.make(1, 2).pipe(
  Stream.concat(Stream.fail(new ParseError({ input: "x" })))
)

const program = numbers.pipe(
  Stream.catchTag("ParseError", (e) => Stream.make(-1)),
  Stream.runCollect
)

Effect.runPromise(program).then((xs) => console.log(xs))
`,
      expectedOutput: `[ 1, 2, -1 ]`,
      hints: [
        "The type error lists the tags that exist in the error type of the stream.",
        "Compare the string in catchTag with the tag in Schema.TaggedError.",
        "Change \"ParseFailure\" to \"ParseError\"."
      ],
      explanation: `\`catchTag\` accepts only the tags that exist in the \`E\` of the stream. In a plain \`try/catch\` with \`if (e.name === ...)\`, a typo catches nothing and gives no warning. Here the compiler rejects the typo, because the type knows the set of possible errors. When the tag matches, \`catchTag\` removes \`ParseError\` from \`E\`. The error type of the stream becomes \`never\`.`
    },
    {
      id: "stream-c7",
      title: "The stream that says it cannot fail",
      task: `The annotation of \`parseAll\` says that the stream cannot fail. But a line that is not a number makes the stream fail with a string. The data below is clean, so the output is correct. The program still does not compile. Make the annotation true: catch the error inside \`parseAll\`. On a bad line, the stream must end and emit nothing more. Do not change the annotation.`,
      code: `import { Effect, Stream } from "effect"

const parseNumber = (line: string) =>
  Effect.try({
    try: () => {
      const n = Number(line)
      if (Number.isNaN(n)) throw new Error()
      return n
    },
    catch: () => "not a number: " + line
  })

const parseAll = (lines: Array<string>): Stream.Stream<number> =>
  Stream.fromIterable(lines).pipe(
    Stream.mapEffect(parseNumber)
  )

Effect.runPromise(Stream.runCollect(parseAll(["10", "20", "30"]))).then((xs) => console.log(xs))
`,
      solution: `import { Effect, Stream } from "effect"

const parseNumber = (line: string) =>
  Effect.try({
    try: () => {
      const n = Number(line)
      if (Number.isNaN(n)) throw new Error()
      return n
    },
    catch: () => "not a number: " + line
  })

const parseAll = (lines: Array<string>): Stream.Stream<number> =>
  Stream.fromIterable(lines).pipe(
    Stream.mapEffect(parseNumber),
    Stream.catch(() => Stream.empty)
  )

Effect.runPromise(Stream.runCollect(parseAll(["10", "20", "30"]))).then((xs) => console.log(xs))
`,
      expectedOutput: `[ 10, 20, 30 ]`,
      hints: [
        "Stream.Stream<number> is short for Stream<number, never, never>. Which step adds a string to the error slot?",
        "Lesson 11: a catch function on a stream returns a stream that continues after the failure. Which stream emits nothing?",
        "Add Stream.catch(() => Stream.empty) after the mapEffect."
      ],
      explanation: `This error is not visible at run time with clean input. The program prints the correct result. The compiler still rejects the program, because \`Effect.try\` put \`string\` into the error channel and the annotation promised \`never\`. \`Stream.catch\` removes the error from \`E\` and makes the annotation true. It also makes you decide now what a bad line means. Here, the stream stops. Without types, the first caller that crashes makes this decision.`
    },
    {
      id: "stream-c8",
      title: "The queue that cannot end",
      task: `A producer fiber offers 3 jobs into a queue and ends the queue. The output is correct, but the program does not compile. Change the type arguments of the queue only.`,
      code: `import { Effect, Queue, Stream } from "effect"

const program = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<string>()

  yield* Effect.forkChild(Effect.gen(function* () {
    yield* Queue.offerAll(queue, ["job-1", "job-2", "job-3"])
    yield* Queue.end(queue)
  }))

  const jobs = yield* Stream.runCollect(Stream.fromQueue(queue))
  console.log(jobs)
})

Effect.runPromise(program)
`,
      solution: `import { Cause, Effect, Queue, Stream } from "effect"

const program = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<string, Cause.Done>()

  yield* Effect.forkChild(Effect.gen(function* () {
    yield* Queue.offerAll(queue, ["job-1", "job-2", "job-3"])
    yield* Queue.end(queue)
  }))

  const jobs = yield* Stream.runCollect(Stream.fromQueue(queue))
  console.log(jobs)
})

Effect.runPromise(program)
`,
      expectedOutput: `[ "job-1", "job-2", "job-3" ]`,
      hints: [
        "Read the type error on Queue.end. It expects a queue whose error type includes Done.",
        "The lesson \"Streams from the outside\" says where the end signal of a queue travels.",
        "Write Queue.unbounded<string, Cause.Done>() and import Cause."
      ],
      explanation: `\`Queue.end\` puts a \`Done\` value into the error channel of the queue. A \`Queue<string, never>\` has no room for it, so the compiler rejects the call. At run time the queue ends without a problem, and the output is correct. The type still matters. \`Stream.fromQueue\` removes \`Done\` from the error type of the stream. With the correct type, the compiler knows that the queue can end, and the stream type stays \`Stream<string>\`.`
    },
    {
      id: "stream-c9",
      title: "The file that closes too late",
      task: `The stream reads 2 lines of a file. The file must close before "next task" prints. The program compiles and runs, but the close comes too late. Change the definition of \`lines\` only.`,
      code: `import { Effect, Stream } from "effect"

const openFile = Effect.acquireRelease(
  Effect.sync(() => {
    console.log("open")
    return ["l1", "l2", "l3"]
  }),
  () => Effect.sync(() => console.log("close"))
)

const lines = Stream.fromEffect(openFile).pipe(
  Stream.flatMap((all) => Stream.fromIterable(all))
)

const program = Effect.gen(function* () {
  console.log(yield* lines.pipe(Stream.take(2), Stream.runCollect))
  console.log("next task")
})

Effect.runPromise(Effect.scoped(program))
`,
      solution: `import { Effect, Stream } from "effect"

const openFile = Effect.acquireRelease(
  Effect.sync(() => {
    console.log("open")
    return ["l1", "l2", "l3"]
  }),
  () => Effect.sync(() => console.log("close"))
)

const lines = Stream.scoped(Stream.fromEffect(openFile)).pipe(
  Stream.flatMap((all) => Stream.fromIterable(all))
)

const program = Effect.gen(function* () {
  console.log(yield* lines.pipe(Stream.take(2), Stream.runCollect))
  console.log("next task")
})

Effect.runPromise(Effect.scoped(program))
`,
      expectedOutput: `open
close
[ "l1", "l2" ]
next task`,
      hints: [
        "Which scope owns the file now? Look at the Effect.scoped on the last line.",
        "The lesson \"Resource safety in streams\" gives the stream its own scope for each run.",
        "Wrap Stream.fromEffect(openFile) in Stream.scoped(...)."
      ],
      explanation: `\`Stream.fromEffect(openFile)\` leaves \`Scope\` in the \`R\` of the stream. The \`Effect.scoped\` on the last line provides that scope. The file then closes when the whole program ends, after "next task". \`Stream.scoped\` gives the stream its own scope for each run. The scope closes when the run ends, so the close comes directly after \`take(2)\`, before the result prints. The \`Effect.scoped\` on the last line is now not necessary, but it does no harm.`
    },
    {
      id: "stream-c10",
      title: "broadcast needs a scope",
      task: `2 reports read 1 broadcast stream. The program does not compile. Do not change the reports. Make the program provide what \`Stream.broadcast\` needs.`,
      code: `import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const shared = yield* Stream.broadcast(Stream.make(3, 1, 4), { capacity: 8 })

  const [sum, max] = yield* Effect.all([
    Stream.runFold(shared, () => 0, (a, b) => a + b),
    Stream.runFold(shared, () => 0, (a, b) => Math.max(a, b))
  ], { concurrency: "unbounded" })

  console.log("sum", sum, "max", max)
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Stream } from "effect"

const program = Effect.gen(function* () {
  const shared = yield* Stream.broadcast(Stream.make(3, 1, 4), { capacity: 8 })

  const [sum, max] = yield* Effect.all([
    Stream.runFold(shared, () => 0, (a, b) => a + b),
    Stream.runFold(shared, () => 0, (a, b) => Math.max(a, b))
  ], { concurrency: "unbounded" })

  console.log("sum", sum, "max", max)
})

Effect.runPromise(Effect.scoped(program))
`,
      expectedOutput: `sum 8 max 4`,
      hints: [
        "Read the type error on the last line. Which service is in the R of program?",
        "Stream.broadcast starts a PubSub, so it returns an effect that needs a Scope. The lesson \"Group, buffer, broadcast\" shows where the scope comes from.",
        "Wrap program in Effect.scoped before you run it."
      ],
      explanation: `\`Stream.broadcast\` returns \`Effect<Stream<A>, never, Scope>\`. The PubSub that it starts must stop at some point, and the scope decides when. Without a scope, the type \`Effect<void, never, Scope>\` does not match the \`never\` that \`Effect.runPromise\` expects. \`Effect.scoped\` makes a scope, runs the program inside it, and closes the scope at the end. The compiler found the absent scope before the program ran. At run time, the absent service is a defect.`
    }
  ],
  problems: [
    {
      id: "stream-p1",
      title: "Log line pipeline",
      spec: `
You receive raw log lines. Build a stream pipeline that parses, filters and counts the lines.

1. \`parse(line)\` splits the line at the first space into \`{ level, message }\`. A line with a level other than \`INFO\`, \`WARN\` or \`ERROR\` is malformed.
2. Use \`Stream.flatMap\` to remove malformed lines with \`Stream.empty\`. Good lines pass through.
3. Use \`Stream.tap\` to print \`alert: <message>\` for each \`ERROR\` line when the line passes.
4. Use \`Stream.runFold\` to count the lines for each level in a \`Record<string, number>\`.

Exact output:

\`\`\`
alert: disk full
alert: timeout
{"INFO":2,"ERROR":2,"WARN":1}
\`\`\`
`,
      starter: `import { Effect, Stream } from "effect"

const lines = [
  "INFO server started",
  "ERROR disk full",
  "garbage line",
  "WARN slow query",
  "INFO request ok",
  "ERROR timeout"
]

interface Entry {
  readonly level: string
  readonly message: string
}

// TODO: parse(line): Entry | null

const program = Stream.fromIterable(lines).pipe(
  // TODO: flatMap to drop malformed lines
  // TODO: tap to print alerts for ERROR lines
  // TODO: runFold into counts per level
  Stream.runCollect
)

Effect.runPromise(program).then((counts) => console.log(JSON.stringify(counts)))
`,
      solution: `import { Effect, Stream } from "effect"

const lines = [
  "INFO server started",
  "ERROR disk full",
  "garbage line",
  "WARN slow query",
  "INFO request ok",
  "ERROR timeout"
]

interface Entry {
  readonly level: string
  readonly message: string
}

const levels = new Set(["INFO", "WARN", "ERROR"])

const parse = (line: string): Entry | null => {
  const i = line.indexOf(" ")
  if (i < 0) return null
  const level = line.slice(0, i)
  return levels.has(level) ? { level, message: line.slice(i + 1) } : null
}

const program = Stream.fromIterable(lines).pipe(
  Stream.flatMap((line) => {
    const entry = parse(line)
    return entry === null ? Stream.empty : Stream.succeed(entry)
  }),
  Stream.tap((entry) =>
    entry.level === "ERROR" ? Effect.sync(() => console.log("alert: " + entry.message)) : Effect.void
  ),
  Stream.runFold(() => ({}) as Record<string, number>, (counts, entry) => {
    counts[entry.level] = (counts[entry.level] ?? 0) + 1
    return counts
  })
)

Effect.runPromise(program).then((counts) => console.log(JSON.stringify(counts)))
`,
      expectedOutput: `alert: disk full
alert: timeout
{"INFO":2,"ERROR":2,"WARN":1}`,
      hints: [
        "flatMap with a function that returns Stream.empty or Stream.succeed(entry) emits 0 or 1 element for each input element.",
        "tap must return an effect for each element. Use Effect.void for the lines that you do not print.",
        "runFold replaces runCollect at the end. The initial value is a function: () => ({}) as Record<string, number>."
      ]
    },
    {
      id: "stream-p2",
      title: "Paginated API fetcher",
      spec: `
A test API returns users 1 page at a time. \`api.page(cursor)\` is given. It returns a Promise of \`{ users, next }\`. \`next\` is the next cursor, or \`null\` on the last page. Each call increments \`api.calls\`.

1. Write \`fetchPage(cursor)\`. It puts \`api.page\` in \`Effect.promise\` and returns the pair \`[users, Option<cursor>]\` that \`Stream.paginate\` needs.
2. \`allUsers\` is \`Stream.paginate(0, fetchPage)\`.
3. Take 3 users, collect them, and print their names. Then print the number of API calls.
4. Set \`api.calls\` to 0. Print the number of all users with \`Stream.runCount\`. Then print the number of API calls again.

Exact output:

\`\`\`
first three [ "u1", "u2", "u3" ]
calls 2
total users 5
calls 3
\`\`\`
`,
      starter: `import { Effect, Option, Stream } from "effect"

const api = {
  calls: 0,
  page: (cursor: number): Promise<{ users: Array<string>; next: number | null }> => {
    api.calls++
    const pages = [["u1", "u2"], ["u3", "u4"], ["u5"]]
    return Promise.resolve({ users: pages[cursor] ?? [], next: cursor < 2 ? cursor + 1 : null })
  }
}

// TODO: fetchPage(cursor) returning Effect<readonly [Array<string>, Option<number>]>

// TODO: allUsers = Stream.paginate(0, fetchPage)

const program = Effect.gen(function* () {
  // TODO: first three, then calls
  // TODO: reset calls, runCount, then calls
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Option, Stream } from "effect"

const api = {
  calls: 0,
  page: (cursor: number): Promise<{ users: Array<string>; next: number | null }> => {
    api.calls++
    const pages = [["u1", "u2"], ["u3", "u4"], ["u5"]]
    return Promise.resolve({ users: pages[cursor] ?? [], next: cursor < 2 ? cursor + 1 : null })
  }
}

const fetchPage = (cursor: number) =>
  Effect.promise(() => api.page(cursor)).pipe(
    Effect.map((res) => [res.users, Option.fromNullOr(res.next)] as const)
  )

const allUsers = Stream.paginate(0, fetchPage)

const program = Effect.gen(function* () {
  const three = yield* allUsers.pipe(Stream.take(3), Stream.runCollect)
  console.log("first three", three)
  console.log("calls", api.calls)

  api.calls = 0
  const total = yield* Stream.runCount(allUsers)
  console.log("total users", total)
  console.log("calls", api.calls)
})

Effect.runPromise(program)
`,
      expectedOutput: `first three [ "u1", "u2", "u3" ]
calls 2
total users 5
calls 3`,
      hints: [
        "Stream.paginate expects a step function that returns an effect of [elements, Option<nextCursor>]. Option.fromNullOr changes number | null into an Option.",
        "Put the Promise in Effect.promise (it cannot reject here). Use Effect.map to change the shape of the result.",
        "3 users need pages 0 and 1 only. This is the laziness from lesson 4. It is the reason why the first call count is 2."
      ]
    },
    {
      id: "stream-p3",
      title: "Moving average with alerts",
      spec: `
Temperature readings arrive as a stream. Compute a moving average over a window of 3 readings. Print an alert when the average is above a limit.

1. \`readings\` is \`Stream.make(20, 22, 27, 31, 33, 28, 24)\`.
2. Use \`Stream.sliding(3)\` to get the windows. Use \`Stream.map\` to change each window into its average. Format each average with \`toFixed(1)\`.
3. Use \`Stream.tap\` to print \`ALERT <average>\` when an average is above \`29\`.
4. End with \`Stream.runForEach\`. Print \`avg <average>\` for each window.

Exact output:

\`\`\`
avg 23.0
avg 26.7
ALERT 30.3
avg 30.3
ALERT 30.7
avg 30.7
avg 28.3
\`\`\`
`,
      starter: `import { Effect, Stream } from "effect"

const readings = Stream.make(20, 22, 27, 31, 33, 28, 24)

const program = readings.pipe(
  // TODO: sliding windows of 3
  // TODO: map each window to its average
  // TODO: tap: print ALERT when the average is above 29
  // TODO: runForEach printing "avg <value>" with toFixed(1)
  Stream.runDrain
)

Effect.runPromise(program)
`,
      solution: `import { Effect, Stream } from "effect"

const readings = Stream.make(20, 22, 27, 31, 33, 28, 24)

const average = (window: ReadonlyArray<number>) =>
  window.reduce((sum, n) => sum + n, 0) / window.length

const program = readings.pipe(
  Stream.sliding(3),
  Stream.map(average),
  Stream.tap((avg) =>
    avg > 29 ? Effect.sync(() => console.log("ALERT " + avg.toFixed(1))) : Effect.void
  ),
  Stream.runForEach((avg) => Effect.sync(() => console.log("avg " + avg.toFixed(1))))
)

Effect.runPromise(program)
`,
      expectedOutput: `avg 23.0
avg 26.7
ALERT 30.3
avg 30.3
ALERT 30.7
avg 30.7
avg 28.3`,
      hints: [
        "sliding(3) emits an array for each position after 3 readings are available. 7 readings give 5 windows.",
        "tap runs before runForEach for the same element. This is the reason why each ALERT line comes before its avg line.",
        "runForEach replaces runDrain. It is the run function that does an effect for each element."
      ]
    }
  ],
  recall: [
    {
      q: "What is the type of `Stream.runCollect(Stream.make(1, 2, 3))`?",
      a: "`Effect<Array<number>, never, never>`. Each run function changes a stream into an effect. You must use `yield*` or `Effect.runPromise` to get the array."
    },
    {
      q: "What happens when you `runCollect` an infinite stream, for example `Stream.iterate(0, n => n + 1)`, without a `take`?",
      a: "The run never ends. The consumer pulls again and again, and the producer always has more elements. Each infinite stream must have a `take`, a `takeWhile`, or a run function that stops early, for example `runHead`."
    },
    {
      q: "Which function do you use to call an API once for each element, with 3 calls at the same time, and keep the output order?",
      a: "`Stream.mapEffect(f, { concurrency: 3 })`. It runs the effect for each element with a concurrency limit and emits the results in the input order. Add `unordered: true` when the order is not important."
    },
    {
      q: "Why does `Stream.runFold` take `() => 0` and not `0`?",
      a: "You can run a stream many times, and each run must start with a new initial value. With a mutable initial value such as `{}` or `[]`, a plain value is shared between the runs."
    },
    {
      q: "What does a pull-based stream give you?",
      a: "The producer emits nothing before the consumer asks. This gives backpressure (a slow consumer does not receive too many elements), laziness (the stream fetches only the pages that you `take`), and safe infinite sources."
    },
    {
      q: "You have a paginated API. Each call returns elements and a next cursor. Which constructor do you use?",
      a: "`Stream.paginate(firstCursor, fetch)`. `fetch` returns an effect of `[elements, Option<nextCursor>]`. `Option.none()` ends the stream."
    },
    {
      q: "A stream fails in the middle. What does `Stream.catchTag(\"Tag\", (e) => Stream.make(x))` do with the elements after the failure?",
      a: "They are lost. The failure ends the original stream, and the replacement stream continues from that point. For recovery of each element, catch the error inside the `mapEffect` function. The stream then never fails."
    },
    {
      q: "A library gives you events through `on(callback)` and `off()`. Which constructor makes a stream from it?",
      a: "`Stream.callback((queue) => Effect.acquireRelease(register, remove))`. Push with `Queue.offerUnsafe(queue, x)` from the callback, and end with `Queue.endUnsafe(queue)`. The release removes the callback when the stream ends, also after a `take`."
    }
  ]
}

export default section
