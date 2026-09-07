import type { Section } from "../types.ts"

const section: Section = {
  id: "getting-started",
  title: "Getting Started",
  order: 1,
  summary: "What an Effect is, how to read its type, how to build one, and how to run it.",
  intro: `
**The problem.** A plain TypeScript function hides 3 facts from its caller. Look at this signature:

\`\`\`ts
async function loadUser(id: string): Promise<User>
\`\`\`

The signature says that the function returns a \`User\`. It does not say that the function can throw \`NotFound\` or \`NetworkError\`. It does not say that the function needs a database connection and a logger. Also, the function starts to run when you call it. Thus you cannot retry it, apply a timeout to it, or run 2 of them in parallel without extra code. The failure, the requirements, and the start of the work are all hidden.

### The shift

Today you think of a function as **code that does work when you call it**. In Effect, a program is **a value that describes work**. The value does not do the work. You build the value, you combine it with other values, and at the end you give it to the runtime. The runtime does the work.

Because an effect is a value, its type can show all the facts that the plain function hid:

\`\`\`ts
Effect<Success, Error, Requirements>
Effect<User,    NotFound | NetworkError, Database | Logger>
\`\`\`

Read the type as follows: "When you run this effect, it gives a \`User\`, or it fails with one of these errors, and it needs these services." The compiler checks all 3 parts. If you do not catch an error, the error stays in the type. If you do not provide a service, the program does not compile.

This design has a benefit in all other sections of this course. Retries, timeouts, concurrency, resource cleanup, and tests all become plain functions. Each function takes an effect and returns a new effect, because an effect is data.

| | Promise | Effect |
|---|---|---|
| Starts to run | Immediately when you create it | Only when you call a \`run\` function |
| Error type | \`any\`, not visible | The second type parameter holds it |
| Dependencies | Hidden inside closures | The third type parameter holds them |
| Reusable | No, a Promise resolves 1 time | Yes, you can run the same effect many times |
| Cancel | Not built in | Interrupt is built in |

In this section you learn to create effects, read their types, put them in sequence, and run them. Nothing more.
`,
  lessons: [
    {
      id: "getting-started-l1",
      title: "An Effect is a description, not an action",
      explain: `
The most important idea comes first. When you create an effect, nothing happens. In plain TypeScript this line prints immediately:

\`\`\`ts
const p = new Promise<void>((resolve) => { console.log("hi"); resolve() })
// "hi" is already on the screen
\`\`\`

The Effect version below builds a description of "print hi" and puts it in a variable. Nothing prints until you call a \`run\` function. Because the effect is only a description, you can run it many times. Each run does the work again.
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
      after: `Notice that "before running" prints first, although the code created \`sayHi\` before it. Delete both \`runSync\` lines: "hi" does not print. The description does not do the work. The run function does the work.`
    },
    {
      id: "getting-started-l2",
      title: "Reading the type: Effect<A, E, R>",
      explain: `
Every effect has 3 type parameters. If you hover over the variables in a real editor, you see these types:

| Constructor | Type | Meaning |
|---|---|---|
| \`Effect.succeed(42)\` | \`Effect<number, never, never>\` | Gives a number, cannot fail, needs no services |
| \`Effect.fail("nope")\` | \`Effect<never, string, never>\` | Gives no value, fails with a string, needs no services |

\`never\` is the TypeScript type for "this cannot happen". When \`E\` is \`never\`, the compiler guarantees that the effect cannot fail. When \`R\` is \`never\`, the effect needs no services.

To see both outcomes without a crash, run the effect with \`Effect.runSyncExit\`. This function returns an \`Exit\`. An \`Exit\` is a plain value. It is a \`Success\` with a \`value\`, or a \`Failure\` with a \`cause\`. Later sections explain \`Exit\` and \`Cause\` in detail. For now, only the tag is important.
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
      after: `Run \`bad\` with \`Effect.runSync\` in place of \`runSyncExit\`. The process throws, because \`runSync\` expects success. \`runSyncExit\` never throws.`
    },
    {
      id: "getting-started-l3",
      title: "Sequencing steps with Effect.gen",
      explain: `
Most real programs have several steps in sequence. Plain TypeScript uses \`async\`/\`await\`:

\`\`\`ts
async function main() {
  const user = await loadUser("1")
  const posts = await loadPosts(user.id)
  return posts.length
}
\`\`\`

Effect uses a generator function with \`yield*\` in the same positions. \`Effect.gen\` takes a generator and gives one effect. This effect runs the steps in order. Where you write \`await\` in plain TypeScript, you write \`yield*\`. Where you write \`return\`, you still write \`return\`. The returned value becomes the success value.

The whole generator is still only a description. Nothing inside it runs until you run the outer effect.
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
      after: `The \`return\` inside the generator became the value that \`runSync\` gave back. Remove one \`yield*\`: TypeScript reports an error, because the variable now holds an effect and not a user.`
    },
    {
      id: "getting-started-l4",
      title: "Transforming with pipe: map, tap, andThen",
      explain: `
\`Effect.gen\` is for step-by-step logic. For small transformations, Effect also gives a pipeline style. This style is similar to array methods, but for effects.

| Function | What it does | Plain TS equivalent |
|---|---|---|
| \`Effect.map(f)\` | Changes the success value | \`promise.then((x) => f(x))\` with a plain function |
| \`Effect.tap(f)\` | Runs a side effect and keeps the value | A log call inside \`.then\` that returns \`x\` again |
| \`Effect.andThen(f)\` | Continues with the next effect | \`promise.then((x) => otherPromise(x))\` |

Read a \`pipe\` from top to bottom. The value on the left goes into each function in turn. Each step returns a new effect. Thus the pipeline is still a description until you run it.
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
      after: `\`tap\` did not change the value. It only read the value. If you replace \`tap\` with \`map\`, the pipeline carries \`undefined\` forward, because \`console.log\` returns nothing. This is the difference between the 2 functions.`
    },
    {
      id: "getting-started-l5",
      title: "Bringing in code that can throw or is async",
      explain: `
Real code calls \`JSON.parse\`, \`fetch\`, and other functions that throw or return Promises. Effect gives one constructor for each situation. When you select the correct constructor, the error becomes visible in the type.

| Your code is... | Use | Error type becomes |
|---|---|---|
| Sync, cannot throw | \`Effect.sync(() => ...)\` | \`never\` |
| Sync, can throw | \`Effect.try({ try, catch })\` | The return type of \`catch\` |
| Async, cannot reject | \`Effect.promise(() => ...)\` | \`never\` |
| Async, can reject | \`Effect.tryPromise({ try, catch })\` | The return type of \`catch\` |

The \`catch\` function receives the thrown value as \`unknown\`. You change this value into a typed value. In this example, both errors become plain strings. In the Error Management section, you use tagged error classes in place of strings.
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
      after: `Change \`fetchName(1)\` to \`fetchName(2)\`. The program fails with the string "user 2 not found", and \`runPromise\` rejects. This is not an unexpected crash. The type described this failure from the start.`
    },
    {
      id: "getting-started-l6",
      title: "Running: runSync, runPromise, and the Exit variants",
      explain: `
An effect runs only at the edge of your program, when you give it to a runner. Select the runner with 2 questions. Is the work synchronous? Do you want a failure to throw?

| Runner | Async permitted? | On failure |
|---|---|---|
| \`Effect.runSync\` | No, it throws when it finds async work | Throws |
| \`Effect.runSyncExit\` | No | Returns \`Exit.Failure\` |
| \`Effect.runPromise\` | Yes | Rejects the Promise |
| \`Effect.runPromiseExit\` | Yes | Resolves with \`Exit.Failure\` |

Keep one \`run\` call at the top of your application. All code below this call stays a description, and you can combine it with other descriptions. Note: many small \`runSync\` calls in the code are a sign that the code does not use effects as values.
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
      after: `The last case is a common mistake on the first day. If an effect contains an async step, \`runSync\` throws. If you are not sure, use \`runPromise\`.`
    }
  ],
  dosAndDonts: [
    {
      do: "Give every effect to one runner at the top of the application.",
      dont: "Do not call `Effect.runSync` inside functions that build effects.",
      why: "An effect that runs early is no longer a value, so you cannot combine it, retry it, or test it."
    },
    {
      do: "Use `Effect.try` for synchronous code that can throw.",
      dont: "Do not put code that can throw inside `Effect.sync`.",
      why: "A throw inside `Effect.sync` becomes a defect with no type, and `Effect.catch` cannot see it."
    },
    {
      do: "Use `Effect.tryPromise` for a Promise that can reject.",
      dont: "Do not wrap a Promise that can reject in `Effect.promise`.",
      why: "`Effect.promise` declares that the Promise cannot reject, so a rejection becomes a defect and `E` stays `never`."
    },
    {
      do: "Write `yield*` in front of every effect inside `Effect.gen`.",
      dont: "Do not assign an effect to a variable and then use it as a plain value.",
      why: "Without `yield*`, the variable holds the effect itself, and the code does not compile or prints an object."
    },
    {
      do: "Use `Effect.andThen` (or `Effect.flatMap`) when the function returns an effect.",
      dont: "Do not use `Effect.map` with a function that returns an effect.",
      why: "`Effect.map` wraps the return value, so you get an effect inside an effect and the next step sees an object."
    },
    {
      do: "Use `Effect.runPromise` when the effect contains async work.",
      dont: "Do not use `Effect.runSync` on an effect that waits for a Promise or a timer.",
      why: "`Effect.runSync` must complete before it returns, so it throws when it finds async work."
    },
    {
      do: "Declare the error type in the return annotation, for example `Effect.Effect<number, string>`.",
      dont: "Do not annotate a function as `Effect.Effect<number>` when its body calls `Effect.fail`.",
      why: "`Effect.Effect<number>` means `E` is `never`, so the compiler rejects the `Effect.fail` in the body."
    }
  ],
  challenges: [
    {
      id: "getting-started-c1",
      title: "The forgotten yield*",
      task: `This program must print \`2\`, but it does not compile. Correct it. Do not change the console.log line.`,
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
        "Read the type error. What is the type of n?",
        "Inside Effect.gen, a keyword unwraps an effect. This keyword is similar to await for Promises.",
        "Put yield* in front of Effect.succeed(1)."
      ],
      explanation: `Without \`yield*\`, \`n\` is the effect itself. It is a description, not the number inside the description. The type checker found the error, because \`Effect + number\` is not valid. In plain JavaScript, this code prints \`[object Object]1\` at run time. Effect moved the bug from run time to compile time.`
    },
    {
      id: "getting-started-c2",
      title: "Nothing happens",
      task: `The program is correct, but it prints nothing. Make it print \`hello from effect\`.`,
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
        "An effect is a description of work. What does the work?",
        "Look at lesson 1. You must call a function with the program as the argument.",
        "Replace the last line with Effect.runSync(program)."
      ],
      explanation: `The line \`program\` on its own does nothing. A function name without a call also does nothing. You must give an effect to a runner such as \`runSync\` or \`runPromise\`. This is the most common surprise for people who come from Promises. A Promise starts to run when you create it.`
    },
    {
      id: "getting-started-c3",
      title: "A throw in the wrong constructor",
      task: `\`JSON.parse\` throws on bad input. At the moment, Effect treats this throw as a bug (a defect), and the raw \`SyntaxError\` comes out. Change only the constructor for the parse step. The failure must become the typed error \`"invalid json"\`, and the program must print \`error: invalid json\`.`,
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
        "Effect.sync is a contract that the function cannot throw. JSON.parse breaks this contract.",
        "Lesson 5 has a table. Which constructor is for sync code that can throw?",
        "Use Effect.try({ try: () => JSON.parse(raw) as { name: string }, catch: () => \"invalid json\" })."
      ],
      explanation: `\`Effect.sync\` is a contract: the function does not throw. When the function throws, Effect treats the throw as a defect. A defect is an unexpected bug. \`runSyncExit\` still gives a \`Failure\`, but the error type stays \`never\`, and the raw \`SyntaxError\` comes out. \`Effect.try\` expects the throw. Its \`catch\` function changes the thrown value into a typed value. The result is an expected failure of type \`string\`. Callers see this failure in the type and can catch it. The Error Management section explains the difference between a failure and a defect in detail.`
    },
    {
      id: "getting-started-c4",
      title: "Wrong runner",
      task: `The program contains async work, and it crashes when it runs. Change the runner so that the program prints \`done after 5ms\`.`,
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
        "Lesson 6 has a table of runners. Which runner permits async work?",
        "Replace Effect.runSync with Effect.runPromise."
      ],
      explanation: `\`runSync\` must complete before it returns. If the effect waits for a Promise or a timer, \`runSync\` can only throw. \`runPromise\` returns a Promise and waits for the async work. Rule: use \`runPromise\` at the top of an application. Use \`runSync\` only for code that you know is synchronous, for example tests of pure logic.`
    },
    {
      id: "getting-started-c5",
      title: "map or andThen?",
      task: `The pipeline must double the number and print \`20\`, but it prints an unexpected value. Correct the pipeline so that the doubled value is a plain number.`,
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
        "What does double return: a number, or an effect of a number?",
        "map wraps the return value of the function. If the function already returns an effect, you get an effect inside an effect.",
        "Use Effect.andThen (or Effect.flatMap) for the first step."
      ],
      explanation: `\`map\` is for plain functions. It takes the value out, applies the function, and puts the result back in. \`double\` already returns an effect. Thus \`map\` produced \`Effect<Effect<number>>\`, and the second step printed the inner effect object. \`andThen\` (and its stricter variant \`flatMap\`) is for functions that return effects. It removes the nested layer. Promises do this automatically in \`then\`. Effect makes the 2 cases explicit.`
    },
    {
      id: "getting-started-c6",
      title: "The type annotation that lies",
      task: `\`parseAge\` has a return type that says it cannot fail, but its body can fail. Correct the return type annotation so that the code compiles and prints the 2 lines below. Do not remove the \`Effect.fail\`.`,
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
        "Effect<number> is short for Effect<number, never, never>. What does never in the error slot mean?",
        "Effect.fail(\"...\") produces an error of type string. The annotation must include this type.",
        "Change the return type to Effect.Effect<number, string>."
      ],
      explanation: `\`Effect.Effect<number>\` means "cannot fail". The body returns \`Effect.fail\` with a string, so the compiler rejects the annotation. The wider annotation \`Effect.Effect<number, string>\` tells every caller, in the type, that this function can fail with a string. In plain TypeScript, the same function uses \`throw\`, and the signature says nothing. This is the purpose of the \`E\` parameter.`
    }
  ],
  problems: [
    {
      id: "getting-started-p1",
      title: "Safe division",
      spec: `
Write \`divide(a, b)\` that returns an effect. The effect fails with the string \`"division by zero"\` when \`b\` is \`0\`. Otherwise it succeeds with \`a / b\`. Then loop over the pairs \`[10, 2]\`, \`[7, 0]\`, \`[9, 3]\`. Run each pair with \`Effect.runSyncExit\` and print one line per pair in this exact format:

\`\`\`
10 / 2 = 5
7 / 0 failed: division by zero
9 / 3 = 3
\`\`\`

To read the error out of a failed \`Exit\`, use \`Cause.squash(exit.cause)\`. This function returns the failure value.
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
        "Effect.fail and Effect.succeed both build effects. Select one of them with a ternary.",
        "Exit.isSuccess(exit) narrows the type, so exit.value is available. In the else branch, exit.cause is available.",
        "Cause.squash(exit.cause) gives back the string that you passed to Effect.fail."
      ]
    },
    {
      id: "getting-started-p2",
      title: "Config loader pipeline",
      spec: `
You have a raw config string, and you need a validated port number. Build 3 small effects and one \`Effect.gen\` that combines them:

1. \`parse(raw)\` uses \`Effect.try\` to parse JSON into \`{ port: unknown }\`. It fails with \`"bad json"\`.
2. \`toNumber(value)\` succeeds with the value if the value is a \`number\`. Otherwise it fails with \`"port is not a number"\`.
3. \`inRange(port)\` succeeds if \`1 <= port <= 65535\`. Otherwise it fails with \`"port out of range"\`.

\`loadPort(raw)\` combines the 3 steps with \`Effect.gen\` and returns the port. Run it on the 3 inputs below with \`Effect.runSyncExit\` and print exactly:

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
        "Each step is a function that returns an Effect<number, string>. Annotate the return types. The annotations make the errors visible.",
        "In the generator, yield* each step in order. The first failure stops the steps after it. This is the correct behavior.",
        "The error type of loadPort is string, so Cause.squash gives the message directly."
      ]
    },
    {
      id: "getting-started-p3",
      title: "Fake API client",
      spec: `
Wrap a Promise-based API in Effect. The API is given: \`api.getUser(id)\` resolves with a user for the ids 1 and 2, and rejects for other ids.

Write \`getUser(id)\` with \`Effect.tryPromise\`. A rejection must become the typed error \`"user <id> not found"\`. Then write \`program\` with \`Effect.gen\`. The program gets users 1 and 2 and prints their names on one line as \`Ada & Lin\`. Then it tries user 3 and prints the error. Get user 3 with \`Effect.runPromiseExit\` and use \`Cause.squash\` to get the message. Exact output:

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
        "Inside the generator, yield* getUser(1) and getUser(2) as normal steps.",
        "For user 3, Effect.runPromiseExit returns a Promise of an Exit. Wrap this Promise with Effect.promise, then yield* it. The Error Management section shows a cleaner method."
      ]
    }
  ],
  recall: [
    {
      q: "What happens when you create an effect but do not run it?",
      a: "Nothing. An effect is a description of work. Only a runner such as `runSync` or `runPromise` does the work. A Promise is different: it starts the work when you create it."
    },
    {
      q: "What is the type of `Effect.fail(new Error(\"x\"))`?",
      a: "`Effect<never, Error, never>`. It gives no success value, it fails with an `Error`, and it needs no services."
    },
    {
      q: "In `Effect<A, E, R>`, what does `R = never` mean?",
      a: "The effect needs no services from outside to run. In the Requirements Management section, `R` becomes a type other than `never`."
    },
    {
      q: "Which constructor do you use to wrap `fs.readFileSync`, which can throw?",
      a: "`Effect.try({ try, catch })`. The function is synchronous and can throw. `Effect.sync` is only for code that cannot throw. A throw inside `Effect.sync` becomes a defect, not a typed failure."
    },
    {
      q: "What is the difference between `Effect.map` and `Effect.andThen`?",
      a: "`map` takes a plain function and wraps its return value. `andThen` (or `flatMap`) takes a function that returns an effect and removes the nested layer. Thus you do not get an effect inside an effect."
    },
    {
      q: "When does `Effect.runSync` throw?",
      a: "It throws when the effect fails, or when the effect contains async work such as a Promise or a timer. Use `runSyncExit` to get a value in place of a throw. Use `runPromise` when the effect has async work."
    },
    {
      q: "Inside `Effect.gen`, what is the equivalent of `await`?",
      a: "`yield*`. It unwraps the success value of an effect. If the effect fails, it stops the generator."
    }
  ]
}

export default section
