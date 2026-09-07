import type { Section } from "../types.ts"

const section: Section = {
  id: "error-management",
  title: "Error Management",
  order: 2,
  summary: "Expected failures versus defects, tagged error classes, the catch family, and reading an Exit.",
  intro: `
**The problem.** In plain TypeScript, every error uses the same mechanism: \`throw\`. Look at this checkout:

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

The signature says \`Promise<Receipt>\`. It does not say which errors can come out. The \`catch\` block gets \`unknown\`, so you write \`instanceof\` checks, and you hope that you remembered every case. Also, the \`catch\` block that you wrote for "card declined" also catches a real bug. The bug is now hidden behind a friendly banner.

### The shift

Today you think of an error as **a value that escapes**. It exits the function and goes up the stack until a \`catch\` block stops it. In Effect, an error is **a value that the program returns**, in the same way that it returns a success. The error is in the type:

\`\`\`ts
const checkout: (cart: Cart) => Effect<Receipt, OutOfStock | CardDeclined>
\`\`\`

Catch \`OutOfStock\`, and the type becomes \`Effect<Receipt, CardDeclined>\`. Catch \`CardDeclined\` too, and the type becomes \`Effect<Receipt, never>\`. The compiler now knows that no error is left. If you do not catch one error, the type keeps it. A function that declares \`never\` then does not compile. The error type becomes smaller as you catch errors, and you can read what is left at any point.

Effect also keeps 2 kinds of problem apart. A **failure** is expected and typed (\`Effect.fail\`). A **defect** is a bug: a thrown exception, or \`Effect.die\`. A defect is unexpected and not typed. The normal \`catch\` functions see only failures, so a bug cannot hide behind a fallback. An **interrupt** is the third kind: code outside the effect stopped it.

| | Plain TS \`try/catch\` | Effect |
|---|---|---|
| Where the error type is | Nowhere, \`catch (e)\` gets \`unknown\` | In the second type parameter, \`E\` |
| Expected error vs bug | Same \`throw\`, same \`catch\` | \`Effect.fail\` (typed) vs \`Effect.die\` (defect) |
| Catch one kind only | \`instanceof\` check, then throw the rest again | \`catchTag("X", ...)\`, the rest stays in \`E\` |
| A case is not caught | Compiles, then crashes in production | Compiles only if the type of the caller permits the case |
| See what happened | Lost after the \`catch\` | \`Exit\` and \`Cause\` are plain values |

In this section you define errors, recover from them by tag or by condition, process defects, and read the full outcome. Retries and schedules come in a later section.
`,
  lessons: [
    {
      id: "error-management-l1",
      title: "Two kinds of failure, and a third reason",
      explain: `
Plain TypeScript makes this bug easy. A function throws \`NotFound\` when a user does not exist. The caller wraps the function in \`try/catch\` and shows "user not found". One day, a typo inside the function throws a \`TypeError\`. The same \`catch\` block runs, the same message shows, and the bug goes to production.

Effect keeps the 2 kinds apart from the start:

- \`Effect.fail(e)\` is an **expected failure**. It goes into the \`E\` type parameter.
- \`Effect.die(x)\` is a **defect**, a bug. An exception thrown inside \`Effect.sync\` is also a defect. Defects are not in the type. \`E\` stays \`never\`.
- An **interrupt** is the third reason: code outside the effect stopped the fiber that runs it. A fiber is the unit of execution that runs an effect.

When an effect does not succeed, its \`Exit\` holds a \`Cause\`. \`cause.reasons\` is an array of reasons. Each reason has a tag: \`Fail\`, \`Die\`, or \`Interrupt\`. The program below shows all 4 ways in which an effect does not succeed, and how each one looks.
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
      after: `Notice that the thrown \`TypeError\` and \`Effect.die\` look the same: both are \`Die\`. Only \`Effect.fail\` appears in the type, as \`string\`. Replace \`Effect.sync\` in the \`thrown\` case with \`Effect.try({ try: ..., catch: () => "typed now" })\`. The reason becomes \`Fail\`, because you told Effect that the throw is expected.`
    },
    {
      id: "error-management-l2",
      title: "Defining errors: tagged classes you can yield",
      explain: `
In plain TypeScript, a custom error is a class that extends \`Error\`, and you \`throw\` it. The signature does not mention it:

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

Effect errors are classes too, with 2 differences. First, they have a \`_tag\`: a string literal that names the error. Effect and TypeScript use the tag to tell error types apart in a union. Second, you can yield them. Inside \`Effect.gen\`, you write \`yield* new NotFound({ id })\`, and the effect fails with that error. This reads like \`throw\`, but the error goes into the \`E\` type.

There are 2 ways to define an error. \`Schema.TaggedError\` is the preferred way. You declare the fields as schemas, so you can validate the error later or send it over a network. \`Data.TaggedError\` is smaller and takes a plain field type. Both set \`_tag\` for you.
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
      after: `Hover over \`loadName\` in an editor. TypeScript collected both errors from the 2 \`yield*\` lines into \`NotFound | Forbidden\`. Change \`yield* new NotFound({ id })\` to \`throw new NotFound({ id })\`. The code still compiles, but the error disappears from the type and becomes a \`Die\`. Challenge 5 is about this mistake.`
    },
    {
      id: "error-management-l3",
      title: "Recovering by tag: catch, catchTag, catchTags",
      explain: `
When errors have tags, recovery is a lookup by tag, not a chain of \`instanceof\` checks. Each function below removes the errors that it catches from \`E\` and keeps the rest.

| Function | Catches | \`E\` afterwards |
|---|---|---|
| \`Effect.catch(f)\` | Every failure | The failure type of \`f\` |
| \`Effect.catchTag("A", f)\` | Only errors with tag \`A\` | The union without \`A\` |
| \`Effect.catchTag(["A", "B"], f)\` | \`A\` or \`B\`, one handler | The union without \`A\` and \`B\` |
| \`Effect.catchTags({ A: f, B: g })\` | Several tags, one handler for each | The union without those tags |
| \`Effect.catchIf(pred, f)\` | Errors that satisfy a condition | Lesson 4 |
| \`Effect.catchFilter(filter, f)\` | Errors that satisfy a \`Filter\` | Lesson 4 |

The handler receives the error, already narrowed to the matched class, and returns a new effect. The success type of this effect is added to \`A\`, and its error type is added to \`E\`. If the handler returns \`Effect.succeed(...)\`, the tag is removed from \`E\`. This is the smaller error type from the intro. The return type annotations in the code make it visible.

Note: \`catchAll\` from older Effect versions is now \`Effect.catch\`.
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
      after: `Delete the \`Timeout\` handler inside \`catchTags\`. \`safeName\` no longer compiles: \`Timeout\` is still in \`E\`, but the annotation declares \`never\`. The compiler does the check that a code reviewer did before.`
    },
    {
      id: "error-management-l4",
      title: "Recovering by condition, and translating errors",
      explain: `
Sometimes the tag is not enough. An \`HttpError\` with status 503 can use a cached fallback. The same class with status 404 cannot. 2 functions look at the error value:

- \`Effect.catchIf(predicate, handler)\`. With a plain boolean predicate, \`E\` does **not** become smaller. A 404 is still an \`HttpError\` that can come out. With a type guard (\`(e): e is HttpError => ...\`), Effect removes the matched class from \`E\`. Use a guard only when the guard matches every value of that class.
- \`Effect.catchFilter(filter, handler)\`. A \`Filter\` (from the \`Filter\` module) is a reusable, named version of the same idea. \`Filter.tagged("ParseError")\` matches a tag and narrows the type correctly. \`Filter.fromPredicate(fn)\` wraps a boolean function.

The third function does not recover at all. \`Effect.mapError(f)\` replaces the error with another value. Use it at a boundary. A low-level \`HttpError\` becomes the \`AppError\` of your domain, and callers see only the domain error. Without this step, every caller must know about HTTP.
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
      after: `Inside the \`mapError\` handler, the type of \`e\` is only \`HttpError\`, because \`catchFilter\` already removed \`ParseError\`. Swap steps 2 and 3. The \`mapError\` handler must now process both classes, and \`e.status\` no longer compiles.`
    },
    {
      id: "error-management-l5",
      title: "Turning a failure into a plain value",
      explain: `
Every function so far replaced a failure with another effect. Often you want a simpler result: a default value, or both outcomes as data. This family changes an effect that can fail into an effect that cannot fail.

| Function | Use when | Result type |
|---|---|---|
| \`Effect.orElseSucceed(() => x)\` | Every failure must become a default value | \`Effect<A \\| X, never>\` |
| \`Effect.match({ onFailure, onSuccess })\` | Both outcomes become a plain value | \`Effect<B, never>\` |
| \`Effect.matchEffect({ onFailure, onSuccess })\` | Same, but the handlers run effects | \`Effect<B, E2>\` |
| \`Effect.result(effect)\` | You keep the error for a later check | \`Effect<Result<A, E>, never>\` |
| \`Effect.option(effect)\` | You only want to know if the effect succeeded | \`Effect<Option<A>, never>\` |
| \`Effect.ignore(effect)\` | You discard both outcomes | \`Effect<void, never>\` |

\`Result\` is the Effect data type for "success or failure" (older versions called it \`Either\`). \`Option\` is the data type for "a value or nothing". Both have guards such as \`isSuccess\` and \`isSome\`.

Note: like \`catch\`, all of these functions see **failures only**. A defect passes through them.
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
      after: `\`Effect.result\` is the clean answer to the last problem in Getting Started, where you ran a nested \`runPromiseExit\`. Replace \`get("theme")\` in the \`option\` line with \`get("size")\`. You get \`none\`, and you cannot know why. Use \`result\` when the reason is important.`
    },
    {
      id: "error-management-l6",
      title: "Defects: the errors that catch does not see",
      explain: `
A developer wraps a lookup in \`Effect.catch\` with a fallback. The developer thinks that every problem is now caught. Then a user id that is not in the table reaches a \`!\` assertion that is not true. The code throws a \`TypeError\`, and the program crashes. The fallback did not run.

This is the intended behavior. The throw happened inside \`Effect.sync\`, so it is a defect, and \`E\` for that effect is \`never\`. \`Effect.catch\`, \`catchTag\`, \`match\`, \`result\`, and the related functions look only at \`E\`. A defect means that the program is in a state that nobody planned for. A default value would hide the defect, and this is the plain TypeScript bug from lesson 1.

When you want to process defects, say so explicitly:

- \`Effect.catchDefect(f)\` sees only defects. \`f\` receives the thrown value as \`unknown\`.
- \`Effect.catchCause(f)\` sees the whole \`Cause\`: failures, defects, and interrupts together. Use it for logs at the top of an application.
- \`Cause.pretty(cause)\` makes a readable report. Its first line is \`Name: message\`. The rest is a stack trace.
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
      after: `The correct fix for \`findName\` is not \`catchDefect\`. The correct fix is to return \`Effect.fail(new NotFound({ id }))\` when the row does not exist. Then the case becomes a typed failure. Keep \`catchDefect\` and \`catchCause\` for boundaries such as request handlers and plugin loaders. At a boundary, a crash must become a log line and a 500 response, not a process exit.`
    },
    {
      id: "error-management-l7",
      title: "Errors with reasons: catchReason, catchReasons, unwrapReason",
      explain: `
Some errors have 2 levels. A payment step fails with one \`PaymentError\`, but the *reason* varies: card declined, not enough funds, gateway down. If you make 3 top-level errors, you lose the information that the payment step failed. If you make one error with a string \`reason\`, you lose the types. Effect v4 supports a middle path: a tagged error with a \`reason\` field that is itself a tagged union.

| Function | What it does | \`E\` afterwards |
|---|---|---|
| \`catchReason("PaymentError", "CardDeclined", f, orElse?)\` | Catches one reason | \`PaymentError\` stays (other reasons can still occur) |
| \`catchReasons("PaymentError", { A: f, B: g }, orElse?)\` | Catches several reasons | \`PaymentError\` stays unless \`orElse\` catches the rest |
| \`unwrapReason("PaymentError")\` | Replaces the parent with its reasons | \`A \\| B \\| C\`, ready for \`catchTags\` |

The handlers receive the **reason** object, already narrowed, not the outer error. The optional last argument, \`orElse\`, gets the reasons that you did not list. When \`orElse\` is present, the parent error leaves \`E\`.
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
      after: `Remove the \`orElse\` argument from \`many\`. The annotation \`Effect<string, never>\` no longer compiles, because a \`PaymentError\` with reason \`GatewayDown\` can still come out. Reasons keep "which step failed" and "why" in one value, and the compiler still checks that you caught every case.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use `Effect.fail` (or `yield*` on a tagged error) for an expected failure.",
      dont: "Do not use `throw` or `Effect.die` for a case that a caller must process.",
      why: "A throw or `Effect.die` makes a defect that is not in `E`, so callers cannot see it or catch it by tag."
    },
    {
      do: "Define errors with `Schema.TaggedError` and a unique `_tag`.",
      dont: "Do not fail with plain strings or classes that extend `Error` without a tag.",
      why: "Without a `_tag`, `catchTag` and `catchTags` cannot select one error from the union."
    },
    {
      do: "Inside `Effect.gen`, write `return yield* new NotFound({ id })` to fail.",
      dont: "Do not write `throw new NotFound({ id })` inside `Effect.gen`.",
      why: "A `throw` inside the generator becomes a defect, the error leaves the type, and `catchTag` cannot see it."
    },
    {
      do: "Catch one error at a time with `Effect.catchTag`, or several with `Effect.catchTags`.",
      dont: "Do not use `Effect.catch` with an `instanceof` chain inside the handler.",
      why: "`Effect.catch` removes every failure from `E`, so the compiler no longer reports the cases that you did not process."
    },
    {
      do: "Annotate the return type, for example `Effect.Effect<string, never>`, after you catch every error.",
      dont: "Do not declare `never` in `E` while one tag is still not caught.",
      why: "The compiler rejects the annotation, and this type error is the only sign of the case that is not caught."
    },
    {
      do: "Use `Effect.mapError` at a boundary to change a low-level error into a domain error.",
      dont: "Do not let a low-level error such as a plain string pass through a domain function.",
      why: "Every caller then must know the low-level detail, and `catchTag` on the domain error does not match."
    },
    {
      do: "Use `Effect.catchDefect` or `Effect.catchCause` only at a boundary, such as a request handler.",
      dont: "Do not use `Effect.catchDefect` to hide a bug with a default value.",
      why: "A defect is a state that nobody planned for, and a default value hides the bug in the same way that plain `try/catch` does."
    },
    {
      do: "Use `Effect.exit` and read `cause.reasons` when you need to see defects and interrupts.",
      dont: "Do not use `Effect.option` or `Effect.result` when a defect is possible and important.",
      why: "`option` and `result` capture only typed failures, and a defect still fails the outer effect."
    }
  ],
  challenges: [
    {
      id: "error-management-c1",
      title: "A name from the past",
      task: `This program uses a function name from Effect v3, and it does not compile. Correct the name so that the program prints \`recovered: boom\`.`,
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
        "Read the type error. Which property does not exist on Effect?",
        "The v4 rule: catchAll became catch, catchAllCause became catchCause, catchAllDefect became catchDefect.",
        "Replace Effect.catchAll with Effect.catch."
      ],
      explanation: `Effect v4 made the names shorter: \`catchAll\` is now \`Effect.catch\`, \`catchAllCause\` is \`catchCause\`, and \`catchAllDefect\` is \`catchDefect\`. The public website still documents the v3 names, so this mistake is common. The compiler found the error before the code ran. This is the same safety that you get for every other typo in a function name.`
    },
    {
      id: "error-management-c2",
      title: "The tag that does not exist",
      task: `\`catchTag\` receives a tag that no error in the program has. The program does not compile, and the tag does not match at run time either. Correct the tag so that the program prints \`missing user 7\`.`,
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
        "The tag in catchTag must be one of the _tag values in the error type. Here there is only one.",
        "Use \"NotFound\", the tag declared on the class."
      ],
      explanation: `\`catchTag\` accepts only tags that exist in the \`E\` type of the effect. The class declares the tag \`"NotFound"\`, so the compiler rejects \`"UserNotFound"\`. In plain TypeScript, a wrong string in an \`if (e.name === "UserNotFound")\` check compiles, and the check never matches. Tags are checked strings.`
    },
    {
      id: "error-management-c3",
      title: "The annotation that promises too much",
      task: `\`safeName\` declares that it cannot fail, but the code catches only one of the 2 errors. Thus it does not compile. Catch \`Forbidden\` too, and succeed with the string \`"hidden"\`. The printed output must stay the same as shown.`,
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
        "The program runs correctly for ids 1 and 3. The compiler reports a case that can happen, not a case that did happen.",
        "After catchTag(\"NotFound\"), the error type is Forbidden, and the annotation says never.",
        "Add a Forbidden handler: a second Effect.catchTag(\"Forbidden\", ...), or Effect.catchTags with both keys."
      ],
      explanation: `Nothing goes wrong at run time with the ids in this program. This is the point. In plain TypeScript, this code goes to production and crashes the first time that id 2 arrives. Effect refuses to compile a function with the annotation \`Effect<string, never>\` while \`Forbidden\` is still in \`E\`. When you catch the second tag, \`E\` becomes \`never\`, and the annotation becomes true. A bug that a type error finds is the cheapest bug to fix.`
    },
    {
      id: "error-management-c4",
      title: "The fallback that never runs",
      task: `\`parseCount\` throws on bad input, so the program crashes, although it has a fallback. Do not change \`parseCount\`. Change the way that the code catches the failure, so that the program prints \`count: 0 (fallback)\`.`,
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
        "What is the error type of parseCount? Hover over it: E is never. What can Effect.catch see?",
        "A throw inside Effect.sync is a defect, not a failure. Lesson 6 lists the 2 functions that see defects.",
        "Replace Effect.catch with Effect.catchDefect (or Effect.catchCause)."
      ],
      explanation: `\`Effect.sync\` declares that the function does not throw. Thus the exception became a defect, and \`E\` stayed \`never\`. \`Effect.catch\` looks only at \`E\`, and \`E\` had nothing to catch. \`catchDefect\` is the explicit way to catch bugs. The better long-term fix is a typed failure with \`Effect.try\` or \`Effect.fail\`. Then the normal \`catch\` works, and the signature is correct. When you cannot change the code that throws, \`catchDefect\` is the correct tool.`
    },
    {
      id: "error-management-c5",
      title: "throw is not yield*",
      task: `The generator uses \`throw\` to report a user that does not exist. Thus the error becomes a defect, and \`catchTag\` cannot see it. The program does not compile. Make the effect fail in the Effect way, so that the program prints the 2 lines below.`,
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
        "Hover over loadName: its error type is never. The throw did not put NotFound into the type.",
        "You can yield tagged errors. Lesson 2 shows the keyword that fails an effect with an error instance.",
        "Replace throw new NotFound({ id }) with return yield* new NotFound({ id })."
      ],
      explanation: `Inside \`Effect.gen\`, \`throw\` is the same as a throw in any other place. It is a defect. The type does not show it, and \`catchTag\` does not see it. This is why \`catchTag("NotFound", ...)\` did not compile: there is no \`NotFound\` in an \`E\` of \`never\`. \`yield*\` on an error instance is the typed equivalent of \`throw\`. It stops the generator, puts \`NotFound\` into \`E\`, and lets every catch function after it see the error. The \`return\` in front only tells TypeScript that the function does not continue.`
    },
    {
      id: "error-management-c6",
      title: "Translate at the boundary",
      task: `\`loadConfig\` declares that it fails only with \`ConfigError\`, but \`readFile\` fails with a plain string. Thus the program does not compile. Make the declaration true. Do not change \`readFile\` or the annotation. The output must stay the same as shown.`,
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
        "Read the error: string is not assignable to ConfigError. The error type must change, not the success type.",
        "You do not want to recover here. You only want to change the type of the error. Lesson 4 has a function for this.",
        "Pipe readFile(path) through Effect.mapError((message) => new ConfigError({ message }))."
      ],
      explanation: `\`mapError\` is \`map\` for the error type. It changes the string into a \`ConfigError\` and does not touch the success value. The program printed the same output before and after the fix. Thus only the type shows this problem. Without the fix, every caller of \`loadConfig\` must know that the file system fails with strings. With the fix, the low-level detail stays at the boundary, and callers can use \`catchTag("ConfigError", ...)\`.`
    },
    {
      id: "error-management-c7",
      title: "Reasons stay wrapped",
      task: `The handlers in \`catchTags\` are written for the reasons, but the effect fails with the outer \`ApiError\`. Thus the handlers never match, and the program does not compile. Add one step before \`catchTags\` so that the program prints the 3 lines below.`,
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
        "What is in the error type of call(n)? Only ApiError. catchTags looks for tags in that type.",
        "Lesson 7 has a function that replaces a parent error with its reasons.",
        "Add Effect.unwrapReason(\"ApiError\") as the first step of the pipe."
      ],
      explanation: `\`catchTags\` matches the \`_tag\` of the error in \`E\`, and that tag is \`"ApiError"\`. The reason tags are one level down. \`unwrapReason("ApiError")\` moves them up: \`E\` becomes \`RateLimited | Unauthorized\`, and the \`catchTags\` keys match. Because the code catches both, \`E\` ends as \`never\`. The alternative that keeps the parent is \`catchReasons("ApiError", { ... })\`. Use \`unwrapReason\` when "which step failed" is no longer important and only "why" is important.`
    },
    {
      id: "error-management-c8",
      title: "Keep the reason",
      task: `The report must say *why* a lookup failed, but the program only knows *that* it failed. Change the way that the code captures the outcome, so that the second line prints \`lang: NotFound\`. Do not change \`get\`.`,
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
        "Effect.option changes a failure into None. Where did the NotFound value go?",
        "The table in lesson 5 has a function related to option that keeps the error. It uses the Result type.",
        "Use Effect.result, then Result.isSuccess(outcome) ? outcome.success : outcome.failure._tag."
      ],
      explanation: `\`Effect.option\` answers one question: did the effect succeed? It discards the error value. \`Effect.result\` keeps both sides as a \`Result<string, NotFound>\`. Thus the failure branch still has the typed error with its \`_tag\` and \`key\`. Use \`option\` when the reason is not important. Use \`result\` when the reason is important. Use \`exit\` when you also need to see defects and interrupts.`
    }
  ],
  problems: [
    {
      id: "error-management-p1",
      title: "Checkout pipeline",
      spec: `
Build a checkout with 2 steps and typed errors.

1. Define \`OutOfStock\` (field \`sku: string\`) and \`CardDeclined\` (field \`code: string\`) with \`Schema.TaggedError\`.
2. \`reserve(order)\` fails with \`OutOfStock\` when the \`sku\` of the order is \`"sku-9"\`. Otherwise it succeeds with the order.
3. \`charge(order)\` fails with \`CardDeclined\` with code \`"05"\` when \`order.total\` is more than \`100\`. Otherwise it succeeds with the string \`"receipt #" + order.id + " for " + order.total\`.
4. \`checkout(order)\` runs \`reserve\` and then \`charge\` with \`Effect.gen\`. Its type must be \`Effect<string, OutOfStock | CardDeclined>\`.
5. \`describe(order)\` catches both errors with \`catchTags\`, so its error type is \`never\`. \`OutOfStock\` becomes \`"out of stock: " + sku\`. \`CardDeclined\` becomes \`"card declined (code " + code + ")"\`.

Run \`describe\` on the 3 orders in the starter and print \`order.id + ": " + result\` for each order. Exact output:

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
        "Each step is a small function with an explicit return type: Effect.Effect<Order, OutOfStock> and Effect.Effect<string, CardDeclined>. Annotate them. The compiler then guides you.",
        "In checkout, yield* reserve first, then return yield* charge. Effect collects the error types of both steps into the union.",
        "catchTags takes an object whose keys are the tags. When both are caught, describe can have the annotation Effect.Effect<string, never>, and it compiles."
      ]
    },
    {
      id: "error-management-p2",
      title: "Config file inspector",
      spec: `
Classify every way in which a config load can end. Read the \`Exit\` to do this.

The starter gives you a fake file system \`files\` and a \`readFile(path)\` that already returns a typed effect. It fails with \`NotFound\` for unknown paths and with \`Forbidden\` for \`"secret.json"\`. Add:

1. \`parsePort(raw)\` uses \`Effect.sync\` with \`JSON.parse(raw)\` and returns \`.port\` as a \`number\`. A corrupt file makes \`JSON.parse\` throw. Keep this as a defect. It is a bug in the file, not an expected case.
2. \`load(path)\` reads and then parses, with \`Effect.gen\`.
3. \`inspect(path)\` captures the outcome with \`Effect.exit\` and prints one line. On success, print \`path + " -> ok port " + port\`. Otherwise, print one line for each reason in \`cause.reasons\`. For a \`Fail\`, print \`path + " -> failed: " + tag\`, where \`tag\` is the \`_tag\` of the error. For a \`Die\`, print \`path + " -> crashed: " + name\`, where \`name\` is the \`.name\` of the defect. The defect is an \`Error\`.

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
        "Effect.exit(load(path)) never fails. yield* it to get an Exit value, then branch with Exit.isSuccess.",
        "In the failure branch, loop over exit.cause.reasons. Each reason has a _tag of Fail, Die, or Interrupt. Branch on the tag.",
        "For a Fail reason, the type of reason.error is NotFound | Forbidden, so ._tag is available. For a Die, reason.defect is unknown. Cast it to Error to read .name."
      ]
    },
    {
      id: "error-management-p3",
      title: "Gateway status messages",
      spec: `
An API client fails with one \`ApiError\`. Its \`reason\` says what happened. Change each outcome into a message for the user.

1. Define 3 reasons with \`Schema.TaggedError\`: \`RateLimited\` (\`retryAfter: number\`), \`Unauthorized\` (\`scope: string\`), \`Maintenance\` (\`until: string\`). Define \`ApiError\` with a \`reason\` field that is a \`Schema.Union\` of the 3 reasons.
2. \`call(n)\` returns \`Effect<string, ApiError>\`. \`n = 1\` succeeds with \`"ok 200"\`. \`n = 2\` fails with \`RateLimited\` (retryAfter 30). \`n = 3\` fails with \`Unauthorized\` (scope \`"orders:read"\`). Any other \`n\` fails with \`Maintenance\` (until \`"06:00"\`).
3. \`message(n)\` uses \`Effect.catchReasons\`. It changes \`RateLimited\` into \`"wait " + retryAfter + "s"\` and \`Unauthorized\` into \`"need scope " + scope\`. The third argument catches any other reason and gives \`"try again after " + until\`. The error type of \`message\` must be \`never\`.

Print \`"call " + n + ": " + message\` for n from 1 to 4. Exact output:

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
        "Declare the reason field like any other schema field: reason: Schema.Union([RateLimited, Unauthorized, Maintenance]). Construct with new ApiError({ reason: new RateLimited({ retryAfter: 30 }) }).",
        "catchReasons takes the parent tag, an object with the reason tags as keys, and an optional third function for the other reasons. Each handler receives the reason, not the ApiError.",
        "With the third function present, the only reason left is Maintenance. Thus r.until is available in it, and E becomes never."
      ]
    }
  ],
  recall: [
    {
      q: "What is the difference between `Effect.fail` and `Effect.die`, and which catch functions see each one?",
      a: "`Effect.fail(e)` is an expected failure. `e` goes into the `E` type, and `catch`, `catchTag`, `catchTags`, `catchIf`, `match`, `result`, and `option` all see it. `Effect.die(x)` is a defect. An exception thrown inside `Effect.sync` is also a defect. A defect is not in the type. Only `catchDefect` and `catchCause` see it."
    },
    {
      q: "What is the type of `Effect.fail(new NotFound({ id: 1 })).pipe(Effect.catchTag(\"NotFound\", () => Effect.succeed(0)))`?",
      a: "`Effect<number, never, never>`. The original effect is `Effect<never, NotFound>`. The handler removes `NotFound` from `E` and adds `number` to `A`. Nothing is left in the error type."
    },
    {
      q: "You have `Effect<User, NotFound | Forbidden | Timeout>`. You want a different fallback for `NotFound` and for `Forbidden`, and you want to keep `Timeout` in `E`. Which function do you use?",
      a: "`Effect.catchTags({ NotFound: ..., Forbidden: ... })`. One handler for each tag, and `Timeout` stays in `E`. If both tags must get the same handler, `Effect.catchTag([\"NotFound\", \"Forbidden\"], ...)` is shorter."
    },
    {
      q: "Inside `Effect.gen`, why is `throw new NotFound({ id })` wrong, and what must you write in its place?",
      a: "`throw` makes a defect. The error leaves the type, and `catchTag` cannot see it. Write `yield* new NotFound({ id })` (usually `return yield* ...`). You can yield tagged errors, so this fails the effect with `NotFound` in `E`."
    },
    {
      q: "What does `cause.reasons` contain on a failed `Exit`, and what are the three tags?",
      a: "A flat array of reasons. Each reason has a `_tag`: `Fail` (with `.error`, the typed value), `Die` (with `.defect`, an `unknown`), or `Interrupt` (with `.fiberId`). In v4 there is no tree of sequential or parallel causes, only this array."
    },
    {
      q: "When do you use `Effect.unwrapReason` in place of `Effect.catchReasons`?",
      a: "`catchReasons` catches some reasons and keeps the parent error in `E` for the other reasons. `unwrapReason` replaces the parent with its reasons. Then `E` becomes the union of the reason types, and you continue with `catchTags` or any other function. Use it when the information \"which step failed\" is no longer necessary."
    },
    {
      q: "`Effect.result`, `Effect.option`, `Effect.exit`: which one shows a defect?",
      a: "Only `Effect.exit`. `result` and `option` capture typed failures only. A defect still fails the outer effect. `Exit` holds the full `Cause`, which includes `Die` and `Interrupt` reasons."
    },
    {
      q: "In `Effect.catchIf`, how does the result `E` change when you pass a type guard and not a plain boolean predicate?",
      a: "With a type guard `(e): e is HttpError => ...`, Effect removes `HttpError` from `E`. Use a guard only when it matches every value of that class. With a plain predicate, `E` does not change. This is correct when the handler recovers only some values (for example, status 500 and above)."
    }
  ]
}

export default section
