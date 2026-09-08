import type { Section } from "../types.ts"

const section: Section = {
  id: "data-types",
  title: "Data Types",
  order: 17,
  summary: "Option, Result, Duration, DateTime, Data classes, Chunk, HashMap and HashSet: explicit values instead of null, throw, raw milliseconds and mutable Dates.",
  intro: `
**The problem.** Plain TypeScript hides 4 kinds of information from the type checker. Each one looks small:

\`\`\`ts
function findUser(id: number): User | null      // each caller must remember the null check
function parseAge(raw: string): number          // throws on bad input; the signature does not say so
setTimeout(retry, 5000)                         // 5000 milliseconds? 5000 seconds? the code does not say
const due = new Date(); due.setDate(due.getDate() + 30)   // changed in place, in the local time of the machine
\`\`\`

If you forget the null check, you get \`Cannot read properties of null\` in production. If you forget the \`try\`, the exception stops the program 3 functions up. If you pass \`5\` where \`5000\` was expected, the retry starts at once. If some code changes a \`Date\` that other code holds, the invoice date is wrong. The compiler does not report any of these 4 mistakes.

### The shift

Today you represent "no value", "failed", "how long" and "when" with conventions: a \`null\` check here, a \`try/catch\` there, a comment that says "in ms". Effect asks you to represent each of them as a value with a type. Then you work on that value with total functions. A total function has a result for every input and never throws.

- \`Option<A>\` means "an \`A\` or nothing". Each operation on it processes both cases.
- \`Result<A, E>\` means "an \`A\` or an \`E\`". The failure is data, not a thrown exception.
- \`Duration\` means "this much time" with a unit. \`"5 seconds"\` and \`5000\` cannot be confused.
- \`DateTime\` is an immutable instant. When you add a day, you get a new value. The time zone is explicit.
- \`Data\` classes, \`Chunk\`, \`HashMap\` and \`HashSet\` are immutable records and collections. They compare by value.

The compiler enforces the convention. You cannot forget an absent value, because the type is \`Option<A>\` and not \`A\`. A failure cannot get out, because it is a \`Result\`. Each of these types also connects to \`Effect\`. An \`Option\` becomes an effect that fails with \`NoSuchElementError\`. A \`Result\` becomes an effect that fails with its \`E\`. A \`Duration\` is the input of \`sleep\` and \`timeout\`.

| Plain TypeScript | Effect | What you get |
|---|---|---|
| \`A \\| null \\| undefined\` | \`Option<A>\` | \`map\`, \`flatMap\` and \`getOrElse\` process the absent case for you |
| \`throw\` / \`try\`-\`catch\` | \`Result<A, E>\` | The failure type is in the signature. The failure is a value that you can inspect. |
| \`number\` of milliseconds | \`Duration\` | The unit is explicit: \`Duration.seconds(5)\`, \`"5 seconds"\` |
| \`Date\` (mutable, local time) | \`DateTime\` | Immutable, UTC by default, explicit zones, calendar math |
| \`Array\` (mutable) | \`Chunk\` | Immutable, cheap append, value equality. Streams emit Chunks. |
| \`Map\` / \`Set\` (keys by reference) | \`HashMap\` / \`HashSet\` | Keys compare by value. An update returns a new collection. |
| \`string\` for a token or a password | \`Redacted<string>\` | \`console.log\` and \`JSON.stringify\` print \`<redacted>\`. You read the value only where you use it. |
| \`number\` for money | \`BigDecimal\` | Exact decimal math. \`0.1 + 0.2\` is \`0.3\`, not \`0.30000000000000004\`. |

In this section, each type gets one small program. Then you combine them. The 2 next sections, Trait and Behaviour, explain the equality and order rules that these types share.
`,
  lessons: [
    {
      id: "data-types-l1",
      title: "Option: a value that can be absent",
      explain: `
Here is the plain TypeScript version of "find a user, get the domain of the email, or use a fallback":

\`\`\`ts
const user = users.find((u) => u.id === id)
if (!user) return "no email"
if (!user.email) return "no email"
return user.email.split("@")[1]
\`\`\`

3 of the 5 lines are null checks, and the fallback text appears twice. \`Option\` replaces this with a chain of total functions. \`Option.fromNullishOr\` converts \`A | null | undefined\` to \`Option<A>\`. Then you use these functions:

| Function | Use when |
|---|---|
| \`Option.map(f)\` | \`f\` returns a plain value |
| \`Option.flatMap(f)\` | \`f\` returns an \`Option\` (a second value that can be absent) |
| \`Option.getOrElse(() => d)\` | You want a plain value, with a default for \`None\` |
| \`Option.match({ onNone, onSome })\` | The 2 cases need different code |

When the Option is \`None\`, \`map\` and \`flatMap\` do nothing and pass the \`None\` on. The type processes the absent case once. You do not process it on each line.
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
      after: `The fallback \`"no email"\` appears once, at the end. Change \`Option.flatMap\` on the email line to \`Option.map\`. The result is an \`Option<Option<string>>\`, and the next \`map\` does not compile, because \`split\` is not a function of an Option. Use \`flatMap\` for functions that return an Option.`
    },
    {
      id: "data-types-l2",
      title: "Option inside an Effect",
      explain: `
An optional value soon appears inside \`Effect.gen\`. In this version of Effect, you cannot \`yield*\` an Option directly. The compiler rejects it, and the runtime rejects it. You convert the Option with one of 3 functions:

| Function | Direction | Result |
|---|---|---|
| \`Effect.fromOption(opt)\` | Option to Effect | \`Some(a)\` succeeds with \`a\`. \`None\` fails with \`NoSuchElementError\`. |
| \`Effect.fromOption(opt, () => err)\` | Option to Effect | The same, but \`None\` fails with your own error |
| \`Effect.option(effect)\` | Effect to Option | A failure becomes \`None\`. A success becomes \`Some\`. |

\`NoSuchElementError\` is a tagged error from the \`Cause\` module. It is in the error channel like each other typed failure: \`Effect<number, NoSuchElementError>\`. The compiler makes you process it. An absent price is not an exception. It is a case.

\`Effect.fromNullishOr(value)\` is a short form of \`Effect.fromOption(Option.fromNullishOr(value))\`.
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
      after: `Look at the type of \`total\` in an editor: \`Effect<number, NoSuchElementError>\`. The absent case went from \`Map.get\` to the error channel of the effect without an \`if\`. Replace the \`Effect.option\` line with \`yield* total(["apple", "kiwi"])\`. The program now fails with \`NoSuchElementError\`, and \`runSync\` throws it.`
    },
    {
      id: "data-types-l3",
      title: "Result: success or failure as a value",
      explain: `
An \`Option\` only says "absent". When you must also say why, use \`Result<A, E>\`. Effect v3 named this type \`Either\`. Compare a validator that throws with a validator that returns a Result:

\`\`\`ts
// throws: the signature does not show it, the caller must guess
function parseAge(raw: string): number {
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error("not a number")
  return n
}
\`\`\`

The Result version returns \`Result.succeed(n)\` or \`Result.fail("not a number")\`. Its type is \`Result<number, string>\`. A Result is data. Nothing runs when you make it. You can \`map\` the success, \`mapError\` the failure, or \`match\` both. No \`try\` is necessary.

2 functions connect Result and Effect, as for Option. \`Effect.fromResult(result)\` moves the failure into the error channel. \`Effect.result(effect)\` captures the outcome of an effect as a \`Result\`. After that, the effect cannot fail.
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
      after: `\`Result.map\` did not touch the 2 failures. \`Result.mapError\` did not touch the success. Each function changes one channel only. Use \`Result\` when the function is pure and code without Effect must also call it. A Result works everywhere.`
    },
    {
      id: "data-types-l4",
      title: "Duration: time with a unit",
      explain: `
A bare number is the most common cause of a wrong timeout. \`Duration\` makes the unit part of the value. There are 3 ways to write the same duration. They compare equal:

| Form | Example | Use when |
|---|---|---|
| Constructor | \`Duration.seconds(5)\`, \`Duration.millis(5000)\` | You build a duration in code |
| Text | \`"5 seconds"\`, \`"500 millis"\`, \`"2 minutes"\` | You give a duration to an Effect API that accepts \`Duration.Input\` |
| Number | \`5000\` | You already have milliseconds. The number is read as milliseconds. |

Each Effect function that waits accepts a \`Duration.Input\`: \`Effect.sleep\`, \`Effect.timeout\` and the retry schedules. A \`Duration.Input\` is one of the 3 forms. \`Duration.fromInputUnsafe\` converts text or a number to a \`Duration\` when you need to do math on it.

Durations are immutable, and you can compare them: \`Duration.equals\`, \`Duration.isLessThan\`, \`Duration.sum\`. \`Duration.format\` makes a text for humans. \`Effect.timeout\` fails with a typed \`TimeoutError\` when the time is over.
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
      after: `Change \`"1 second"\` to \`1\`. A bare \`1\` means 1 millisecond, so the first call also times out. This is the mistake that \`Duration\` makes visible. Write \`"1 second"\` or \`Duration.seconds(1)\`, and the unit is in the code.`
    },
    {
      id: "data-types-l5",
      title: "DateTime: immutable instants with explicit zones",
      explain: `
A JavaScript \`Date\` has 3 problems. Other code can change it. It prints in the local time of the machine. Bad input becomes \`Invalid Date\` instead of an error. \`DateTime\` corrects all 3.

| Need | Function |
|---|---|
| Parse text, safely | \`DateTime.make(input)\` returns \`Option<DateTime>\` |
| Parse text that you trust | \`DateTime.makeUnsafe(input)\` throws on bad input |
| The current time | \`yield* DateTime.now\` inside an effect. It uses the Clock service, so tests can control the time. Outside an effect: \`DateTime.nowUnsafe()\` |
| Calendar math | \`DateTime.add(dt, { days: 20 })\`, \`DateTime.startOf(dt, "month")\` |
| Duration math | \`DateTime.addDuration(dt, "90 minutes")\` |
| Time between 2 instants | \`DateTime.distance(a, b)\` returns a \`Duration\` |
| Print | \`DateTime.formatIso\`, \`formatIsoDate\`, \`formatIsoZoned\` |

A \`DateTime.Utc\` is a point in time. \`DateTime.setZoneNamedUnsafe(dt, "Asia/Tokyo")\` gives a \`DateTime.Zoned\`. It is the same instant, seen through a zone. The calendar parts from \`toParts\` follow the zone. \`toPartsUtc\` ignores the zone.

Note: this lesson builds the values from a fixed ISO text, so the output is stable. Real code uses \`DateTime.now\`.
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
      after: `\`launch\` printed the same value before and after the math. Each function returned a new \`DateTime\`. Compare \`DateTime.add(launch, { months: 1 })\` with \`DateTime.add(launch, { days: 30 })\`. A calendar month and a fixed duration are different things. \`DateTime\` lets you say which one you mean.`
    },
    {
      id: "data-types-l6",
      title: "Data: small immutable records",
      explain: `
The \`Data\` module builds immutable domain values with less code than a class that you write by hand:

| Helper | Gives you |
|---|---|
| \`Data.Class<{ fields }>\` | Readonly fields, a constructor with 1 object argument, \`.pipe\` |
| \`Data.TaggedClass("Tag")<{ fields }>\` | The same, plus a \`_tag\` field that you do not write |
| \`Data.taggedEnum<Union>()\` | Constructors and a \`$match\` function for a union of tagged records |
| \`Data.Error\` / \`Data.TaggedError\` | Errors that you can \`yield*\` inside \`Effect.gen\` (see Error Management) |

Effect v3 had \`Data.struct\` and \`Data.array\`. They gave objects value equality. They do not exist in v4, because \`Equal.equals\` now compares plain objects, arrays and class instances by value without help. \`Data\` still gives you a shape: readonly fields, the \`_tag\`, and one constructor form.

Value equality is a preview of the next section. \`===\` compares references, so 2 points with the same fields are different. \`Equal.equals\` compares the contents.
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
      after: `Remove the \`Rect\` case from \`$match\`. TypeScript rejects the program, because the matcher must cover each variant of \`Shape\`. If you add a third variant to the type, each \`$match\` in the program reports the absent case. A loose \`{ kind: string }\` does not give you this check.`
    },
    {
      id: "data-types-l7",
      title: "Chunk, HashMap and HashSet: immutable collections with value keys",
      explain: `
The JavaScript \`Array\`, \`Map\` and \`Set\` can be changed in place. \`Map\` and \`Set\` compare keys by reference. \`new Map().get({ id: 1 })\` never finds an entry, because the lookup object is a different reference from the stored key. The Effect collections correct both problems.

| Collection | Like | Different because |
|---|---|---|
| \`Chunk<A>\` | \`ReadonlyArray<A>\` | Immutable. \`append\`, \`prepend\` and \`appendAll\` are cheap. Compares by value. Streams emit Chunks. |
| \`HashMap<K, V>\` | \`Map<K, V>\` | Keys compare by value. \`set\` and \`remove\` return a new map. |
| \`HashSet<A>\` | \`Set<A>\` | Members compare by value. One entry per equal value. |

When does \`Chunk\` matter? Mostly at the edges of streams and batches, where a producer appends many times and you do not want a copy of the full array. For other code, a \`ReadonlyArray\` with the functions of the \`Array\` module is enough. \`Chunk.toArray\` and \`Chunk.fromIterable\` convert in both directions.

\`HashMap.get\` returns an \`Option\`. A key that is not in the map gives \`None\`, not \`undefined\`.
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
      after: `The lookup key \`{ warehouse: "B", sku: "bolt" }\` was a new object each time, and it found the entry. A JS \`Map\` returns \`undefined\` for a new object. This works because \`HashMap\` uses the \`Equal\` and \`Hash\` traits. The next section explains them.`
    },
    {
      id: "data-types-l8",
      title: "Redacted: a secret that does not print",
      explain: `
Here is a plain TypeScript log line. It looks harmless:

\`\`\`ts
const token = "sk-live-12345"
console.log("request failed for token " + token)   // the secret is now in the log
\`\`\`

The token is a \`string\`. A \`string\` prints everywhere: in a log, in a JSON body, in an error message. The compiler cannot tell a secret from a user name. \`Redacted<string>\` is a wrapper for a secret. When you print it, each print form shows \`<redacted>\`. The value is still inside, and \`Redacted.value\` returns it.

| Function | What it does |
|---|---|
| \`Redacted.make(value)\` | Wraps the value. The option \`{ label }\` changes the print text to \`<redacted:label>\`. |
| \`Redacted.value(secret)\` | Returns the original value. Call it at the point of use, and nowhere else. |
| \`Equal.equals(a, b)\` | Compares 2 secrets by value. No secret becomes text. |
| \`Config.redacted("KEY")\` | Reads a configuration key as \`Redacted<string>\` |

\`Config.redacted\` is the form for API keys and passwords in configuration. The program in this lesson provides a \`ConfigProvider\` from a fixed object, as the Configuration section does. Note: a function that declares a \`string\` parameter does not accept a \`Redacted<string>\`. The compiler shows you each place where a secret becomes text.
`,
      code: `import { Config, ConfigProvider, Effect, Equal, Redacted } from "effect"

// Plain TypeScript: a string prints everywhere, so the secret is now in the log
const plainToken = "sk-live-12345"
console.log("plain: request failed for token " + plainToken)

// Redacted: the same value, but each print form shows <redacted>
const token = Redacted.make("sk-live-12345")
console.log("log:", token)
console.log("concat: request failed for token " + token)
console.log("json:", JSON.stringify({ token }))

// The value is still there. Ask for it at the point of use, and nowhere else.
const header = "Bearer " + Redacted.value(token)
console.log("header length:", header.length)

// Compare 2 secrets by value. No secret becomes text.
console.log("equal:", Equal.equals(token, Redacted.make("sk-live-12345")))
console.log("equal:", Equal.equals(token, Redacted.make("sk-test-00000")))

// A label says which secret it is, not what it is
console.log("labelled:", String(Redacted.make("hunter2", { label: "DB_PASSWORD" })))

// Config.redacted reads a key as Redacted<string>, so a log of the config cannot show it
const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("API_KEY")
  console.log("config:", apiKey)
  return Redacted.value(apiKey).length
})

const TestConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({ API_KEY: "sk-live-12345" }))
console.log("key length:", Effect.runSync(Effect.provide(program, TestConfig)))
`,
      expectedOutput: `plain: request failed for token sk-live-12345
log: <redacted>
concat: request failed for token <redacted>
json: {"token":"<redacted>"}
header length: 20
equal: true
equal: false
labelled: <redacted:DB_PASSWORD>
config: <redacted>
key length: 13`,
      after: `Search a code base for \`Redacted.value\`, and you find each place where a secret becomes text. Note: the \`+\` operator accepts any value, so \`"failed for " + token\` compiles and prints \`<redacted>\`. A function with a \`string\` parameter does not accept the wrapper. Change the \`header\` line to \`"Bearer " + token\`. The program compiles, and the header length becomes 17, because the text is \`Bearer <redacted>\`.`
    },
    {
      id: "data-types-l9",
      title: "BigDecimal: money without floating point errors",
      explain: `
Run these 3 lines in plain TypeScript:

\`\`\`ts
console.log(0.1 + 0.2)          // 0.30000000000000004
console.log(0.1 + 0.2 === 0.3)  // false
console.log(1.15 * 100)         // 114.99999999999999
\`\`\`

A \`number\` is a binary float. It cannot store \`0.1\` exactly. The error is small, but it moves into invoice totals, comparisons and rounded prices. \`BigDecimal\` stores a \`bigint\` and a scale. \`19.99\` is \`1999n\` with scale \`2\`. The math on it is exact.

| Need | Function |
|---|---|
| Parse text | \`BigDecimal.fromString(s)\` returns \`Option<BigDecimal>\`. \`fromStringUnsafe(s)\` throws on bad text. |
| Build from digits | \`BigDecimal.make(1999n, 2)\` is \`19.99\`. \`fromBigInt(3n)\` is \`3\`. |
| Convert a number | \`BigDecimal.fromNumberUnsafe(n)\`. Caution: the float error of \`n\` comes with it. |
| Math | \`sum\`, \`subtract\`, \`multiply\`, \`sumAll\` |
| Round | \`BigDecimal.round(n, { scale: 2 })\`. \`BigDecimal.scale(n, 2)\` cuts the extra digits toward zero. |
| Compare | \`BigDecimal.equals\`, \`Equal.equals\`, \`isLessThan\`. \`BigDecimal.Order\` sorts an array. |
| Print | \`BigDecimal.format(n)\` |

Note: \`format\` removes zeros at the end, so \`5.00\` prints as \`5\`. Note: \`===\` compares references. 2 decimals with the same value are different objects.
`,
      code: `import { BigDecimal, Equal } from "effect"

// Plain numbers are binary floats. They cannot store 0.1 exactly.
console.log(0.1 + 0.2, 0.1 + 0.2 === 0.3)

// BigDecimal stores a bigint and a scale: 0.1 is 1n with scale 1. The sum is exact.
const a = BigDecimal.fromStringUnsafe("0.1")
const b = BigDecimal.fromStringUnsafe("0.2")
const sum = BigDecimal.sum(a, b)
console.log(BigDecimal.format(sum), BigDecimal.equals(sum, BigDecimal.fromStringUnsafe("0.3")))

// 3 constructors for the same value. fromString returns an Option for text that you do not trust.
console.log(BigDecimal.equals(BigDecimal.make(1999n, 2), BigDecimal.fromStringUnsafe("19.99")), BigDecimal.format(BigDecimal.fromNumberUnsafe(19.99)))
console.log(String(BigDecimal.fromString("19.99x")))

// round uses "half-from-zero" by default. scale cuts the extra digits. format removes zeros at the end.
const raw = BigDecimal.fromStringUnsafe("11.3943")
console.log(BigDecimal.format(BigDecimal.round(raw, { scale: 2 })), BigDecimal.format(BigDecimal.scale(raw, 1)), BigDecimal.format(BigDecimal.fromStringUnsafe("5.00")))

// === compares references. equals, Equal.equals and Order compare the value.
console.log(a === BigDecimal.fromStringUnsafe("0.1"), Equal.equals(a, BigDecimal.fromStringUnsafe("0.1")))
console.log(BigDecimal.isLessThan(a, b), [b, a].sort(BigDecimal.Order).map(BigDecimal.format).join(" "))

// A small invoice: 2 lines, 19% VAT rounded to cents
const lines = [["19.99", 3n], ["4.25", 2n]] as const
const net = BigDecimal.sumAll(
  lines.map(([price, qty]) => BigDecimal.multiply(BigDecimal.fromStringUnsafe(price), BigDecimal.fromBigInt(qty)))
)
const vat = BigDecimal.round(BigDecimal.multiply(net, BigDecimal.fromStringUnsafe("0.19")), { scale: 2 })
console.log("net", BigDecimal.format(net), "vat", BigDecimal.format(vat), "total", BigDecimal.format(BigDecimal.sum(net, vat)))
`,
      expectedOutput: `0.30000000000000004 false
0.3 true
true 19.99
none()
11.39 11.3 5
false true
true 0.1 0.2
net 68.47 vat 13.01 total 81.48`,
      after: `Change the first \`fromStringUnsafe("0.1")\` to \`fromNumberUnsafe(0.1 + 0.2)\` and print it with \`format\`. You get \`3.0000000000000004e-1\`. The float error was in the number before \`BigDecimal\` saw it. Parse prices from text, or build them from integer cents with \`make\`. Do not do the math in \`number\` first.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use `Option.fromNullishOr(value)` to convert `A | null | undefined` to an `Option<A>`.",
      dont: "Do not call `Option.fromNullable`. It does not exist in v4.",
      why: "The program does not compile, and the error message names a property that does not exist."
    },
    {
      do: "Use `Option.flatMap` when the function returns an `Option`.",
      dont: "Do not use `Option.map` with a function that returns an `Option`.",
      why: "You get an `Option<Option<A>>`, and `getOrElse` returns an Option instead of the value."
    },
    {
      do: "Give `Option.getOrElse` a function: `Option.getOrElse(() => 0)`.",
      dont: "Do not pass the default value directly: `Option.getOrElse(0)`.",
      why: "The default must be a function, and the program stops with \"onNone is not a function\" on the None path."
    },
    {
      do: "Convert an `Option` with `Effect.fromOption` before you use it in `Effect.gen`.",
      dont: "Do not `yield*` an `Option` or a `Result` directly inside `Effect.gen`.",
      why: "The compiler rejects it, and the runtime stops with \"Not a valid effect\"."
    },
    {
      do: "Write durations with a unit: `\"2 seconds\"` or `Duration.seconds(2)`.",
      dont: "Do not pass a bare number when you mean seconds: `Effect.timeout(2)`.",
      why: "A bare number means milliseconds, so the timeout is 2 milliseconds and the effect always times out."
    },
    {
      do: "Keep the value that `DateTime.add` returns: `const next = DateTime.add(dt, { days: 1 })`.",
      dont: "Do not call `DateTime.add(dt, ...)` and then use `dt`.",
      why: "A `DateTime` is immutable, so `dt` does not change and the program prints the old date."
    },
    {
      do: "Use `DateTime.now` inside an effect to read the current time.",
      dont: "Do not use `DateTime.nowUnsafe()` or `new Date()` inside effect code.",
      why: "Tests cannot control the time with `TestClock`, and the output changes on each run."
    },
    {
      do: "Use `HashMap` or `HashSet` when the keys are objects.",
      dont: "Do not put object keys in a JS `Map` or `Set`.",
      why: "A JS `Map` compares object keys by reference, so a new object with the same fields never finds the entry."
    }
  ],
  challenges: [
    {
      id: "data-types-c1",
      title: "A v3 name",
      task: `This program must print \`port 8080\`. It does not compile, because the Option constructor does not exist in this version of Effect. Replace it with the correct one.`,
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
        "The v3 name was fromNullable. The v4 names say what they treat as absent: null-ish, null, or undefined.",
        "Lesson 1 uses the function that treats null and undefined as None.",
        "Use Option.fromNullishOr(config.port)."
      ],
      explanation: `v4 renamed the nullable constructors. Each name says what it treats as absent: \`Option.fromNullishOr\` (null or undefined), \`Option.fromNullOr\` (only null) and \`Option.fromUndefinedOr\` (only undefined). The old \`fromNullable\` does not exist, so the property access is a type error. Read the error message: "Property 'fromNullable' does not exist". Then look at the module for the family of functions and select the one that matches your input type.`
    },
    {
      id: "data-types-c2",
      title: "The default that is not lazy",
      task: `The program prints the correct output at runtime, but it does not compile. Make it compile. The output must stay \`The Countess\`.`,
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
        "Read the type error. getOrElse wants a LazyArg. A LazyArg is a function with no arguments.",
        "The default is only necessary when the Option is None. Effect asks for a function that makes it.",
        "Write Option.getOrElse(() => \"stranger\")."
      ],
      explanation: `\`getOrElse\` takes a function \`() => B\`, not a \`B\`. The function is called only when the Option is \`None\`. This matters when the default is expensive to compute or has a side effect. Here the input was \`Some\`, so at runtime the wrong argument was never called and the output looked correct. Call \`greet("lin")\` in the broken version: it stops with "onNone is not a function". The type checker found a runtime error that only shows on the None path.`
    },
    {
      id: "data-types-c3",
      title: "An Option inside an Option",
      task: `\`run\` must print \`4\`, \`-1\`, \`-1\`: the square root when the input is a number that is not negative, otherwise \`-1\`. It prints something else. Fix the pipeline. Do not change \`safeSqrt\` or \`parse\`.`,
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
        "Look at what the broken version prints for \"16\": some(4). Where does the extra some come from?",
        "safeSqrt already returns an Option. map puts its result inside another Option: Option<Option<number>>.",
        "Use Option.flatMap for the safeSqrt step."
      ],
      explanation: `\`Option.map\` puts the result of the function inside an Option. When the function already returns an Option, the result is \`Option<Option<number>>\`. \`getOrElse\` removed one layer and printed the inner \`some(4)\`. For \`-4\` it printed \`none()\` instead of \`-1\`. \`Option.flatMap\` removes the extra layer: the outer \`None\` and the inner \`None\` become one \`None\`. This is the same difference between map and flatMap as for Effect, and it also applies to Result.`
    },
    {
      id: "data-types-c4",
      title: "The absent case that got out",
      task: `\`displayName\` declares \`Effect.Effect<string>\`, an effect that cannot fail. Its body can fail. Process the None case so that unknown ids give \`guest\`. Do not change the annotation. Expected output: \`ADA\`, then \`guest\`.`,
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
        "Read the type error. Which error type is in the error channel of the body, but not in the annotation?",
        "Effect.fromOption fails with NoSuchElementError when the Option is None. This error has a _tag.",
        "Pipe the generator into Effect.catchTag(\"NoSuchElementError\", () => Effect.succeed(\"guest\"))."
      ],
      explanation: `\`Effect.fromOption\` converted the \`None\` to a typed \`NoSuchElementError\`. The real type of the body is \`Effect<string, NoSuchElementError>\`. The annotation \`Effect<string>\` is not true, and the compiler rejects it. \`catchTag\` removes the error from the error channel, and the annotation becomes true. In plain TypeScript, \`names.get(3)!.toUpperCase()\` compiles and stops at runtime. A second correct fix is to convert the Option before the effect, with \`Option.match\` or \`Option.getOrElse\`. Both make the None case explicit.`
    },
    {
      id: "data-types-c5",
      title: "The unit of the timeout",
      task: `The report takes about 30 milliseconds. The code intends to wait 2 seconds. It prints \`gave up\`. Fix the timeout so that the program prints \`report ready\`.`,
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
        "What unit does a bare number have when you give it as a Duration.Input?",
        "See the table in lesson 4: a number is milliseconds. 2 milliseconds is not 2 seconds.",
        "Use Effect.timeout(\"2 seconds\") or Effect.timeout(Duration.seconds(2))."
      ],
      explanation: `A bare number in a \`Duration.Input\` position means milliseconds. \`timeout(2)\` gave the report 2 milliseconds, and the timeout always came first. \`"2 seconds"\` or \`Duration.seconds(2)\` puts the unit in the code, where a reviewer can see it. The compiler cannot tell \`2\` from \`2000\`, but it can read \`"2 seconds"\`. This is the reason \`Duration\` exists.`
    },
    {
      id: "data-types-c6",
      title: "The date that did not move",
      task: `A trial ends 30 days after signup. The program prints the signup date, not the end date. Make it print \`trial ends 2024-03-30\`.`,
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
        "Does DateTime.add change its argument, or does it return a new value?",
        "Lesson 5 printed the original DateTime after the math, and it was unchanged.",
        "Keep the result: const trialEnds = DateTime.add(signup, { days: 30 })."
      ],
      explanation: `\`DateTime\` values are immutable. \`DateTime.add\` returns a new value and does not change \`signup\`. The program did not keep the result, so \`trialEnds\` was still the signup date. With a JS \`Date\`, \`setDate\` changes the object in place. The same code would give the correct output, and it would also change \`signup\` for all other code that holds it. With an immutable value, the only way to get the new date is to keep the return value. That is what makes the value safe to share.`
    },
    {
      id: "data-types-c7",
      title: "A secret where a string is expected",
      task: `\`authHeader\` needs the text of the key. The program does not compile, because it gives the wrapper to a function that wants a \`string\`. Fix the call. Do not change \`authHeader\`. Expected output: \`header length: 20\`.`,
      code: `import { Redacted } from "effect"

const apiKey = Redacted.make("sk-live-12345")

// Builds the header of an outgoing request. It needs the text of the key.
const authHeader = (key: string): string => "Bearer " + key

const header = authHeader(apiKey)
console.log("header length:", header.length)
`,
      solution: `import { Redacted } from "effect"

const apiKey = Redacted.make("sk-live-12345")

// Builds the header of an outgoing request. It needs the text of the key.
const authHeader = (key: string): string => "Bearer " + key

const header = authHeader(Redacted.value(apiKey))
console.log("header length:", header.length)
`,
      expectedOutput: `header length: 20`,
      hints: [
        "Read the type error: Redacted<string> is not assignable to string. The wrapper is not the text.",
        "Lesson 8 has 1 function that returns the original value. Use it at the point of use, and nowhere else.",
        "Call authHeader(Redacted.value(apiKey))."
      ],
      explanation: `\`Redacted<string>\` and \`string\` are different types. The wrapper does not have the methods of a string, and the compiler rejects the call. This is the purpose of the type. Each place where a secret becomes text needs \`Redacted.value\`, and a reviewer can search for it. Note: the \`+\` operator does not give this check. \`"Bearer " + apiKey\` compiles and gives \`Bearer <redacted>\`, a header with the wrong text and length 17. The type error found the mistake before the request went out.`
    },
    {
      id: "data-types-c8",
      title: "Two decimals compared with ===",
      task: `The customer paid \`100.00\`, and the invoice lines sum to \`100.00\`. The program prints \`open: 0\`. Fix the comparison so that it prints \`settled\`.`,
      code: `import { BigDecimal } from "effect"

const paid = BigDecimal.fromStringUnsafe("100.00")
const due = BigDecimal.sum(BigDecimal.fromStringUnsafe("59.97"), BigDecimal.fromStringUnsafe("40.03"))

// Is the invoice settled?
if (paid === due) {
  console.log("settled")
} else {
  console.log("open: " + BigDecimal.format(BigDecimal.subtract(due, paid)))
}
`,
      solution: `import { BigDecimal } from "effect"

const paid = BigDecimal.fromStringUnsafe("100.00")
const due = BigDecimal.sum(BigDecimal.fromStringUnsafe("59.97"), BigDecimal.fromStringUnsafe("40.03"))

// Is the invoice settled? Compare the value, not the reference.
if (BigDecimal.equals(paid, due)) {
  console.log("settled")
} else {
  console.log("open: " + BigDecimal.format(BigDecimal.subtract(due, paid)))
}
`,
      expectedOutput: `settled`,
      hints: [
        "The 2 values are equal. What does === compare when both sides are objects?",
        "Lesson 9 shows 2 functions that compare a BigDecimal by value.",
        "Use BigDecimal.equals(paid, due), or Equal.equals(paid, due)."
      ],
      explanation: `A \`BigDecimal\` is an object. \`===\` compares the references, and \`paid\` and \`due\` are 2 different objects. The compiler permits this comparison, because both sides have the same type. \`BigDecimal.equals\` normalizes both values first, so \`100.00\` and \`100.0\` are also equal. Note: \`paid.value === due.value\` is not correct either. \`100.00\` has value \`10000n\` and scale \`2\`, and \`100.0\` has value \`1000n\` and scale \`1\`. Use \`BigDecimal.equals\` or \`Equal.equals\` for each comparison of decimals.`
    }
  ],
  problems: [
    {
      id: "data-types-p1",
      title: "Config with fallbacks",
      spec: `
Settings can come from 3 places. Check them in this sequence: command-line arguments, environment variables (the keys are upper-case), then defaults. Build it with \`Option\`:

1. \`fromCli(key)\`, \`fromEnv(key)\` and \`fromDefaults(key)\` each return \`Option<string>\`. Use \`Option.fromNullishOr\`. \`fromEnv\` looks up \`key.toUpperCase()\`.
2. \`setting(key)\` returns the first \`Some\` of the 3. Use \`Option.orElse\`.
3. \`portNumber\` converts \`setting("port")\` to a number with \`Option.flatMap\`. A text that is not a number gives \`None\`. The default is \`0\`.

Print 1 line per key for \`host\`, \`port\`, \`mode\` and \`timeout\`. Then print the port as a number. Exact output:

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
        "Each source function is 1 line: Option.fromNullishOr(source[key]).",
        "Option.orElse takes a function that returns an Option. It runs the function only when necessary. Chain 2 of them.",
        "parseNumber returns an Option. Combine it with Option.flatMap, not with map."
      ]
    },
    {
      id: "data-types-p2",
      title: "Meeting agenda",
      spec: `
A meeting starts at \`2024-09-02T09:00:00Z\`. It has 4 items. The durations are text:

\`\`\`
Standup        "15 minutes"
Design review  "45 minutes"
Break          "10 minutes"
Planning       "1 hour"
\`\`\`

Walk through the agenda with \`DateTime.addDuration\`. Keep the current \`DateTime\` in a variable. For each item, print \`HH:MM-HH:MM Title\`. The times are UTC hours and minutes from \`DateTime.toPartsUtc\`, with a zero in front from \`String.prototype.padStart\`. Then print the total length: \`total \` plus \`Duration.format\` of \`DateTime.distance(start, end)\`. Then print the end time in Tokyo with \`DateTime.setZoneNamedUnsafe\` and \`DateTime.formatIsoZoned\`. Exact output:

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
        "DateTime.addDuration accepts the text form directly. Give it the agenda entries as they are.",
        "Keep a `let current`. After each item, set it to the DateTime that addDuration returned. Nothing changes in place.",
        "DateTime.distance(start, end) returns a Duration. Duration.format prints it as 2h 10m."
      ]
    },
    {
      id: "data-types-p3",
      title: "Warehouse stock",
      spec: `
Track the stock per SKU and per warehouse. A key is \`class Sku extends Data.Class<{ readonly warehouse: string; readonly code: string }>\`. Stock movements arrive as a \`Chunk\` of \`{ sku: Sku; delta: number }\`:

\`\`\`
A/bolt +100,  B/bolt +8,  A/bolt -30,  A/nut +12
\`\`\`

1. \`apply(stock, movement)\` returns a new \`HashMap<Sku, number>\`. It adds the delta to the current quantity, or to \`0\` when the key is absent. Use \`HashMap.get\` with \`Option.getOrElse\`, then \`HashMap.set\`.
2. Fold the Chunk with \`Chunk.reduce\`. Start from \`HashMap.empty()\`.
3. \`report(warehouse, code)\` looks up a **new** \`new Sku(...)\` and prints \`W/code: qty\` or \`W/code: none\`.

Print the reports for A/bolt, B/bolt, A/nut and C/bolt. Then print the number of different SKUs with \`HashMap.size\`. Exact output:

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

const movements: Chunk.Chunk<Movement> = Chunk.make(
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

const movements: Chunk.Chunk<Movement> = Chunk.make(
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
        "apply is 2 lines: read the current quantity as an Option with a default of 0, then HashMap.set with the sum.",
        "Chunk.reduce(chunk, initial, (acc, item) => ...) works like Array.prototype.reduce.",
        "Sku extends Data.Class, so a new Sku({ warehouse: \"A\", code: \"bolt\" }) finds the entry that a different instance stored."
      ]
    }
  ],
  recall: [
    {
      q: "You have a value of type `string | undefined`. Which function converts it to an `Option<string>`? What happens to `undefined`?",
      a: "`Option.fromNullishOr(value)`. `undefined` and `null` become `None`. Each other value becomes `Some`. The v3 name `fromNullable` does not exist."
    },
    {
      q: "What would the type of `Effect.fromOption(Option.some(42))` be?",
      a: "`Effect<number, NoSuchElementError>`. A `None` fails with `Cause.NoSuchElementError`. Give a second argument `() => myError` to fail with your own error type."
    },
    {
      q: "Can you `yield*` an `Option` directly inside `Effect.gen` in this version?",
      a: "No. It is a type error, and the runtime rejects it. Use `Effect.fromOption(opt)`, or `Effect.fromResult(res)` for a `Result`, to move the value into an effect first. `Option.gen` and `Result.gen` exist for generators over Options and Results."
    },
    {
      q: "Which function would you use to wait half a second in `Effect.sleep`? Why not `500`?",
      a: "`Effect.sleep(\"500 millis\")` or `Effect.sleep(Duration.millis(500))`. A bare `500` also works and means milliseconds, but the unit is not visible in the code. The text form or the constructor makes the unit explicit and prevents the seconds and milliseconds mistake."
    },
    {
      q: "What is the difference between `DateTime.now` and `DateTime.nowUnsafe()`?",
      a: "`DateTime.now` is an effect that reads the Clock service, so tests can control the time with `TestClock`. `DateTime.nowUnsafe()` reads the system clock at once and returns a `DateTime.Utc`. Use it only outside Effect code."
    },
    {
      q: "Why does `HashMap.get(map, { id: 1 })` find an entry when `new Map().get({ id: 1 })` does not?",
      a: "`HashMap` compares keys with the structural `Equal` of Effect and puts them in buckets with `Hash`. A new object with the same contents is the same key. A JS `Map` compares object keys by reference. `Data.Class` instances, Options, Chunks and plain objects all work as HashMap keys for the same reason."
    },
    {
      q: "An API key comes from configuration. Which function would you use to read it, and what prints when you log the result?",
      a: "`Config.redacted(\"API_KEY\")`. The result is a `Redacted<string>`. `console.log`, `String()` and `JSON.stringify` show `<redacted>`. `Redacted.value(key)` returns the text at the point of use."
    },
    {
      q: "What would the type of `BigDecimal.fromString(\"19.99\")` be? Why does `fromStringUnsafe` also exist?",
      a: "`Option<BigDecimal>`. Text that is not a decimal gives `None`. `fromStringUnsafe` returns a `BigDecimal` and throws on bad text. Use it for literals in the code, where the text is known."
    }
  ]
}

export default section
