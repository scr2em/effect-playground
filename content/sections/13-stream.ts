import type { Section } from "../types.ts"

const section: Section = {
  id: "stream",
  title: "Stream",
  order: 13,
  summary: "Streams: an Effect that produces many values, lazily, with typed errors, backpressure and concurrency.",
  intro: `
**The problem.** When data comes in pieces, plain TypeScript gives you two tools and both hurt. The first is an array:

\`\`\`ts
const rows = await db.loadAllRows()          // 2 million rows in memory
const top = rows.filter(isPaid).map(total).slice(0, 10)
\`\`\`

You wanted ten rows, you loaded two million. The second tool is an async generator with \`for await\`:

\`\`\`ts
async function* rows() { /* yield one row at a time */ }
for await (const row of rows()) { /* ... */ }
\`\`\`

This fixes memory but nothing else. There is no error type: a throw inside the generator crashes the loop. There is no way to process three rows at a time without hand-written bookkeeping. If you \`break\` out of the loop, cleanup of the underlying connection is your job. And you cannot hand the loop to another function to add a retry or a timeout, because a loop is not a value.

### The shift

Today you think of a sequence as **something you pull from with a loop and hope for the best**. Effect asks you to think of it as **a value that describes many results**. A \`Stream<A, E, R>\` is an Effect that, when run, produces zero or more \`A\` values instead of exactly one. Same three type parameters, same rules: it does nothing until run, its errors are typed, its requirements are tracked.

Because it is a value you get the rest for free. \`Stream.map\` and \`Stream.filter\` work like array methods but process one element at a time. \`Stream.take(10)\` stops the producer after ten elements, so an infinite source is fine. The consumer pulls: a slow consumer does not get buried under a fast producer, which is what "backpressure" means. Resources opened by the stream are closed when it ends, whether it finished, failed, or was interrupted.

| | Array | Async generator | Stream |
|---|---|---|---|
| Memory | Everything at once | One at a time | One chunk at a time |
| Error type | none, throws | none, throws | Tracked in \`E\` |
| Concurrency | \`Promise.all\` on the whole array | Manual | \`mapEffect(f, { concurrency })\` |
| Stops early | \`slice\` after loading all | \`break\` | \`take\`, \`takeWhile\` |
| Cleanup on stop | n/a | \`finally\` in the generator | Automatic |
| Retry / timeout | Wrap by hand | Wrap by hand | \`Stream.retry\`, \`Stream.timeout\` |

In this section you will build streams, transform them, run them, and see why laziness matters. The consumer side gets its own section next: Sink.
`,
  lessons: [
    {
      id: "stream-l1",
      title: "A Stream is an Effect that produces many values",
      explain: `
You build a Stream the same way you build an Effect: with a constructor. And like an Effect, a Stream is only a description. Nothing runs until you hand it to a \`run\` function.

| Constructor | Produces | Use when |
|---|---|---|
| \`Stream.make(1, 2, 3)\` | The given values | Fixed test data |
| \`Stream.fromIterable(xs)\` | Every element of an array, Set, or generator | You already have a collection |
| \`Stream.range(1, 5)\` | \`1, 2, 3, 4, 5\` (both ends included) | Counting |
| \`Stream.fromEffect(eff)\` | One value, the result of the Effect | Lift a single Effect |
| \`Stream.succeed(x)\` / \`Stream.fail(e)\` | One value / no values, fails | The single-element cases |
| \`Stream.fromQueue(q)\` | Values offered to a Queue, until \`Queue.end\` | Something else pushes data in |

\`Stream.runCollect\` runs a stream and gathers every value into an array. It returns an \`Effect<Array<A>, E, R>\`, so you still need \`yield*\` or a runner to get the array. That is the pattern for the whole section: a \`run\` function turns a Stream into an Effect.
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
      after: `The "producing" lines appear after "built, nothing produced yet". Try running \`Stream.runCollect(numbers)\` twice: the stream produces its values again, because it is a recipe. Try deleting \`Queue.end\`: the queue stream waits forever for more values, and the program never finishes.`
    },
    {
      id: "stream-l2",
      title: "Transforming: the array methods, one element at a time",
      explain: `
The everyday operators look like array methods, and read the same way in a \`pipe\`. The difference is that they process elements as they arrive instead of building a new array at every step.

| Stream | Array equivalent | Notes |
|---|---|---|
| \`Stream.map(f)\` | \`.map(f)\` | Pure transformation |
| \`Stream.filter(p)\` | \`.filter(p)\` | Type guards narrow the element type |
| \`Stream.take(n)\` | \`.slice(0, n)\` | Also stops the producer |
| \`Stream.drop(n)\` | \`.slice(n)\` | |
| \`Stream.takeWhile(p)\` | Loop with \`break\` | Stops at the first failing element |
| \`Stream.tap(f)\` | Log inside \`.map\` | Runs an Effect per element, keeps the element |
| \`Stream.scan(init, f)\` | \`.reduce\`, but emitting every step | Running totals |

\`scan\` is the one without a direct array twin. It is a \`reduce\` that emits the accumulator after every element (and the initial value first), so a stream of amounts becomes a stream of running balances.
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
      after: `Remove the \`Stream.drop(1)\` and the balance list starts with the initial \`0\`. \`scan\` always emits the seed first; that is useful when the seed is a real state, and noise when it is not.`
    },
    {
      id: "stream-l3",
      title: "Running: the run family",
      explain: `
A Stream becomes an Effect only through a \`run\` function. Pick the one that matches the shape of the answer you want. Collecting everything into an array is the most common and also the one that gives up the memory benefit, so learn the others.

| Function | Result type | Use when |
|---|---|---|
| \`Stream.runCollect\` | \`Effect<Array<A>>\` | You need all values, and they fit in memory |
| \`Stream.runHead\` | \`Effect<Option<A>>\` | Only the first value matters; stops early |
| \`Stream.runLast\` | \`Effect<Option<A>>\` | Only the final value matters |
| \`Stream.runFold(() => init, f)\` | \`Effect<Z>\` | Reduce to one value (sum, max, a Map) |
| \`Stream.runForEach(f)\` | \`Effect<void>\` | Do an Effect per element (write, send) |
| \`Stream.runDrain\` | \`Effect<void>\` | Run for the side effects in \`tap\`, ignore values |
| \`Stream.runCount\` | \`Effect<number>\` | How many elements |

Two details that catch people. \`runHead\` and \`runLast\` return an \`Option\`, because the stream may be empty; use \`Option.getOrElse\` or \`Option.match\` to print. And \`runFold\` takes the initial value as a function \`() => init\`, not a plain value, so that each run starts from a fresh accumulator (a fresh \`[]\` or \`new Map()\`).
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
      after: `\`runHead\` stopped pulling after the first element; the stream never produced the others. Compare with \`runLast\`, which had to pull all four. Choosing the right runner is how you avoid doing work you throw away.`
    },
    {
      id: "stream-l4",
      title: "Pull and laziness: infinite streams are fine",
      explain: `
A Stream is pull-based. The consumer asks for the next chunk; the producer computes it and waits. Nothing is produced ahead of demand. Two things follow from this.

First, an infinite stream is a normal value. \`Stream.iterate(0, (n) => n + 1)\` describes every natural number. Add \`Stream.take(5)\` and the run finishes after five pulls. Forget the \`take\` and \`runCollect\` never returns, because it keeps asking for more. This is the one rule of this section: **an infinite stream must end with a \`take\`, \`takeWhile\`, or a runner that stops early such as \`runHead\`.**

Second, laziness means expensive sources do only the work that is consumed. In the example, \`fetchPage\` counts how many times it is called. Taking three items from pages of two calls it twice, not four times.

| Constructor | Ends? | What it does |
|---|---|---|
| \`Stream.iterate(seed, next)\` | Never | \`seed, next(seed), next(next(seed)), ...\` |
| \`Stream.unfold(seed, step)\` | When \`step\` returns \`undefined\` | Like iterate, but each step is an Effect and can stop |
| \`Stream.tick(interval)\` | Never | One \`void\` immediately, then one per interval |
| \`Stream.fromSchedule(s)\` | When the schedule ends | One value per schedule step, with the schedule's delays |
| \`Stream.paginate(cursor, fetch)\` | When \`fetch\` returns \`Option.none()\` for the next cursor | Paginated APIs |
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
      after: `Notice the \`take(5)\` comes after the \`filter\`. Take five, then filter, would give you at most five candidates and fewer results. Order in a pipeline is order of pulling. Try moving the \`take\` above the \`filter\` and see how many squares come out.`
    },
    {
      id: "stream-l5",
      title: "Side by side: async generator vs Stream with mapEffect",
      explain: `
Here is a common job in plain TypeScript: for a list of ids, call a slow API for each, keep the results in order, and do not run more than three calls at once.

\`\`\`ts
async function* enrich(ids: number[]) {
  // "three at a time, keep order" needs a manual worker pool.
  // Most people give up and write either a serial loop (slow)
  // or Promise.all (unbounded, order kept only by luck of the array index).
  for (const id of ids) yield await fetchUser(id)
}
for await (const user of enrich([1, 2, 3, 4, 5, 6])) console.log(user)
\`\`\`

\`Stream.mapEffect\` is \`map\` for functions that return an Effect. Without options it runs one at a time. With \`{ concurrency: 3 }\` it keeps three in flight and still emits results in the original order. The example tracks the peak number of in-flight calls to prove it; that number is stable because every call waits the same tiny amount.
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
      after: `The results stay in order even though calls overlap. If you do not care about order, add \`unordered: true\` to the options and results are emitted as soon as they finish. \`Stream.tap\` accepts the same \`concurrency\` option, and \`Stream.flatMap\` does too for stream-returning functions.`
    },
    {
      id: "stream-l6",
      title: "Combining streams: zip, merge, flatMap, grouped",
      explain: `
Real pipelines have more than one source, or need to reshape elements into batches. These operators combine or regroup.

| Operator | Result | Use when |
|---|---|---|
| \`Stream.zip(other)\` | Pairs \`[a, b]\`, stops at the shorter | Two streams that line up, like values and indexes |
| \`Stream.zipWith(other, f)\` | \`f(a, b)\` per pair | Same, without the tuple |
| \`Stream.merge(other)\` | Elements of both, in arrival order | Two independent sources (two queues, two sockets) |
| \`Stream.flatMap(f)\` | Every element of every \`f(a)\` | One input becomes zero or more outputs |
| \`Stream.grouped(n)\` | Arrays of \`n\` elements, last may be shorter | Batching writes |
| \`Stream.groupedWithin(n, duration)\` | Arrays of up to \`n\`, or whatever arrived within the duration | Batching with a latency bound |

\`merge\` interleaves in the order elements become ready, so its output order is not guaranteed. The example sorts the merged values before printing; in a real program you would not rely on the order at all. \`flatMap\` returning \`Stream.empty\` is the idiom for "drop this element", and returning \`Stream.make(x, y)\` is "expand into two".
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
      after: `\`zipWith\` against the infinite \`Stream.iterate(1, ...)\` is safe: zip stops when \`names\` ends, so the infinite side is only pulled three times. \`Stream.zipWithIndex\` is the shortcut for exactly this numbering.`
    },
    {
      id: "stream-l7",
      title: "Errors in streams: catch, catchTag, retry",
      explain: `
A stream's \`E\` works like an Effect's. Any element step can fail, and the first failure ends the stream. The handlers mirror the Effect ones, but the recovery is a *stream*: whatever you return continues the output from the point of failure.

| Function | What it does |
|---|---|
| \`Stream.catch((e) => fallbackStream)\` | Handle every error, continue with another stream |
| \`Stream.catchTag("Tag", (e) => fallbackStream)\` | Handle one tagged error, others stay in \`E\` |
| \`Stream.retry(schedule)\` | Re-run the whole stream from the start on failure |
| \`Stream.mapError(f)\` | Change the error type, do not handle it |

\`retry\` restarts the stream, so it re-runs whatever opened it. That is right for a source that failed to connect, and wrong for a source that already emitted half its elements to a consumer that cannot handle duplicates. Wrap the source in \`Stream.suspend\` when the failure depends on state that changes between attempts, as the flaky source below does.
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
      after: `"never reached" is never emitted: a failure ends the stream, and the fallback replaces the rest, not the failed element only. If you need per-element recovery, handle the error inside the \`mapEffect\` function with \`Effect.catch\` so the stream itself never fails.`
    }
  ],
  challenges: [
    {
      id: "stream-c1",
      title: "A stream is not an Effect",
      task: `The program should print \`processing 1\`, \`processing 2\`, \`processing 3\` but it does not compile. Fix the last line without touching the pipeline.`,
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
        "Read the type error: a Stream is being passed where an Effect is expected.",
        "Lesson 3 lists the functions that turn a Stream into an Effect.",
        "You only want the side effects, so wrap the stream in Stream.runDrain before running it."
      ],
      explanation: `\`Effect.runPromise\` runs Effects, and a Stream is not one. A Stream must first be consumed by a \`run\` function, which decides what the result is: an array, the first value, a count, or nothing. \`runDrain\` is the "nothing" case, right for a pipeline whose useful work happens in \`tap\`. The compiler caught it because \`Stream\` and \`Effect\` are different types, even though they share three type parameters.`
    },
    {
      id: "stream-c2",
      title: "Batches, not windows",
      task: `The writer expects batches of three: \`[1,2,3]\`, \`[4,5,6]\`, \`[7]\`. The program prints overlapping windows instead. Change one function name.`,
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
        "Look at the output: every element appears in up to three batches.",
        "sliding gives a moving window. Lesson 6 has the operator for non-overlapping groups.",
        "Replace Stream.sliding(3) with Stream.grouped(3)."
      ],
      explanation: `\`sliding(n)\` emits a window of the last \`n\` elements at every step, which is what you want for moving averages and nothing else. \`grouped(n)\` cuts the stream into consecutive pieces of \`n\`, with a shorter final piece. Both return arrays, so the type checker could not tell them apart; only the output did.`
    },
    {
      id: "stream-c3",
      title: "map or mapEffect?",
      task: `\`lookupPrice\` returns an Effect. The pipeline should print the total \`60\`, but it does not compile. Fix the pipeline so the prices are plain numbers before they are summed.`,
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
        "What is the element type after the map step: a number, or an Effect of a number?",
        "The same map versus andThen problem from Getting Started, now for streams.",
        "Use Stream.mapEffect for a function that returns an Effect."
      ],
      explanation: `\`Stream.map\` wraps whatever the function returns, so the stream became a \`Stream<Effect<number>>\` and \`total + price\` tried to add an Effect to a number. \`Stream.mapEffect\` runs the Effect for each element and emits its result, giving a \`Stream<number>\`. It is also where you would add \`{ concurrency: n }\` if the lookup were slow.`
    },
    {
      id: "stream-c4",
      title: "take in the wrong place",
      task: `We want the first four multiples of 7 from the naturals. The program prints fewer. Fix the pipeline so it prints \`[ 0, 7, 14, 21 ]\`. Keep every operator; only their order is wrong.`,
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
        "Which four numbers reach the filter right now?",
        "take limits whatever is above it in the pipe. You want to limit the multiples, not the naturals.",
        "Swap the take and the filter."
      ],
      explanation: `Operators apply in pipe order. \`take(4)\` first lets through \`0, 1, 2, 3\` and ends the stream; the filter then sees only those. Filter first and \`take(4)\` counts multiples of 7, pulling as many naturals as it needs and stopping after the fourth match. Because pulling is lazy, the infinite source is still safe: it is only asked for 22 numbers.`
    },
    {
      id: "stream-c5",
      title: "runFold wants a fresh start",
      task: `The word counter does not compile. Fix the call to \`runFold\` so it prints \`{"a":2,"b":1}\`.`,
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
        "Read the type error on the second argument: what does runFold expect there?",
        "Lesson 3: the initial value is given as a function so every run starts from a fresh value.",
        "Change the second argument to () => ({}) as Record<string, number>."
      ],
      explanation: `\`runFold\` takes the initial accumulator as a function \`() => init\`. This looks like ceremony until you remember that a stream is a description you can run many times. With a plain \`{}\` every run would share and mutate the same object, and the second run would start with the first run's counts. The lazy form gives each run its own empty object. The same rule applies to \`Sink.reduce\` in the next section.`
    },
    {
      id: "stream-c6",
      title: "The tag that does not exist",
      task: `The stream fails with a \`ParseError\` halfway. The recovery is in place but the program does not compile. Fix it so it prints \`[ 1, 2, -1 ]\`.`,
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
        "The type error lists the tags that are actually in the stream's error type.",
        "Compare the string in catchTag with the tag given to Schema.TaggedError.",
        "Change \"ParseFailure\" to \"ParseError\"."
      ],
      explanation: `\`catchTag\` only accepts tags that exist in the stream's \`E\`. A typo would silently catch nothing in a plain \`try/catch\` with \`if (e.name === ...)\`; here the compiler refuses it, because the set of possible errors is known from the type. Once the tag matches, \`ParseError\` is removed from \`E\` and the stream's error type becomes \`never\`.`
    },
    {
      id: "stream-c7",
      title: "The stream that claims it cannot fail",
      task: `\`parseAll\` is annotated as a stream that cannot fail, but a line that is not a number makes it fail with a string. The data below happens to be clean, so the output is right, yet the program does not compile. Make the annotation true by handling the error inside \`parseAll\`: on a bad line the stream should end, emitting nothing more. Do not change the annotation.`,
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
        "Lesson 7: a handler on a stream returns a stream that continues from the failure. Which stream emits nothing?",
        "Add Stream.catch(() => Stream.empty) after the mapEffect."
      ],
      explanation: `This bug is invisible at runtime with clean input: the program prints the right answer. The compiler still rejects it, because \`Effect.try\` put \`string\` into the error channel and the annotation promised \`never\`. Handling the error with \`Stream.catch\` removes it from \`E\` and makes the promise true, and it forces you to decide now what a bad line means (here: stop quietly). Without types, that decision would be made by whichever caller crashed first.`
    }
  ],
  problems: [
    {
      id: "stream-p1",
      title: "Log line pipeline",
      spec: `
You receive raw log lines. Build a stream pipeline that parses, filters and counts them.

1. \`parse(line)\` splits on the first space into \`{ level, message }\`. A line whose level is not \`INFO\`, \`WARN\` or \`ERROR\` is malformed.
2. Use \`Stream.flatMap\` so malformed lines are dropped (\`Stream.empty\`) and good lines pass through.
3. Print \`alert: <message>\` for every \`ERROR\` line using \`Stream.tap\`, as they pass.
4. Count lines per level with \`Stream.runFold\` into a \`Record<string, number>\`.

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
        "flatMap with a function returning Stream.empty or Stream.succeed(entry) is the way to emit zero or one element per input.",
        "tap must return an Effect for every element; use Effect.void for the lines you do not want to print.",
        "runFold replaces runCollect at the end. Remember the initial value is a function: () => ({}) as Record<string, number>."
      ]
    },
    {
      id: "stream-p2",
      title: "Paginated API fetcher",
      spec: `
A fake API returns users one page at a time. \`api.page(cursor)\` is given: it returns a Promise of \`{ users, next }\` where \`next\` is the next cursor or \`null\` on the last page. It also increments \`api.calls\`.

1. Write \`fetchPage(cursor)\` that wraps \`api.page\` in \`Effect.promise\` and returns the \`[users, Option<cursor>]\` pair that \`Stream.paginate\` needs.
2. \`allUsers\` is \`Stream.paginate(0, fetchPage)\`.
3. Print the first three user names by taking three and collecting, then print how many API calls that took.
4. Reset \`api.calls\` to 0, print the count of all users using \`Stream.runCount\`, then print the calls again.

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
        "Stream.paginate wants the step to return an Effect of [items, Option<nextCursor>]. Option.fromNullOr turns number | null into an Option.",
        "Wrap the Promise with Effect.promise (it cannot reject here) and Effect.map to reshape the result.",
        "Taking three items needs pages 0 and 1 only. That is the laziness from lesson 4, and it is why the first calls count is 2."
      ]
    },
    {
      id: "stream-p3",
      title: "Moving average with alerts",
      spec: `
Temperature readings arrive as a stream. Compute a moving average over a window of three readings and alert when it crosses a threshold.

1. \`readings\` is \`Stream.make(20, 22, 27, 31, 33, 28, 24)\`.
2. Use \`Stream.sliding(3)\` to get windows, then \`Stream.map\` to their average. Format each average with \`toFixed(1)\`.
3. Use \`Stream.tap\` to print \`ALERT <average>\` whenever an average is above \`29\`.
4. Finish with \`Stream.runForEach\` printing \`avg <average>\` for every window.

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
        "sliding(3) emits an array for every position once three readings are available: 7 readings give 5 windows.",
        "tap runs before runForEach for the same element, which is why ALERT lines come before their avg line.",
        "runForEach replaces runDrain; it is the runner that does an Effect per element."
      ]
    }
  ],
  recall: [
    {
      q: "What would the type of `Stream.runCollect(Stream.make(1, 2, 3))` be?",
      a: "`Effect<Array<number>, never, never>`. Every `run` function turns a Stream into an Effect; you still need `yield*` or `Effect.runPromise` to get the array."
    },
    {
      q: "What happens if you `runCollect` an infinite stream such as `Stream.iterate(0, n => n + 1)` without a `take`?",
      a: "It never finishes. The consumer keeps pulling and the producer always has more. Every infinite stream needs `take`, `takeWhile`, or a runner that stops early such as `runHead`."
    },
    {
      q: "Which function would you reach for to call an API once per element, three calls at a time, keeping the output order?",
      a: "`Stream.mapEffect(f, { concurrency: 3 })`. It runs the Effect per element with bounded concurrency and emits results in input order. Add `unordered: true` if order does not matter."
    },
    {
      q: "Why does `Stream.runFold` take `() => 0` instead of `0`?",
      a: "Because a stream can be run many times, and the initial value must be fresh each run. With a mutable initial value such as `{}` or `[]`, a plain value would be shared across runs."
    },
    {
      q: "What does 'pull-based' buy you?",
      a: "Nothing is produced before it is asked for. That means backpressure (a slow consumer is not flooded), laziness (only the pages you `take` are fetched), and safe infinite sources."
    },
    {
      q: "You have a paginated API where each call returns items and a next cursor. Which constructor?",
      a: "`Stream.paginate(firstCursor, fetch)` where `fetch` returns an Effect of `[items, Option<nextCursor>]`. `Option.none()` ends the stream."
    },
    {
      q: "A stream fails in the middle. What does `Stream.catchTag(\"Tag\", (e) => Stream.make(x))` do with the elements after the failure?",
      a: "They are gone. The failure ends the original stream, and the handler's stream continues from that point. For per-element recovery, catch inside the `mapEffect` function instead so the stream never fails."
    }
  ]
}

export default section
