import type { Section } from "../types.ts"

const section: Section = {
  id: "code-style",
  title: "Code Style",
  order: 16,
  summary: "gen or pipe, data-first or data-last, Effect.fn, branded ids, Match instead of switch, tagged enums, and 1 run call at the edge.",
  intro: `
**The problem.** You can write Effect code badly. The most common bad shape is a helper class. Its methods run effects from the inside, all ids are \`string\`, and a \`switch\` ignores a new case without a warning:

\`\`\`ts
class OrderService {
  getTotal(orderId: string, userId: string) {
    const order = Effect.runSync(this.repo.find(orderId))   // runs in the middle of business logic
    switch (order.status) {
      case "paid": return order.total
      case "pending": return 0
      // "refunded" was added last week; this returns undefined now
    }
  }
}
service.getTotal(userId, orderId)   // arguments swapped, compiles fine
\`\`\`

Every line compiles. Every line is a bug that waits for production. The \`runSync\` throws as soon as \`find\` becomes async. You can exchange the 2 \`string\` parameters without a compile error. The \`switch\` cannot tell you that it is incomplete.

### The shift

Today you think of a program as objects with methods. The important rules are in comments and tests. In Effect, you write small named functions that return effects, and the types hold the rules. A function accepts an \`OrderId\`, not a \`string\`, so exchanged arguments are a compile error. A state is a tagged union, and \`Match.exhaustive\` refuses to compile until you process every case. You build effects with \`Effect.gen\` for sequences and with \`pipe\` for transformations. You run them 1 time, at the edge of the program. The result is that most review comments become type errors. The code reads from top to bottom as a description of what it does.

| Situation | Use | Do not use |
|---|---|---|
| Steps that use earlier results, branches, loops | \`Effect.gen\` with \`yield*\` | Nested \`flatMap\` |
| A straight line of transformations on 1 value | \`.pipe(Effect.map, Effect.tap, ...)\` | A \`gen\` with 1 \`yield*\` and a \`return\` |
| A reusable function with parameters | \`Effect.fn("name")(function* (...) {})\` | A plain function that wraps \`Effect.gen\` |
| Ids and units that must not mix | \`Brand.Branded<string, "UserId">\` | \`string\` and \`number\` everywhere |
| Process every case of a union | \`Match.type<T>()\` + \`Match.exhaustive\` | \`switch\` without a default |
| A value with several shapes | \`Data.taggedEnum\` | \`{ status: string; data?: unknown }\` |
| Run an effect | 1 time, at the edge (\`runPromise\` in \`main\`) | \`runSync\` inside a \`map\` or a method |

The rule for depth: do not put a \`gen\` inside a \`pipe\` inside a \`gen\`. If you see this shape, move the inner part into a named function and call it.
`,
  lessons: [
    {
      id: "code-style-l1",
      title: "Effect.gen or pipe? Select by shape",
      explain: `
Both build the same type of value: an effect. They differ in what they make easy to read.

| Use \`Effect.gen\` when | Use \`pipe\` when |
|---|---|
| A later step needs a value from an earlier step | Each step needs only the previous result |
| There is an \`if\`, an early \`return\`, or a loop | The steps are a straight line |
| You want named intermediate values | The intermediate values do not need names |
| The code must read like \`async\`/\`await\` | The code must read like array method chains |

The bad pattern is a mix at depth:

\`\`\`ts
Effect.gen(function* () {
  const x = yield* load().pipe(
    Effect.flatMap((a) => Effect.gen(function* () { ... }))   // gen in pipe in gen: stop
  )
})
\`\`\`

When you see this shape, move the inner \`gen\` into a named function. In the program below, \`subtotal\` is a straight line, so it is a \`pipe\`. \`total\` has a branch and uses \`order\` 2 times, so it is a \`gen\`. Each function is small enough to read in 1 look.
`,
      code: `import { Effect } from "effect"

interface Order { readonly id: number; readonly items: ReadonlyArray<number>; readonly coupon?: string }

const loadOrder = (id: number) => Effect.succeed<Order>({ id, items: [20, 15, 5], coupon: "SAVE10" })
const couponDiscount = (code: string | undefined) => Effect.succeed(code === "SAVE10" ? 10 : 0)

// pipe: a straight line of transformations. No branching, no names for intermediate values.
const subtotal = (order: Order) =>
  Effect.succeed(order.items).pipe(
    Effect.map((items) => items.reduce((a, b) => a + b, 0)),
    Effect.map((sum) => Math.round(sum * 100) / 100)
  )

// gen: steps that depend on earlier results, with a branch in the middle.
const total = (id: number) =>
  Effect.gen(function* () {
    const order = yield* loadOrder(id)
    const sum = yield* subtotal(order)
    if (sum < 30) return sum                       // small orders: no discount, stop here
    const discount = yield* couponDiscount(order.coupon)
    return sum - discount
  })

console.log("total:", Effect.runSync(total(1)))
`,
      expectedOutput: `total: 30`,
      after: `Try to write \`total\` as a \`pipe\`. You need \`flatMap\` to keep \`order\` in scope for the discount step, and the early return becomes a nested ternary. That difficulty is the signal. Now try to write \`subtotal\` as a \`gen\`. It works, but you must invent 2 variable names for values that nobody reads a second time.`
    },
    {
      id: "code-style-l2",
      title: "Data-first and data-last: read the signatures",
      explain: `
Almost every Effect function has 2 forms. This is called a dual API:

\`\`\`ts
export const map: {
  <A, B>(f: (a: A) => B): <E, R>(self: Effect<A, E, R>) => Effect<B, E, R>   // data-last
  <A, E, R, B>(self: Effect<A, E, R>, f: (a: A) => B): Effect<B, E, R>       // data-first
}
\`\`\`

The first overload accepts only the function. It returns a new function that waits for the effect. \`.pipe\` uses that form. The second overload accepts the effect (the "data") as the first argument and does the work at once.

| Form | Example | Best for |
|---|---|---|
| Data-first | \`Effect.map(effect, f)\` | A single call, when there is no chain |
| Data-last | \`effect.pipe(Effect.map(f))\` | A chain of several steps |
| Data-last, stored | \`const addTax = Effect.map(...)\` | A named transformation that you use again |

When you read the docs and see an overload list, find the overload whose first parameter is \`self\`. That overload is data-first. The other overload is the pipeable form. Both produce the same effect.
`,
      code: `import { Effect, pipe } from "effect"

const double = (n: number) => n * 2

const a = Effect.map(Effect.succeed(21), double)        // data-first: the Effect is the first argument
const b = Effect.succeed(21).pipe(Effect.map(double))   // data-last: only the function, then .pipe
const c = pipe(Effect.succeed(21), Effect.map(double))  // data-last with the standalone pipe function

console.log(Effect.runSync(a), Effect.runSync(b), Effect.runSync(c))

// Only the data-last form gives you a reusable, named transformation
const addTax = Effect.map((price: number) => price * 1.2)

console.log(Effect.runSync(addTax(Effect.succeed(100))))
console.log(Effect.runSync(Effect.succeed(50).pipe(addTax)))
`,
      expectedOutput: `42 42 42
120
60`,
      after: `\`addTax\` is a plain function from an effect to an effect. You can pass it as an argument, put it in a list, or apply it in a \`pipe\`. Try to write it data-first. You cannot, because there is no effect to put first. This is why libraries expose data-last forms. They compose.`
    },
    {
      id: "code-style-l3",
      title: "Effect.fn: named functions with parameters",
      explain: `
A function that accepts parameters and returns an effect is the most common unit of Effect code. The basic version is an arrow function that wraps \`Effect.gen\`:

\`\`\`ts
const findUser = (id: number) => Effect.gen(function* () { ... })   // works, but has no name in traces
\`\`\`

\`Effect.fn("findUser")\` does the same with 3 additions. The generator receives the parameters directly. The name appears in stack traces, and the function makes a tracing span. A span is a named, timed record of 1 operation. A slow \`findUser\` is then visible by name in your observability tool. Extra arguments after the generator are applied to the result, like \`pipe\` steps. The original parameters are also available to them. Put error handlers and annotations there. Caution: do not call \`.pipe\` on the function itself. A function has no \`pipe\`.

\`Effect.fnUntraced\` is the same without the span. Use it for small helpers and for hot paths, where a span for each call is noise. Use \`fn\` for an operation that a person wants to see in a trace.

To state the return type, annotate the generator with \`Effect.fn.Return<A, E, R>\`. Example: \`function* (id: number): Effect.fn.Return<string, NotFound> { ... }\`.
`,
      code: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const users: Record<number, string> = { 1: "Ada", 2: "Lin" }

// Effect.fn: a generator body with parameters, plus a name for traces and spans
const findUser = Effect.fn("findUser")(function* (id: number) {
  const name = users[id]
  if (name === undefined) return yield* new NotFound({ id })
  return name
})

// Extra arguments are applied to the result like pipe steps. No .pipe on the function itself.
const findUserOrGuest = Effect.fn("findUserOrGuest")(
  function* (id: number) {
    return yield* findUser(id)
  },
  Effect.catchTag("NotFound", (e) => Effect.succeed("guest-" + e.id))
)

// fnUntraced: same ergonomics, no span. For small helpers and hot paths.
const shout = Effect.fnUntraced(function* (name: string) {
  return name.toUpperCase() + "!"
})

const program = Effect.gen(function* () {
  console.log(yield* findUser(1))
  console.log(yield* findUserOrGuest(9))
  console.log(yield* shout(yield* findUser(2)))
})

Effect.runSync(program)
`,
      expectedOutput: `Ada
guest-9
LIN!`,
      after: `Point at \`findUser\` in an editor. Its type is \`(id: number) => Effect<string, NotFound>\`, the same as the arrow version. Callers do not know which style you used. Remove the \`return\` before \`yield* new NotFound({ id })\`. TypeScript then thinks that the function continues, and the return type includes \`undefined\`. Always write \`return\` when you yield an error.`
    },
    {
      id: "code-style-l4",
      title: "Branded types: make a wrong argument a type error",
      explain: `
\`UserId\` and \`OrderId\` are both strings at run time. That is the problem. \`loadOrder(userId, orderId)\` compiles with the arguments exchanged. A brand adds a compile-time tag to a base type. The value is still a plain string, but TypeScript treats \`UserId\` and \`OrderId\` as different types.

\`\`\`ts
type UserId = Brand.Branded<string, "UserId">
const UserId = Brand.nominal<UserId>()     // constructor: UserId("u-1")
\`\`\`

The convention is to use the same name for the type and the constructor. \`Brand.nominal\` adds no run-time check. \`Brand.make\` accepts a predicate and gives a constructor that validates. A call with bad input throws. The constructor also has \`.is\`, \`.option\`, and \`.result\` for checks that do not throw.

The commented line in the code produces this error if you enable it:

\`\`\`
Argument of type 'UserId' is not assignable to parameter of type 'OrderId'.
\`\`\`

That is the purpose. You cannot write the invalid state, so it cannot reach production.
`,
      code: `import { Brand, Result } from "effect"

// Two brands over the same base type. At runtime both are plain strings.
type UserId = Brand.Branded<string, "UserId">
type OrderId = Brand.Branded<string, "OrderId">
const UserId = Brand.nominal<UserId>()      // no runtime check, only a type tag
const OrderId = Brand.nominal<OrderId>()

// A validated brand: the constructor enforces the rule
type Quantity = Brand.Branded<number, "Quantity">
const Quantity = Brand.make<Quantity>((n) => Number.isInteger(n) && n > 0)

const describeOrder = (order: OrderId, owner: UserId) => "order " + order + " belongs to " + owner

const userId = UserId("u-1")
const orderId = OrderId("o-9")

console.log(describeOrder(orderId, userId))
// describeOrder(userId, orderId)   // type error: 'UserId' is not assignable to 'OrderId'

console.log("is 3 a quantity?", Quantity.is(3), "is -2?", Quantity.is(-2))
const checked = Quantity.result(0.5)
console.log(Result.isSuccess(checked) ? "quantity " + checked.success : "rejected 0.5")
`,
      expectedOutput: `order o-9 belongs to u-1
is 3 a quantity? true is -2? false
rejected 0.5`,
      after: `Enable the commented call and read the error. Then try \`describeOrder("o-9", userId)\`. A raw string is rejected too, because only the constructor can produce an \`OrderId\`. Every place that makes an id becomes visible. That is where validation belongs.`
    },
    {
      id: "code-style-l5",
      title: "Match instead of switch",
      explain: `
A \`switch\` on \`_tag\` works until a person adds a case. The new case has no branch, the \`switch\` returns \`undefined\`, and nobody sees it. The \`Match\` module builds the same decision as a value. \`Match.exhaustive\` refuses to compile while a case is not processed.

| \`switch\` | \`Match\` |
|---|---|
| A statement. You need a variable to collect the result | An expression. It returns the result |
| A missing case returns \`undefined\` without a warning | A missing case is a compile error with \`exhaustive\` |
| Only equality on 1 field | Tags, predicates, and partial object shapes |
| Not reusable | \`Match.type<T>()\` builds a reusable function |

There are 2 entry points. \`Match.type<T>()\` builds a function \`(t: T) => result\` that you can pass as an argument. \`Match.value(x)\` matches 1 value at once and gives the result. Add cases with \`Match.tag("Name", handler)\` for tagged unions. Add cases with \`Match.when(pattern, handler)\` for predicates or partial shapes. End with \`Match.exhaustive\` when all cases must be processed. End with \`Match.orElse(fallback)\` when a default is acceptable. Note: the matcher tries the cases in order, and the first match wins.
`,
      code: `import { Match } from "effect"

type Event =
  | { readonly _tag: "Deposit"; readonly amount: number }
  | { readonly _tag: "Withdraw"; readonly amount: number }
  | { readonly _tag: "Close" }

// Match.type builds a reusable function. exhaustive turns a missing case into a compile error.
const describe = Match.type<Event>().pipe(
  Match.tag("Deposit", (e) => "+" + e.amount),
  Match.tag("Withdraw", (e) => "-" + e.amount),
  Match.tag("Close", () => "closed"),
  Match.exhaustive
)

// Match.value matches one value right away. when() takes a predicate or a partial shape.
const grade = (score: number) =>
  Match.value(score).pipe(
    Match.when((n: number) => n >= 90, () => "A"),
    Match.when((n: number) => n >= 75, () => "B"),
    Match.orElse(() => "C")
  )

const events: Array<Event> = [{ _tag: "Deposit", amount: 50 }, { _tag: "Withdraw", amount: 20 }, { _tag: "Close" }]
console.log(events.map(describe).join(" "))
console.log([95, 80, 40].map(grade).join(" "))
`,
      expectedOutput: `+50 -20 closed
A B C`,
      after: `Remove the \`Close\` line in \`describe\`. The error is on \`Match.exhaustive\`. It says that the \`Close\` shape is not assignable to \`never\`, which means "not processed". Add a fourth event type, and you get the same error at compile time in every matcher that does not process it.`
    },
    {
      id: "code-style-l6",
      title: "Tagged enums, small effects, 1 run call at the edge",
      explain: `
When you write a tagged union by hand, you also write the constructors, the type guards, and the matcher. \`Data.taggedEnum\` makes all 3 from 1 type: a constructor for each case, \`$is("Case")\` guards, and an exhaustive \`$match\`.

The second half of this lesson is about shape. This is the version that you must not write:

\`\`\`ts
const lifecycle = Effect.succeed(Pending({ amount: 40 })).pipe(
  Effect.map((p) => Effect.runSync(charge(p))),            // runSync inside business logic
  Effect.flatMap((paid) => Effect.gen(function* () {       // gen inside pipe
    const refunded = yield* refund(paid)
    return [paid, refunded].map((x) => Effect.runSync(describeEffect(x)))
  }))
)
\`\`\`

Every \`runSync\` in the middle is a place where a future async step causes a crash. A test cannot replace a layer there, because the effect already ran. The correction is always the same. Move the work into small named effects (\`charge\`, \`refund\`). Sequence them in 1 flat \`gen\`. Run the result 1 time, at the end. \`Effect.runSync\` and \`Effect.runPromise\` belong in \`main\`, in a test, or at a framework boundary. They do not belong in a service method.
`,
      code: `import { Data, Effect } from "effect"

type Payment = Data.TaggedEnum<{
  Pending: { readonly amount: number }
  Paid: { readonly amount: number; readonly receipt: string }
  Refunded: { readonly amount: number }
}>
const { Pending, Paid, Refunded, $is, $match } = Data.taggedEnum<Payment>()

// Small, named effects. Each one does a single transition.
const charge = (p: Payment) =>
  $is("Pending")(p)
    ? Effect.succeed(Paid({ amount: p.amount, receipt: "r-" + p.amount }))
    : Effect.fail("cannot charge a " + p._tag + " payment")

const refund = (p: Payment) =>
  $is("Paid")(p)
    ? Effect.succeed(Refunded({ amount: p.amount }))
    : Effect.fail("cannot refund a " + p._tag + " payment")

// $match is exhaustive: add a fourth state and this stops compiling until you handle it
const describe = $match({
  Pending: (p) => "pending " + p.amount,
  Paid: (p) => "paid " + p.amount + " (receipt " + p.receipt + ")",
  Refunded: (p) => "refunded " + p.amount
})

const lifecycle = Effect.gen(function* () {
  const started = Pending({ amount: 40 })
  const paid = yield* charge(started)
  const refunded = yield* refund(paid)
  return [started, paid, refunded].map(describe)
})

// One run call, at the edge of the program
for (const line of Effect.runSync(lifecycle)) console.log(line)
`,
      expectedOutput: `pending 40
paid 40 (receipt r-40)
refunded 40`,
      after: `Note: \`$is("Pending")(p)\` narrows \`p\`, so \`p.amount\` is typed in the true branch. Exchange the 2 \`yield*\` lines. \`refund(started)\` fails with a clear message and does not corrupt the state, because each transition checks the tag that it accepts.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use `Effect.gen` when a step needs a value from an earlier step or when there is a branch.",
      dont: "Do not write nested `Effect.flatMap` closures to keep an earlier value in scope.",
      why: "Each nested closure adds 1 level of depth, and the code becomes hard to read and to change."
    },
    {
      do: "Move an inner `Effect.gen` out of a `pipe` into a named function.",
      dont: "Do not put a `gen` inside a `pipe` inside a `gen`.",
      why: "The depth hides the sequence of steps, and a reader cannot see which value flows where."
    },
    {
      do: "Write `Effect.map(effect, f)` for a single call and `effect.pipe(Effect.map(f))` for a chain.",
      dont: "Do not write `Effect.map(f, effect)`.",
      why: "The data-first overload expects the effect as the first argument, so the call does not compile."
    },
    {
      do: "Pass error handlers as extra arguments to `Effect.fn`, after the generator.",
      dont: "Do not call `.pipe` on the function that `Effect.fn` returns.",
      why: "`Effect.fn` returns a function, and a function has no `pipe`, so the code does not compile."
    },
    {
      do: "Write `return yield* new NotFound({ id })` when you yield an error in a generator.",
      dont: "Do not write `yield* new NotFound({ id })` without `return`.",
      why: "TypeScript thinks that the function continues after the error, and the return type includes `undefined`."
    },
    {
      do: "Make an id type with `Brand.Branded<string, \"UserId\">` and a constructor with `Brand.nominal`.",
      dont: "Do not use plain `string` for 2 different types of id in 1 function signature.",
      why: "The compiler accepts exchanged arguments, and the code reads the wrong record without a warning."
    },
    {
      do: "End a matcher over a union with `Match.exhaustive`.",
      dont: "Do not use a `switch` without a default for a union that can grow.",
      why: "A new case in the union returns `undefined` from the `switch`, and the compiler does not report it."
    },
    {
      do: "Run an effect 1 time, at the edge, with `Effect.runPromise` in `main` or in a test.",
      dont: "Do not call `Effect.runSync` inside `Effect.map` or inside a service method.",
      why: "`runSync` throws as soon as the inner effect has an async step, and a test layer cannot reach the inner effect."
    }
  ],
  challenges: [
    {
      id: "code-style-c1",
      title: "Which argument comes first?",
      task: `This program must print \`42\`, but it does not compile. Correct the call to \`Effect.map\`. Do not change to \`.pipe\`.`,
      code: `import { Effect } from "effect"

const double = (n: number) => n * 2

const program = Effect.map(double, Effect.succeed(21))

console.log(Effect.runSync(program))
`,
      solution: `import { Effect } from "effect"

const double = (n: number) => n * 2

const program = Effect.map(Effect.succeed(21), double)

console.log(Effect.runSync(program))
`,
      expectedOutput: `42`,
      hints: [
        "Read the error. A function is passed where an effect is expected.",
        "In the data-first form, the data (the effect) is the first argument and the function is the second.",
        "Effect.map(Effect.succeed(21), double)."
      ],
      explanation: `\`Effect.map\` is dual. With 2 arguments it is data-first: \`(self, f)\`. With 1 argument it is data-last and returns a function for \`.pipe\`. The call \`(double, effect)\` matched neither overload, so TypeScript reported the first argument. Lesson 2 shows how to read the overload list. The overload whose first parameter is \`self\` is the one that you call here.`
    },
    {
      id: "code-style-c2",
      title: "Exchanged ids",
      task: `The program must print \`you own o-1\`, but it does not compile. Correct the call to \`ownerOf\`. Do not change the brands or the function.`,
      code: `import { Brand } from "effect"

type UserId = Brand.Branded<string, "UserId">
type OrderId = Brand.Branded<string, "OrderId">
const UserId = Brand.nominal<UserId>()
const OrderId = Brand.nominal<OrderId>()

const orders: Record<string, { owner: UserId; total: number }> = {
  "o-1": { owner: UserId("u-1"), total: 30 }
}

const ownerOf = (orderId: OrderId, requester: UserId) => {
  const order = orders[orderId]
  if (order === undefined) return "no such order"
  return order.owner === requester ? "you own " + orderId : "not your order"
}

const me = UserId("u-1")
const myOrder = OrderId("o-1")

console.log(ownerOf(me, myOrder))
`,
      solution: `import { Brand } from "effect"

type UserId = Brand.Branded<string, "UserId">
type OrderId = Brand.Branded<string, "OrderId">
const UserId = Brand.nominal<UserId>()
const OrderId = Brand.nominal<OrderId>()

const orders: Record<string, { owner: UserId; total: number }> = {
  "o-1": { owner: UserId("u-1"), total: 30 }
}

const ownerOf = (orderId: OrderId, requester: UserId) => {
  const order = orders[orderId]
  if (order === undefined) return "no such order"
  return order.owner === requester ? "you own " + orderId : "not your order"
}

const me = UserId("u-1")
const myOrder = OrderId("o-1")

console.log(ownerOf(myOrder, me))
`,
      expectedOutput: `you own o-1`,
      hints: [
        "The error says that 'UserId' is not assignable to 'OrderId'. Look at the argument positions.",
        "ownerOf accepts the order first and the user second.",
        "ownerOf(myOrder, me)."
      ],
      explanation: `Without brands, this call compiles, reads \`orders["u-1"]\`, and prints \`no such order\`. That is a wrong answer with no warning. With brands, \`UserId\` and \`OrderId\` are different types, although both are strings at run time. The exchanged arguments are a compile error at the call site. The run-time cost is zero. \`Brand.nominal\` returns its input without a change.`
    },
    {
      id: "code-style-c3",
      title: "The case that was added last week",
      task: `A \`Line\` shape was added to the union, and now the matcher does not compile. Make it process every shape, so that the program prints \`13 9 0\`. A line has an area of 0.`,
      code: `import { Match } from "effect"

type Shape =
  | { readonly _tag: "Circle"; readonly radius: number }
  | { readonly _tag: "Square"; readonly side: number }
  | { readonly _tag: "Line"; readonly length: number }

const area = Match.type<Shape>().pipe(
  Match.tag("Circle", (s) => Math.round(Math.PI * s.radius * s.radius)),
  Match.tag("Square", (s) => s.side * s.side),
  Match.exhaustive
)

const shapes: Array<Shape> = [{ _tag: "Circle", radius: 2 }, { _tag: "Square", side: 3 }, { _tag: "Line", length: 5 }]
console.log(shapes.map(area).join(" "))
`,
      solution: `import { Match } from "effect"

type Shape =
  | { readonly _tag: "Circle"; readonly radius: number }
  | { readonly _tag: "Square"; readonly side: number }
  | { readonly _tag: "Line"; readonly length: number }

const area = Match.type<Shape>().pipe(
  Match.tag("Circle", (s) => Math.round(Math.PI * s.radius * s.radius)),
  Match.tag("Square", (s) => s.side * s.side),
  Match.tag("Line", () => 0),
  Match.exhaustive
)

const shapes: Array<Shape> = [{ _tag: "Circle", radius: 2 }, { _tag: "Square", side: 3 }, { _tag: "Line", length: 5 }]
console.log(shapes.map(area).join(" "))
`,
      expectedOutput: `13 9 0`,
      hints: [
        "The error is on Match.exhaustive. It says that the Line shape is not assignable to never.",
        "Here never means \"no case is left\". One case is left.",
        "Add Match.tag(\"Line\", () => 0) before Match.exhaustive."
      ],
      explanation: `\`Match.exhaustive\` accepts only a matcher whose type of unprocessed cases is \`never\`. After \`Circle\` and \`Square\`, the \`Line\` case remained. The type was not \`never\`, and the compiler pointed at it. A \`switch\` compiles and returns \`undefined\` for lines. This is the reason to use \`Match\` for a union that can grow.`
    },
    {
      id: "code-style-c4",
      title: "runSync in the middle",
      task: `The basket total stops with an error at run time. Change \`basketTotal\` so that the prices are read inside the effect pipeline, without a \`runSync\`. The program must print \`total: 8\`.`,
      code: `import { Effect } from "effect"

// Prices come from an async source
const fetchPrice = (sku: string) => Effect.promise(() => Promise.resolve(sku === "apple" ? 3 : 5))

const basketTotal = (skus: ReadonlyArray<string>) =>
  Effect.succeed(skus).pipe(
    Effect.map((list) => list.map((sku) => Effect.runSync(fetchPrice(sku)))),
    Effect.map((prices) => prices.reduce((a, b) => a + b, 0))
  )

Effect.runPromise(basketTotal(["apple", "pear"])).then((total) => console.log("total:", total))
`,
      solution: `import { Effect } from "effect"

// Prices come from an async source
const fetchPrice = (sku: string) => Effect.promise(() => Promise.resolve(sku === "apple" ? 3 : 5))

const basketTotal = (skus: ReadonlyArray<string>) =>
  Effect.succeed(skus).pipe(
    Effect.flatMap((list) => Effect.forEach(list, fetchPrice)),
    Effect.map((prices) => prices.reduce((a, b) => a + b, 0))
  )

Effect.runPromise(basketTotal(["apple", "pear"])).then((total) => console.log("total:", total))
`,
      expectedOutput: `total: 8`,
      hints: [
        "runSync cannot run async work. fetchPrice is a Promise inside.",
        "You have a list and a function that returns an effect for each item. Effect.forEach(list, f) turns that into 1 effect of a list.",
        "Replace the first map with Effect.flatMap((list) => Effect.forEach(list, fetchPrice))."
      ],
      explanation: `\`Effect.runSync\` inside \`map\` runs an effect while another effect is built. It throws as soon as the inner effect has an async step. It also hides the inner effect from the outer effect. A timeout, a retry, or a test layer that you apply to \`basketTotal\` never reaches \`fetchPrice\`. \`Effect.forEach\` keeps all the work as 1 effect, and \`flatMap\` puts it into the pipeline. Now there is exactly 1 \`run\` call, at the edge.`
    },
    {
      id: "code-style-c5",
      title: "The first match wins",
      task: `The status labels are wrong. \`404\` and \`503\` must get their specific labels. Only the other 4xx and 5xx codes must be \`error\`. Change the order of the cases, so that the program prints \`ok, not found, try again later, error\`.`,
      code: `import { Match } from "effect"

const label = (status: number) =>
  Match.value(status).pipe(
    Match.when((s: number) => s >= 400, () => "error"),
    Match.when(404, () => "not found"),
    Match.when(503, () => "try again later"),
    Match.orElse(() => "ok")
  )

console.log([200, 404, 503, 418].map(label).join(", "))
`,
      solution: `import { Match } from "effect"

const label = (status: number) =>
  Match.value(status).pipe(
    Match.when(404, () => "not found"),
    Match.when(503, () => "try again later"),
    Match.when((s: number) => s >= 400, () => "error"),
    Match.orElse(() => "ok")
  )

console.log([200, 404, 503, 418].map(label).join(", "))
`,
      expectedOutput: `ok, not found, try again later, error`,
      hints: [
        "Every code above 400 prints \"error\", and that includes 404. Which case is tested first?",
        "The matcher tries the cases from top to bottom, and the first match wins. The wide predicate hides the specific values.",
        "Move the predicate case below the 2 exact-value cases."
      ],
      explanation: `\`Match\` tries the cases in the order that you wrote them, like a chain of \`if\` and \`else if\`. The predicate \`s >= 400\` is true for 404 and 503, so it captured them before their own cases. Put specific cases first and wide fallbacks last. \`Match.exhaustive\` cannot find this bug, because every value is still processed. Only the order was wrong.`
    },
    {
      id: "code-style-c6",
      title: "A function has no pipe",
      task: `The author tried to attach an error handler to an \`Effect.fn\` with \`.pipe\`, and the program does not compile. Move the handler to the position that \`Effect.fn\` expects. The program must print \`Ada\` and then \`guest\`.`,
      code: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const users: Record<number, string> = { 1: "Ada" }

const findUserOrGuest = Effect.fn("findUserOrGuest")(function* (id: number) {
  const name = users[id]
  if (name === undefined) return yield* new NotFound({ id })
  return name
}).pipe(Effect.catchTag("NotFound", () => Effect.succeed("guest")))

const program = Effect.gen(function* () {
  console.log(yield* findUserOrGuest(1))
  console.log(yield* findUserOrGuest(2))
})

Effect.runSync(program)
`,
      solution: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const users: Record<number, string> = { 1: "Ada" }

const findUserOrGuest = Effect.fn("findUserOrGuest")(
  function* (id: number) {
    const name = users[id]
    if (name === undefined) return yield* new NotFound({ id })
    return name
  },
  Effect.catchTag("NotFound", () => Effect.succeed("guest"))
)

const program = Effect.gen(function* () {
  console.log(yield* findUserOrGuest(1))
  console.log(yield* findUserOrGuest(2))
})

Effect.runSync(program)
`,
      expectedOutput: `Ada
guest`,
      hints: [
        "The error says that the property 'pipe' does not exist on the type '(id: number) => Effect<...>'. What does Effect.fn return?",
        "Effect.fn returns a function, not an effect. The pipe steps go inside the Effect.fn call, after the generator.",
        "Effect.fn(\"findUserOrGuest\")(function* (id) { ... }, Effect.catchTag(\"NotFound\", () => Effect.succeed(\"guest\")))."
      ],
      explanation: `\`Effect.fn(name)(body)\` returns a function from parameters to an effect. A function has no \`.pipe\`. Only an effect has one. \`Effect.fn\` accepts extra arguments after the generator. It applies each one to the result effect, like \`pipe\` steps. Those transforms also receive the original parameters. That is the correct position for \`catchTag\`, \`withSpan\`, \`annotateLogs\`, and similar functions.`
    }
  ],
  problems: [
    {
      id: "code-style-p1",
      title: "Typed ids and a named lookup",
      spec: `
Change the loose lookup into typed, named code.

1. Make \`UserId\` and \`OrderId\` nominal brands over \`string\`. Use the same name for the type and the constructor.
2. Write \`getOrder\` with \`Effect.fn("getOrder")\`. It accepts \`(orderId: OrderId, requester: UserId)\`. It fails with \`NotFound\` when the order does not exist. It fails with \`Forbidden\` (with \`requester\` as \`userId\`) when the order belongs to a different user. Otherwise it returns the order.
3. Write \`describeError\` with \`Match.type<NotFound | Forbidden>()\`, \`Match.tag\`, and \`Match.exhaustive\`. It returns \`"NotFound"\` or \`"Forbidden for <userId>"\`.
4. Write \`report(orderId, requester)\`. It maps a success to \`"order <id>: <items> items"\`. It maps each error, with \`Effect.catch\`, to \`"order <id>: <describeError(e)>"\`.

Run it as the user \`u-1\` for the orders \`o-1\`, \`o-2\`, and \`o-9\`. The output must be:

\`\`\`
order o-1: 3 items
order o-2: Forbidden for u-1
order o-9: NotFound
\`\`\`
`,
      starter: `import { Brand, Effect, Match, Schema } from "effect"

// TODO: UserId and OrderId as nominal brands over string
type UserId = string
type OrderId = string

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { orderId: Schema.String }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { userId: Schema.String }) {}

interface Order { readonly owner: UserId; readonly items: number }

const orders: Record<string, Order> = {
  "o-1": { owner: "u-1", items: 3 },
  "o-2": { owner: "u-2", items: 1 }
}

// TODO: getOrder with Effect.fn: NotFound when missing, Forbidden when owned by someone else
const getOrder = (orderId: OrderId, requester: UserId): Effect.Effect<Order, NotFound | Forbidden> =>
  Effect.fail(new NotFound({ orderId }))

// TODO: describeError with Match.type over the error union, exhaustive

// TODO: report(orderId, requester) maps success and errors to the lines in the spec
const report = (orderId: OrderId, requester: UserId): Effect.Effect<string> => Effect.succeed("")

const program = Effect.gen(function* () {
  const me = "u-1"
  for (const id of ["o-1", "o-2", "o-9"]) {
    console.log(yield* report(id, me))
  }
})

Effect.runSync(program)
`,
      solution: `import { Brand, Effect, Match, Schema } from "effect"

type UserId = Brand.Branded<string, "UserId">
type OrderId = Brand.Branded<string, "OrderId">
const UserId = Brand.nominal<UserId>()
const OrderId = Brand.nominal<OrderId>()

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { orderId: Schema.String }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { userId: Schema.String }) {}

interface Order { readonly owner: UserId; readonly items: number }

const orders: Record<string, Order> = {
  "o-1": { owner: UserId("u-1"), items: 3 },
  "o-2": { owner: UserId("u-2"), items: 1 }
}

const getOrder = Effect.fn("getOrder")(function* (orderId: OrderId, requester: UserId) {
  const order = orders[orderId]
  if (order === undefined) return yield* new NotFound({ orderId })
  if (order.owner !== requester) return yield* new Forbidden({ userId: requester })
  return order
})

const describeError = Match.type<NotFound | Forbidden>().pipe(
  Match.tag("NotFound", () => "NotFound"),
  Match.tag("Forbidden", (e) => "Forbidden for " + e.userId),
  Match.exhaustive
)

const report = (orderId: OrderId, requester: UserId) =>
  getOrder(orderId, requester).pipe(
    Effect.map((order) => "order " + orderId + ": " + order.items + " items"),
    Effect.catch((e) => Effect.succeed("order " + orderId + ": " + describeError(e)))
  )

const program = Effect.gen(function* () {
  const me = UserId("u-1")
  for (const id of ["o-1", "o-2", "o-9"]) {
    console.log(yield* report(OrderId(id), me))
  }
})

Effect.runSync(program)
`,
      expectedOutput: `order o-1: 3 items
order o-2: Forbidden for u-1
order o-9: NotFound`,
      hints: [
        "type UserId = Brand.Branded<string, \"UserId\">; const UserId = Brand.nominal<UserId>(). After the brands exist, the raw strings in orders and in program do not compile. Wrap them with the constructors.",
        "In the Effect.fn generator, write return yield* new NotFound({ orderId }) and return yield* new Forbidden({ userId: requester }). The return keeps the success type clean.",
        "report is a pipe: Effect.map for the success line, then Effect.catch((e) => Effect.succeed(...)) with describeError(e). The error union is exactly NotFound | Forbidden, which is the type that the matcher expects."
      ]
    },
    {
      id: "code-style-p2",
      title: "A document workflow with a tagged enum",
      spec: `
Model a document as a \`Data.TaggedEnum\` with 3 states: \`Draft { title }\`, \`InReview { title, reviewer }\`, and \`Published { title }\`. The commands are \`"submit"\`, \`"approve"\`, and \`"reject"\`.

Write \`transition(doc, command)\`. It returns \`Effect<Doc, InvalidTransition>\`. Build it with 1 exhaustive \`$match\` over the current state:

- \`Draft\` + \`submit\` becomes \`InReview\` with the reviewer \`"lin"\`
- \`InReview\` + \`approve\` becomes \`Published\`. \`InReview\` + \`reject\` becomes \`Draft\`
- every other combination fails with \`InvalidTransition({ from: doc._tag, command })\`

Start with a \`Draft\` with the title \`"Effect style guide"\`. Apply \`submit, reject, submit, approve, submit\` in this order. Use \`Effect.result\` on each transition. On success, print \`<command>: <from> -> <to>\` and move to the new state. On failure, print \`<command>: invalid from <from>\` and keep the state. At the end, print \`final: <state>\`. The output must be:

\`\`\`
submit: Draft -> InReview
reject: InReview -> Draft
submit: Draft -> InReview
approve: InReview -> Published
submit: invalid from Published
final: Published
\`\`\`
`,
      starter: `import { Data, Effect, Result, Schema } from "effect"

// TODO: Doc as a Data.TaggedEnum with Draft { title }, InReview { title, reviewer }, Published { title }

type Command = "submit" | "approve" | "reject"

class InvalidTransition extends Schema.TaggedError<InvalidTransition>()("InvalidTransition", {
  from: Schema.String,
  command: Schema.String
}) {}

// TODO: transition(doc, command) using $match, failing with InvalidTransition

const program = Effect.gen(function* () {
  // TODO: start as Draft "Effect style guide", apply the commands in the spec, print each line
  for (const command of ["submit", "reject", "submit", "approve", "submit"] as const) {
    console.log(command + ": TODO")
  }
  console.log("final: TODO")
})

Effect.runSync(program)
`,
      solution: `import { Data, Effect, Result, Schema } from "effect"

type Doc = Data.TaggedEnum<{
  Draft: { readonly title: string }
  InReview: { readonly title: string; readonly reviewer: string }
  Published: { readonly title: string }
}>
const { Draft, InReview, Published, $match } = Data.taggedEnum<Doc>()

type Command = "submit" | "approve" | "reject"

class InvalidTransition extends Schema.TaggedError<InvalidTransition>()("InvalidTransition", {
  from: Schema.String,
  command: Schema.String
}) {}

const invalid = (doc: Doc, command: Command) =>
  Effect.fail(new InvalidTransition({ from: doc._tag, command }))

// One exhaustive match over the current state; each state decides which commands it accepts
const transition = (doc: Doc, command: Command): Effect.Effect<Doc, InvalidTransition> =>
  $match(doc, {
    Draft: (d) => (command === "submit" ? Effect.succeed(InReview({ title: d.title, reviewer: "lin" })) : invalid(d, command)),
    InReview: (d) =>
      command === "approve"
        ? Effect.succeed(Published({ title: d.title }))
        : command === "reject"
        ? Effect.succeed(Draft({ title: d.title }))
        : invalid(d, command),
    Published: (d) => invalid(d, command)
  })

const program = Effect.gen(function* () {
  let doc: Doc = Draft({ title: "Effect style guide" })
  for (const command of ["submit", "reject", "submit", "approve", "submit"] as const) {
    const outcome: Result.Result<Doc, InvalidTransition> = yield* Effect.result(transition(doc, command))
    if (Result.isSuccess(outcome)) {
      console.log(command + ": " + doc._tag + " -> " + outcome.success._tag)
      doc = outcome.success
    } else {
      console.log(command + ": invalid from " + outcome.failure.from)
    }
  }
  console.log("final: " + doc._tag)
})

Effect.runSync(program)
`,
      expectedOutput: `submit: Draft -> InReview
reject: InReview -> Draft
submit: Draft -> InReview
approve: InReview -> Published
submit: invalid from Published
final: Published`,
      hints: [
        "const { Draft, InReview, Published, $match } = Data.taggedEnum<Doc>() gives you the constructors and the matcher. A constructor accepts an object without _tag.",
        "$match(doc, { Draft: (d) => ..., InReview: (d) => ..., Published: (d) => ... }) is data-first and must include all 3 keys. Each handler returns an effect.",
        "Keep the current state in let doc: Doc. Annotate the Effect.result value as Result.Result<Doc, InvalidTransition>. Without the annotation, TypeScript reports a circular inference between doc and the outcome."
      ]
    }
  ],
  recall: [
    {
      q: "You have 3 steps. The third step needs values from the first and the second. `gen` or `pipe`?",
      a: "`Effect.gen`. A `pipe` passes only the previous result forward. To keep an earlier value in scope, you need nested `flatMap` closures. `gen` gives every step a name with `const x = yield* ...`."
    },
    {
      q: "What does it mean that `Effect.map` is a dual API?",
      a: "It has 2 overloads. Data-first is `Effect.map(effect, f)`. Data-last is `Effect.map(f)`, which returns a function for `.pipe`. In the docs, the overload whose first parameter is `self` is data-first. Both produce the same effect."
    },
    {
      q: "What is the type of `Effect.fn(\"findUser\")(function* (id: number) { ...; return \"Ada\" })`?",
      a: "A function `(id: number) => Effect<string, never, never>`. This is the same type as an arrow function that wraps `Effect.gen`. If the body does `return yield* new NotFound(...)`, the error type becomes `NotFound`. The name changes only traces and spans, not the type."
    },
    {
      q: "Which function do you use so that `UserId` and `OrderId` cannot be exchanged, with no run-time cost?",
      a: "`Brand.nominal<UserId>()` over `type UserId = Brand.Branded<string, \"UserId\">`. It adds a compile-time tag and returns its input without a change. Use `Brand.make(predicate)` when the constructor must also validate."
    },
    {
      q: "Why use `Match.type<T>()` with `Match.exhaustive` instead of a `switch`?",
      a: "When a person adds a case to `T`, `Match.exhaustive` does not compile until you process the case. The type of unprocessed cases is no longer `never`. A `switch` compiles and returns `undefined`. `Match` is also an expression, and it supports predicates and partial shapes."
    },
    {
      q: "What does `Data.taggedEnum<T>()` give you?",
      a: "A constructor for each case (`Pending({ amount })`), a `$is(\"Case\")` type guard that narrows the type, and an exhaustive `$match`. You can call `$match` data-first (`$match(value, cases)`) or data-last (`$match(cases)`)."
    },
    {
      q: "Where must `Effect.runSync` or `Effect.runPromise` appear in an application?",
      a: "One time, at the edge: in `main`, in a test, or at a framework boundary such as a request handler. Inside business logic, use `flatMap`, `forEach`, or `yield*`. A `runSync` inside a `map` throws on async work. It also hides the inner effect from layers, retries, and timeouts."
    }
  ]
}

export default section
