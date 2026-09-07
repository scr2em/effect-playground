import type { Section } from "../types.ts"

const section: Section = {
  id: "data-types",
  title: "Data Types",
  order: 17,
  summary: "Option, Result, Duration, DateTime, Data classes, Chunk, HashMap and HashSet: explicit values instead of null, throw, raw milliseconds and mutable Dates.",
  intro: `
**The problem.** Plain TypeScript has four habits that hide information from the type checker. They look harmless one at a time:

\`\`\`ts
function findUser(id: number): User | null      // every caller must remember the null check
function parseAge(raw: string): number          // throws on bad input, the signature says nothing
setTimeout(retry, 5000)                         // is 5000 milliseconds? seconds? nobody knows
const due = new Date(); due.setDate(due.getDate() + 30)   // mutated in place, timezone of the machine
\`\`\`

Forget the null check and you get \`Cannot read properties of null\` in production. Forget the \`try\` and the throw escapes three layers up. Pass \`5\` where \`5000\` was expected and the retry fires instantly. Reuse a \`Date\` after something mutated it and the invoice is a month late. None of these mistakes is a compile error.

### The shift

Today you think of "no value", "failed", "how long" and "when" as things you handle with **conventions**: a \`null\` check here, a \`try/catch\` there, a comment saying "in ms". Effect asks you to represent each of them as an **explicit value with a type**, and to work on those values with **total functions**, functions that have an answer for every input and never throw.

- \`Option<A>\` says "maybe an \`A\`" and every operation on it handles both cases for you.
- \`Result<A, E>\` says "an \`A\` or an \`E\`" and carries the failure as data instead of a thrown exception.
- \`Duration\` says "this much time" with a unit, so \`"5 seconds"\` and \`5000\` cannot be confused.
- \`DateTime\` is an immutable instant; adding a day returns a new value and the time zone is explicit.
- \`Data\` classes, \`Chunk\`, \`HashMap\` and \`HashSet\` are immutable collections and records that compare by value.

The payoff: the compiler enforces the convention. A missing value cannot be forgotten because it is not an \`A\`, it is an \`Option<A>\`. A failure cannot escape because it is a \`Result\`. And every one of these types plugs straight into \`Effect\`: an \`Option\` becomes an \`Effect\` that fails with \`NoSuchElementError\`, a \`Result\` becomes an \`Effect\` that fails with its \`E\`, a \`Duration\` is what \`sleep\` and \`timeout\` accept.

| Plain TypeScript | Effect | What you gain |
|---|---|---|
| \`A \\| null \\| undefined\` | \`Option<A>\` | \`map\`, \`flatMap\`, \`getOrElse\` never forget the empty case |
| \`throw\` / \`try\`-\`catch\` | \`Result<A, E>\` | The failure type is in the signature; it is a value you can inspect |
| \`number\` of milliseconds | \`Duration\` | Units are explicit: \`Duration.seconds(5)\`, \`"5 seconds"\` |
| \`Date\` (mutable, local time) | \`DateTime\` | Immutable, UTC by default, explicit zones, calendar math |
| \`Array\` (mutable) | \`Chunk\` | Immutable, cheap append, value equality; what streams emit |
| \`Map\` / \`Set\` (keys by reference) | \`HashMap\` / \`HashSet\` | Keys compared by value, updates return a new collection |

In this section you will meet each type through a small program, then combine them. The next two sections (Trait, Behaviour) explain the equality and ordering machinery these types share.
`,
  lessons: [
    {
      id: "data-types-l1",
      title: "Option: a value that may be missing",
      explain: `
Here is the plain TypeScript version of "find a user, then get the domain of their email, or a fallback":

\`\`\`ts
const user = users.find((u) => u.id === id)
if (!user) return "no email"
if (!user.email) return "no email"
return user.email.split("@")[1]
\`\`\`

Three lines of the five are null checks, and the fallback string is repeated. \`Option\` replaces this with a chain of total functions. \`Option.fromNullishOr\` turns \`A | null | undefined\` into \`Option<A>\`. Then:

| Function | Use when |
|---|---|
| \`Option.map(f)\` | \`f\` returns a plain value |
| \`Option.flatMap(f)\` | \`f\` itself returns an \`Option\` (a second thing that may be missing) |
| \`Option.getOrElse(() => d)\` | You want to leave Option-land with a default |
| \`Option.match({ onNone, onSome })\` | Both branches need different code |

If the Option is \`None\`, \`map\` and \`flatMap\` do nothing and pass the \`None\` along. The empty case is handled once, by the type, not once per line.
`,
      code: `import { Option } from "effect"

interface User {
  readonly id: number
  readonly name: string
  readonly email?: string
}

const users: ReadonlyArray<User> = [
  { id: 1, name: "Ada", email: "ada@example.com" },
  { id: 2, name: "Lin" }
]

// Array.find returns User | undefined. fromNullishOr turns that into Option<User>.
const findUser = (id: number): Option.Option<User> =>
  Option.fromNullishOr(users.find((u) => u.id === id))

// Every step is total: it has an answer for Some and for None, no if-checks in between
const emailDomain = (id: number): string =>
  findUser(id).pipe(
    Option.flatMap((u) => Option.fromNullishOr(u.email)),   // email is optional too
    Option.map((email) => email.split("@")[1]),
    Option.getOrElse(() => "no email")
  )

console.log(emailDomain(1))
console.log(emailDomain(2))
console.log(emailDomain(3))

// match when the two branches need different code
const describe = findUser(2).pipe(
  Option.match({
    onNone: () => "unknown user",
    onSome: (u) => "user " + u.name
  })
)
console.log(describe)
`,
      expectedOutput: `example.com
no email
no email
user Lin`,
      after: `Notice that the fallback \`"no email"\` appears once, at the end. Try changing \`Option.flatMap\` on the email line to \`Option.map\`: you get an \`Option<Option<string>>\` and the next \`map\` no longer type-checks, because \`split\` is not a function on an Option. \`flatMap\` is for functions that return an Option.`
    },
    {
      id: "data-types-l2",
      title: "Option inside an Effect",
      explain: `
Sooner or later an optional value shows up inside \`Effect.gen\`. In this version of Effect you do not \`yield*\` an Option directly (that is neither an accepted type nor a valid runtime step). You convert it with one of two bridges:

| Bridge | Direction | Result |
|---|---|---|
| \`Effect.fromOption(opt)\` | Option to Effect | \`Some(a)\` succeeds with \`a\`; \`None\` fails with \`NoSuchElementError\` |
| \`Effect.fromOption(opt, () => err)\` | Option to Effect | Same, but \`None\` fails with your own error |
| \`Effect.option(effect)\` | Effect to Option | Any failure becomes \`None\`, success becomes \`Some\` |

\`NoSuchElementError\` is a tagged error from the \`Cause\` module, so it sits in the error channel like any other typed failure: \`Effect<number, NoSuchElementError>\`. The compiler will make you handle it, which is exactly the point. A missing price is not an exception, it is a case.

\`Effect.fromNullishOr(value)\` is the shortcut for \`Effect.fromOption(Option.fromNullishOr(value))\`.
`,
      code: `import { Effect, Option } from "effect"

const prices = new Map([["apple", 120], ["pear", 95]])

// Map.get returns number | undefined, so this is Option<number>
const price = (item: string): Option.Option<number> => Option.fromNullishOr(prices.get(item))

// Effect.fromOption: Some -> success, None -> fails with NoSuchElementError
const total = (items: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let sum = 0
    for (const item of items) {
      sum += yield* Effect.fromOption(price(item))   // Effect<number, NoSuchElementError>
    }
    return sum
  })

const program = Effect.gen(function* () {
  console.log("total:", yield* total(["apple", "pear"]))

  // Effect.option goes the other way: the failure becomes a None, no error channel left
  const maybe = yield* Effect.option(total(["apple", "kiwi"]))
  console.log("with kiwi:", String(maybe))

  // Give None a custom error instead of NoSuchElementError. flip swaps error and success so we can print it.
  const err = yield* Effect.flip(Effect.fromOption(price("kiwi"), () => "kiwi is not for sale"))
  console.log(err)
})

Effect.runSync(program)
`,
      expectedOutput: `total: 215
with kiwi: none()
kiwi is not for sale`,
      after: `Hover \`total\` in an editor: its type is \`Effect<number, NoSuchElementError>\`. The missing case travelled from \`Map.get\` all the way into the Effect's error channel without a single \`if\`. Try replacing the \`Effect.option\` line with a plain \`yield* total(["apple", "kiwi"])\`: the program now fails with \`NoSuchElementError\`, which \`runSync\` throws.`
    },
    {
      id: "data-types-l3",
      title: "Result: success or failure as a value",
      explain: `
An \`Option\` only says "missing". When you also need to say *why*, use \`Result<A, E>\` (Effect v3 called it \`Either\`). Compare a throwing validator with a Result-returning one:

\`\`\`ts
// throws: the signature is a lie, the caller must guess
function parseAge(raw: string): number {
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error("not a number")
  return n
}
\`\`\`

The Result version returns \`Result.succeed(n)\` or \`Result.fail("not a number")\`, and its type is \`Result<number, string>\`. A Result is plain data: nothing runs when you create it, and you can \`map\` the success, \`mapError\` the failure, or \`match\` both without any \`try\`.

Two bridges connect Result to Effect, the same way as for Option: \`Effect.fromResult(result)\` moves the failure into the error channel, and \`Effect.result(effect)\` captures an Effect's outcome as a \`Result\` so the effect itself can no longer fail.
`,
      code: `import { Effect, Result } from "effect"

// A pure validation. It returns a Result instead of throwing.
const parseAge = (raw: string): Result.Result<number, string> => {
  const n = Number(raw)
  if (Number.isNaN(n)) return Result.fail("not a number: " + raw)
  if (n < 0 || n > 150) return Result.fail("out of range: " + n)
  return Result.succeed(n)
}

// Results are values: transform and fold them without running anything
for (const raw of ["42", "abc", "200"]) {
  const message = parseAge(raw).pipe(
    Result.map((age) => age + 1),                 // only touches a Success
    Result.mapError((e) => e.toUpperCase()),      // only touches a Failure
    Result.match({
      onFailure: (e) => "rejected (" + e + ")",
      onSuccess: (age) => "next year " + age
    })
  )
  console.log(message)
}

const program = Effect.gen(function* () {
  // fromResult: the string failure moves into the Effect error channel
  const age = yield* Effect.fromResult(parseAge("30"))
  console.log("age from effect:", age)

  // Effect.result: capture the outcome as a value instead of failing
  const captured = yield* Effect.result(Effect.fromResult(parseAge("x")))
  console.log("captured:", String(captured))
})

Effect.runSync(program)
`,
      expectedOutput: `next year 43
rejected (NOT A NUMBER: ABC)
rejected (OUT OF RANGE: 200)
age from effect: 30
captured: failure("not a number: x")`,
      after: `\`Result.map\` skipped the two failures and \`Result.mapError\` skipped the success. Each function touches one channel only. When would you pick \`Result\` over throwing inside \`Effect.try\`? When the function is pure and you want to call it from non-Effect code too; a Result works anywhere.`
    },
    {
      id: "data-types-l4",
      title: "Duration: time with a unit",
      explain: `
A bare number is the most common way to get a timeout wrong. \`Duration\` makes the unit part of the value. There are three ways to write the same duration, and they compare equal:

| Form | Example | Use when |
|---|---|---|
| Constructor | \`Duration.seconds(5)\`, \`Duration.millis(5000)\` | Building durations in code |
| String | \`"5 seconds"\`, \`"500 millis"\`, \`"2 minutes"\` | Passing to an Effect API that takes \`Duration.Input\` |
| Number | \`5000\` | Only when you already have milliseconds; it is treated as millis |

Every Effect function that waits (\`Effect.sleep\`, \`Effect.timeout\`, retry schedules) accepts a \`Duration.Input\`, which is any of the three forms. \`Duration.fromInputUnsafe\` converts a string or number into a real \`Duration\` when you need to do math on it.

Durations are immutable and comparable: \`Duration.equals\`, \`Duration.isLessThan\`, \`Duration.sum\`, \`Duration.format\` for a human-readable string. \`Effect.timeout\` fails with a typed \`TimeoutError\` when the time runs out.
`,
      code: `import { Duration, Effect } from "effect"

// Three ways to say the same thing
const a = Duration.seconds(5)
const b = Duration.millis(5000)
const c = Duration.fromInputUnsafe("5 seconds")   // the string form every Effect API accepts

console.log(Duration.equals(a, b), Duration.equals(b, c))
console.log(Duration.toMillis(Duration.fromInputUnsafe("1.5 minutes")))
console.log(Duration.format(Duration.sum(Duration.minutes(1), Duration.millis(2500))))
console.log(Duration.isLessThan(Duration.millis(900), Duration.seconds(1)))

// sleep and timeout take a Duration.Input: a Duration, a string, or a number of millis
const slowJob = Effect.sleep("50 millis").pipe(Effect.as("job done"))

const main = async () => {
  // Plenty of time: the job finishes
  console.log(await Effect.runPromise(Effect.timeout(slowJob, "1 second")))

  // Not enough time: a typed TimeoutError. flip swaps it into the success channel so we can print it.
  const err = await Effect.runPromise(Effect.flip(Effect.timeout(slowJob, "10 millis")))
  console.log(err._tag)
}

main()
`,
      expectedOutput: `true true
90000
1m 2s 500ms
true
job done
TimeoutError`,
      after: `Try changing \`"1 second"\` to \`1\`. A bare \`1\` means one millisecond, so the first call times out too. That is the bug \`Duration\` is designed to make visible: write \`"1 second"\` or \`Duration.seconds(1)\` and the unit is in the code.`
    },
    {
      id: "data-types-l5",
      title: "DateTime: immutable instants with explicit zones",
      explain: `
JavaScript's \`Date\` is mutable, prints in the machine's local time, and turns bad input into \`Invalid Date\` instead of an error. \`DateTime\` fixes all three.

| Need | Function |
|---|---|
| Parse a string, safely | \`DateTime.make(input)\` returns \`Option<DateTime>\` |
| Parse a string you trust | \`DateTime.makeUnsafe(input)\` throws on bad input |
| The current time | \`yield* DateTime.now\` inside an Effect (uses the Clock service, so tests can control it); \`DateTime.nowUnsafe()\` outside |
| Calendar math | \`DateTime.add(dt, { days: 20 })\`, \`DateTime.startOf(dt, "month")\` |
| Duration math | \`DateTime.addDuration(dt, "90 minutes")\` |
| Gap between two instants | \`DateTime.distance(a, b)\` returns a \`Duration\` |
| Print | \`DateTime.formatIso\`, \`formatIsoDate\`, \`formatIsoZoned\` |

A \`DateTime.Utc\` is a point in time. \`DateTime.setZoneNamedUnsafe(dt, "Asia/Tokyo")\` gives a \`DateTime.Zoned\`: the **same instant**, viewed through a zone. Calendar parts (\`toParts\`) follow the zone; \`toPartsUtc\` ignores it.

This lesson builds from a fixed ISO string so the output is stable. Real code uses \`DateTime.now\`.
`,
      code: `import { DateTime, Duration, Option } from "effect"

// Build from a fixed ISO string. In real code: yield* DateTime.now inside an Effect.
const launch = DateTime.makeUnsafe("2024-06-15T14:30:00Z")

console.log(DateTime.formatIso(launch))
console.log(DateTime.formatIso(DateTime.add(launch, { days: 20 })))          // calendar math
console.log(DateTime.formatIso(DateTime.addDuration(launch, "90 minutes")))  // duration math
console.log(DateTime.formatIso(DateTime.startOf(launch, "month")))
console.log(DateTime.formatIso(launch))   // the original never changed

// Parsing user input: make returns an Option instead of an Invalid Date
console.log(String(DateTime.make("not a date")))
console.log(DateTime.make("2024-12-25").pipe(Option.map(DateTime.formatIsoDate), Option.getOrElse(() => "invalid")))

// The gap between two instants is a Duration
const deadline = DateTime.makeUnsafe("2024-06-18T09:00:00Z")
console.log(Duration.format(DateTime.distance(launch, deadline)))

// Time zones: the instant stays the same, the calendar view changes
const tokyo = DateTime.setZoneNamedUnsafe(launch, "Asia/Tokyo")
console.log(DateTime.formatIsoZoned(tokyo))
console.log(DateTime.toParts(tokyo).hour, DateTime.toPartsUtc(tokyo).hour)
`,
      expectedOutput: `2024-06-15T14:30:00.000Z
2024-07-05T14:30:00.000Z
2024-06-15T16:00:00.000Z
2024-06-01T00:00:00.000Z
2024-06-15T14:30:00.000Z
none()
2024-12-25
2d 18h 30m
2024-06-15T23:30:00.000+09:00[Asia/Tokyo]
23 14`,
      after: `\`launch\` printed the same value before and after all the math, because every function returned a new \`DateTime\`. Try \`DateTime.add(launch, { months: 1 })\` and then \`{ days: 30 }\`: calendar months and fixed durations are different things, and \`DateTime\` lets you say which one you mean.`
    },
    {
      id: "data-types-l6",
      title: "Data: small immutable records",
      explain: `
The \`Data\` module builds immutable domain values with less ceremony than a hand-written class:

| Helper | Gives you |
|---|---|
| \`Data.Class<{ fields }>\` | Readonly fields, one-object constructor, \`.pipe\` |
| \`Data.TaggedClass("Tag")<{ fields }>\` | The same plus a \`_tag\` field you do not have to write |
| \`Data.taggedEnum<Union>()\` | Constructors and a \`$match\` for a whole union of tagged records |
| \`Data.Error\` / \`Data.TaggedError\` | Errors that can be yielded inside \`Effect.gen\` (see Error Management) |

If you used Effect v3 you may remember \`Data.struct\` and \`Data.array\`, which existed to opt objects into value equality. They are gone in v4, because \`Equal.equals\` now compares plain objects, arrays and class instances by value out of the box. What \`Data\` still adds is shape: readonly fields, the \`_tag\`, and the constructor discipline.

Value equality is the preview of the next section. \`===\` compares references and says two identical points are different; \`Equal.equals\` compares contents.
`,
      code: `import { Data, Equal } from "effect"

// Data.Class: readonly fields, constructed from one object
class Point extends Data.Class<{ readonly x: number; readonly y: number }> {}

const p1 = new Point({ x: 1, y: 2 })
const p2 = new Point({ x: 1, y: 2 })
console.log(p1 === p2, Equal.equals(p1, p2))   // reference vs value equality

// Data.TaggedClass adds a _tag you did not have to write
class Money extends Data.TaggedClass("Money")<{ readonly cents: number; readonly currency: string }> {}

const m = new Money({ cents: 500, currency: "EUR" })
console.log(m._tag, m.cents, Equal.equals(m, new Money({ cents: 500, currency: "EUR" })))

// Data.taggedEnum: a whole union with constructors and an exhaustive matcher
type Shape = Data.TaggedEnum<{
  Circle: { readonly radius: number }
  Rect: { readonly w: number; readonly h: number }
}>
const { Circle, Rect, $match } = Data.taggedEnum<Shape>()

const area = $match({
  Circle: ({ radius }) => Math.round(Math.PI * radius * radius),
  Rect: ({ w, h }) => w * h
})

console.log(area(Circle({ radius: 2 })), area(Rect({ w: 3, h: 4 })))
console.log(Equal.equals(Circle({ radius: 2 }), Circle({ radius: 2 })))
`,
      expectedOutput: `false true
Money 500 true
13 12
true`,
      after: `Try removing the \`Rect\` case from \`$match\`: TypeScript refuses, because the matcher must cover every variant of \`Shape\`. Add a third variant to the type and every \`$match\` in the codebase flags the missing case. That is what a tagged union buys you over a loose \`{ kind: string }\`.`
    },
    {
      id: "data-types-l7",
      title: "Chunk, HashMap and HashSet: immutable collections with value keys",
      explain: `
JavaScript's \`Array\`, \`Map\` and \`Set\` are mutable, and \`Map\`/\`Set\` compare keys by reference: \`new Map().get({ id: 1 })\` never finds anything, because the lookup object is a different reference from the stored one. Effect's collections fix both.

| Collection | Like | Different because |
|---|---|---|
| \`Chunk<A>\` | \`ReadonlyArray<A>\` | Immutable, cheap \`append\`/\`prepend\`/\`appendAll\`, compares by value. Streams emit Chunks. |
| \`HashMap<K, V>\` | \`Map<K, V>\` | Keys compared by value; \`set\`/\`remove\` return a new map |
| \`HashSet<A>\` | \`Set<A>\` | Members compared by value; one entry per equal value |

When does \`Chunk\` matter? Mostly at the edges of streams and batches, where a producer keeps appending and you never want to copy the whole array. For everyday code, a plain \`ReadonlyArray\` plus the \`Array\` module functions is fine, and \`Chunk.toArray\` / \`Chunk.fromIterable\` convert in both directions.

\`HashMap.get\` returns an \`Option\`, so a missing key is a value, not \`undefined\`.
`,
      code: `import { Chunk, Equal, HashMap, HashSet, Option } from "effect"

// Chunk: immutable, cheap append, value equality
const c1 = Chunk.make(1, 2, 3)
const c2 = Chunk.append(c1, 4)          // c1 is untouched
console.log(Chunk.toArray(c1).join(","), Chunk.toArray(c2).join(","))
console.log(Equal.equals(Chunk.make(1, 2), Chunk.make(1, 2)), Chunk.make(1, 2) === Chunk.make(1, 2))

// HashMap with a structural key: a fresh object with the same fields finds the entry
const stock = HashMap.make(
  [{ warehouse: "A", sku: "bolt" }, 120],
  [{ warehouse: "B", sku: "bolt" }, 8]
)
console.log(String(HashMap.get(stock, { warehouse: "B", sku: "bolt" })))
console.log(String(HashMap.get(stock, { warehouse: "C", sku: "bolt" })))

// set returns a new map; the old one is unchanged
const restocked = HashMap.set(stock, { warehouse: "B", sku: "bolt" }, 50)
const count = (map: HashMap.HashMap<{ warehouse: string; sku: string }, number>) =>
  HashMap.get(map, { warehouse: "B", sku: "bolt" }).pipe(Option.getOrElse(() => 0))
console.log(count(stock), count(restocked))

// HashSet dedupes by value, JS Set by reference
const tags = HashSet.fromIterable([{ id: 1 }, { id: 1 }, { id: 2 }])
console.log(HashSet.size(tags), new Set([{ id: 1 }, { id: 1 }, { id: 2 }]).size)
`,
      expectedOutput: `1,2,3 1,2,3,4
true false
some(8)
none()
8 50
2 3`,
      after: `The lookup key \`{ warehouse: "B", sku: "bolt" }\` was a brand-new object each time and still found the entry. A JS \`Map\` would have returned \`undefined\`. This works because \`HashMap\` uses the \`Equal\` and \`Hash\` traits, which the next section explains.`
    }
  ],
  challenges: [
    {
      id: "data-types-c1",
      title: "A v3 name",
      task: `This program should print \`port 8080\` but it does not compile: the Option constructor it uses does not exist in this version of Effect. Replace it with the right one.`,
      code: `import { Option } from "effect"

const config: { port?: number } = {}

const port = Option.fromNullable(config.port).pipe(
  Option.getOrElse(() => 8080)
)

console.log("port", port)
`,
      solution: `import { Option } from "effect"

const config: { port?: number } = {}

const port = Option.fromNullishOr(config.port).pipe(
  Option.getOrElse(() => 8080)
)

console.log("port", port)
`,
      expectedOutput: `port 8080`,
      hints: [
        "The v3 name was fromNullable. The v4 family is named after what it treats as absent: null-ish, null, or undefined.",
        "Lesson 1 used the function that treats both null and undefined as None.",
        "Use Option.fromNullishOr(config.port)."
      ],
      explanation: `v4 renamed the nullable constructors to say exactly what they consider absent: \`Option.fromNullishOr\` (null or undefined), \`Option.fromNullOr\` (only null) and \`Option.fromUndefinedOr\` (only undefined). The old \`fromNullable\` is gone, so the property access is a type error. Reading the error message ("Property 'fromNullable' does not exist") is faster than guessing: grep the module for the family and pick the one that matches your input type.`
    },
    {
      id: "data-types-c2",
      title: "The default that is not lazy",
      task: `The program prints the right thing at runtime but does not type-check. Make it compile without changing the output \`The Countess\`.`,
      code: `import { Option } from "effect"

const nicknames = new Map([["ada", "The Countess"]])

const greet = (user: string) =>
  Option.fromNullishOr(nicknames.get(user)).pipe(
    Option.getOrElse("stranger")
  )

console.log(greet("ada"))
`,
      solution: `import { Option } from "effect"

const nicknames = new Map([["ada", "The Countess"]])

const greet = (user: string) =>
  Option.fromNullishOr(nicknames.get(user)).pipe(
    Option.getOrElse(() => "stranger")
  )

console.log(greet("ada"))
`,
      expectedOutput: `The Countess`,
      hints: [
        "Read the type error: getOrElse wants a LazyArg. What is a LazyArg?",
        "The default is only needed when the Option is None, so Effect asks for a function that produces it.",
        "Write Option.getOrElse(() => \"stranger\")."
      ],
      explanation: `\`getOrElse\` takes a function \`() => B\`, not a \`B\`. Laziness is the point: the default is only computed when the Option is \`None\`, which matters when the default is expensive or has side effects. Here the input was \`Some\`, so at runtime the bad argument was never called and the output looked fine. Try \`greet("lin")\` on the broken version: it crashes with "onNone is not a function". The type checker caught a runtime bug that only shows up on the empty path.`
    },
    {
      id: "data-types-c3",
      title: "An Option inside an Option",
      task: `\`run\` should print \`4\`, \`-1\`, \`-1\` (the square root when the input is a non-negative number, otherwise \`-1\`). It prints something else. Fix the pipeline without changing \`safeSqrt\` or \`parse\`.`,
      code: `import { Option } from "effect"

const safeSqrt = (n: number): Option.Option<number> =>
  n >= 0 ? Option.some(Math.sqrt(n)) : Option.none()

const parse = (s: string): Option.Option<number> => {
  const n = Number(s)
  return Number.isNaN(n) ? Option.none() : Option.some(n)
}

const run = (input: string) =>
  parse(input).pipe(
    Option.map((n) => safeSqrt(n)),
    Option.getOrElse(() => -1)
  )

for (const s of ["16", "-4", "abc"]) {
  console.log(String(run(s)))
}
`,
      solution: `import { Option } from "effect"

const safeSqrt = (n: number): Option.Option<number> =>
  n >= 0 ? Option.some(Math.sqrt(n)) : Option.none()

const parse = (s: string): Option.Option<number> => {
  const n = Number(s)
  return Number.isNaN(n) ? Option.none() : Option.some(n)
}

const run = (input: string) =>
  parse(input).pipe(
    Option.flatMap((n) => safeSqrt(n)),
    Option.getOrElse(() => -1)
  )

for (const s of ["16", "-4", "abc"]) {
  console.log(String(run(s)))
}
`,
      expectedOutput: `4
-1
-1`,
      hints: [
        "Look at what the broken version prints for \"16\": some(4). Where did the extra some come from?",
        "safeSqrt already returns an Option. Wrapping its result with map gives Option<Option<number>>.",
        "Use Option.flatMap for the safeSqrt step."
      ],
      explanation: `\`Option.map\` wraps whatever the function returns, so a function that already returns an Option produces \`Option<Option<number>>\`. \`getOrElse\` then unwrapped one layer and printed the inner \`some(4)\`, and for \`-4\` it printed \`none()\` instead of \`-1\`. \`Option.flatMap\` flattens the nesting: the outer \`None\` and the inner \`None\` become one \`None\`. This is the same map-versus-flatMap distinction as for Effect, and it applies to Result too.`
    },
    {
      id: "data-types-c4",
      title: "The missing case that leaked",
      task: `\`displayName\` promises \`Effect.Effect<string>\`, an effect that cannot fail, but the body can. Handle the missing case so unknown ids produce \`guest\`, without changing the annotation. Expected output: \`ADA\` then \`guest\`.`,
      code: `import { Effect, Option } from "effect"

const names = new Map([[1, "Ada"], [2, "Lin"]])

// Callers rely on this never failing: unknown ids must become "guest"
const displayName = (id: number): Effect.Effect<string> =>
  Effect.gen(function* () {
    const name = yield* Effect.fromOption(Option.fromNullishOr(names.get(id)))
    return name.toUpperCase()
  })

const program = Effect.gen(function* () {
  console.log(yield* displayName(1))
  console.log(yield* displayName(3))
})

Effect.runSync(program)
`,
      solution: `import { Effect, Option } from "effect"

const names = new Map([[1, "Ada"], [2, "Lin"]])

const displayName = (id: number): Effect.Effect<string> =>
  Effect.gen(function* () {
    const name = yield* Effect.fromOption(Option.fromNullishOr(names.get(id)))
    return name.toUpperCase()
  }).pipe(
    Effect.catchTag("NoSuchElementError", () => Effect.succeed("guest"))
  )

const program = Effect.gen(function* () {
  console.log(yield* displayName(1))
  console.log(yield* displayName(3))
})

Effect.runSync(program)
`,
      expectedOutput: `ADA
guest`,
      hints: [
        "Read the type error: which error type is in the body's error channel that the annotation does not allow?",
        "Effect.fromOption fails with NoSuchElementError when the Option is None. That failure has a _tag.",
        "Pipe the generator into Effect.catchTag(\"NoSuchElementError\", () => Effect.succeed(\"guest\"))."
      ],
      explanation: `\`Effect.fromOption\` turned the \`None\` into a typed \`NoSuchElementError\`, so the body's real type is \`Effect<string, NoSuchElementError>\` and the annotation \`Effect<string>\` is a lie the compiler refuses. Handling the error with \`catchTag\` removes it from the error channel and the annotation becomes true. Compare with plain TypeScript, where \`names.get(3)!.toUpperCase()\` compiles and crashes at runtime. Another valid fix is to fold the Option before entering the Effect with \`Option.match\` or \`Option.getOrElse\`; both make the missing case explicit.`
    },
    {
      id: "data-types-c5",
      title: "Two what?",
      task: `The report takes about 30 milliseconds and the code intends to give it two seconds. Instead it prints \`gave up\`. Fix the timeout so the program prints \`report ready\`.`,
      code: `import { Effect } from "effect"

// Simulates a call that takes about 30ms
const fetchReport = Effect.sleep("30 millis").pipe(Effect.as("report ready"))

// Intended: give up after 2 seconds
const program = fetchReport.pipe(
  Effect.timeout(2),
  Effect.catchTag("TimeoutError", () => Effect.succeed("gave up"))
)

Effect.runPromise(program).then(console.log)
`,
      solution: `import { Effect } from "effect"

// Simulates a call that takes about 30ms
const fetchReport = Effect.sleep("30 millis").pipe(Effect.as("report ready"))

// Intended: give up after 2 seconds
const program = fetchReport.pipe(
  Effect.timeout("2 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.succeed("gave up"))
)

Effect.runPromise(program).then(console.log)
`,
      expectedOutput: `report ready`,
      hints: [
        "What unit does a bare number mean when passed as a Duration.Input?",
        "Lesson 4's table: a number is milliseconds. Two milliseconds is not two seconds.",
        "Use Effect.timeout(\"2 seconds\") or Effect.timeout(Duration.seconds(2))."
      ],
      explanation: `A bare number in a \`Duration.Input\` position means milliseconds, so \`timeout(2)\` gave the report two milliseconds and it lost the race every time. Writing \`"2 seconds"\` or \`Duration.seconds(2)\` puts the unit in the code where a reviewer can see it. This is the whole reason \`Duration\` exists: the compiler cannot tell \`2\` from \`2000\`, but it can read \`"2 seconds"\`.`
    },
    {
      id: "data-types-c6",
      title: "The date that did not move",
      task: `A trial lasts 30 days from signup. The program prints the signup date instead of the end date. Make it print \`trial ends 2024-03-30\`.`,
      code: `import { DateTime } from "effect"

const signup = DateTime.makeUnsafe("2024-02-29T10:00:00Z")

// Trial lasts 30 days
let trialEnds = signup
DateTime.add(trialEnds, { days: 30 })

console.log("trial ends", DateTime.formatIsoDate(trialEnds))
`,
      solution: `import { DateTime } from "effect"

const signup = DateTime.makeUnsafe("2024-02-29T10:00:00Z")

// Trial lasts 30 days
const trialEnds = DateTime.add(signup, { days: 30 })

console.log("trial ends", DateTime.formatIsoDate(trialEnds))
`,
      expectedOutput: `trial ends 2024-03-30`,
      hints: [
        "Does DateTime.add change its argument, or return something?",
        "Lesson 5 printed the original DateTime after doing math on it and it was unchanged.",
        "Assign the result: const trialEnds = DateTime.add(signup, { days: 30 })."
      ],
      explanation: `\`DateTime\` values are immutable. \`DateTime.add\` returns a new value and leaves \`signup\` alone, so the result was thrown away and \`trialEnds\` still pointed at the signup. With a JS \`Date\`, \`setDate\` mutates in place and the same code would have "worked", while also silently changing \`signup\` for everyone else holding it. Immutability means the only way to get the new date is to keep the return value, which is what makes the value safe to share.`
    }
  ],
  problems: [
    {
      id: "data-types-p1",
      title: "Config with fallbacks",
      spec: `
Settings can come from three places, checked in order: command-line arguments, environment variables (keys are uppercase), then defaults. Build it with \`Option\`:

1. \`fromCli(key)\`, \`fromEnv(key)\` and \`fromDefaults(key)\` each return \`Option<string>\` using \`Option.fromNullishOr\`. \`fromEnv\` looks up \`key.toUpperCase()\`.
2. \`setting(key)\` returns the first \`Some\` of the three, using \`Option.orElse\`.
3. \`portNumber\` parses \`setting("port")\` into a number with \`Option.flatMap\` (a \`None\` if it is not a number), defaulting to \`0\`.

Print one line per key for \`host\`, \`port\`, \`mode\` and \`timeout\`, then the port as a number. Exact output:

\`\`\`
host=0.0.0.0
port=8080
mode=dev
timeout=missing
port as number: 8080
\`\`\`

Sources: \`cli = { host: "0.0.0.0" }\`, \`env = { PORT: "8080" }\`, \`defaults = { mode: "dev" }\`.
`,
      starter: `import { Option } from "effect"

const cli: Record<string, string | undefined> = { host: "0.0.0.0" }
const env: Record<string, string | undefined> = { PORT: "8080" }
const defaults: Record<string, string | undefined> = { mode: "dev" }

// TODO: fromCli, fromEnv (uppercase key), fromDefaults, each returning Option<string>

// TODO: setting(key) returns the first Some using Option.orElse
const setting = (key: string): Option.Option<string> => Option.none()

for (const key of ["host", "port", "mode", "timeout"]) {
  // TODO: print key=value or key=missing
}

// TODO: portNumber via Option.flatMap, default 0
`,
      solution: `import { Option } from "effect"

const cli: Record<string, string | undefined> = { host: "0.0.0.0" }
const env: Record<string, string | undefined> = { PORT: "8080" }
const defaults: Record<string, string | undefined> = { mode: "dev" }

const fromCli = (key: string) => Option.fromNullishOr(cli[key])
const fromEnv = (key: string) => Option.fromNullishOr(env[key.toUpperCase()])
const fromDefaults = (key: string) => Option.fromNullishOr(defaults[key])

// orElse is lazy: the next source is only consulted when the previous one is None
const setting = (key: string): Option.Option<string> =>
  fromCli(key).pipe(
    Option.orElse(() => fromEnv(key)),
    Option.orElse(() => fromDefaults(key))
  )

for (const key of ["host", "port", "mode", "timeout"]) {
  console.log(key + "=" + Option.getOrElse(setting(key), () => "missing"))
}

const parseNumber = (s: string): Option.Option<number> => {
  const n = Number(s)
  return Number.isNaN(n) ? Option.none() : Option.some(n)
}

const portNumber = setting("port").pipe(
  Option.flatMap(parseNumber),
  Option.getOrElse(() => 0)
)

console.log("port as number:", portNumber)
`,
      expectedOutput: `host=0.0.0.0
port=8080
mode=dev
timeout=missing
port as number: 8080`,
      hints: [
        "Each source function is one line: Option.fromNullishOr(source[key]).",
        "Option.orElse takes a function returning an Option, so it only runs when needed. Chain two of them.",
        "parseNumber returns an Option, so combine it with Option.flatMap, not map."
      ]
    },
    {
      id: "data-types-p2",
      title: "Meeting agenda",
      spec: `
A meeting starts at \`2024-09-02T09:00:00Z\` and has four items with durations given as strings:

\`\`\`
Standup        "15 minutes"
Design review  "45 minutes"
Break          "10 minutes"
Planning       "1 hour"
\`\`\`

Walk the agenda with \`DateTime.addDuration\`, keeping a running \`DateTime\`. For each item print \`HH:MM-HH:MM Title\` where the times are UTC hours and minutes from \`DateTime.toPartsUtc\`, zero-padded with \`String.prototype.padStart\`. Then print the total length as \`total <Duration.format of DateTime.distance(start, end)>\` and finally the end time in Tokyo using \`DateTime.setZoneNamedUnsafe\` and \`DateTime.formatIsoZoned\`. Exact output:

\`\`\`
09:00-09:15 Standup
09:15-10:00 Design review
10:00-10:10 Break
10:10-11:10 Planning
total 2h 10m
ends in Tokyo at 2024-09-02T20:10:00.000+09:00[Asia/Tokyo]
\`\`\`
`,
      starter: `import { DateTime, Duration } from "effect"

const start = DateTime.makeUnsafe("2024-09-02T09:00:00Z")

const agenda: ReadonlyArray<readonly [title: string, length: Duration.Input]> = [
  ["Standup", "15 minutes"],
  ["Design review", "45 minutes"],
  ["Break", "10 minutes"],
  ["Planning", "1 hour"]
]

// TODO: hhmm(dt) formats a DateTime as HH:MM in UTC

// TODO: walk the agenda, printing "HH:MM-HH:MM Title" and keeping the running time

// TODO: print "total <duration>" and "ends in Tokyo at <zoned iso>"
`,
      solution: `import { DateTime, Duration } from "effect"

const start = DateTime.makeUnsafe("2024-09-02T09:00:00Z")

const agenda: ReadonlyArray<readonly [title: string, length: Duration.Input]> = [
  ["Standup", "15 minutes"],
  ["Design review", "45 minutes"],
  ["Break", "10 minutes"],
  ["Planning", "1 hour"]
]

const hhmm = (dt: DateTime.DateTime): string => {
  const parts = DateTime.toPartsUtc(dt)
  return String(parts.hour).padStart(2, "0") + ":" + String(parts.minute).padStart(2, "0")
}

let current = start
for (const [title, length] of agenda) {
  const next = DateTime.addDuration(current, length)   // a new DateTime; current is untouched
  console.log(hhmm(current) + "-" + hhmm(next) + " " + title)
  current = next
}

console.log("total " + Duration.format(DateTime.distance(start, current)))

const tokyo = DateTime.setZoneNamedUnsafe(current, "Asia/Tokyo")
console.log("ends in Tokyo at " + DateTime.formatIsoZoned(tokyo))
`,
      expectedOutput: `09:00-09:15 Standup
09:15-10:00 Design review
10:00-10:10 Break
10:10-11:10 Planning
total 2h 10m
ends in Tokyo at 2024-09-02T20:10:00.000+09:00[Asia/Tokyo]`,
      hints: [
        "DateTime.addDuration accepts the string form directly, so the agenda entries can be passed as they are.",
        "Keep a `let current` and reassign it to the returned DateTime after each item; nothing mutates.",
        "DateTime.distance(start, end) returns a Duration; Duration.format prints it as 2h 10m."
      ]
    },
    {
      id: "data-types-p3",
      title: "Warehouse stock",
      spec: `
Track stock per SKU per warehouse. A key is \`class Sku extends Data.Class<{ readonly warehouse: string; readonly code: string }>\`. Stock movements arrive as a \`Chunk\` of \`{ sku: Sku; delta: number }\`:

\`\`\`
A/bolt +100,  B/bolt +8,  A/bolt -30,  A/nut +12
\`\`\`

1. \`apply(stock, movement)\` returns a new \`HashMap<Sku, number>\` with the delta added to the current quantity (\`0\` if absent). Use \`HashMap.get\` + \`Option.getOrElse\` and \`HashMap.set\`.
2. Fold the Chunk with \`Chunk.reduce\` starting from \`HashMap.empty()\`.
3. \`report(warehouse, code)\` looks up a **fresh** \`new Sku(...)\` and prints \`W/code: qty\` or \`W/code: none\`.

Print reports for A/bolt, B/bolt, A/nut and C/bolt, then the number of distinct SKUs with \`HashMap.size\`. Exact output:

\`\`\`
A/bolt: 70
B/bolt: 8
A/nut: 12
C/bolt: none
distinct skus: 3
\`\`\`
`,
      starter: `import { Chunk, Data, HashMap, Option } from "effect"

class Sku extends Data.Class<{ readonly warehouse: string; readonly code: string }> {}

interface Movement {
  readonly sku: Sku
  readonly delta: number
}

const movements = Chunk.make<ReadonlyArray<Movement>>(
  { sku: new Sku({ warehouse: "A", code: "bolt" }), delta: 100 },
  { sku: new Sku({ warehouse: "B", code: "bolt" }), delta: 8 },
  { sku: new Sku({ warehouse: "A", code: "bolt" }), delta: -30 },
  { sku: new Sku({ warehouse: "A", code: "nut" }), delta: 12 }
)

// TODO: apply(stock, movement) returns a new HashMap with the delta added

// TODO: fold movements with Chunk.reduce from HashMap.empty<Sku, number>()

// TODO: report(warehouse, code) prints "W/code: qty" or "W/code: none"

// TODO: print the reports and "distinct skus: N"
`,
      solution: `import { Chunk, Data, HashMap, Option } from "effect"

class Sku extends Data.Class<{ readonly warehouse: string; readonly code: string }> {}

interface Movement {
  readonly sku: Sku
  readonly delta: number
}

const movements = Chunk.make<ReadonlyArray<Movement>>(
  { sku: new Sku({ warehouse: "A", code: "bolt" }), delta: 100 },
  { sku: new Sku({ warehouse: "B", code: "bolt" }), delta: 8 },
  { sku: new Sku({ warehouse: "A", code: "bolt" }), delta: -30 },
  { sku: new Sku({ warehouse: "A", code: "nut" }), delta: 12 }
)

const apply = (stock: HashMap.HashMap<Sku, number>, m: Movement): HashMap.HashMap<Sku, number> => {
  const current = HashMap.get(stock, m.sku).pipe(Option.getOrElse(() => 0))
  return HashMap.set(stock, m.sku, current + m.delta)   // a new map each time
}

const stock = Chunk.reduce(movements, HashMap.empty<Sku, number>(), apply)

// A fresh Sku with the same fields is the same key: value equality, not reference equality
const report = (warehouse: string, code: string) => {
  const qty = HashMap.get(stock, new Sku({ warehouse, code })).pipe(
    Option.match({ onNone: () => "none", onSome: (n) => String(n) })
  )
  console.log(warehouse + "/" + code + ": " + qty)
}

report("A", "bolt")
report("B", "bolt")
report("A", "nut")
report("C", "bolt")
console.log("distinct skus:", HashMap.size(stock))
`,
      expectedOutput: `A/bolt: 70
B/bolt: 8
A/nut: 12
C/bolt: none
distinct skus: 3`,
      hints: [
        "apply is two lines: read the current quantity as an Option with a default of 0, then HashMap.set with the sum.",
        "Chunk.reduce(chunk, initial, (acc, item) => ...) works like Array.prototype.reduce.",
        "Because Sku extends Data.Class, a new Sku({ warehouse: \"A\", code: \"bolt\" }) finds the entry stored under a different instance."
      ]
    }
  ],
  recall: [
    {
      q: "You have a value of type `string | undefined`. Which function turns it into an `Option<string>`, and what happens to the `undefined`?",
      a: "`Option.fromNullishOr(value)`. `undefined` (and `null`) become `None`; anything else becomes `Some`. The v3 name `fromNullable` no longer exists."
    },
    {
      q: "What would the type of `Effect.fromOption(Option.some(42))` be?",
      a: "`Effect<number, NoSuchElementError>`. A `None` fails with `Cause.NoSuchElementError`. Pass a second argument `() => myError` to fail with your own error type instead."
    },
    {
      q: "Can you `yield*` an `Option` directly inside `Effect.gen` in this version?",
      a: "No. It is a type error and the runtime rejects it. Use `Effect.fromOption(opt)` (or `Effect.fromResult(res)` for a `Result`) to move the value into an Effect first. `Option.gen` and `Result.gen` exist for generators over Options and Results themselves."
    },
    {
      q: "Which would you reach for to say \"wait half a second\" in `Effect.sleep`, and why not `500`?",
      a: "`Effect.sleep(\"500 millis\")` or `Effect.sleep(Duration.millis(500))`. A bare `500` also works and means milliseconds, but the unit is invisible in the code; the string or constructor form makes it explicit and stops the seconds-versus-milliseconds bug."
    },
    {
      q: "What is the difference between `DateTime.now` and `DateTime.nowUnsafe()`?",
      a: "`DateTime.now` is an Effect that reads the Clock service, so tests can control time with `TestClock`. `DateTime.nowUnsafe()` reads the system clock immediately and returns a `DateTime.Utc`; use it only outside Effect code."
    },
    {
      q: "Why does `HashMap.get(map, { id: 1 })` find an entry when `new Map().get({ id: 1 })` does not?",
      a: "`HashMap` compares keys with Effect's structural `Equal` and buckets them with `Hash`, so a fresh object with the same contents is the same key. A JS `Map` compares object keys by reference. `Data.Class` instances, Options, Chunks and plain objects all work as HashMap keys for the same reason."
    }
  ]
}

export default section
