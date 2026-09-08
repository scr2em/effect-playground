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
      id: "getting-started-l7",
      title: "Control flow: forEach, all, and when",
      explain: `
Real programs run one effect for each element of a list, or several effects together. In plain TypeScript you write a loop and \`Promise.all\`:

\`\`\`ts
const names = []
for (const id of [1, 2, 3]) names.push(await loadName(id))
const [name, posts] = await Promise.all([loadName(1), countPosts(1)])
if (await isAdmin(1)) await notify("admin Ada")
\`\`\`

Effect has one function for each of these shapes. Each function takes effects and returns one new effect. The result type follows the shape of the input.

| Function | Input | Result type | Use it when |
|---|---|---|---|
| \`Effect.forEach(items, f)\` | A list and a function that returns an effect | \`Effect<Array<B>>\` | You need one result per element |
| \`Effect.forEach(items, f, { discard: true })\` | The same | \`Effect<void>\` | You only need the side effects |
| \`Effect.all([a, b])\` | A tuple of effects | \`Effect<[A, B]>\` | A fixed number of different effects |
| \`Effect.all({ a, b })\` | An object of effects | \`Effect<{ a: A; b: B }>\` | You want the results by name |
| \`Effect.when(effect, condition)\` | An effect and an \`Effect<boolean>\` | \`Effect<Option<A>>\` | The condition is itself an effect |

\`forEach\` and \`all\` run the effects in sequence by default. The Concurrency section shows the \`concurrency\` option. \`when\` returns an \`Option\`: \`Some\` with the value when the effect ran, \`None\` when it did not run. An \`Option\` is the Effect data type for "a value or nothing".

Note: Effect v4 has no \`Effect.unless\` and no \`Effect.if\`. For a plain boolean, write an \`if\` statement inside \`Effect.gen\`.
`,
      code: `import { Effect, Option } from "effect"

const names: Record<number, string> = { 1: "Ada", 2: "Lin", 3: "Bo" }
const loadName = (id: number) => Effect.succeed(names[id] ?? "?")
const countPosts = (id: number) => Effect.succeed(id * 2)
const notify = (name: string) => Effect.sync(() => console.log("notified", name))
const isAdmin = (id: number) => Effect.succeed(id === 1)

const program = Effect.gen(function* () {
  // 1. forEach: one effect per element, in order. The results come back as an array.
  const loaded = yield* Effect.forEach([1, 2, 3], loadName)          // Array<string>
  console.log("names:", loaded.join(", "))

  // 2. forEach with discard: only the side effects. The result is void.
  yield* Effect.forEach(loaded, notify, { discard: true })

  // 3. all over a tuple: the result is a typed tuple.
  const [name, posts] = yield* Effect.all([loadName(1), countPosts(1)])   // [string, number]
  console.log(name, "has", posts, "posts")

  // 4. all over an object: the result has the same keys as the input.
  const data = yield* Effect.all({ name: loadName(2), posts: countPosts(2) })   // { name: string; posts: number }
  console.log(data.name, "has", data.posts, "posts")

  // 5. when: the effect runs only if the condition effect gives true. The result is an Option.
  const sent = yield* Effect.when(notify("admin Ada"), isAdmin(1))
  const skipped = yield* Effect.when(notify("admin Lin"), isAdmin(2))
  console.log("sent:", Option.isSome(sent), "skipped:", Option.isNone(skipped))
})

Effect.runSync(program)
`,
      expectedOutput: `names: Ada, Lin, Bo
notified Ada
notified Lin
notified Bo
Ada has 2 posts
Lin has 4 posts
notified admin Ada
sent: true skipped: true`,
      after: `Change \`data.posts\` to \`data.post\`. TypeScript reports an error, because the result of \`Effect.all\` has only the keys of the input object. Remove \`{ discard: true }\` from step 2. The output is the same, but the \`yield*\` now gives an array of 3 \`undefined\` values.`
    },
    {
      id: "getting-started-l8",
      title: "Loops and recursion: whileLoop and suspend",
      explain: `
Some work does not have a list to loop over. A countdown runs until a number is 0. A poll runs until a job is complete. There are 3 ways to write this with effects:

1. A plain \`for\` or \`while\` loop inside \`Effect.gen\`. Each step has \`yield*\`.
2. \`Effect.whileLoop({ while, body, step })\`. \`while\` is a function that returns a boolean. \`body\` is a function that returns the effect for one step. \`step\` receives the result of each step.
3. A function that returns an effect and calls itself.

The third way has a trap. Look at the function \`eagerSumTo\` in the code. When you call \`eagerSumTo(5)\`, the function calls \`eagerSumTo(4)\` at once, and so on to 0. Thus the call builds all 6 effects before any run. For a large number, the call uses too much stack space and throws a \`RangeError\`.

\`Effect.suspend(() => effect)\` is the fix. It takes a function and delays the call until the effect runs. Thus \`lazySumTo(5)\` builds nothing. The runtime calls the function one step at a time, and the stack stays small.

Note: Effect v4 has no \`Effect.loop\` and no \`Effect.iterate\`. Use the 3 ways above.
`,
      code: `import { Effect } from "effect"

// 1. A plain loop inside Effect.gen. yield* runs each step.
const countdown = Effect.gen(function* () {
  for (let n = 3; n > 0; n--) {
    yield* Effect.sync(() => console.log("t-minus", n))
  }
  console.log("liftoff")
})

// 2. whileLoop: while and body are functions, so both run at run time, not before.
let remaining = 3
const drain = Effect.whileLoop({
  while: () => remaining > 0,
  body: () => Effect.sync(() => remaining--),
  step: (left) => console.log("drained, before:", left)
})

// 3. Recursion without suspend. The call eagerSumTo(5) builds the whole chain before any run.
let built = 0
const eagerSumTo = (n: number): Effect.Effect<number> => {
  built++
  return n === 0 ? Effect.succeed(0) : Effect.map(eagerSumTo(n - 1), (rest) => rest + n)
}
const eager = eagerSumTo(5)
console.log("eager: built", built, "effects before run")

// 4. suspend delays the body until the effect runs. The call lazySumTo(5) builds nothing.
built = 0
const lazySumTo = (n: number): Effect.Effect<number> =>
  Effect.suspend(() => {
    built++
    return n === 0 ? Effect.succeed(0) : Effect.map(lazySumTo(n - 1), (rest) => rest + n)
  })
const lazy = lazySumTo(5)
console.log("lazy: built", built, "effects before run")

Effect.runSync(countdown)
Effect.runSync(drain)
console.log("eager sum:", Effect.runSync(eager))
console.log("lazy sum:", Effect.runSync(lazy), "- built", built, "during the run")
`,
      expectedOutput: `eager: built 6 effects before run
lazy: built 0 effects before run
t-minus 3
t-minus 2
t-minus 1
liftoff
drained, before: 3
drained, before: 2
drained, before: 1
eager sum: 15
lazy sum: 15 - built 6 during the run`,
      after: `Change \`eagerSumTo(5)\` to \`eagerSumTo(200000)\`. The call throws a \`RangeError\` before any run, because each nested call needs stack space. Change \`lazySumTo(5)\` to \`lazySumTo(200000)\` in place of this. The program prints the sum, because the runtime builds one step at a time. Caution: a function that returns an effect and calls itself must make the call inside \`Effect.suspend\` or inside \`Effect.gen\`.`
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
    },
    {
      do: "Put the body of a function that returns an effect and calls itself inside `Effect.suspend`.",
      dont: "Do not let such a function call itself directly in a `map` or `andThen` argument.",
      why: "The first call builds the whole chain before any run, and a deep chain throws a `RangeError`."
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
      id: "getting-started-c7",
      title: "The loop that runs nothing",
      task: `The program must greet both names before it prints \`done\`, but only \`done\` prints. Replace the \`for\` loop with one Effect function that runs \`greet\` for each name. Do not change \`greet\`.`,
      code: `import { Effect } from "effect"

const greet = (name: string) => Effect.sync(() => console.log("hello", name))

const program = Effect.gen(function* () {
  for (const name of ["Ada", "Lin"]) {
    greet(name)
  }
  console.log("done")
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const greet = (name: string) => Effect.sync(() => console.log("hello", name))

const program = Effect.gen(function* () {
  yield* Effect.forEach(["Ada", "Lin"], greet, { discard: true })
  console.log("done")
})

Effect.runSync(program)
`,
      expectedOutput: `hello Ada
hello Lin
done`,
      hints: [
        "greet(name) builds an effect. Nothing in the loop runs that effect.",
        "The control flow lesson has a function that takes a list and a function, and runs one effect per element.",
        "Write yield* Effect.forEach([\"Ada\", \"Lin\"], greet, { discard: true })."
      ],
      explanation: `\`greet(name)\` returns a description. The loop built 2 descriptions and threw both away, because no \`yield*\` ran them. \`Effect.forEach\` builds one effect that runs \`greet\` for each element in order. The \`yield*\` in front runs this effect. \`{ discard: true }\` says that the results are not important, so the type is \`Effect<void>\`. A \`yield* greet(name)\` inside the loop is also correct. \`forEach\` is shorter, and later you can add a \`concurrency\` option to it.`
    },
    {
      id: "getting-started-c8",
      title: "The key that does not exist",
      task: `The program does not compile. The code reads a property that the result of \`Effect.all\` does not have. Correct the property name so that the program prints \`Ada has 2 posts\`. Do not change the object that goes into \`Effect.all\`.`,
      code: `import { Effect } from "effect"

const loadName = (id: number) => Effect.succeed(id === 1 ? "Ada" : "Lin")
const countPosts = (id: number) => Effect.succeed(id * 2)

const program = Effect.gen(function* () {
  const data = yield* Effect.all({ name: loadName(1), posts: countPosts(1) })
  console.log(data.name, "has", data.postCount, "posts")
})

Effect.runSync(program)
`,
      solution: `import { Effect } from "effect"

const loadName = (id: number) => Effect.succeed(id === 1 ? "Ada" : "Lin")
const countPosts = (id: number) => Effect.succeed(id * 2)

const program = Effect.gen(function* () {
  const data = yield* Effect.all({ name: loadName(1), posts: countPosts(1) })
  console.log(data.name, "has", data.posts, "posts")
})

Effect.runSync(program)
`,
      expectedOutput: `Ada has 2 posts`,
      hints: [
        "Read the type error. Which property does not exist on the type of data?",
        "The result of Effect.all over an object has the same keys as the input object.",
        "Change data.postCount to data.posts."
      ],
      explanation: `\`Effect.all\` keeps the shape of its input. The input object has the keys \`name\` and \`posts\`, so the success type is \`{ name: string; posts: number }\`. The key \`postCount\` is not in this type, and the compiler rejects it. In plain TypeScript with \`Promise.all\`, you get an array, and you must count positions. With an object in \`Effect.all\`, each result has a name, and a wrong name is a type error.`
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
        "Lesson 7 has a table. Which constructor is for sync code that can throw?",
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
        "Lesson 8 has a table of runners. Which runner permits async work?",
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
    },
    {
      q: "What is the success type of `Effect.all({ user: loadUser(1), posts: loadPosts(1) })`, where `loadUser` gives a `User` and `loadPosts` gives an `Array<Post>`?",
      a: "`{ user: User; posts: Array<Post> }`. `Effect.all` keeps the keys of the input object. With a tuple input, it gives a tuple. With `Effect.forEach` over a list, you get an `Array` of the results."
    }
  ]
}

export default section
