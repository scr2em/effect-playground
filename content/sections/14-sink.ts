import type { Section } from "../types.ts"

const section: Section = {
  id: "sink",
  title: "Sink",
  order: 14,
  summary: "Sinks: the consumer side of a stream as a reusable, typed value you can name, compose and test.",
  intro: `
**The problem.** Every time you consume a sequence in plain TypeScript you write the consumer inline, from scratch:

\`\`\`ts
let sum = 0, count = 0, max = -Infinity
for await (const order of orders()) {
  sum += order.total; count++; max = Math.max(max, order.total)
}
\`\`\`

Three mutable variables, a loop, and the logic is welded to this one source. When the same summary is needed for yesterday's orders, or for a test with fake data, you copy the loop. \`array.reduce((acc, x) => ..., init)\` is a little better, but the callback and its initial value still travel as a pair you cannot name, and it only works on arrays that are already in memory. Stopping early ("read the header line, then treat the rest as rows") needs a flag and an \`if\` inside the loop.

### The shift

Today you think of consuming as **a loop you write at the call site**. Effect asks you to think of it as **a value that describes how to consume**, separate from what is being produced. A \`Sink<A, In, L, E, R>\` reads elements of type \`In\` and produces one result \`A\`. It may fail with \`E\`, need services \`R\`, and hand back leftover elements \`L\` it pulled but did not use. \`Stream.run(stream, sink)\` connects a producer to a consumer and gives you an \`Effect<A, E, R>\`.

Because a sink is a value, you can give it a name (\`orderStats\`), export it, run it against any stream of the right element type, and test it with \`Stream.make\` in three lines. You can also combine sinks: change the result with \`map\`, adapt the input with \`mapInput\`, and chain one after another with \`flatMap\`, where the second sink starts on the leftovers of the first. The \`run*\` functions from the Stream section are all sinks in disguise: \`runCollect\` is \`Sink.collect()\`, \`runCount\` is \`Sink.count\`.

| | \`array.reduce\` | \`Stream.runFold\` | \`Sink\` |
|---|---|---|---|
| Works on | Arrays in memory | Any stream | Any stream |
| Reusable by name | The callback only | No, tied to one call | Yes, a first-class value |
| Typed input | Yes | Yes | Yes, and adaptable with \`mapInput\` |
| Stop early | No | No | Yes: \`take\`, \`reduceWhile\`, \`fold\` |
| Chain consumers | No | No | \`Sink.flatMap\` |
| Effects while consuming | No | No | \`Sink.forEach\`, \`Sink.fold\` |

This section teaches the built-in sinks, how to write your own, how to adapt and chain them, and when \`runFold\` is enough.
`,
  lessons: [
    {
      id: "sink-l1",
      title: "Built-in sinks and Stream.run",
      explain: `
A sink is used with \`Stream.run\`. The stream provides elements, the sink consumes them and produces a single result. The built-ins cover the everyday cases, and each one is a plain value you can reuse against as many streams as you like.

| Sink | Result | Notes |
|---|---|---|
| \`Sink.sum\` | \`number\` | Input must be numbers |
| \`Sink.count\` | \`number\` | Any input |
| \`Sink.collect()\` | \`Array<In>\` | Same as \`runCollect\` |
| \`Sink.head()\` | \`Option<In>\` | Stops after the first element |
| \`Sink.last()\` | \`Option<In>\` | Reads to the end |
| \`Sink.take(n)\` | \`Array<In>\` | First \`n\`, the rest become leftovers |
| \`Sink.forEach(f)\` | \`void\` | Runs an Effect per element |
| \`Sink.drain\` | \`void\` | Consumes and discards |

The example builds one \`Sink.forEach\` and runs it against two different streams. That is the point: the consumer was written once. Note the v4 names: it is \`Sink.collect()\`, not \`collectAll\`, and there is no \`foldLeft\`, the folding sinks are \`reduce\` and \`fold\` (next lesson).
`,
      code: `import { Effect, Option, Sink, Stream } from "effect"

// A consumer, defined once, with no stream in sight
const printer = Sink.forEach((line: string) => Effect.sync(() => console.log("> " + line)))

const today = Stream.make("deploy", "rollback")
const yesterday = Stream.make("hotfix")

const program = Effect.gen(function* () {
  yield* Stream.run(today, printer)          // same sink...
  yield* Stream.run(yesterday, printer)      // ...different stream

  const amounts = Stream.make(19, 5, 42)
  console.log("sum", yield* Stream.run(amounts, Sink.sum))
  console.log("count", yield* amounts.pipe(Stream.run(Sink.count)))   // pipe style works too
  console.log("collect", yield* amounts.pipe(Stream.run(Sink.collect())))
  console.log("first two", yield* amounts.pipe(Stream.run(Sink.take(2))))

  const first = yield* amounts.pipe(Stream.run(Sink.head()))
  console.log("head", Option.getOrElse(first, () => 0))

  const none = yield* Stream.empty.pipe(Stream.run(Sink.last()))
  console.log("last of empty is", Option.isNone(none) ? "none" : "some")
})

Effect.runPromise(program)
`,
      expectedOutput: `> deploy
> rollback
> hotfix
sum 66
count 3
collect [ 19, 5, 42 ]
first two [ 19, 5 ]
head 19
last of empty is none`,
      after: `Try \`Stream.run(amounts, printer)\`: it does not compile, because \`printer\` consumes strings and \`amounts\` produces numbers. The sink's \`In\` type is checked against the stream's element type at the join.`
    },
    {
      id: "sink-l2",
      title: "Your own sink: reduce, and stats in one pass",
      explain: `
Most custom consumers are a fold: keep some state, update it per element, return it at the end. In plain TypeScript that is \`reduce\`:

\`\`\`ts
const stats = xs.reduce(
  (s, x) => ({ min: Math.min(s.min, x), max: Math.max(s.max, x), sum: s.sum + x, n: s.n + 1 }),
  { min: Infinity, max: -Infinity, sum: 0, n: 0 }
)
\`\`\`

\`Sink.reduce(() => init, step)\` is the same idea as a value. Like \`runFold\`, the initial state is a function so each run starts fresh. The example computes min, max and mean in a single pass, then uses \`Sink.map\` to turn the raw state into the shape callers want. The result is a named sink, \`stats\`, that works on any \`Stream<number>\`, including one too large to hold in memory.

| Function | Consumes | Use when |
|---|---|---|
| \`Sink.reduce(init, f)\` | Everything | Pure fold to the end |
| \`Sink.reduceWhile(init, keepGoing, f)\` | Until \`keepGoing(state)\` is false | Pure fold that can stop |
| \`Sink.fold(init, keepGoing, f)\` | Until \`keepGoing(state)\` is false | \`f\` returns an Effect (may fail, need services) |
`,
      code: `import { Effect, Sink, Stream } from "effect"

interface State {
  readonly min: number
  readonly max: number
  readonly sum: number
  readonly n: number
}

// One pass over the input, no arrays allocated
const stats = Sink.reduce(
  (): State => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 }),   // fresh state per run
  (s: State, x: number): State => ({
    min: Math.min(s.min, x),
    max: Math.max(s.max, x),
    sum: s.sum + x,
    n: s.n + 1
  })
).pipe(
  Sink.map((s) => ({ min: s.min, max: s.max, mean: s.sum / s.n }))   // reshape the result
)

const program = Effect.gen(function* () {
  console.log(yield* Stream.make(4, 8, 15, 16, 23, 42).pipe(Stream.run(stats)))
  console.log(yield* Stream.range(1, 1000).pipe(Stream.run(stats)))

  // reduceWhile stops as soon as the predicate on the state is false
  const untilTen = Sink.reduceWhile(() => 0, (total) => total < 10, (total, x: number) => total + x)
  console.log("first total >= 10:", yield* Stream.range(1, 1_000_000).pipe(Stream.run(untilTen)))
})

Effect.runPromise(program)
`,
      expectedOutput: `{
  min: 4,
  max: 42,
  mean: 18,
}
{
  min: 1,
  max: 1000,
  mean: 500.5,
}
first total >= 10: 10`,
      after: `\`untilTen\` ran against a stream of a million numbers and stopped after four. A \`Sink.reduce\` would have read all million. Try replacing \`reduceWhile\` with \`reduce\` (dropping the predicate) and watch the answer become the full sum.`
    },
    {
      id: "sink-l3",
      title: "Adapting: map changes the result, mapInput changes the input",
      explain: `
A sink has two ends. \`Sink.map\` changes what comes out, the result \`A\`. \`Sink.mapInput\` changes what goes in, the element type \`In\`. In other libraries \`mapInput\` is called \`contramap\`: you give it a function *from* the new input *to* the old one, and the sink now accepts the new type.

| Function | Signature (informal) | Turns |
|---|---|---|
| \`Sink.map(f)\` | \`Sink<A, In>\` and \`A => B\` | into \`Sink<B, In>\` |
| \`Sink.mapInput(g)\` | \`Sink<A, In>\` and \`In0 => In\` | into \`Sink<A, In0>\` |
| \`Sink.as(value)\` | \`Sink<A, In>\` | into \`Sink<value, In>\` |

The arrow direction of \`mapInput\` surprises people: to make \`Sink.sum\` accept orders, you supply \`(order) => order.total\`, a function that goes from \`Order\` to \`number\`. Think of it as "how do I turn one of these into what the sink already understands?" The example builds a \`Sink<number, Order>\` from \`Sink.sum\` this way, then reuses it for a second aggregate by mapping a different field.
`,
      code: `import { Effect, Sink, Stream } from "effect"

interface Order {
  readonly id: string
  readonly total: number
  readonly items: number
}

const orders = Stream.make(
  { id: "o1", total: 30, items: 2 },
  { id: "o2", total: 45, items: 1 },
  { id: "o3", total: 25, items: 4 }
)

// Sink.sum wants numbers. mapInput teaches it how to read an Order.
const revenue: Sink.Sink<number, Order> = Sink.sum.pipe(Sink.mapInput((o: Order) => o.total))
const itemsSold: Sink.Sink<number, Order> = Sink.sum.pipe(Sink.mapInput((o: Order) => o.items))

// map changes the result: a number becomes a formatted string
const revenueReport = revenue.pipe(Sink.map((n) => "revenue: $" + n))

// as replaces the result with a constant, keeping the consumption
const ack = Sink.drain.pipe(Sink.as("all orders read"))

const program = Effect.gen(function* () {
  console.log(yield* orders.pipe(Stream.run(revenue)))
  console.log(yield* orders.pipe(Stream.run(itemsSold)))
  console.log(yield* orders.pipe(Stream.run(revenueReport)))
  console.log(yield* orders.pipe(Stream.run(ack)))
})

Effect.runPromise(program)
`,
      expectedOutput: `100
7
revenue: $100
all orders read`,
      after: `Try removing the \`mapInput\` from \`revenue\`: the annotation \`Sink.Sink<number, Order>\` fails, because \`Sink.sum\` is a \`Sink<number, number>\`. The compiler reads the input type of a sink the same way it reads the argument type of a function.`
    },
    {
      id: "sink-l4",
      title: "Chaining: flatMap and leftovers",
      explain: `
Some inputs have structure: a header line followed by rows, a length prefix followed by that many items, a command followed by its arguments. In a loop this is a state flag:

\`\`\`ts
let header: string | undefined
const rows: string[] = []
for (const line of lines) {
  if (header === undefined) header = line   // first line only
  else rows.push(line)
}
\`\`\`

With sinks it is two consumers in sequence. \`Sink.take(1)\` reads the first element and returns everything it pulled but did not need as **leftovers**. \`Sink.flatMap\` takes the first sink's result, builds a second sink from it, and starts that second sink on the leftovers before pulling more from upstream. No element is lost or read twice. The result of the pair is the result of the second sink.

The \`L\` type parameter records what a sink can leave over. \`take\` and \`head\` have \`L = In\`; sinks that consume to the end, like \`sum\` and \`collect\`, have \`L = never\` and can only be last in a chain.
`,
      code: `import { Effect, Sink, Stream } from "effect"

const csv = Stream.make("name,qty", "apple,3", "pear,5", "fig,2")

// Sink 1 reads the header. Sink 2 is built from it and reads the rest.
const table = Sink.take<string>(1).pipe(
  Sink.flatMap((headerLines) => {
    const columns = headerLines[0]!.split(",")
    return Sink.collect<string>().pipe(
      Sink.map((rows) => rows.map((row) => {
        const cells = row.split(",")
        return Object.fromEntries(columns.map((c, i) => [c, cells[i]]))
      }))
    )
  })
)

// A length-prefixed message: first element says how many to read
const prefixed = Sink.head<number>().pipe(
  Sink.flatMap((len) => Sink.take<number>(len._tag === "Some" ? len.value : 0))
)

const program = Effect.gen(function* () {
  const rows = yield* csv.pipe(Stream.run(table))
  console.log(JSON.stringify(rows))

  const payload = yield* Stream.make(3, 10, 20, 30, 40, 50).pipe(Stream.run(prefixed))
  console.log("payload", payload)                          // 40 and 50 are left over, not read
})

Effect.runPromise(program)
`,
      expectedOutput: `[{"name":"apple","qty":"3"},{"name":"pear","qty":"5"},{"name":"fig","qty":"2"}]
payload [ 10, 20, 30 ]`,
      after: `Both halves of \`table\` are ordinary sinks you could test alone: run \`Sink.take<string>(1)\` against \`Stream.make("a", "b")\` and you get \`["a"]\`. Try changing the first element of the prefixed stream to \`5\`: the second sink takes five, and the stream has exactly five more to give.`
    }
  ],
  challenges: [
    {
      id: "sink-c1",
      title: "The v3 name",
      task: `This code was written for Effect v3 and does not compile against v4. Fix the one sink name so it prints \`[ "a", "b", "c" ]\`.`,
      code: `import { Effect, Sink, Stream } from "effect"

const letters = Stream.make("a", "b", "c")

const program = letters.pipe(Stream.run(Sink.collectAll()))

Effect.runPromise(program).then((xs) => console.log(xs))
`,
      solution: `import { Effect, Sink, Stream } from "effect"

const letters = Stream.make("a", "b", "c")

const program = letters.pipe(Stream.run(Sink.collect()))

Effect.runPromise(program).then((xs) => console.log(xs))
`,
      expectedOutput: `[ "a", "b", "c" ]`,
      hints: [
        "Read the error: the property does not exist, and TypeScript suggests a name.",
        "Lesson 1 has the table of built-in sinks.",
        "Use Sink.collect()."
      ],
      explanation: `v4 renamed \`Sink.collectAll\` to \`Sink.collect\`. Because the module is typed, a stale name is a compile error with a suggestion, not a runtime \`undefined is not a function\` deep inside a pipeline. When migrating, grep the source module for the export rather than trusting v3 docs.`
    },
    {
      id: "sink-c2",
      title: "Wrong end of the sink",
      task: `\`totalLength\` should add up the lengths of the strings and print \`9\`, but it does not compile. Fix the adapter so the sink accepts strings.`,
      code: `import { Effect, Sink, Stream } from "effect"

const words = Stream.make("ab", "cde", "fghi")

const totalLength = Sink.sum.pipe(Sink.map((s: string) => s.length))

Effect.runPromise(words.pipe(Stream.run(totalLength))).then((n) => console.log(n))
`,
      solution: `import { Effect, Sink, Stream } from "effect"

const words = Stream.make("ab", "cde", "fghi")

const totalLength = Sink.sum.pipe(Sink.mapInput((s: string) => s.length))

Effect.runPromise(words.pipe(Stream.run(totalLength))).then((n) => console.log(n))
`,
      expectedOutput: `9`,
      hints: [
        "Sink.sum produces a number. Which end of it do you want to change: the result, or what it reads?",
        "Lesson 3: map changes the result, mapInput changes the input.",
        "Replace Sink.map with Sink.mapInput."
      ],
      explanation: `\`Sink.map\` transforms the result, and \`Sink.sum\`'s result is a \`number\`, so a function expecting a \`string\` cannot go there. \`Sink.mapInput\` transforms each incoming element before the sink sees it: strings go in, \`s.length\` numbers reach \`sum\`. Same function body, other end of the sink.`
    },
    {
      id: "sink-c3",
      title: "The sink that claims it cannot fail",
      task: `\`validated\` rejects negative amounts with a typed error, but its annotation says it cannot fail. The amounts below are all positive, so the run works and prints \`all amounts valid\`; still, the program does not compile. Fix the annotation so it tells the truth. Do not remove the \`Effect.fail\`.`,
      code: `import { Effect, Sink, Stream } from "effect"

const validated: Sink.Sink<void, number> = Sink.forEach((amount: number) =>
  amount < 0 ? Effect.fail("negative amount: " + amount) : Effect.void
)

const program = Stream.make(10, 20, 30).pipe(Stream.run(validated))

Effect.runPromise(program).then(() => console.log("all amounts valid"))
`,
      solution: `import { Effect, Sink, Stream } from "effect"

const validated: Sink.Sink<void, number, never, string> = Sink.forEach((amount: number) =>
  amount < 0 ? Effect.fail("negative amount: " + amount) : Effect.void
)

const program = Stream.make(10, 20, 30).pipe(Stream.run(validated))

Effect.runPromise(program).then(() => console.log("all amounts valid"))
`,
      expectedOutput: `all amounts valid`,
      hints: [
        "Sink<A, In, L, E, R>: the error slot is the fourth. What is it right now, and what does Effect.fail put there?",
        "Sink.Sink<void, number> means E = never. The forEach body can fail with a string.",
        "Annotate as Sink.Sink<void, number, never, string>."
      ],
      explanation: `Nothing goes wrong at runtime here, which is exactly why the type matters. The \`forEach\` body returns \`Effect.fail(string)\` on one branch, so the sink's \`E\` is \`string\`; the annotation claimed \`never\`. Widening it to \`Sink.Sink<void, number, never, string>\` makes every \`Stream.run(_, validated)\` an \`Effect<void, string>\`, and callers are forced to decide what a negative amount means before they ship. The third parameter, \`L\`, stays \`never\`: \`forEach\` reads everything and leaves nothing over.`
    },
    {
      id: "sink-c4",
      title: "A fold that reads too much",
      task: `We want the first prefix of the stream whose running total reaches at least \`100\`. The sink reads the whole stream instead and prints the wrong total. Fix the sink so it prints \`stopped at 105\`.`,
      code: `import { Effect, Sink, Stream } from "effect"

const deposits = Stream.make(40, 35, 30, 50, 10)

const untilHundred = Sink.reduce(() => 0, (total, n: number) => total + n)

Effect.runPromise(deposits.pipe(Stream.run(untilHundred))).then((n) => console.log("stopped at", n))
`,
      solution: `import { Effect, Sink, Stream } from "effect"

const deposits = Stream.make(40, 35, 30, 50, 10)

const untilHundred = Sink.reduceWhile(() => 0, (total) => total < 100, (total, n: number) => total + n)

Effect.runPromise(deposits.pipe(Stream.run(untilHundred))).then((n) => console.log("stopped at", n))
`,
      expectedOutput: `stopped at 105`,
      hints: [
        "40 + 35 + 30 = 105 is the first total at or above 100. Which elements did the current sink read?",
        "Lesson 2: reduce reads to the end. Which sibling takes a predicate on the state?",
        "Use Sink.reduceWhile(() => 0, (total) => total < 100, (total, n) => total + n)."
      ],
      explanation: `\`Sink.reduce\` has no way to stop, so it summed all five deposits to \`165\`. \`Sink.reduceWhile\` checks the predicate on the state after each element and ends the sink the moment it returns false, handing any unread elements back as leftovers. On a large or endless stream this is the difference between finishing and hanging.`
    }
  ],
  problems: [
    {
      id: "sink-p1",
      title: "Reusable daily report",
      spec: `
Build one sink, \`report\`, that summarises a stream of \`Sale\` records, then run it on two days of sales.

1. Define \`Sale\` as \`{ readonly sku: string; readonly amount: number }\`.
2. \`report\` is a \`Sink.Sink<string, Sale>\`. Use \`Sink.reduce\` to compute in one pass: the number of sales, the total amount, and the sku of the largest single sale. Then \`Sink.map\` the state to a string \`"<count> sales, total <total>, top <sku>"\`.
3. Run \`report\` against \`monday\` and \`tuesday\` and print each result.

Exact output:

\`\`\`
3 sales, total 90, top B
2 sales, total 65, top C
\`\`\`
`,
      starter: `import { Effect, Sink, Stream } from "effect"

interface Sale {
  readonly sku: string
  readonly amount: number
}

const monday = Stream.make<Array<Sale>>({ sku: "A", amount: 20 }, { sku: "B", amount: 50 }, { sku: "C", amount: 20 })
const tuesday = Stream.make<Array<Sale>>({ sku: "A", amount: 25 }, { sku: "C", amount: 40 })

// TODO: report: Sink.Sink<string, Sale> built from Sink.reduce and Sink.map

const program = Effect.gen(function* () {
  // TODO: run report on monday and tuesday, print both
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Sink, Stream } from "effect"

interface Sale {
  readonly sku: string
  readonly amount: number
}

const monday = Stream.make<Array<Sale>>({ sku: "A", amount: 20 }, { sku: "B", amount: 50 }, { sku: "C", amount: 20 })
const tuesday = Stream.make<Array<Sale>>({ sku: "A", amount: 25 }, { sku: "C", amount: 40 })

interface State {
  readonly count: number
  readonly total: number
  readonly topSku: string
  readonly topAmount: number
}

const report: Sink.Sink<string, Sale> = Sink.reduce(
  (): State => ({ count: 0, total: 0, topSku: "", topAmount: -Infinity }),
  (s: State, sale: Sale): State => ({
    count: s.count + 1,
    total: s.total + sale.amount,
    topSku: sale.amount > s.topAmount ? sale.sku : s.topSku,
    topAmount: Math.max(s.topAmount, sale.amount)
  })
).pipe(
  Sink.map((s) => s.count + " sales, total " + s.total + ", top " + s.topSku)
)

const program = Effect.gen(function* () {
  console.log(yield* monday.pipe(Stream.run(report)))
  console.log(yield* tuesday.pipe(Stream.run(report)))
})

Effect.runPromise(program)
`,
      expectedOutput: `3 sales, total 90, top B
2 sales, total 65, top C`,
      hints: [
        "Keep four fields in the state: count, total, the top sku and the top amount. The initial state is a function.",
        "Annotate the reducer's parameters ((s: State, sale: Sale): State) so TypeScript infers the sink's input type.",
        "Sink.map turns the final State into the report string; the sink is then a Sink<string, Sale> and runs on both days unchanged."
      ]
    },
    {
      id: "sink-p2",
      title: "Length-prefixed frames",
      spec: `
A byte-like protocol sends numbers in frames. Each frame is a length followed by that many values, and the stream contains several frames back to back: \`2, 10, 20, 3, 1, 2, 3, 1, 99\` is three frames: \`[10, 20]\`, \`[1, 2, 3]\`, \`[99]\`.

1. Write \`frame\`, a sink that reads one frame: \`Sink.head()\` for the length, then \`Sink.flatMap\` into \`Sink.take(length)\`. If the stream is empty, the frame is \`[]\`.
2. Write \`frames(n)\` that returns a sink reading \`n\` frames in a row by chaining \`frame\` with \`Sink.flatMap\`, accumulating an array of frames. A recursive function works well.
3. Run \`frames(3)\` on the stream and print the result as JSON. Then run \`frame\` alone on the same stream and print only the first frame.

Exact output:

\`\`\`
[[10,20],[1,2,3],[99]]
first [10,20]
\`\`\`
`,
      starter: `import { Effect, Option, Sink, Stream } from "effect"

const wire = Stream.make(2, 10, 20, 3, 1, 2, 3, 1, 99)

// TODO: frame: Sink.Sink<Array<number>, number, number>

// TODO: frames(n): Sink.Sink<Array<Array<number>>, number, number>

const program = Effect.gen(function* () {
  // TODO: run frames(3), print JSON
  // TODO: run frame, print "first <json>"
})

Effect.runPromise(program)
`,
      solution: `import { Effect, Option, Sink, Stream } from "effect"

const wire = Stream.make(2, 10, 20, 3, 1, 2, 3, 1, 99)

const frame: Sink.Sink<Array<number>, number, number> = Sink.head<number>().pipe(
  Sink.flatMap((length) => Sink.take<number>(Option.getOrElse(length, () => 0)))
)

const frames = (n: number): Sink.Sink<Array<Array<number>>, number, number> =>
  n === 0
    ? Sink.succeed([])
    : frame.pipe(
      Sink.flatMap((first) => frames(n - 1).pipe(Sink.map((rest) => [first, ...rest])))
    )

const program = Effect.gen(function* () {
  const all = yield* wire.pipe(Stream.run(frames(3)))
  console.log(JSON.stringify(all))

  const first = yield* wire.pipe(Stream.run(frame))
  console.log("first", JSON.stringify(first))
})

Effect.runPromise(program)
`,
      expectedOutput: `[[10,20],[1,2,3],[99]]
first [10,20]`,
      hints: [
        "Sink.head() returns an Option; Option.getOrElse(length, () => 0) gives the count to take.",
        "Each frame sink leaves the unread elements as leftovers, and flatMap starts the next sink on exactly those, so frames never overlap.",
        "For frames(n): if n is 0 return Sink.succeed([]); otherwise frame.pipe(Sink.flatMap((first) => frames(n - 1).pipe(Sink.map((rest) => [first, ...rest]))))."
      ]
    }
  ],
  recall: [
    {
      q: "What would the type of `Stream.run(Stream.make(1, 2, 3), Sink.count)` be?",
      a: "`Effect<number, never, never>`. `Stream.run` joins a `Stream<A, E, R>` and a `Sink<B, A, L, E2, R2>` into an `Effect<B, E | E2, R | R2>`. The sink's result type becomes the Effect's success type."
    },
    {
      q: "In `Sink<A, In, L, E, R>`, what is `L`?",
      a: "Leftovers: elements the sink pulled but did not consume. `Sink.take(2)` has `L = In` because it may stop mid-way; `Sink.sum` has `L = never` because it reads everything. `Sink.flatMap` feeds one sink's leftovers to the next."
    },
    {
      q: "You have `Sink.sum` and a stream of `{ price: number }` objects. Which function would you reach for?",
      a: "`Sink.mapInput((item) => item.price)`. It adapts the input side, giving a `Sink<number, { price: number }>`. `Sink.map` would change the result, not the input."
    },
    {
      q: "What is the difference between `Sink.reduce` and `Sink.reduceWhile`?",
      a: "`reduce` folds every element to the end. `reduceWhile` takes a predicate on the state and stops as soon as it is false, returning unread elements as leftovers. Use `Sink.fold` when the step function must return an Effect."
    },
    {
      q: "When is `Stream.runFold` enough, and when do you want a Sink?",
      a: "`runFold` is fine for a one-off reduction at the end of a pipeline. Reach for a Sink when the consumer should be named and reused, tested on its own, adapted with `mapInput`, stopped early, or chained with `flatMap`."
    }
  ]
}

export default section
