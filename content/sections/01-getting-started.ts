import type { Section } from "../types.ts"

const section: Section = {
  id: "getting-started",
  title: "Getting Started",
  order: 1,
  summary: "What an Effect is, how to read its type, how to build one, and how to run it.",
  intro: `
**The problem.** A plain TypeScript function hides three things from its caller. Look at this signature:

\`\`\`ts
async function loadUser(id: string): Promise<User>
\`\`\`

It says it returns a \`User\`. It does not say that it can throw \`NotFound\` or \`NetworkError\`. It does not say that it needs a database connection and a logger to work. And the moment you *call* it, it starts running, so you cannot retry it, time it out, or run two of them in parallel without extra wrapping code. The failure, the requirements, and the execution are all invisible.

### The shift

Today you think of a function as **something that does work when called**. Effect asks you to think of a program as **a value that describes work**. An \`Effect\` is a recipe, not a meal. You build the recipe, pass it around, combine it with other recipes, and only at the very end you hand it to a runtime that cooks it.

Because it is a value, its type can carry everything the plain function hid:

\`\`\`ts
Effect<Success, Error, Requirements>
Effect<User,    NotFound | NetworkError, Database | Logger>
\`\`\`

Read it as: "when run, this produces a \`User\`, or fails with one of these errors, and it needs these services to run." The compiler now checks all three. Forget to handle an error and it stays in the type. Forget to provide a service and the program will not compile.

The payoff shows up everywhere else in this course: retries, timeouts, concurrency, resource cleanup, and testing all become plain functions that take an Effect and return a new Effect, because an Effect is data.

| | Promise | Effect |
|---|---|---|
| Starts running | Immediately when created | Only when you call a \`run\` function |
| Error type | \`any\`, invisible | Tracked in the second type parameter |
| Dependencies | Hidden inside closures | Tracked in the third type parameter |
| Reusable | No, a Promise resolves once | Yes, run the same Effect as often as you like |
| Cancel | Not built in | Interruption built in |

In this section you will learn to create Effects, read their types, sequence them, and run them. Nothing else yet.
`,
  lessons: [
    {
      id: "getting-started-l1",
      title: "An Effect is a description, not an action",
      explain: `
The most important idea comes first. Creating an Effect does nothing. In plain TypeScript this line prints immediately:

\`\`\`ts
const p = new Promise<void>((resolve) => { console.log("hi"); resolve() })
// "hi" is already on the screen
\`\`\`

The Effect version below builds a description of "print hi" and stores it in a variable. Nothing prints until a \`run\` function is called. Because it is only a description, you can run it as many times as you want, and each run does the work again.
`,
      code: `import { Effect } from "effect"

// This builds a description. Nothing prints yet.
const sayHi = Effect.sync(() => console.log("hi"))

console.log("before running")

// Running the description does the work. Running twice does it twice.
Effect.runSync(sayHi)
Effect.runSync(sayHi)

console.log("after running")
`,
      expectedOutput: `before running
hi
hi
after running`,
      after: `Notice that "before running" comes first even though \`sayHi\` was created earlier. Try deleting both \`runSync\` lines: "hi" never appears. That is the recipe versus meal distinction.`
    },
    {
      id: "getting-started-l2",
      title: "Reading the type: Effect<A, E, R>",
      explain: `
Every Effect has three type parameters. Hover over the variables in a real editor and you would see:

| Constructor | Type | Meaning |
|---|---|---|
| \`Effect.succeed(42)\` | \`Effect<number, never, never>\` | Produces a number, cannot fail, needs nothing |
| \`Effect.fail("nope")\` | \`Effect<never, string, never>\` | Never produces a value, fails with a string |

\`never\` is TypeScript's "this cannot happen" type. When \`E\` is \`never\` you know, with the compiler's guarantee, that the effect cannot fail. When \`R\` is \`never\` it needs no services.

To see both outcomes without crashing, run with \`Effect.runSyncExit\`. It returns an \`Exit\`, a plain value that is either \`Success\` with a \`value\` or \`Failure\` with a \`cause\`. Later sections dig into \`Exit\` and \`Cause\`. For now, only the tag matters.
`,
      code: `import { Effect, Exit } from "effect"

const ok = Effect.succeed(42)              // Effect<number, never, never>
const bad = Effect.fail("no permission")   // Effect<never, string, never>

const exit1 = Effect.runSyncExit(ok)
const exit2 = Effect.runSyncExit(bad)

console.log(exit1._tag, Exit.isSuccess(exit1) ? exit1.value : "")
console.log(exit2._tag, Exit.isFailure(exit2) ? "it failed" : "")
`,
      expectedOutput: `Success 42
Failure it failed`,
      after: `Try running \`bad\` with plain \`Effect.runSync\` instead. The process throws, because \`runSync\` assumes success. \`runSyncExit\` is the version that never throws.`
    },
    {
      id: "getting-started-l3",
      title: "Sequencing steps with Effect.gen",
      explain: `
Most real programs are several steps in a row. Plain TypeScript uses \`async\`/\`await\`:

\`\`\`ts
async function main() {
  const user = await loadUser("1")
  const posts = await loadPosts(user.id)
  return posts.length
}
\`\`\`

Effect uses a generator function with \`yield*\` in exactly the same positions. \`Effect.gen\` takes a generator and produces one Effect that runs the steps in order. Where you would write \`await\` you write \`yield*\`. Where you would \`return\`, you still \`return\`, and that becomes the success value.

The whole generator is still only a description. Nothing inside runs until the outer Effect is run.
`,
      code: `import { Effect } from "effect"

// Two tiny "services" that just return data
const loadUser = (id: string) => Effect.succeed({ id, name: "Ada" })
const loadPosts = (userId: string) => Effect.succeed(["post-1", "post-2", "post-3"])

// Same shape as async/await, with yield* instead of await
const program = Effect.gen(function* () {
  const user = yield* loadUser("1")
  const posts = yield* loadPosts(user.id)
  console.log(user.name, "has", posts.length, "posts")
  return posts.length
})

const count = Effect.runSync(program)
console.log("returned:", count)
`,
      expectedOutput: `Ada has 3 posts
returned: 3`,
      after: `The \`return\` inside the generator became the value that \`runSync\` gave back. Try removing one \`yield*\`: TypeScript will complain, because now you are holding an Effect instead of a user.`
    },
    {
      id: "getting-started-l4",
      title: "Transforming with pipe: map, tap, andThen",
      explain: `
\`Effect.gen\` is for step-by-step logic. For small transformations, Effect also gives you a pipeline style, like array methods but for Effects.

| Function | What it does | Plain TS equivalent |
|---|---|---|
| \`Effect.map(f)\` | Change the success value | \`promise.then((x) => f(x))\` with a plain function |
| \`Effect.tap(f)\` | Run a side effect, keep the value | Logging inside \`.then\` and returning \`x\` again |
| \`Effect.andThen(f)\` | Chain into the next Effect | \`promise.then((x) => otherPromise(x))\` |

\`pipe\` reads top to bottom: the value on the left flows into each function in turn. Every step returns a new Effect, so the pipeline is still a description until you run it.
`,
      code: `import { Effect } from "effect"

const getPrice = Effect.succeed(100)

const program = getPrice.pipe(
  Effect.map((price) => price * 1.15),                        // add tax
  Effect.tap((total) => Effect.sync(() => console.log("total is", total))),
  Effect.andThen((total) => Effect.succeed("charged " + total)) // chain into another Effect
)

console.log(Effect.runSync(program))
`,
      expectedOutput: `total is 114.99999999999999
charged 114.99999999999999`,
      after: `\`tap\` did not change the value, it only looked at it. If you replace \`tap\` with \`map\` the pipeline would carry \`undefined\` forward, because \`console.log\` returns nothing. That is the difference between the two.`
    },
    {
      id: "getting-started-l5",
      title: "Bringing in code that can throw or is async",
      explain: `
Real code calls \`JSON.parse\`, \`fetch\`, and other things that throw or return Promises. Effect gives one constructor per situation. Choosing the right one is what makes errors visible in the type.

| Your code is... | Use | Error type becomes |
|---|---|---|
| Sync, cannot throw | \`Effect.sync(() => ...)\` | \`never\` |
| Sync, may throw | \`Effect.try({ try, catch })\` | Whatever \`catch\` returns |
| Async, cannot reject | \`Effect.promise(() => ...)\` | \`never\` |
| Async, may reject | \`Effect.tryPromise({ try, catch })\` | Whatever \`catch\` returns |

The \`catch\` function receives the thrown value as \`unknown\` and you turn it into something typed. In this example both errors become plain strings. Later, in Error Management, you will use tagged error classes instead.
`,
      code: `import { Effect } from "effect"

// A sync operation that can throw, made safe and typed
const parseJson = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as { port: number },
    catch: () => "invalid json"          // Effect<{ port: number }, string>
  })

// A fake async API that rejects for unknown ids
const fakeFetch = (id: number): Promise<string> =>
  id === 1 ? Promise.resolve("Ada") : Promise.reject(new Error("404"))

const fetchName = (id: number) =>
  Effect.tryPromise({
    try: () => fakeFetch(id),
    catch: () => "user " + id + " not found"   // Effect<string, string>
  })

const program = Effect.gen(function* () {
  const config = yield* parseJson('{"port": 8080}')
  const name = yield* fetchName(1)
  console.log("port", config.port, "user", name)
})

Effect.runPromise(program)
`,
      expectedOutput: `port 8080 user Ada`,
      after: `Change \`fetchName(1)\` to \`fetchName(2)\`. The program fails with the string "user 2 not found" and \`runPromise\` rejects. Nothing crashed unexpectedly, the failure was described in the type all along.`
    },
    {
      id: "getting-started-l6",
      title: "Running: runSync, runPromise, and the Exit variants",
      explain: `
An Effect only runs at the edge of your program, when you hand it to a runner. Pick the runner based on two questions: is the work synchronous, and do you want failures to throw?

| Runner | Async allowed? | On failure |
|---|---|---|
| \`Effect.runSync\` | No, throws if it hits async work | Throws |
| \`Effect.runSyncExit\` | No | Returns \`Exit.Failure\` |
| \`Effect.runPromise\` | Yes | Rejects the Promise |
| \`Effect.runPromiseExit\` | Yes | Resolves with \`Exit.Failure\` |

A good habit: keep one \`run\` call at the very top of your app, and everything under it stays as composable descriptions. Many small \`runSync\` calls sprinkled through the code is a sign that you are fighting the model.
`,
      code: `import { Effect, Exit } from "effect"

const syncWork = Effect.succeed("sync result")
const asyncWork = Effect.promise(() => new Promise<string>((resolve) => setTimeout(() => resolve("async result"), 10)))
const failing = Effect.fail("boom")

const main = async () => {
  console.log(Effect.runSync(syncWork))
  console.log(await Effect.runPromise(asyncWork))

  const exit = await Effect.runPromiseExit(failing)
  console.log(Exit.isFailure(exit) ? "handled failure without throwing" : "unexpected")

  try {
    Effect.runSync(asyncWork)   // async inside runSync is not allowed
  } catch (e) {
    console.log("runSync refused async work")
  }
}

main()
`,
      expectedOutput: `sync result
async result
handled failure without throwing
runSync refused async work`,
      after: `The last case is a common first-day mistake. If an effect contains any async step, \`runSync\` throws. When in doubt use \`runPromise\`.`
    }
  ],
  challenges: [
    {
      id: "getting-started-c1",
      title: "The forgotten yield*",
      task: `This program should print \`2\`, but it does not compile. Fix it without changing the console.log line.`,
      code: `import { Effect } from "effect"

const program = Effect.gen(function* () {
  const n = Effect.succeed(1)
  console.log(n + 1)
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const program = Effect.gen(function* () {
  const n = yield* Effect.succeed(1)
  console.log(n + 1)
})

Effect.runSync(program)
`,
      expectedOutput: `2`,
      hints: [
        "Read the type error carefully: what type is n?",
        "Inside Effect.gen, an Effect is unwrapped with a keyword, like await for Promises.",
        "Put yield* in front of Effect.succeed(1)."
      ],
      explanation: `Without \`yield*\`, \`n\` is the Effect itself, a description, not the number inside it. The type checker caught it because \`Effect + number\` makes no sense. In plain JavaScript this would have printed \`[object Object]1\` at runtime. Effect moved the bug from runtime to compile time.`
    },
    {
      id: "getting-started-c2",
      title: "Nothing happens",
      task: `The program is correct but prints nothing. Make it print \`hello from effect\`.`,
      code: `import { Effect } from "effect"

const program = Effect.sync(() => console.log("hello from effect"))

program
`,
      solution: `import { Effect } from "effect"

const program = Effect.sync(() => console.log("hello from effect"))

Effect.runSync(program)
`,
      expectedOutput: `hello from effect`,
      hints: [
        "An Effect is a recipe. Who cooks it?",
        "Look at lesson 1: something has to be called with the program as argument.",
        "Replace the last line with Effect.runSync(program)."
      ],
      explanation: `Referencing \`program\` on its own line does nothing, the same way writing the name of a function without calling it does nothing. An Effect must be handed to a runner such as \`runSync\` or \`runPromise\`. This is the number one thing that surprises people coming from Promises, which run as soon as they are created.`
    },
    {
      id: "getting-started-c3",
      title: "A throw in the wrong constructor",
      task: `\`JSON.parse\` throws on bad input. Right now that throw is treated as a bug (a defect) and the raw \`SyntaxError\` leaks out. Change only the constructor used for parsing so the failure becomes the typed error \`"invalid json"\` and the program prints \`error: invalid json\`.`,
      code: `import { Cause, Effect, Exit } from "effect"

const parse = (raw: string) =>
  Effect.sync(() => JSON.parse(raw) as { name: string })

const exit = Effect.runSyncExit(parse("{ not json"))

if (Exit.isFailure(exit)) {
  console.log("error:", Cause.squash(exit.cause))
} else {
  console.log("parsed", exit.value.name)
}
`,
      solution: `import { Cause, Effect, Exit } from "effect"

const parse = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as { name: string },
    catch: () => "invalid json"
  })

const exit = Effect.runSyncExit(parse("{ not json"))

if (Exit.isFailure(exit)) {
  console.log("error:", Cause.squash(exit.cause))
} else {
  console.log("parsed", exit.value.name)
}
`,
      expectedOutput: `error: invalid json`,
      hints: [
        "Effect.sync promises that the function cannot throw. JSON.parse breaks that promise.",
        "Lesson 5 has a table: which constructor is for sync code that may throw?",
        "Use Effect.try({ try: () => JSON.parse(raw) as { name: string }, catch: () => \"invalid json\" })."
      ],
      explanation: `\`Effect.sync\` is a contract: "this will not throw." When it does anyway, Effect treats it as a defect, an unexpected bug. \`runSyncExit\` still gives a Failure, but the error type stayed \`never\` and the raw \`SyntaxError\` leaked out. \`Effect.try\` expects the throw and lets you turn it into a typed value with \`catch\`, so it becomes an expected error of type \`string\` that callers can see and handle. Error Management goes deep on this failure versus defect split.`
    },
    {
      id: "getting-started-c4",
      title: "Wrong runner",
      task: `The program contains async work, and it crashes when run. Change the runner so it prints \`done after 5ms\`.`,
      code: `import { Effect } from "effect"

const wait = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))

const program = Effect.gen(function* () {
  yield* wait
  console.log("done after 5ms")
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const wait = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))

const program = Effect.gen(function* () {
  yield* wait
  console.log("done after 5ms")
})

Effect.runPromise(program)
`,
      expectedOutput: `done after 5ms`,
      hints: [
        "Read the error message that the crash prints.",
        "Lesson 6 has a table of runners. Which one allows async?",
        "Replace Effect.runSync with Effect.runPromise."
      ],
      explanation: `\`runSync\` must finish before it returns, so if the effect suspends on a Promise or a timer there is nothing it can do except throw. \`runPromise\` returns a Promise and waits for async work. Rule of thumb: \`runPromise\` at the top of an app, \`runSync\` only for code you know is synchronous, such as tests of pure logic.`
    },
    {
      id: "getting-started-c5",
      title: "map or andThen?",
      task: `The pipeline should double the number and print \`20\`, but it prints something strange. Fix the pipeline so the doubled value is a plain number.`,
      code: `import { Effect } from "effect"

const double = (n: number) => Effect.succeed(n * 2)

const program = Effect.succeed(10).pipe(
  Effect.map((n) => double(n)),
  Effect.map((result) => console.log(String(result)))
)

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const double = (n: number) => Effect.succeed(n * 2)

const program = Effect.succeed(10).pipe(
  Effect.andThen((n) => double(n)),
  Effect.map((result) => console.log(String(result)))
)

Effect.runSync(program)
`,
      expectedOutput: `20`,
      hints: [
        "What does double return: a number or an Effect of a number?",
        "map wraps whatever the function returns. If the function already returns an Effect you get an Effect inside an Effect.",
        "Use Effect.andThen (or Effect.flatMap) for the first step."
      ],
      explanation: `\`map\` is for plain functions: it takes the value out, applies the function, puts the result back in. \`double\` already returns an Effect, so \`map\` produced \`Effect<Effect<number>>\` and the second step printed the inner Effect object. \`andThen\` (and its stricter sibling \`flatMap\`) is for functions that return Effects, and it flattens the nesting. This is exactly the \`then\` behavior you get for free with Promises, made explicit.`
    },
    {
      id: "getting-started-c6",
      title: "The type annotation that lies",
      task: `\`parseAge\` claims it cannot fail, but its body can. Fix the return type annotation so the code compiles and prints the two lines below. Do not remove the \`Effect.fail\`.`,
      code: `import { Effect, Exit } from "effect"

const parseAge = (input: string): Effect.Effect<number> => {
  const n = Number(input)
  return Number.isNaN(n) ? Effect.fail("not a number: " + input) : Effect.succeed(n)
}

for (const input of ["30", "abc"]) {
  const exit = Effect.runSyncExit(parseAge(input))
  console.log(Exit.isSuccess(exit) ? "age " + exit.value : "rejected " + input)
}
`,
      solution: `import { Effect, Exit } from "effect"

const parseAge = (input: string): Effect.Effect<number, string> => {
  const n = Number(input)
  return Number.isNaN(n) ? Effect.fail("not a number: " + input) : Effect.succeed(n)
}

for (const input of ["30", "abc"]) {
  const exit = Effect.runSyncExit(parseAge(input))
  console.log(Exit.isSuccess(exit) ? "age " + exit.value : "rejected " + input)
}
`,
      expectedOutput: `age 30
rejected abc`,
      hints: [
        "Effect<number> is short for Effect<number, never, never>. What does never in the error slot promise?",
        "Effect.fail(\"...\") produces an error of type string. The annotation needs to admit that.",
        "Change the return type to Effect.Effect<number, string>."
      ],
      explanation: `\`Effect.Effect<number>\` means "cannot fail." The body returns \`Effect.fail\` with a string, so the compiler refuses the lie. Widening the annotation to \`Effect.Effect<number, string>\` tells every caller, at the type level, that this can fail with a string. In plain TypeScript the same function would have used \`throw\` and the signature would have said nothing. This is the whole point of the \`E\` parameter.`
    }
  ],
  problems: [
    {
      id: "getting-started-p1",
      title: "Safe division",
      spec: `
Write \`divide(a, b)\` that returns an Effect. It fails with the string \`"division by zero"\` when \`b\` is \`0\`, and succeeds with \`a / b\` otherwise. Then loop over the pairs \`[10, 2]\`, \`[7, 0]\`, \`[9, 3]\`, run each with \`Effect.runSyncExit\`, and print one line per pair in this exact format:

\`\`\`
10 / 2 = 5
7 / 0 failed: division by zero
9 / 3 = 3
\`\`\`

To read the error out of a failed Exit, use \`Cause.squash(exit.cause)\`, which returns the failure value.
`,
      starter: `import { Cause, Effect, Exit } from "effect"

// TODO: divide returns Effect<number, string>
const divide = (a: number, b: number) => {
  throw new Error("TODO")
}

const pairs: Array<[number, number]> = [[10, 2], [7, 0], [9, 3]]

for (const [a, b] of pairs) {
  // TODO: run divide(a, b) with Effect.runSyncExit and print the result
}
`,
      solution: `import { Cause, Effect, Exit } from "effect"

const divide = (a: number, b: number): Effect.Effect<number, string> =>
  b === 0 ? Effect.fail("division by zero") : Effect.succeed(a / b)

const pairs: Array<[number, number]> = [[10, 2], [7, 0], [9, 3]]

for (const [a, b] of pairs) {
  const exit = Effect.runSyncExit(divide(a, b))
  if (Exit.isSuccess(exit)) {
    console.log(a + " / " + b + " = " + exit.value)
  } else {
    console.log(a + " / " + b + " failed: " + Cause.squash(exit.cause))
  }
}
`,
      expectedOutput: `10 / 2 = 5
7 / 0 failed: division by zero
9 / 3 = 3`,
      hints: [
        "Effect.fail and Effect.succeed both build Effects. Choose between them with a ternary.",
        "Exit.isSuccess(exit) narrows the type so exit.value is available; in the else branch exit.cause is.",
        "Cause.squash(exit.cause) gives you back the string you passed to Effect.fail."
      ]
    },
    {
      id: "getting-started-p2",
      title: "Config loader pipeline",
      spec: `
You have a raw config string and need a validated port number. Build it as three small Effects and one \`Effect.gen\` that combines them:

1. \`parse(raw)\` uses \`Effect.try\` to parse JSON into \`{ port: unknown }\`, failing with \`"bad json"\`.
2. \`toNumber(value)\` succeeds with the value if it is a \`number\`, otherwise fails with \`"port is not a number"\`.
3. \`inRange(port)\` succeeds if \`1 <= port <= 65535\`, otherwise fails with \`"port out of range"\`.

\`loadPort(raw)\` chains them with \`Effect.gen\` and returns the port. Run it on the three inputs below with \`Effect.runSyncExit\` and print exactly:

\`\`\`
ok 8080
error port out of range
error bad json
\`\`\`

Inputs, in order: \`'{"port": 8080}'\`, \`'{"port": 70000}'\`, \`'not json'\`.
`,
      starter: `import { Cause, Effect, Exit } from "effect"

// TODO: parse, toNumber, inRange

const loadPort = (raw: string) =>
  Effect.gen(function* () {
    // TODO: chain the three steps and return the port
    return 0
  })

const inputs = ['{"port": 8080}', '{"port": 70000}', "not json"]

for (const raw of inputs) {
  const exit = Effect.runSyncExit(loadPort(raw))
  // TODO: print "ok <port>" or "error <message>"
}
`,
      solution: `import { Cause, Effect, Exit } from "effect"

const parse = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as { port: unknown },
    catch: () => "bad json"
  })

const toNumber = (value: unknown): Effect.Effect<number, string> =>
  typeof value === "number" ? Effect.succeed(value) : Effect.fail("port is not a number")

const inRange = (port: number): Effect.Effect<number, string> =>
  port >= 1 && port <= 65535 ? Effect.succeed(port) : Effect.fail("port out of range")

const loadPort = (raw: string) =>
  Effect.gen(function* () {
    const config = yield* parse(raw)
    const port = yield* toNumber(config.port)
    return yield* inRange(port)
  })

const inputs = ['{"port": 8080}', '{"port": 70000}', "not json"]

for (const raw of inputs) {
  const exit = Effect.runSyncExit(loadPort(raw))
  if (Exit.isSuccess(exit)) {
    console.log("ok " + exit.value)
  } else {
    console.log("error " + Cause.squash(exit.cause))
  }
}
`,
      expectedOutput: `ok 8080
error port out of range
error bad json`,
      hints: [
        "Each step is a function that returns an Effect<number, string>. Annotate the return types, it makes the errors obvious.",
        "In the generator, yield* each step in order. The first failure stops the rest, which is what you want.",
        "The error union for loadPort is just string, so Cause.squash gives you the message directly."
      ]
    },
    {
      id: "getting-started-p3",
      title: "Fake API client",
      spec: `
Wrap a Promise-based API in Effect. The API is given: \`api.getUser(id)\` resolves with a user for ids 1 and 2 and rejects otherwise.

Write \`getUser(id)\` using \`Effect.tryPromise\` so a rejection becomes the typed error \`"user <id> not found"\`. Then write \`program\` with \`Effect.gen\` that fetches users 1 and 2, prints their names on one line as \`Ada & Lin\`, then tries user 3 and prints the error. Fetch user 3 with \`Effect.runPromiseExit\` and \`Cause.squash\` to get the message. Exact output:

\`\`\`
Ada & Lin
user 3 not found
\`\`\`
`,
      starter: `import { Cause, Effect, Exit } from "effect"

const api = {
  getUser: (id: number): Promise<{ id: number; name: string }> => {
    const users: Record<number, string> = { 1: "Ada", 2: "Lin" }
    return id in users ? Promise.resolve({ id, name: users[id]! }) : Promise.reject(new Error("404"))
  }
}

// TODO: getUser(id) with Effect.tryPromise

const program = Effect.gen(function* () {
  // TODO: fetch users 1 and 2, print "Ada & Lin"
  // TODO: run getUser(3) via Effect.runPromiseExit and print the error message
})

Effect.runPromise(program)
`,
      solution: `import { Cause, Effect, Exit } from "effect"

const api = {
  getUser: (id: number): Promise<{ id: number; name: string }> => {
    const users: Record<number, string> = { 1: "Ada", 2: "Lin" }
    return id in users ? Promise.resolve({ id, name: users[id]! }) : Promise.reject(new Error("404"))
  }
}

const getUser = (id: number) =>
  Effect.tryPromise({
    try: () => api.getUser(id),
    catch: () => "user " + id + " not found"
  })

const program = Effect.gen(function* () {
  const a = yield* getUser(1)
  const b = yield* getUser(2)
  console.log(a.name + " & " + b.name)

  const exit = yield* Effect.promise(() => Effect.runPromiseExit(getUser(3)))
  if (Exit.isFailure(exit)) {
    console.log(Cause.squash(exit.cause))
  }
})

Effect.runPromise(program)
`,
      expectedOutput: `Ada & Lin
user 3 not found`,
      hints: [
        "Effect.tryPromise takes { try: () => promise, catch: (unknown) => error }.",
        "Inside the generator you can yield* getUser(1) and getUser(2) like normal steps.",
        "For user 3, Effect.runPromiseExit returns a Promise of an Exit; wrap that Promise with Effect.promise to yield* it. Error Management will show a cleaner way."
      ]
    }
  ],
  recall: [
    {
      q: "What happens when you create an Effect but never run it?",
      a: "Nothing. An Effect is a description of work, like a recipe. Only a runner such as `runSync` or `runPromise` performs it. Creating a Promise, by contrast, starts the work immediately."
    },
    {
      q: "What would the type of `Effect.fail(new Error(\"x\"))` be?",
      a: "`Effect<never, Error, never>`. It never produces a success value, fails with an `Error`, and needs no services."
    },
    {
      q: "In `Effect<A, E, R>`, what does `R = never` mean?",
      a: "The effect needs no services from the outside to run. Requirements Management is where `R` stops being `never`."
    },
    {
      q: "Which constructor would you reach for to wrap `fs.readFileSync`, which can throw?",
      a: "`Effect.try({ try, catch })`. It is synchronous and may throw. `Effect.sync` is only for code that cannot throw; a throw inside it becomes a defect instead of a typed error."
    },
    {
      q: "What is the difference between `Effect.map` and `Effect.andThen`?",
      a: "`map` takes a plain function and wraps its return value. `andThen` (or `flatMap`) takes a function that returns an Effect and flattens it, so you do not end up with an Effect inside an Effect."
    },
    {
      q: "When does `Effect.runSync` throw?",
      a: "When the effect fails, or when it contains async work such as a Promise or a timer. Use `runSyncExit` to get a value instead of a throw, and `runPromise` when there is any async work."
    },
    {
      q: "Inside `Effect.gen`, what is the equivalent of `await`?",
      a: "`yield*`. It unwraps the success value of an Effect and stops the generator early if the Effect fails."
    }
  ]
}

export default section
