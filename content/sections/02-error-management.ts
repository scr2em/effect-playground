import type { Section } from "../types.ts"

const section: Section = {
  id: "error-management",
  title: "Error Management",
  order: 2,
  summary: "Expected failures versus defects, tagged error classes, the catch family, and reading an Exit.",
  intro: `
**The problem.** In plain TypeScript every error travels the same road: \`throw\`. Look at this checkout:

\`\`\`ts
async function checkout(cart: Cart): Promise<Receipt> {
  const stock = await reserve(cart)     // may throw OutOfStock
  const charge = await pay(cart.total)  // may throw CardDeclined... or a TypeError from a typo
  return receipt(stock, charge)
}

try {
  await checkout(cart)
} catch (e) {
  // e is unknown. Out of stock? Card declined? A bug? All three land here.
  showBanner("Something went wrong")
}
\`\`\`

The signature says \`Promise<Receipt>\`. It does not say which errors can come out. The \`catch\` block gets \`unknown\`, so you write \`instanceof\` chains and hope you remembered every case. Worse, the same \`catch\` that was meant for "card declined" also swallows a real bug, and the bug is now hidden behind a friendly banner.

### The shift

Today you think of an error as **something that escapes**. It jumps out of the function, up the stack, until some \`catch\` stops it. Effect asks you to think of an error as **a value the program returns**, in the same way it returns a success. The error is right there in the type:

\`\`\`ts
const checkout: (cart: Cart) => Effect<Receipt, OutOfStock | CardDeclined>
\`\`\`

Handle \`OutOfStock\` and the type becomes \`Effect<Receipt, CardDeclined>\`. Handle that too and it becomes \`Effect<Receipt, never>\`: the compiler now knows nothing is left. Forget one and the type keeps it, and any function that claims \`never\` will not compile. The error channel shrinks as you handle things, and you can read what is left at any point.

Effect also refuses to mix the two kinds of trouble. A **failure** is expected and typed (\`Effect.fail\`). A **defect** is a bug: a thrown exception, or \`Effect.die\` (unexpected, untyped). The normal \`catch\` functions only see failures, so a bug cannot hide behind a fallback. Interruption is the third kind: the program was cancelled from outside.

| | Plain TS \`try/catch\` | Effect |
|---|---|---|
| Where the error type lives | Nowhere, \`catch (e)\` gets \`unknown\` | The second type parameter, \`E\` |
| Expected error vs bug | Same \`throw\`, same \`catch\` | \`Effect.fail\` (typed) vs \`Effect.die\` (defect) |
| Handle one kind only | \`instanceof\` check, rethrow the rest | \`catchTag("X", ...)\`, the rest stays in \`E\` |
| Forgot to handle a case | Compiles, crashes in production | Compiles only if the caller's type admits it |
| See exactly what happened | Gone once caught | \`Exit\` and \`Cause\` are plain values |

In this section you will define errors, recover from them by tag or by condition, deal with defects, and read the full outcome. Retries and schedules come later.
`,
  lessons: [
    {
      id: "error-management-l1",
      title: "Two kinds of failure, and a third reason",
      explain: `
Here is a bug that plain TypeScript makes easy. A function throws \`NotFound\` when a user is missing. The caller wraps it in \`try/catch\` and shows "user not found". One day a typo inside the function throws a \`TypeError\` instead. The same \`catch\` runs, the same message shows, and the bug ships.

Effect keeps the two apart from the start:

- \`Effect.fail(e)\` is an **expected failure**. It goes into the \`E\` type parameter.
- \`Effect.die(x)\` is a **defect**, a bug. So is any exception thrown inside \`Effect.sync\`. Defects are not in the type; \`E\` stays \`never\`.
- **Interruption** is the third reason: the fiber running the effect was cancelled.

When an effect does not succeed, its \`Exit\` holds a \`Cause\`, and \`cause.reasons\` is an array of reasons, each tagged \`Fail\`, \`Die\`, or \`Interrupt\`. The program below shows all four ways of not succeeding and what they look like.
`,
      code: `import { Effect, Exit } from "effect"

const cases = {
  fail: Effect.fail("user not found"),                                 // Effect<never, string>
  thrown: Effect.sync(() => { throw new TypeError("x is undefined") }), // Effect<never, never>: a bug
  die: Effect.die("unreachable state"),                                // Effect<never, never>: a bug on purpose
  interrupt: Effect.interrupt                                          // Effect<never, never>: cancelled
}

for (const [name, effect] of Object.entries(cases)) {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isFailure(exit)) {
    // Every reason has a _tag: Fail, Die, or Interrupt
    console.log(name, "->", exit.cause.reasons.map((r) => r._tag).join(","))
  }
}
`,
      expectedOutput: `fail -> Fail
thrown -> Die
die -> Die
interrupt -> Interrupt`,
      after: `Notice that the thrown \`TypeError\` and \`Effect.die\` look the same: both are \`Die\`. Only \`Effect.fail\` shows up in the type as \`string\`. Try replacing \`Effect.sync\` in the \`thrown\` case with \`Effect.try({ try: ..., catch: () => "typed now" })\`: the reason becomes \`Fail\`, because you told Effect the throw was expected.`
    },
    {
      id: "error-management-l2",
      title: "Defining errors: tagged classes you can yield",
      explain: `
In plain TypeScript a custom error is a class that extends \`Error\`, and you \`throw\` it. Nothing in the signature mentions it:

\`\`\`ts
class NotFound extends Error {
  constructor(readonly id: number) { super("user " + id + " not found") }
}

function loadName(id: number): string {   // says nothing about NotFound
  const user = users.get(id)
  if (!user) throw new NotFound(id)
  return user.name
}
\`\`\`

Effect errors are classes too, with two differences. First, they carry a \`_tag\`: a string literal that names the error and lets Effect (and TypeScript) tell error types apart in a union. Second, they are **yieldable**: inside \`Effect.gen\` you write \`yield* new NotFound({ id })\` and the effect fails with that error. It reads like \`throw\`, but the error lands in the \`E\` type, not in the void.

Two ways to define one. \`Schema.TaggedError\` is preferred: fields are declared as schemas, so the error can later be validated or sent over the wire. \`Data.TaggedError\` is lighter and takes a plain field type. Both fill in \`_tag\` for you.
`,
      code: `import { Cause, Data, Effect, Exit, Schema } from "effect"

// Preferred: schema-backed. _tag is "NotFound", filled in automatically.
class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.Number
}) {}

// Lighter: plain fields, no schema.
class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly id: number
  readonly role: string
}> {}

const users = new Map([
  [1, { name: "Ada", role: "admin" }],
  [2, { name: "Lin", role: "guest" }]
])

// Inferred: Effect<string, NotFound | Forbidden>. Both errors are in the type.
const loadName = (id: number) =>
  Effect.gen(function* () {
    const user = users.get(id)
    if (user === undefined) {
      return yield* new NotFound({ id })   // yield* an error instance to fail: a typed throw
    }
    if (user.role !== "admin") {
      return yield* new Forbidden({ id, role: user.role })
    }
    return user.name
  })

for (const id of [1, 2, 3]) {
  const exit = Effect.runSyncExit(loadName(id))
  if (Exit.isSuccess(exit)) {
    console.log(id, "ok", exit.value)
  } else {
    const error = Cause.squash(exit.cause) as NotFound | Forbidden
    // _tag narrows the union, so the right field is available in each branch
    console.log(id, error._tag, error._tag === "NotFound" ? "id " + error.id : "role " + error.role)
  }
}
`,
      expectedOutput: `1 ok Ada
2 Forbidden role guest
3 NotFound id 3`,
      after: `Hover \`loadName\` in an editor: TypeScript collected both errors from the two \`yield*\` lines into \`NotFound | Forbidden\`. Try changing \`yield* new NotFound({ id })\` to \`throw new NotFound({ id })\`. It still compiles, but the error disappears from the type and becomes a \`Die\`. Challenge 5 is about exactly this mistake.`
    },
    {
      id: "error-management-l3",
      title: "Recovering by tag: catch, catchTag, catchTags",
      explain: `
Once errors have tags, recovery is a lookup, not an \`instanceof\` chain. Each function below removes what it handles from \`E\` and leaves the rest.

| Function | Handles | \`E\` afterwards |
|---|---|---|
| \`Effect.catch(f)\` | Every failure | Whatever \`f\` can fail with |
| \`Effect.catchTag("A", f)\` | Only errors tagged \`A\` | The union without \`A\` |
| \`Effect.catchTag(["A", "B"], f)\` | \`A\` or \`B\`, one handler | The union without \`A\` and \`B\` |
| \`Effect.catchTags({ A: f, B: g })\` | Several tags, one handler each | The union without those tags |
| \`Effect.catchIf(pred, f)\` | Errors matching a condition | Lesson 4 |
| \`Effect.catchFilter(filter, f)\` | Errors matching a \`Filter\` | Lesson 4 |

The handler receives the error, already narrowed to the matching class, and returns a new Effect. That Effect's success type is merged into \`A\` and its error type into \`E\`. If the handler returns \`Effect.succeed(...)\`, the tag is gone from \`E\` for good. This is the shrinking error channel from the intro, and the return type annotations in the code make it visible.

Note the name: \`catchAll\` from older Effect versions is now \`Effect.catch\`.
`,
      code: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { role: Schema.String }) {}
class Timeout extends Schema.TaggedError<Timeout>()("Timeout", { ms: Schema.Number }) {}

const loadName = (id: number): Effect.Effect<string, NotFound | Forbidden | Timeout> =>
  id === 1 ? Effect.succeed("Ada")
  : id === 2 ? Effect.fail(new Forbidden({ role: "guest" }))
  : id === 3 ? Effect.fail(new Timeout({ ms: 500 }))
  : Effect.fail(new NotFound({ id }))

// One tag handled. E shrinks to Forbidden | Timeout.
const step1 = (id: number): Effect.Effect<string, Forbidden | Timeout> =>
  loadName(id).pipe(
    Effect.catchTag("NotFound", (e) => Effect.succeed("nobody #" + e.id))
  )

// The remaining tags, one handler each. E shrinks to never.
const safeName = (id: number): Effect.Effect<string, never> =>
  step1(id).pipe(
    Effect.catchTags({
      Forbidden: (e) => Effect.succeed("hidden (" + e.role + ")"),
      Timeout: (e) => Effect.succeed("slow (" + e.ms + "ms)")
    })
  )

// Array form for a shared handler, then catch for whatever is left (only Timeout here).
const fallback = (id: number): Effect.Effect<string, never> =>
  loadName(id).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], (e) => Effect.succeed("no access: " + e._tag)),
    Effect.catch((e) => Effect.succeed("other: " + e._tag))
  )

for (const id of [1, 2, 3, 4]) {
  console.log(id, Effect.runSync(safeName(id)), "|", Effect.runSync(fallback(id)))
}
`,
      expectedOutput: `1 Ada | Ada
2 hidden (guest) | no access: Forbidden
3 slow (500ms) | other: Timeout
4 nobody #4 | no access: NotFound`,
      after: `Delete the \`Timeout\` handler inside \`catchTags\`. \`safeName\` stops compiling: \`Timeout\` is still in \`E\`, but the annotation promised \`never\`. That is the compiler doing the bookkeeping a code reviewer used to do.`
    },
    {
      id: "error-management-l4",
      title: "Recovering by condition, and translating errors",
      explain: `
Sometimes the tag is not enough. An \`HttpError\` with status 503 deserves a cached fallback; the same class with status 404 does not. Two tools look at the error value:

- \`Effect.catchIf(predicate, handler)\`. With a plain boolean predicate, \`E\` does **not** shrink: a 404 is still an \`HttpError\` that can come out. With a type guard (\`(e): e is HttpError => ...\`), the matched class is removed from \`E\`, so only use a guard when the guard really catches every value of that class.
- \`Effect.catchFilter(filter, handler)\`. A \`Filter\` (from the \`Filter\` module) is a reusable, named version of the same idea. \`Filter.tagged("ParseError")\` matches a tag and narrows correctly; \`Filter.fromPredicate(fn)\` wraps a boolean function.

The third tool does not recover at all. \`Effect.mapError(f)\` replaces the error with another value. Use it at a boundary: a low-level \`HttpError\` becomes your domain's \`AppError\`, and callers only ever see the domain error. Get this wrong and every caller has to know about HTTP.
`,
      code: `import { Cause, Effect, Exit, Filter, Schema } from "effect"

class HttpError extends Schema.TaggedError<HttpError>()("HttpError", { status: Schema.Number }) {}
class ParseError extends Schema.TaggedError<ParseError>()("ParseError", { input: Schema.String }) {}
class AppError extends Schema.TaggedError<AppError>()("AppError", { message: Schema.String }) {}

const request = (status: number): Effect.Effect<string, HttpError | ParseError> =>
  status === 200 ? Effect.succeed("body")
  : status === 0 ? Effect.fail(new ParseError({ input: "<html>" }))
  : Effect.fail(new HttpError({ status }))

const load = (status: number): Effect.Effect<string, AppError> =>
  request(status).pipe(
    // 1. A plain predicate: recover only when the value says so. E does not shrink.
    Effect.catchIf(
      (e) => e._tag === "HttpError" && e.status >= 500,
      () => Effect.succeed("cached copy")
    ),
    // 2. A reusable Filter on the tag. ParseError leaves E here.
    Effect.catchFilter(
      Filter.tagged("ParseError"),
      (e) => Effect.succeed("empty (could not parse " + e.input + ")")
    ),
    // 3. Translate what is left (only HttpError now) into the domain error.
    Effect.mapError((e) => new AppError({ message: "request failed with " + e.status }))
  )

for (const status of [200, 503, 0, 404]) {
  const exit = Effect.runSyncExit(load(status))
  console.log(status, Exit.isSuccess(exit) ? exit.value : "AppError: " + (Cause.squash(exit.cause) as AppError).message)
}
`,
      expectedOutput: `200 body
503 cached copy
0 empty (could not parse <html>)
404 AppError: request failed with 404`,
      after: `Inside the \`mapError\` handler, \`e\` is typed as \`HttpError\` only, because \`catchFilter\` already removed \`ParseError\`. Try swapping steps 2 and 3: the \`mapError\` handler now has to deal with both classes, and \`e.status\` no longer compiles.`
    },
    {
      id: "error-management-l5",
      title: "Turning a failure into a plain value",
      explain: `
Every function so far replaced a failure with another Effect. Often you want something simpler: a default, or "give me both outcomes as data and let me decide". This family turns a failing Effect into one that cannot fail.

| Function | Use when | Result type |
|---|---|---|
| \`Effect.orElseSucceed(() => x)\` | Any failure should become a default value | \`Effect<A \\| X, never>\` |
| \`Effect.match({ onFailure, onSuccess })\` | Both outcomes map to a plain value | \`Effect<B, never>\` |
| \`Effect.matchEffect({ onFailure, onSuccess })\` | Same, but the handlers need to run Effects | \`Effect<B, E2>\` |
| \`Effect.result(effect)\` | Keep the error for later inspection | \`Effect<Result<A, E>, never>\` |
| \`Effect.option(effect)\` | You only care whether it worked | \`Effect<Option<A>, never>\` |
| \`Effect.ignore(effect)\` | Fire and forget, discard everything | \`Effect<void, never>\` |

\`Result\` is Effect's "success or failure" data type (older versions called it \`Either\`). \`Option\` is "a value or nothing". Both have \`isSuccess\` / \`isSome\` style guards.

Remember: like \`catch\`, all of these see **failures only**. A defect still passes straight through them.
`,
      code: `import { Effect, Option, Result, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { key: Schema.String }) {}

const settings = new Map([["theme", "dark"]])
const get = (key: string): Effect.Effect<string, NotFound> => {
  const value = settings.get(key)
  return value === undefined ? Effect.fail(new NotFound({ key })) : Effect.succeed(value)
}

const program = Effect.gen(function* () {
  // A default value. Effect<string, never>
  const lang = yield* get("lang").pipe(Effect.orElseSucceed(() => "en"))
  console.log("lang:", lang)

  // One plain function per outcome
  const theme = yield* get("theme").pipe(Effect.match({
    onFailure: (e) => "missing " + e.key,
    onSuccess: (v) => "theme is " + v
  }))
  console.log(theme)

  // Same shape, but each handler is an Effect
  yield* get("font").pipe(Effect.matchEffect({
    onFailure: (e) => Effect.sync(() => console.log("no", e.key, "setting, using default")),
    onSuccess: (v) => Effect.sync(() => console.log("font is", v))
  }))

  // Both outcomes as data. Effect<Result<string, NotFound>, never>
  const r = yield* Effect.result(get("lang"))
  console.log("result:", Result.isSuccess(r) ? r.success : "failed with " + r.failure._tag)

  // Only "did it work". The error is thrown away. Effect<Option<string>, never>
  const o = yield* Effect.option(get("theme"))
  console.log("option:", Option.isSome(o) ? o.value : "none")

  // Do not care at all. Effect<void, never>
  yield* Effect.ignore(get("lang"))
  console.log("still running")
})

Effect.runSync(program)
`,
      expectedOutput: `lang: en
theme is dark
no font setting, using default
result: failed with NotFound
option: dark
still running`,
      after: `\`Effect.result\` is the clean answer to the last problem in Getting Started, where you had to run a nested \`runPromiseExit\`. Try replacing \`get("theme")\` in the \`option\` line with \`get("size")\`: you get \`none\`, and no way to know why. Reach for \`result\` when the reason matters.`
    },
    {
      id: "error-management-l6",
      title: "Defects: the errors that catch does not see",
      explain: `
A developer wraps a lookup in \`Effect.catch\` with a fallback and moves on, confident that "anything that goes wrong" is handled. Then a user id that is not in the table hits a \`!\` that was a lie, a \`TypeError\` is thrown, and the program crashes anyway. The fallback never ran.

That is by design. The throw happened inside \`Effect.sync\`, so it is a defect, and \`E\` for that effect is \`never\`. \`Effect.catch\`, \`catchTag\`, \`match\`, \`result\` and friends only look at \`E\`. A defect means the program is in a state nobody planned for, so hiding it behind a default would be exactly the plain TypeScript bug from lesson 1.

When you do want to deal with defects, say so explicitly:

- \`Effect.catchDefect(f)\` sees only defects. \`f\` receives the thrown value as \`unknown\`.
- \`Effect.catchCause(f)\` sees the whole \`Cause\`: failures, defects, and interruptions together. Use it for logging at the top of an app.
- \`Cause.pretty(cause)\` renders a readable report. Its first line is \`Name: message\`; the rest is a stack trace.
`,
      code: `import { Cause, Effect, Exit } from "effect"

// Bug: crashes for unknown ids. The thrown TypeError becomes a defect.
const findName = (id: number) =>
  Effect.sync(() => {
    const rows = [{ id: 1, name: "Ada" }]
    return rows.find((r) => r.id === id)!.name
  })

// 1. catch cannot see it. E is never, so this handler never runs.
const naive = findName(2).pipe(Effect.catch(() => Effect.succeed("fallback")))
const exit = Effect.runSyncExit(naive)
console.log("naive:", Exit.isFailure(exit) ? exit.cause.reasons.map((r) => r._tag).join(",") : "recovered")

// 2. catchDefect sees only defects, as unknown.
const guarded = findName(2).pipe(
  Effect.catchDefect((defect) =>
    Effect.succeed(defect instanceof TypeError ? "recovered from a TypeError" : "recovered")
  )
)
console.log("guarded:", Effect.runSync(guarded))

// 3. catchCause sees everything, and Cause.pretty describes it.
const reported = Effect.die(new Error("unreachable: cart already paid")).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      console.log("report:", Cause.pretty(cause).split("\\n")[0])   // first line; the rest is a stack trace
      return "recovered"
    })
  )
)
console.log("reported:", Effect.runSync(reported))
`,
      expectedOutput: `naive: Die
guarded: recovered from a TypeError
report: Error: unreachable: cart already paid
reported: recovered`,
      after: `The honest fix for \`findName\` is not \`catchDefect\`, it is to stop lying: return \`Effect.fail(new NotFound({ id }))\` when the row is missing, so the case becomes a typed failure. Keep \`catchDefect\` and \`catchCause\` for boundaries such as request handlers and plugin loaders, where a crash should become a log line and a 500 instead of taking the process down.`
    },
    {
      id: "error-management-l7",
      title: "Errors with reasons: catchReason, catchReasons, unwrapReason",
      explain: `
Some errors are two-level. A payment step fails with one \`PaymentError\`, but the *reason* varies: card declined, not enough funds, gateway down. Flattening them into three top-level errors loses the "this came from the payment step" information; a single error with a string \`reason\` loses the types. Effect v4 supports the middle path: a tagged error with a \`reason\` field that is itself a tagged union.

| Function | What it does | \`E\` afterwards |
|---|---|---|
| \`catchReason("PaymentError", "CardDeclined", f, orElse?)\` | Handle one reason | \`PaymentError\` stays (other reasons can still occur) |
| \`catchReasons("PaymentError", { A: f, B: g }, orElse?)\` | Handle several reasons | \`PaymentError\` stays unless \`orElse\` covers the rest |
| \`unwrapReason("PaymentError")\` | Replace the parent with its reasons | \`A \\| B \\| C\`, ready for \`catchTags\` |

The handlers receive the **reason** object, already narrowed, not the outer error. The optional last argument, \`orElse\`, gets the reasons you did not list, and when it is present the parent error leaves \`E\` entirely.
`,
      code: `import { Effect, Schema } from "effect"

class CardDeclined extends Schema.TaggedError<CardDeclined>()("CardDeclined", { code: Schema.String }) {}
class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", { missing: Schema.Number }) {}
class GatewayDown extends Schema.TaggedError<GatewayDown>()("GatewayDown", { retryAfter: Schema.Number }) {}

// One error for the payment step. The reason says why.
class PaymentError extends Schema.TaggedError<PaymentError>()("PaymentError", {
  reason: Schema.Union([CardDeclined, InsufficientFunds, GatewayDown])
}) {}

const pay = (amount: number): Effect.Effect<string, PaymentError> =>
  amount <= 50 ? Effect.succeed("paid " + amount)
  : amount <= 100 ? Effect.fail(new PaymentError({ reason: new InsufficientFunds({ missing: amount - 50 }) }))
  : amount <= 500 ? Effect.fail(new PaymentError({ reason: new CardDeclined({ code: "51" }) }))
  : Effect.fail(new PaymentError({ reason: new GatewayDown({ retryAfter: 30 }) }))

// One reason. E is still PaymentError, because the other reasons can happen.
const one = (amount: number): Effect.Effect<string, PaymentError> =>
  pay(amount).pipe(
    Effect.catchReason("PaymentError", "InsufficientFunds", (r) => Effect.succeed("top up " + r.missing))
  )

// Several reasons plus a catch-all for the rest. E is never.
const many = (amount: number): Effect.Effect<string, never> =>
  pay(amount).pipe(
    Effect.catchReasons("PaymentError", {
      InsufficientFunds: (r) => Effect.succeed("top up " + r.missing),
      CardDeclined: (r) => Effect.succeed("declined, code " + r.code)
    }, (r) => Effect.succeed("later: " + r._tag))
  )

// The reasons become the error. E is CardDeclined | InsufficientFunds after catchTag.
const unwrapped = (amount: number): Effect.Effect<string, CardDeclined | InsufficientFunds> =>
  pay(amount).pipe(
    Effect.unwrapReason("PaymentError"),
    Effect.catchTag("GatewayDown", (r) => Effect.succeed("retry in " + r.retryAfter + "s"))
  )

for (const amount of [40, 80, 300, 900]) {
  console.log(amount, "->", Effect.runSync(many(amount)))
}
console.log("one(80):", Effect.runSync(one(80)))
console.log("unwrapped(900):", Effect.runSync(unwrapped(900)))
`,
      expectedOutput: `40 -> paid 40
80 -> top up 30
300 -> declined, code 51
900 -> later: GatewayDown
one(80): top up 30
unwrapped(900): retry in 30s`,
      after: `Try removing the \`orElse\` argument from \`many\`. The annotation \`Effect<string, never>\` no longer compiles, because a \`PaymentError\` with reason \`GatewayDown\` can still come out. Reasons let you keep "where it failed" and "why" in one value, and still get exhaustive checking.`
    }
  ],
  challenges: [
    {
      id: "error-management-c1",
      title: "A name from the past",
      task: `This program uses a function name from Effect v3 and does not compile. Fix the name so it prints \`recovered: boom\`.`,
      code: `import { Effect } from "effect"

const program = Effect.fail("boom").pipe(
  Effect.catchAll((e) => Effect.succeed("recovered: " + e))
)

console.log(Effect.runSync(program))
`,
      solution: `import { Effect } from "effect"

const program = Effect.fail("boom").pipe(
  Effect.catch((e) => Effect.succeed("recovered: " + e))
)

console.log(Effect.runSync(program))
`,
      expectedOutput: `recovered: boom`,
      hints: [
        "Read the type error: which property does not exist on Effect?",
        "The v4 rule: catchAll became catch, catchAllCause became catchCause, catchAllDefect became catchDefect.",
        "Replace Effect.catchAll with Effect.catch."
      ],
      explanation: `Effect v4 shortened the whole family: \`catchAll\` is now \`Effect.catch\`, \`catchAllCause\` is \`catchCause\`, and \`catchAllDefect\` is \`catchDefect\`. The public website still documents v3 names, so this mistake is common. The compiler caught it before anything ran, which is the same safety you get for every other typo in a function name.`
    },
    {
      id: "error-management-c2",
      title: "The tag that does not exist",
      task: `\`catchTag\` is given a tag that no error in the program has, so it does not compile and would not match at runtime either. Fix the tag so the program prints \`missing user 7\`.`,
      code: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const loadUser = (id: number): Effect.Effect<string, NotFound> =>
  id === 1 ? Effect.succeed("Ada") : Effect.fail(new NotFound({ id }))

const program = loadUser(7).pipe(
  Effect.catchTag("UserNotFound", (e) => Effect.succeed("missing user " + e.id))
)

console.log(Effect.runSync(program))
`,
      solution: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const loadUser = (id: number): Effect.Effect<string, NotFound> =>
  id === 1 ? Effect.succeed("Ada") : Effect.fail(new NotFound({ id }))

const program = loadUser(7).pipe(
  Effect.catchTag("NotFound", (e) => Effect.succeed("missing user " + e.id))
)

console.log(Effect.runSync(program))
`,
      expectedOutput: `missing user 7`,
      hints: [
        "Where does the tag string come from? Look at the first argument of Schema.TaggedError.",
        "The tag in catchTag must be one of the _tag values in the error channel, here just one.",
        "Use \"NotFound\", the tag declared on the class."
      ],
      explanation: `\`catchTag\` only accepts tags that exist in the effect's \`E\` type. The class was declared with the tag \`"NotFound"\`, so \`"UserNotFound"\` is rejected at compile time. In plain TypeScript, a wrong string in an \`if (e.name === "UserNotFound")\` check would compile and silently never match. Tags are checked strings.`
    },
    {
      id: "error-management-c3",
      title: "The annotation that promises too much",
      task: `\`safeName\` claims it cannot fail, but only one of the two errors is handled, so it does not compile. Handle \`Forbidden\` too, succeeding with the string \`"hidden"\`. The printed output must stay exactly as shown.`,
      code: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { role: Schema.String }) {}

const loadName = (id: number): Effect.Effect<string, NotFound | Forbidden> =>
  id === 1 ? Effect.succeed("Ada")
  : id === 2 ? Effect.fail(new Forbidden({ role: "guest" }))
  : Effect.fail(new NotFound({ id }))

const safeName = (id: number): Effect.Effect<string, never> =>
  loadName(id).pipe(
    Effect.catchTag("NotFound", (e) => Effect.succeed("nobody #" + e.id))
  )

console.log(Effect.runSync(safeName(1)))
console.log(Effect.runSync(safeName(3)))
`,
      solution: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { role: Schema.String }) {}

const loadName = (id: number): Effect.Effect<string, NotFound | Forbidden> =>
  id === 1 ? Effect.succeed("Ada")
  : id === 2 ? Effect.fail(new Forbidden({ role: "guest" }))
  : Effect.fail(new NotFound({ id }))

const safeName = (id: number): Effect.Effect<string, never> =>
  loadName(id).pipe(
    Effect.catchTags({
      NotFound: (e) => Effect.succeed("nobody #" + e.id),
      Forbidden: () => Effect.succeed("hidden")
    })
  )

console.log(Effect.runSync(safeName(1)))
console.log(Effect.runSync(safeName(3)))
`,
      expectedOutput: `Ada
nobody #3`,
      hints: [
        "The program runs fine for ids 1 and 3. The compiler is complaining about a case that could happen, not one that did.",
        "After catchTag(\"NotFound\") the error channel is Forbidden, and the annotation says never.",
        "Add a Forbidden handler: either a second Effect.catchTag(\"Forbidden\", ...) or switch to Effect.catchTags with both keys."
      ],
      explanation: `Nothing goes wrong at runtime with the ids used here, and that is the point. In plain TypeScript this code would ship and crash the first time id 2 came through. Effect refuses to compile a function annotated \`Effect<string, never>\` while \`Forbidden\` is still in \`E\`. Handling the second tag shrinks \`E\` to \`never\` and the annotation becomes true. Bugs that a type error catches are the cheapest bugs you will ever fix.`
    },
    {
      id: "error-management-c4",
      title: "The fallback that never runs",
      task: `\`parseCount\` throws on bad input, so the program crashes even though it has a fallback. Do not change \`parseCount\`. Change how the failure is caught so the program prints \`count: 0 (fallback)\`.`,
      code: `import { Effect } from "effect"

const parseCount = (raw: string) =>
  Effect.sync(() => {
    const n = Number(raw)
    if (Number.isNaN(n)) throw new Error("not a number: " + raw)
    return n
  })

const program = parseCount("abc").pipe(
  Effect.catch(() => Effect.succeed(0)),
  Effect.map((n) => "count: " + n + (n === 0 ? " (fallback)" : ""))
)

console.log(Effect.runSync(program))
`,
      solution: `import { Effect } from "effect"

const parseCount = (raw: string) =>
  Effect.sync(() => {
    const n = Number(raw)
    if (Number.isNaN(n)) throw new Error("not a number: " + raw)
    return n
  })

const program = parseCount("abc").pipe(
  Effect.catchDefect(() => Effect.succeed(0)),
  Effect.map((n) => "count: " + n + (n === 0 ? " (fallback)" : ""))
)

console.log(Effect.runSync(program))
`,
      expectedOutput: `count: 0 (fallback)`,
      hints: [
        "What is the error type of parseCount? Hover it: E is never. So what can Effect.catch possibly catch?",
        "A throw inside Effect.sync is a defect, not a failure. Lesson 6 lists the two functions that see defects.",
        "Replace Effect.catch with Effect.catchDefect (or Effect.catchCause)."
      ],
      explanation: `\`Effect.sync\` promises no throw, so the exception became a defect and \`E\` stayed \`never\`. \`Effect.catch\` only looks at \`E\`, and there was nothing there to catch. \`catchDefect\` is the explicit opt-in for handling bugs. The better long-term fix is to make the failure typed with \`Effect.try\` or \`Effect.fail\`, so ordinary \`catch\` works and the signature tells the truth; but when you cannot change the code that throws, \`catchDefect\` is the right tool.`
    },
    {
      id: "error-management-c5",
      title: "throw is not yield*",
      task: `The generator uses \`throw\` to signal a missing user, so the error becomes a defect and \`catchTag\` cannot see it (it does not even compile). Fail the effect the Effect way so the program prints the two lines below.`,
      code: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const users = new Map([[1, "Ada"]])

const loadName = (id: number) =>
  Effect.gen(function* () {
    const name = users.get(id)
    if (name === undefined) throw new NotFound({ id })
    return name
  })

const describe = (id: number) =>
  loadName(id).pipe(
    Effect.catchTag("NotFound", (e) => Effect.succeed("no user with id " + e.id))
  )

console.log(Effect.runSync(describe(1)))
console.log(Effect.runSync(describe(2)))
`,
      solution: `import { Effect, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.Number }) {}

const users = new Map([[1, "Ada"]])

const loadName = (id: number) =>
  Effect.gen(function* () {
    const name = users.get(id)
    if (name === undefined) return yield* new NotFound({ id })
    return name
  })

const describe = (id: number) =>
  loadName(id).pipe(
    Effect.catchTag("NotFound", (e) => Effect.succeed("no user with id " + e.id))
  )

console.log(Effect.runSync(describe(1)))
console.log(Effect.runSync(describe(2)))
`,
      expectedOutput: `Ada
no user with id 2`,
      hints: [
        "Hover loadName: its error type is never. The throw did not put NotFound into the type.",
        "Tagged errors are yieldable. Lesson 2 shows the keyword that fails an effect with an error instance.",
        "Replace throw new NotFound({ id }) with return yield* new NotFound({ id })."
      ],
      explanation: `Inside \`Effect.gen\`, \`throw\` is the same as a throw anywhere else: it is a defect, invisible to the type and to \`catchTag\`. That is why \`catchTag("NotFound", ...)\` refused to compile: there is no \`NotFound\` in an \`E\` of \`never\`. \`yield*\` on an error instance is the typed equivalent of \`throw\`: it stops the generator, puts \`NotFound\` into \`E\`, and lets every catch function downstream see it. The \`return\` in front is only there so TypeScript knows the function does not continue.`
    },
    {
      id: "error-management-c6",
      title: "Translate at the boundary",
      task: `\`loadConfig\` promises to fail only with \`ConfigError\`, but \`readFile\` fails with a plain string, so the program does not compile. Make the promise true without changing \`readFile\` or the annotation. The output must stay exactly as shown.`,
      code: `import { Effect, Schema } from "effect"

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", { message: Schema.String }) {}

// A low-level helper you do not own. It fails with a string.
const readFile = (path: string): Effect.Effect<string, string> =>
  path === "app.json" ? Effect.succeed('{"port":8080}') : Effect.fail("ENOENT " + path)

// The domain function. Callers should only ever see ConfigError.
const loadConfig = (path: string): Effect.Effect<string, ConfigError> =>
  readFile(path)

const program = Effect.gen(function* () {
  const raw = yield* loadConfig("app.json")
  console.log("loaded", raw)
  const fallback = yield* loadConfig("missing.json").pipe(Effect.catch(() => Effect.succeed("{}")))
  console.log("fallback", fallback)
})

Effect.runSync(program)
`,
      solution: `import { Effect, Schema } from "effect"

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", { message: Schema.String }) {}

// A low-level helper you do not own. It fails with a string.
const readFile = (path: string): Effect.Effect<string, string> =>
  path === "app.json" ? Effect.succeed('{"port":8080}') : Effect.fail("ENOENT " + path)

// The domain function. Callers should only ever see ConfigError.
const loadConfig = (path: string): Effect.Effect<string, ConfigError> =>
  readFile(path).pipe(
    Effect.mapError((message) => new ConfigError({ message }))
  )

const program = Effect.gen(function* () {
  const raw = yield* loadConfig("app.json")
  console.log("loaded", raw)
  const fallback = yield* loadConfig("missing.json").pipe(Effect.catch(() => Effect.succeed("{}")))
  console.log("fallback", fallback)
})

Effect.runSync(program)
`,
      expectedOutput: `loaded {"port":8080}
fallback {}`,
      hints: [
        "Read the error: string is not assignable to ConfigError. The error channel needs to change, not the success.",
        "You do not want to recover here, only to change the error's type. Lesson 4 has a function for that.",
        "Pipe readFile(path) through Effect.mapError((message) => new ConfigError({ message }))."
      ],
      explanation: `\`mapError\` is \`map\` for the error channel: it turns the string into a \`ConfigError\` and leaves success untouched. The program printed the same thing before and after, so this is a fix you would only find through the type. Without it, every caller of \`loadConfig\` would have to know that the file system speaks in strings. With it, the low-level detail is sealed at the boundary, and callers can use \`catchTag("ConfigError", ...)\` with confidence.`
    },
    {
      id: "error-management-c7",
      title: "Reasons stay wrapped",
      task: `The handlers in \`catchTags\` are written for the reasons, but the effect fails with the outer \`ApiError\`, so they never match and the program does not compile. Add one step before \`catchTags\` so the program prints the three lines below.`,
      code: `import { Effect, Schema } from "effect"

class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfter: Schema.Number }) {}
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { scope: Schema.String }) {}
class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  reason: Schema.Union([RateLimited, Unauthorized])
}) {}

const call = (n: number): Effect.Effect<string, ApiError> =>
  n === 1 ? Effect.succeed("200 OK")
  : n === 2 ? Effect.fail(new ApiError({ reason: new RateLimited({ retryAfter: 30 }) }))
  : Effect.fail(new ApiError({ reason: new Unauthorized({ scope: "orders:read" }) }))

const describe = (n: number): Effect.Effect<string, never> =>
  call(n).pipe(
    Effect.catchTags({
      RateLimited: (r) => Effect.succeed("wait " + r.retryAfter + "s"),
      Unauthorized: (r) => Effect.succeed("need scope " + r.scope)
    })
  )

for (const n of [1, 2, 3]) console.log(Effect.runSync(describe(n)))
`,
      solution: `import { Effect, Schema } from "effect"

class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfter: Schema.Number }) {}
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { scope: Schema.String }) {}
class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  reason: Schema.Union([RateLimited, Unauthorized])
}) {}

const call = (n: number): Effect.Effect<string, ApiError> =>
  n === 1 ? Effect.succeed("200 OK")
  : n === 2 ? Effect.fail(new ApiError({ reason: new RateLimited({ retryAfter: 30 }) }))
  : Effect.fail(new ApiError({ reason: new Unauthorized({ scope: "orders:read" }) }))

const describe = (n: number): Effect.Effect<string, never> =>
  call(n).pipe(
    Effect.unwrapReason("ApiError"),
    Effect.catchTags({
      RateLimited: (r) => Effect.succeed("wait " + r.retryAfter + "s"),
      Unauthorized: (r) => Effect.succeed("need scope " + r.scope)
    })
  )

for (const n of [1, 2, 3]) console.log(Effect.runSync(describe(n)))
`,
      expectedOutput: `200 OK
wait 30s
need scope orders:read`,
      hints: [
        "What is in the error channel of call(n)? Only ApiError. catchTags looks for tags in that channel.",
        "Lesson 7 has a function that replaces a parent error with its reasons.",
        "Add Effect.unwrapReason(\"ApiError\") as the first step of the pipe."
      ],
      explanation: `\`catchTags\` matches on the \`_tag\` of the error in \`E\`, and that tag is \`"ApiError"\`. The reason tags live one level down. \`unwrapReason("ApiError")\` promotes them: \`E\` becomes \`RateLimited | Unauthorized\`, the \`catchTags\` keys line up, and because both are handled \`E\` ends as \`never\`. The alternative that keeps the parent is \`catchReasons("ApiError", { ... })\`; use \`unwrapReason\` when the "where" no longer matters and only the "why" does.`
    },
    {
      id: "error-management-c8",
      title: "Keep the reason",
      task: `The report should say *why* a lookup failed, but the program only knows *that* it failed. Change the way the outcome is captured so it prints \`lang: NotFound\` on the second line, without changing \`get\`.`,
      code: `import { Effect, Option, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { key: Schema.String }) {}

const settings = new Map([["theme", "dark"]])
const get = (key: string): Effect.Effect<string, NotFound> => {
  const value = settings.get(key)
  return value === undefined ? Effect.fail(new NotFound({ key })) : Effect.succeed(value)
}

const report = (key: string) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.option(get(key))
    console.log(key + ": " + (Option.isSome(outcome) ? outcome.value : "failed"))
  })

Effect.runSync(report("theme"))
Effect.runSync(report("lang"))
`,
      solution: `import { Effect, Result, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { key: Schema.String }) {}

const settings = new Map([["theme", "dark"]])
const get = (key: string): Effect.Effect<string, NotFound> => {
  const value = settings.get(key)
  return value === undefined ? Effect.fail(new NotFound({ key })) : Effect.succeed(value)
}

const report = (key: string) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(get(key))
    console.log(key + ": " + (Result.isSuccess(outcome) ? outcome.success : outcome.failure._tag))
  })

Effect.runSync(report("theme"))
Effect.runSync(report("lang"))
`,
      expectedOutput: `theme: dark
lang: NotFound`,
      hints: [
        "Effect.option turns a failure into None. Where did the NotFound value go?",
        "Lesson 5's table has a sibling of option that keeps the error. It uses the Result type.",
        "Use Effect.result, then Result.isSuccess(outcome) ? outcome.success : outcome.failure._tag."
      ],
      explanation: `\`Effect.option\` answers one question, "did it work?", and throws the error value away to do it. \`Effect.result\` keeps both sides as a \`Result<string, NotFound>\`, so the failure branch still has the typed error with its \`_tag\` and \`key\`. Pick \`option\` when the reason really does not matter, \`result\` when it does, and \`exit\` when you also need to see defects and interruptions.`
    }
  ],
  problems: [
    {
      id: "error-management-p1",
      title: "Checkout pipeline",
      spec: `
Build a two-step checkout with typed errors.

1. Define \`OutOfStock\` (field \`sku: string\`) and \`CardDeclined\` (field \`code: string\`) with \`Schema.TaggedError\`.
2. \`reserve(order)\` fails with \`OutOfStock\` when the order's \`sku\` is \`"sku-9"\`, and succeeds with the order otherwise.
3. \`charge(order)\` fails with \`CardDeclined\` with code \`"05"\` when \`order.total\` is over \`100\`, and succeeds with the string \`"receipt #" + order.id + " for " + order.total\` otherwise.
4. \`checkout(order)\` runs \`reserve\` then \`charge\` with \`Effect.gen\`. Its type must be \`Effect<string, OutOfStock | CardDeclined>\`.
5. \`describe(order)\` handles both errors with \`catchTags\` so its error type is \`never\`: \`OutOfStock\` becomes \`"out of stock: " + sku\`, \`CardDeclined\` becomes \`"card declined (code " + code + ")"\`.

Run \`describe\` on the three orders in the starter and print \`order.id + ": " + result\` for each. Exact output:

\`\`\`
1: receipt #1 for 30
2: out of stock: sku-9
3: card declined (code 05)
\`\`\`
`,
      starter: `import { Effect, Schema } from "effect"

interface Order {
  readonly id: number
  readonly sku: string
  readonly total: number
}

// TODO: OutOfStock and CardDeclined with Schema.TaggedError

// TODO: reserve(order): Effect<Order, OutOfStock>
// TODO: charge(order): Effect<string, CardDeclined>

const checkout = (order: Order) =>
  Effect.gen(function* () {
    // TODO: reserve, then charge
    return "TODO"
  })

// TODO: describe(order) handles both errors with catchTags

const orders: Array<Order> = [
  { id: 1, sku: "sku-1", total: 30 },
  { id: 2, sku: "sku-9", total: 30 },
  { id: 3, sku: "sku-1", total: 250 }
]

for (const order of orders) {
  // TODO: print order.id + ": " + describe(order)
}
`,
      solution: `import { Effect, Schema } from "effect"

interface Order {
  readonly id: number
  readonly sku: string
  readonly total: number
}

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", { sku: Schema.String }) {}
class CardDeclined extends Schema.TaggedError<CardDeclined>()("CardDeclined", { code: Schema.String }) {}

const reserve = (order: Order): Effect.Effect<Order, OutOfStock> =>
  order.sku === "sku-9" ? Effect.fail(new OutOfStock({ sku: order.sku })) : Effect.succeed(order)

const charge = (order: Order): Effect.Effect<string, CardDeclined> =>
  order.total > 100
    ? Effect.fail(new CardDeclined({ code: "05" }))
    : Effect.succeed("receipt #" + order.id + " for " + order.total)

const checkout = (order: Order): Effect.Effect<string, OutOfStock | CardDeclined> =>
  Effect.gen(function* () {
    const reserved = yield* reserve(order)
    return yield* charge(reserved)
  })

const describe = (order: Order): Effect.Effect<string, never> =>
  checkout(order).pipe(
    Effect.catchTags({
      OutOfStock: (e) => Effect.succeed("out of stock: " + e.sku),
      CardDeclined: (e) => Effect.succeed("card declined (code " + e.code + ")")
    })
  )

const orders: Array<Order> = [
  { id: 1, sku: "sku-1", total: 30 },
  { id: 2, sku: "sku-9", total: 30 },
  { id: 3, sku: "sku-1", total: 250 }
]

for (const order of orders) {
  console.log(order.id + ": " + Effect.runSync(describe(order)))
}
`,
      expectedOutput: `1: receipt #1 for 30
2: out of stock: sku-9
3: card declined (code 05)`,
      hints: [
        "Each step is a small function with an explicit return type: Effect.Effect<Order, OutOfStock> and Effect.Effect<string, CardDeclined>. Annotate them, the compiler will guide you.",
        "In checkout, yield* reserve first, then return yield* charge. The error types of both steps are collected into the union automatically.",
        "catchTags takes an object whose keys are the tags. Once both are handled, describe can be annotated Effect.Effect<string, never> and it will compile."
      ]
    },
    {
      id: "error-management-p2",
      title: "Config file inspector",
      spec: `
Classify every way a config load can end, by reading the \`Exit\`.

The starter gives you a fake file system \`files\` and a \`readFile(path)\` that already returns a typed effect: it fails with \`NotFound\` for unknown paths and \`Forbidden\` for \`"secret.json"\`. Add:

1. \`parsePort(raw)\` that uses \`Effect.sync\` with \`JSON.parse(raw)\` and returns \`.port\` as a \`number\`. A corrupt file makes \`JSON.parse\` throw; leave that as a defect, it is a bug in the file, not an expected case.
2. \`load(path)\` that reads then parses, with \`Effect.gen\`.
3. \`inspect(path)\` that captures the outcome with \`Effect.exit\` and prints one line: \`path + " -> ok port " + port\` on success; otherwise, for each reason in \`cause.reasons\`, \`path + " -> failed: " + tag\` for a \`Fail\` (use the error's \`_tag\`) and \`path + " -> crashed: " + name\` for a \`Die\` (use the defect's \`.name\`, it is an \`Error\`).

Run \`inspect\` on \`"app.json"\`, \`"missing.json"\`, \`"secret.json"\`, \`"corrupt.json"\` in that order. Exact output:

\`\`\`
app.json -> ok port 8080
missing.json -> failed: NotFound
secret.json -> failed: Forbidden
corrupt.json -> crashed: SyntaxError
\`\`\`
`,
      starter: `import { Effect, Exit, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { path: Schema.String }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { path: Schema.String }) {}

const files = new Map([
  ["app.json", '{"port": 8080}'],
  ["secret.json", '{"port": 1}'],
  ["corrupt.json", "{port: oops"]
])

const readFile = (path: string): Effect.Effect<string, NotFound | Forbidden> => {
  if (path === "secret.json") return Effect.fail(new Forbidden({ path }))
  const content = files.get(path)
  return content === undefined ? Effect.fail(new NotFound({ path })) : Effect.succeed(content)
}

// TODO: parsePort(raw) with Effect.sync and JSON.parse

// TODO: load(path) = read then parse

const inspect = (path: string) =>
  Effect.gen(function* () {
    // TODO: capture the Exit of load(path) and print one line per outcome
  })

for (const path of ["app.json", "missing.json", "secret.json", "corrupt.json"]) {
  Effect.runSync(inspect(path))
}
`,
      solution: `import { Effect, Exit, Schema } from "effect"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { path: Schema.String }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { path: Schema.String }) {}

const files = new Map([
  ["app.json", '{"port": 8080}'],
  ["secret.json", '{"port": 1}'],
  ["corrupt.json", "{port: oops"]
])

const readFile = (path: string): Effect.Effect<string, NotFound | Forbidden> => {
  if (path === "secret.json") return Effect.fail(new Forbidden({ path }))
  const content = files.get(path)
  return content === undefined ? Effect.fail(new NotFound({ path })) : Effect.succeed(content)
}

// A throw here is a defect on purpose: a corrupt file is not an expected case.
const parsePort = (raw: string) =>
  Effect.sync(() => (JSON.parse(raw) as { port: number }).port)

const load = (path: string) =>
  Effect.gen(function* () {
    const raw = yield* readFile(path)
    return yield* parsePort(raw)
  })

const inspect = (path: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(load(path))
    if (Exit.isSuccess(exit)) {
      console.log(path + " -> ok port " + exit.value)
      return
    }
    for (const reason of exit.cause.reasons) {
      if (reason._tag === "Fail") {
        console.log(path + " -> failed: " + reason.error._tag)
      } else if (reason._tag === "Die") {
        console.log(path + " -> crashed: " + (reason.defect as Error).name)
      }
    }
  })

for (const path of ["app.json", "missing.json", "secret.json", "corrupt.json"]) {
  Effect.runSync(inspect(path))
}
`,
      expectedOutput: `app.json -> ok port 8080
missing.json -> failed: NotFound
secret.json -> failed: Forbidden
corrupt.json -> crashed: SyntaxError`,
      hints: [
        "Effect.exit(load(path)) never fails: yield* it to get an Exit value, then branch with Exit.isSuccess.",
        "In the failure branch, loop over exit.cause.reasons. Each reason has a _tag of Fail, Die, or Interrupt; switch on it.",
        "For a Fail reason, reason.error is typed NotFound | Forbidden so ._tag is available. For Die, reason.defect is unknown; cast it to Error to read .name."
      ]
    },
    {
      id: "error-management-p3",
      title: "Gateway status messages",
      spec: `
An API client fails with one \`ApiError\` whose \`reason\` explains what happened. Turn each outcome into a message for the user.

1. Define three reasons with \`Schema.TaggedError\`: \`RateLimited\` (\`retryAfter: number\`), \`Unauthorized\` (\`scope: string\`), \`Maintenance\` (\`until: string\`). Define \`ApiError\` with a \`reason\` field that is a \`Schema.Union\` of the three.
2. \`call(n)\` returns \`Effect<string, ApiError>\`: \`n = 1\` succeeds with \`"ok 200"\`, \`n = 2\` fails with \`RateLimited\` (retryAfter 30), \`n = 3\` fails with \`Unauthorized\` (scope \`"orders:read"\`), anything else fails with \`Maintenance\` (until \`"06:00"\`).
3. \`message(n)\` uses \`Effect.catchReasons\` to handle \`RateLimited\` as \`"wait " + retryAfter + "s"\` and \`Unauthorized\` as \`"need scope " + scope\`, and the catch-all third argument for any other reason as \`"try again after " + until\`. Its error type must be \`never\`.

Print \`"call " + n + ": " + message\` for n in 1 to 4. Exact output:

\`\`\`
call 1: ok 200
call 2: wait 30s
call 3: need scope orders:read
call 4: try again after 06:00
\`\`\`
`,
      starter: `import { Effect, Schema } from "effect"

// TODO: RateLimited, Unauthorized, Maintenance reasons

// TODO: ApiError with a reason field (Schema.Union of the three)

// TODO: call(n): Effect<string, ApiError>

// TODO: message(n): Effect<string, never> with Effect.catchReasons and a catch-all

for (const n of [1, 2, 3, 4]) {
  // TODO: print "call " + n + ": " + message
}
`,
      solution: `import { Effect, Schema } from "effect"

class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfter: Schema.Number }) {}
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { scope: Schema.String }) {}
class Maintenance extends Schema.TaggedError<Maintenance>()("Maintenance", { until: Schema.String }) {}

class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  reason: Schema.Union([RateLimited, Unauthorized, Maintenance])
}) {}

const call = (n: number): Effect.Effect<string, ApiError> =>
  n === 1 ? Effect.succeed("ok 200")
  : n === 2 ? Effect.fail(new ApiError({ reason: new RateLimited({ retryAfter: 30 }) }))
  : n === 3 ? Effect.fail(new ApiError({ reason: new Unauthorized({ scope: "orders:read" }) }))
  : Effect.fail(new ApiError({ reason: new Maintenance({ until: "06:00" }) }))

const message = (n: number): Effect.Effect<string, never> =>
  call(n).pipe(
    Effect.catchReasons("ApiError", {
      RateLimited: (r) => Effect.succeed("wait " + r.retryAfter + "s"),
      Unauthorized: (r) => Effect.succeed("need scope " + r.scope)
    }, (r) => Effect.succeed("try again after " + r.until))
  )

for (const n of [1, 2, 3, 4]) {
  console.log("call " + n + ": " + Effect.runSync(message(n)))
}
`,
      expectedOutput: `call 1: ok 200
call 2: wait 30s
call 3: need scope orders:read
call 4: try again after 06:00`,
      hints: [
        "The reason field is declared like any other schema field: reason: Schema.Union([RateLimited, Unauthorized, Maintenance]). Construct with new ApiError({ reason: new RateLimited({ retryAfter: 30 }) }).",
        "catchReasons takes the parent tag, an object keyed by reason tags, and an optional third function for the remaining reasons. Each handler receives the reason, not the ApiError.",
        "With the catch-all present, the only reason left is Maintenance, so r.until is available in it and E becomes never."
      ]
    }
  ],
  recall: [
    {
      q: "What is the difference between `Effect.fail` and `Effect.die`, and which catch functions see each?",
      a: "`Effect.fail(e)` is an expected failure: `e` goes into the `E` type, and `catch`, `catchTag`, `catchTags`, `catchIf`, `match`, `result`, `option` all see it. `Effect.die(x)` (and any exception thrown inside `Effect.sync`) is a defect: it is not in the type, and only `catchDefect` and `catchCause` see it."
    },
    {
      q: "What would the type be of `Effect.fail(new NotFound({ id: 1 })).pipe(Effect.catchTag(\"NotFound\", () => Effect.succeed(0)))`?",
      a: "`Effect<number, never, never>`. The original effect is `Effect<never, NotFound>`; the handler removes `NotFound` from `E` and adds `number` to `A`. Nothing is left in the error channel."
    },
    {
      q: "You have `Effect<User, NotFound | Forbidden | Timeout>` and want a different fallback for `NotFound` and `Forbidden`, leaving `Timeout` unhandled. Which function would you reach for?",
      a: "`Effect.catchTags({ NotFound: ..., Forbidden: ... })`. One handler per tag, and `Timeout` stays in `E`. If both should get the same handler, `Effect.catchTag([\"NotFound\", \"Forbidden\"], ...)` is shorter."
    },
    {
      q: "Inside `Effect.gen`, why is `throw new NotFound({ id })` wrong, and what should you write instead?",
      a: "`throw` makes a defect: the error leaves the type and `catchTag` cannot see it. Write `yield* new NotFound({ id })` (usually `return yield* ...`). Tagged errors are yieldable, so this fails the effect with `NotFound` in `E`."
    },
    {
      q: "What does `cause.reasons` contain on a failed `Exit`, and what are the three tags?",
      a: "A flat array of reasons. Each has `_tag` equal to `Fail` (with `.error`, the typed value), `Die` (with `.defect`, an `unknown`), or `Interrupt` (with `.fiberId`). There is no tree of sequential or parallel causes in v4, only this array."
    },
    {
      q: "When would you use `Effect.unwrapReason` instead of `Effect.catchReasons`?",
      a: "`catchReasons` handles some reasons while keeping the parent error in `E` for the others. `unwrapReason` replaces the parent with its reasons entirely, so `E` becomes the union of reason types and you continue with `catchTags` or any other tool. Use it when the \"which step failed\" information is no longer needed."
    },
    {
      q: "`Effect.result`, `Effect.option`, `Effect.exit`: which one shows you a defect?",
      a: "Only `Effect.exit`. `result` and `option` capture typed failures only, and a defect still fails the surrounding effect. `Exit` carries the full `Cause`, including `Die` and `Interrupt` reasons."
    },
    {
      q: "In `Effect.catchIf`, what changes in the resulting `E` when you pass a type guard versus a plain boolean predicate?",
      a: "With a type guard `(e): e is HttpError => ...`, `HttpError` is removed from `E`, so only use a guard when it matches every value of that class. With a plain predicate, `E` is unchanged, which is correct when only some values (say status 500 and above) are recovered."
    }
  ]
}

export default section
