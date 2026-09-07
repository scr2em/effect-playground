import type { Section } from "../types.ts"

const section: Section = {
  id: "sink",
  title: "Sink",
  order: 14,
  summary: "A sink is the consumer side of a stream: a reusable, typed value that you can name, combine and test.",
  intro: `
**The problem.** In plain TypeScript, you write each consumer of a sequence at the call site, from zero:

\`\`\`ts
let sum = 0, count = 0, max = -Infinity
for await (const order of orders()) {
  sum += order.total; count++; max = Math.max(max, order.total)
}
\`\`\`

This code has 3 mutable variables and a loop. The logic is tied to this 1 source. When you need the same summary for the orders of yesterday, or for a test with test data, you copy the loop. \`array.reduce((acc, x) => ..., init)\` is a small improvement. But the callback and its initial value are a pair that you cannot name. And \`reduce\` works only on arrays that are already in memory. To stop early (for example: read the header line, then process the rest as rows), you need a flag and an \`if\` inside the loop.

### The shift

Today you think of a consumer as a loop that you write at the call site. In Effect, a consumer is a value. The value describes how to consume elements. It is separate from the producer. A \`Sink<A, In, L, E, R>\` reads elements of type \`In\` and gives 1 result of type \`A\`. It can fail with \`E\`. It can need services \`R\`. It can give back leftover elements of type \`L\`. Leftover elements are elements that the sink pulled but did not use. \`Stream.run(stream, sink)\` connects a producer to a consumer and gives an \`Effect<A, E, R>\`.

Because a sink is a value, you can give it a name, for example \`orderStats\`. You can export it. You can run it on each stream with the correct element type. You can test it with \`Stream.make\` in 3 lines. You can also combine sinks:

- \`Sink.map\` changes the result.
- \`Sink.mapInput\` changes the input.
- \`Sink.flatMap\` runs a second sink after the first. The second sink starts with the leftover elements of the first sink.

The run functions from the Stream section are sinks: \`runCollect\` is \`Sink.collect()\`, and \`runCount\` is \`Sink.count\`.

| | \`array.reduce\` | \`Stream.runFold\` | \`Sink\` |
|---|---|---|---|
| Works on | Arrays in memory | Each stream | Each stream |
| Has a name and is reusable | The callback only | No. It is tied to 1 call. | Yes. It is a value. |
| Typed input | Yes | Yes | Yes. \`mapInput\` adapts it. |
| Stops early | No | No | Yes: \`take\`, \`reduceWhile\`, \`fold\` |
| Chains consumers | No | No | \`Sink.flatMap\` |
| Effects while it consumes | No | No | \`Sink.forEach\`, \`Sink.fold\` |

This section shows the built-in sinks, how to write your own sink, how to adapt and chain sinks, and when \`runFold\` is sufficient.
`,
  lessons: [
    {
      id: "sink-l1",
      title: "Built-in sinks and Stream.run",
      explain: `
You use a sink with \`Stream.run\`. The stream emits elements. The sink consumes the elements and gives 1 result. The built-in sinks cover the common cases. Each built-in sink is a plain value. You can use it with as many streams as you want.

| Sink | Result | Notes |
|---|---|---|
| \`Sink.sum\` | \`number\` | The input elements must be numbers |
| \`Sink.count\` | \`number\` | Any input |
| \`Sink.collect()\` | \`Array<In>\` | The same as \`runCollect\` |
| \`Sink.head()\` | \`Option<In>\` | Stops after the first element |
| \`Sink.last()\` | \`Option<In>\` | Reads to the end |
| \`Sink.take(n)\` | \`Array<In>\` | The first \`n\` elements. The other elements become leftover elements. |
| \`Sink.forEach(f)\` | \`void\` | Runs an effect for each element |
| \`Sink.drain\` | \`void\` | Consumes and discards the elements |

The example builds 1 \`Sink.forEach\` and runs it with 2 different streams. You write the consumer once. Note the v4 names: the sink is \`Sink.collect()\`, not \`collectAll\`. There is no \`foldLeft\`. The fold sinks are \`reduce\` and \`fold\` (next lesson).
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
      after: `Try \`Stream.run(amounts, printer)\`. It does not compile, because \`printer\` consumes strings and \`amounts\` emits numbers. The compiler checks the \`In\` type of the sink against the element type of the stream.`
    },
    {
      id: "sink-l2",
      title: "Your own sink: reduce, and statistics in 1 pass",
      explain: `
Most custom consumers are a fold. A fold keeps a state, updates the state for each element, and returns the state at the end. In plain TypeScript, this is \`reduce\`:

\`\`\`ts
const stats = xs.reduce(
  (s, x) => ({ min: Math.min(s.min, x), max: Math.max(s.max, x), sum: s.sum + x, n: s.n + 1 }),
  { min: Infinity, max: -Infinity, sum: 0, n: 0 }
)
\`\`\`

\`Sink.reduce(() => init, step)\` is the same idea as a value. As with \`runFold\`, the initial state is a function, so each run starts with a new state. The example computes the minimum, the maximum and the mean in 1 pass. Then it uses \`Sink.map\` to change the raw state into the shape that the callers want. The result is a sink with a name, \`stats\`. It works with each \`Stream<number>\`, also with a stream that is too large for memory.

| Function | Consumes | Use when |
|---|---|---|
| \`Sink.reduce(init, f)\` | All elements | A pure fold to the end |
| \`Sink.reduceWhile(init, keepGoing, f)\` | Until \`keepGoing(state)\` is false | A pure fold that can stop |
| \`Sink.fold(init, keepGoing, f)\` | Until \`keepGoing(state)\` is false | \`f\` returns an effect. The effect can fail or need services. |
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
      after: `\`untilTen\` ran on a stream of 1 million numbers and stopped after 4 elements. A \`Sink.reduce\` reads all 1 million elements. Replace \`reduceWhile\` with \`reduce\` and remove the predicate. The result becomes the full sum.`
    },
    {
      id: "sink-l3",
      title: "Adapt a sink: map changes the result, mapInput changes the input",
      explain: `
A sink has 2 ends. \`Sink.map\` changes the result \`A\`. \`Sink.mapInput\` changes the element type \`In\`. Other libraries call \`mapInput\` "contramap". You give it a function from the new input type to the old input type. The sink then accepts the new type.

| Function | Signature (informal) | Result |
|---|---|---|
| \`Sink.map(f)\` | \`Sink<A, In>\` and \`A => B\` | \`Sink<B, In>\` |
| \`Sink.mapInput(g)\` | \`Sink<A, In>\` and \`In0 => In\` | \`Sink<A, In0>\` |
| \`Sink.as(value)\` | \`Sink<A, In>\` | \`Sink<value, In>\` |

Note: the direction of the \`mapInput\` function is the opposite of what many people expect. To make \`Sink.sum\` accept orders, you give it \`(order) => order.total\`. This function goes from \`Order\` to \`number\`. Ask this question: how do I change 1 new element into an element that the sink already understands? The example builds a \`Sink<number, Order>\` from \`Sink.sum\` in this way. Then it uses the same method for a second total with a different field.
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
      after: `Remove the \`mapInput\` from \`revenue\`. The annotation \`Sink.Sink<number, Order>\` then fails, because \`Sink.sum\` is a \`Sink<number, number>\`. The compiler reads the input type of a sink in the same way as the argument type of a function.`
    },
    {
      id: "sink-l4",
      title: "Chain sinks: flatMap and leftover elements",
      explain: `
Some inputs have a structure: a header line and then rows, a length and then that many elements, a command and then its arguments. In a loop, you need a state flag:

\`\`\`ts
let header: string | undefined
const rows: string[] = []
for (const line of lines) {
  if (header === undefined) header = line   // first line only
  else rows.push(line)
}
\`\`\`

With sinks, this is 2 consumers in sequence. \`Sink.take(1)\` reads the first element. The elements that it pulled but did not use become leftover elements. \`Sink.flatMap\` takes the result of the first sink and builds a second sink from it. The second sink starts with the leftover elements, before it pulls more elements from the stream. No element is lost, and no element is read 2 times. The result of the pair is the result of the second sink.

The type parameter \`L\` records the leftover elements that a sink can give back. \`take\` and \`head\` have \`L = In\`. Sinks that consume to the end, for example \`sum\` and \`collect\`, have \`L = never\`. Such a sink can only be the last sink in a chain.
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
      after: `Both halves of \`table\` are normal sinks. You can test each one alone: run \`Sink.take<string>(1)\` with \`Stream.make("a", "b")\`, and you get \`["a"]\`. Change the first element of the prefixed stream to \`5\`. The second sink then takes 5 elements, and the stream has exactly 5 more elements.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use the v4 names `Sink.collect()` and `Sink.reduce`.",
      dont: "Do not use the v3 names `Sink.collectAll` and `Sink.foldLeft`.",
      why: "These names do not exist in v4, and the program does not compile."
    },
    {
      do: "Use `Sink.mapInput` to change the element type that a sink accepts.",
      dont: "Do not use `Sink.map` to change the input type.",
      why: "`Sink.map` changes the result only, so the input type stays the same and the program does not compile."
    },
    {
      do: "Use `Sink.reduceWhile` or `Sink.fold` when the sink must stop before the end of the stream.",
      dont: "Do not use `Sink.reduce` on a large or infinite stream when you need only the first part.",
      why: "`reduce` reads all elements, and on an infinite stream the program never ends."
    },
    {
      do: "Give `Sink.reduce` the initial state as a function, `() => init`.",
      dont: "Do not pass a plain object as the initial state.",
      why: "A plain mutable object is shared between runs, and the second run starts with the state of the first run."
    },
    {
      do: "Put a sink with `L = never`, for example `Sink.sum` or `Sink.collect()`, last in a `Sink.flatMap` chain.",
      dont: "Do not chain a second sink after `Sink.sum` or `Sink.forEach`.",
      why: "These sinks consume all elements and give back no leftover elements, so the second sink has no input and the chain does not compile."
    },
    {
      do: "Write the error type in the annotation of a sink that can fail: `Sink.Sink<A, In, never, E>`.",
      dont: "Do not annotate a sink as `Sink.Sink<A, In>` when its `forEach` body calls `Effect.fail`.",
      why: "`Sink.Sink<A, In>` means `E = never`, and the program does not compile."
    },
    {
      do: "Use `Option.getOrElse` or `Option.match` on the result of `Sink.head()` and `Sink.last()`.",
      dont: "Do not use the result of `Sink.head()` as a plain value.",
      why: "The stream can be empty, so the result is an `Option`, and the program does not compile."
    }
  ],
  challenges: [
    {
      id: "sink-c1",
      title: "The v3 name",
      task: `This code is from Effect v3. It does not compile with v4. Change 1 sink name so that the program prints \`[ "a", "b", "c" ]\`.`,
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
        "Read the error. The property does not exist, and TypeScript suggests a name.",
        "Lesson 1 has the table of built-in sinks.",
        "Use Sink.collect()."
      ],
      explanation: `v4 renamed \`Sink.collectAll\` to \`Sink.collect\`. The module is typed, so an old name is a compile error with a suggestion. It is not an \`undefined is not a function\` error at run time inside a pipeline. When you migrate, search the source module for the export. Do not trust the v3 documentation.`
    },
    {
      id: "sink-c2",
      title: "The wrong end of the sink",
      task: `\`totalLength\` must add the lengths of the strings and print \`9\`, but it does not compile. Change the adapter so that the sink accepts strings.`,
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
        "Sink.sum gives a number. Which end of the sink do you want to change: the result, or the input?",
        "Lesson 3: map changes the result. mapInput changes the input.",
        "Replace Sink.map with Sink.mapInput."
      ],
      explanation: `\`Sink.map\` changes the result. The result of \`Sink.sum\` is a \`number\`, so a function that expects a \`string\` cannot go there. \`Sink.mapInput\` changes each input element before the sink sees it. Strings go in, and the \`s.length\` numbers reach \`sum\`. The function body is the same. Only the end of the sink is different.`
    },
    {
      id: "sink-c3",
      title: "The sink that says it cannot fail",
      task: `\`validated\` rejects negative amounts with a typed error. But its annotation says that it cannot fail. The amounts below are all positive, so the run works and prints \`all amounts valid\`. The program still does not compile. Change the annotation so that it is true. Do not remove the \`Effect.fail\`.`,
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
        "Sink<A, In, L, E, R>: the error slot is the fourth. What is it now, and what does Effect.fail put there?",
        "Sink.Sink<void, number> means E = never. The forEach body can fail with a string.",
        "Annotate as Sink.Sink<void, number, never, string>."
      ],
      explanation: `Nothing goes wrong at run time here. That is the reason why the type is important. The \`forEach\` body returns \`Effect.fail(string)\` on 1 branch, so the \`E\` of the sink is \`string\`. The annotation said \`never\`. The annotation \`Sink.Sink<void, number, never, string>\` makes each \`Stream.run(_, validated)\` an \`Effect<void, string>\`. The callers must then decide what a negative amount means before they ship. The third parameter, \`L\`, stays \`never\`. \`forEach\` reads all elements and gives back no leftover elements.`
    },
    {
      id: "sink-c4",
      title: "A fold that reads too much",
      task: `We want the first part of the stream where the total reaches at least \`100\`. The sink reads the full stream and prints the wrong total. Change the sink so that it prints \`stopped at 105\`.`,
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
        "Lesson 2: reduce reads to the end. Which related function takes a predicate on the state?",
        "Use Sink.reduceWhile(() => 0, (total) => total < 100, (total, n) => total + n)."
      ],
      explanation: `\`Sink.reduce\` cannot stop, so it added all 5 deposits and gave \`165\`. \`Sink.reduceWhile\` checks the predicate on the state after each element. When the predicate returns false, the sink ends and gives back the unread elements as leftover elements. On a large or infinite stream, this is the difference between a program that ends and a program that never ends.`
    }
  ],
  problems: [
    {
      id: "sink-p1",
      title: "Reusable daily report",
      spec: `
Build 1 sink, \`report\`, that summarizes a stream of \`Sale\` records. Then run it on the sales of 2 days.

1. Define \`Sale\` as \`{ readonly sku: string; readonly amount: number }\`.
2. \`report\` is a \`Sink.Sink<string, Sale>\`. Use \`Sink.reduce\` to compute in 1 pass: the number of sales, the total amount, and the sku of the largest single sale. Then use \`Sink.map\` to change the state into the string \`"<count> sales, total <total>, top <sku>"\`.
3. Run \`report\` on \`monday\` and on \`tuesday\`. Print each result.

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
        "Keep 4 fields in the state: the count, the total, the top sku and the top amount. The initial state is a function.",
        "Annotate the parameters of the reducer, (s: State, sale: Sale): State, so that TypeScript infers the input type of the sink.",
        "Sink.map changes the final State into the report string. The sink is then a Sink<string, Sale>. It runs on both days without change."
      ]
    },
    {
      id: "sink-p2",
      title: "Length-prefixed frames",
      spec: `
A protocol sends numbers in frames. Each frame is a length and then that many elements. The stream contains several frames one after the other. \`2, 10, 20, 3, 1, 2, 3, 1, 99\` is 3 frames: \`[10, 20]\`, \`[1, 2, 3]\`, \`[99]\`.

1. Write \`frame\`, a sink that reads 1 frame. Use \`Sink.head()\` for the length, then \`Sink.flatMap\` into \`Sink.take(length)\`. If the stream is empty, the frame is \`[]\`.
2. Write \`frames(n)\`. It returns a sink that reads \`n\` frames one after the other. Chain \`frame\` with \`Sink.flatMap\` and collect the frames in an array. A recursive function works well.
3. Run \`frames(3)\` on the stream and print the result as JSON. Then run \`frame\` alone on the same stream and print the first frame only.

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
        "Sink.head() returns an Option. Option.getOrElse(length, () => 0) gives the count for take.",
        "Each frame sink gives back the unread elements as leftover elements. flatMap starts the next sink with exactly these elements, so the frames do not overlap.",
        "For frames(n): if n is 0, return Sink.succeed([]). Otherwise return frame.pipe(Sink.flatMap((first) => frames(n - 1).pipe(Sink.map((rest) => [first, ...rest]))))."
      ]
    }
  ],
  recall: [
    {
      q: "What is the type of `Stream.run(Stream.make(1, 2, 3), Sink.count)`?",
      a: "`Effect<number, never, never>`. `Stream.run` joins a `Stream<A, E, R>` and a `Sink<B, A, L, E2, R2>` into an `Effect<B, E | E2, R | R2>`. The result type of the sink becomes the success type of the effect."
    },
    {
      q: "In `Sink<A, In, L, E, R>`, what is `L`?",
      a: "`L` is the type of the leftover elements. These are elements that the sink pulled but did not consume. `Sink.take(2)` has `L = In`, because it can stop in the middle. `Sink.sum` has `L = never`, because it reads all elements. `Sink.flatMap` gives the leftover elements of 1 sink to the next sink."
    },
    {
      q: "You have `Sink.sum` and a stream of `{ price: number }` objects. Which function do you use?",
      a: "`Sink.mapInput((item) => item.price)`. It adapts the input side and gives a `Sink<number, { price: number }>`. `Sink.map` changes the result, not the input."
    },
    {
      q: "What is the difference between `Sink.reduce` and `Sink.reduceWhile`?",
      a: "`reduce` folds all elements to the end. `reduceWhile` takes a predicate on the state. It stops as soon as the predicate is false, and it gives back the unread elements as leftover elements. Use `Sink.fold` when the step function must return an effect."
    },
    {
      q: "When is `Stream.runFold` sufficient, and when do you use a sink?",
      a: "`runFold` is sufficient for 1 reduction at the end of a pipeline. Use a sink when the consumer must have a name, or when you must test it alone, adapt it with `mapInput`, stop it early, or chain it with `flatMap`."
    }
  ]
}

export default section
