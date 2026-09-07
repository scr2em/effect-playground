import type { Section } from "../types.ts"

const section: Section = {
  id: "behaviour",
  title: "Behaviour",
  order: 19,
  summary: "Order and Equivalence: comparison and equality as named, reusable values instead of comparator functions at each call site.",
  intro: `
**The problem.** Plain TypeScript has no type for "how to compare 2 values". You write a comparator function at each call site:

\`\`\`ts
users.sort((a, b) => a.age - b.age)
users.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
users.filter((u, i, all) => all.findIndex((o) => o.id === u.id) === i)   // "unique by id"
\`\`\`

The default \`sort()\` compares numbers as text: \`[10, 9, 1].sort()\` gives \`[1, 10, 9]\`. The default \`sort()\` also changes the array in place. The rules for "same" and "before" are copied into many files. When a rule changes, you must find every copy. If you miss one copy, 2 parts of the program disagree about the order of the same list.

### The shift

Today you think of a comparison as a small function that you write where you need it. Effect asks you to make the comparison a named value. An \`Order<A>\` is a value that says which of 2 \`A\` values comes first. An \`Equivalence<A>\` is a value that says if 2 \`A\` values are the same. You build these values once from small parts. Then you give them to functions that sort a list, find a minimum, remove duplicates, or compare 2 lists.

There are 2 tools to build them. \`mapInput\` adapts an existing rule to a larger type: "order employees by their salary". \`combine\` joins 2 rules: "by department, then by salary". The result is a value with a name and a type. The compiler checks that you use it with the correct element type. When you change the rule, you change it in one place.

| Plain TypeScript | Effect | What changes |
|---|---|---|
| \`(a, b) => a.age - b.age\` at each call site | \`Order.mapInput(Order.Number, (u) => u.age)\` as a named value | One definition, and the compiler checks the element type |
| \`items.sort()\` | \`Array.sort(items, order)\` | Returns a new array and uses the given Order |
| \`Math.min(a, b)\`, numbers only | \`Order.min(order)(a, b)\`, any type | Works for dates, durations and your own types |
| \`a.email.toLowerCase() === b.email.toLowerCase()\` | \`Equivalence.mapInput(Equivalence.String, normalize)\` | One definition of "same email" |
| \`findIndex\` tricks for "unique by" | \`Array.dedupeWith(items, equivalence)\` | The rule is a value, not a trick |

The previous section put equality inside the type with the \`Equal\` trait. This section keeps the rule outside the type. Use a trait when a type has one natural meaning of "same". Use an \`Equivalence\` or an \`Order\` when the rule depends on the situation, or when you do not own the type.
`,
  lessons: [
    {
      id: "behaviour-l1",
      title: "Order: a named comparison",
      explain: `
An \`Order<A>\` is a function \`(self, that) => -1 | 0 | 1\`. It returns \`-1\` when \`self\` comes first, \`1\` when \`that\` comes first, and \`0\` when they are equal. The \`Order\` module gives you \`Order.Number\`, \`Order.String\`, \`Order.Boolean\`, \`Order.BigInt\` and \`Order.Date\`.

Compare the plain TypeScript version with the Effect version:

\`\`\`ts
const copy = [...scores]     // copy first, because sort() changes the array
copy.sort((a, b) => a - b)   // a comparator written at the call site
\`\`\`

\`Array.sort(items, Order.Number)\` from the Effect \`Array\` module returns a new array and does not change the input. \`Order.flip(order)\` reverses an order. You do not write \`(b, a) => ...\` by hand.

Note: the code imports the module as \`Array as Arr\`. Without the alias, the Effect module hides the global \`Array\` type.
`,
      code: `import { Array as Arr, Order } from "effect"

const scores = [10, 9, 100, 1]

// Plain sort compares as text and changes the input array
const copy = [...scores]
copy.sort()
console.log(copy.join(","))

// Order.Number is a named, reusable comparison. Arr.sort returns a new array.
console.log(Arr.sort(scores, Order.Number).join(","))
console.log(scores.join(","))   // the input did not change

// flip reverses an Order
console.log(Arr.sort(scores, Order.flip(Order.Number)).join(","))
console.log(Arr.sort(["pear", "Apple", "fig"], Order.String).join(","))

// An Order is a function that returns -1, 0 or 1
console.log(Order.Number(1, 2), Order.String("b", "a"), Order.Number(3, 3))
`,
      expectedOutput: `1,10,100,9
1,9,10,100
10,9,100,1
100,10,9,1
Apple,fig,pear
-1 1 0`,
      after: `The first line shows the text order: \`10\` comes before \`9\` because \`"1"\` is before \`"9"\`. \`Order.String\` is case-sensitive: \`"Apple"\` comes before \`"fig"\` because upper-case letters have lower character codes. Change \`Order.String\` to \`Order.mapInput(Order.String, (s: string) => s.toLowerCase())\` to get a case-insensitive order.`
    },
    {
      id: "behaviour-l2",
      title: "mapInput and combine: orders for records",
      explain: `
Most data is a record, not a number. \`Order.mapInput(order, getKey)\` makes an \`Order\` for a record from an \`Order\` for one of its fields. The name means: map the input first, then compare.

\`Order.combine(first, second)\` makes an \`Order\` that uses \`first\`, and uses \`second\` only when \`first\` returns \`0\`. \`Order.combineAll([...])\` does the same for a list of orders. 3 functions accept these values:

| Function | Use when |
|---|---|
| \`Arr.sort(items, order)\` | You have one \`Order\`, possibly built with \`combineAll\` |
| \`Arr.sortBy(order1, order2, ...)(items)\` | You want to list the orders in place; a later Order decides when an earlier one returns \`0\` |
| \`Order.Struct({ field: order, ... })\` | You want an \`Order\` for a record from an \`Order\` per field, in field order |

\`Array.prototype.sort\` is stable, and \`Arr.sort\` uses it. When 2 items are equal for every \`Order\`, they keep their input order.
`,
      code: `import { Array as Arr, Order } from "effect"

interface Employee {
  readonly name: string
  readonly dept: string
  readonly salary: number
}

const staff: ReadonlyArray<Employee> = [
  { name: "Lin", dept: "eng", salary: 120 },
  { name: "Ada", dept: "eng", salary: 150 },
  { name: "Bob", dept: "ops", salary: 90 },
  { name: "Cy", dept: "ops", salary: 90 }
]

// mapInput: reuse an Order for one field of a larger type
const byDept = Order.mapInput(Order.String, (e: Employee) => e.dept)
const bySalaryDesc = Order.mapInput(Order.flip(Order.Number), (e: Employee) => e.salary)
const byName = Order.mapInput(Order.String, (e: Employee) => e.name)

// combineAll: the first Order decides; ties go to the next one
const ranking = Order.combineAll([byDept, bySalaryDesc, byName])

const show = (es: ReadonlyArray<Employee>) => es.map((e) => e.dept + ":" + e.name + ":" + e.salary).join(" ")

console.log(show(Arr.sort(staff, ranking)))

// sortBy takes the orders directly
console.log(show(Arr.sortBy(byDept, bySalaryDesc, byName)(staff)))

// Order.Struct: one Order per field, applied in field order. Bob and Cy tie, so they keep input order.
const byDeptThenSalary = Order.Struct({ dept: Order.String, salary: Order.Number })
console.log(show(Arr.sort(staff, byDeptThenSalary)))
`,
      expectedOutput: `eng:Ada:150 eng:Lin:120 ops:Bob:90 ops:Cy:90
eng:Ada:150 eng:Lin:120 ops:Bob:90 ops:Cy:90
eng:Lin:120 eng:Ada:150 ops:Bob:90 ops:Cy:90`,
      after: `\`byDept\`, \`bySalaryDesc\` and \`byName\` are values. You can export them and use them in a table view, a report and a test. Remove \`byName\` from \`ranking\`: the output does not change, because Bob and Cy are already in name order in the input. Swap Bob and Cy in the input to see the difference.`
    },
    {
      id: "behaviour-l3",
      title: "min, max, clamp and isBetween",
      explain: `
An \`Order\` gives you more than a sort. The \`Order\` module makes 4 helpers from any \`Order\`:

| Helper | Result |
|---|---|
| \`Order.min(order)(a, b)\` | The smaller value |
| \`Order.max(order)(a, b)\` | The larger value |
| \`Order.clamp(order)({ minimum, maximum })(a)\` | \`a\`, limited to the range |
| \`Order.isBetween(order)({ minimum, maximum })(a)\` | \`true\` when \`a\` is in the range, limits included |

\`Math.min\` works for numbers only. These helpers work for any type that has an \`Order\`. The \`DateTime\` and \`Duration\` modules export their own \`Order\` values, so "the later of 2 dates" and "the shortest timeout" use the same helpers.

Each helper takes the \`Order\` first and returns a function. Give that function a name, and you have a reusable operation.
`,
      code: `import { Array as Arr, DateTime, Duration, Order } from "effect"

// clamp: keep a value inside a range
const clampPercent = Order.clamp(Order.Number)({ minimum: 0, maximum: 100 })
console.log(clampPercent(140), clampPercent(-5), clampPercent(42))

// max with the DateTime Order: the later of 2 dates
const later = Order.max(DateTime.Order)
const a = DateTime.makeUnsafe("2024-03-01")
const b = DateTime.makeUnsafe("2024-01-15")
console.log(DateTime.formatIsoDate(later(a, b)))

// isBetween with the DateTime Order: is this date in the first quarter?
const inQ1 = Order.isBetween(DateTime.Order)({
  minimum: DateTime.makeUnsafe("2024-01-01"),
  maximum: DateTime.makeUnsafe("2024-03-31")
})
console.log(inQ1(a), inQ1(DateTime.makeUnsafe("2024-04-02")))

// min with the Duration Order: the shortest of a list
const timeouts = [Duration.seconds(30), Duration.millis(750), Duration.minutes(1)]
const shortest = timeouts.reduce((acc, d) => Order.min(Duration.Order)(acc, d))
console.log(Duration.format(shortest))
console.log(Arr.sort(timeouts, Duration.Order).map(Duration.format).join(" < "))

// The predicates also come from the Order
console.log(Order.isLessThan(Order.String)("apple", "banana"))
`,
      expectedOutput: `100 0 42
2024-03-01
true false
750ms
750ms < 30s < 1m
true`,
      after: `\`DateTime.Order\` compares instants, so it is correct for zoned values too. Change \`later\` to \`Order.min(DateTime.Order)\` to get the earlier date. \`Order.isBetween\` includes both limits: \`inQ1(DateTime.makeUnsafe("2024-03-31"))\` is \`true\`.`
    },
    {
      id: "behaviour-l4",
      title: "Equivalence: a named rule for \"same\"",
      explain: `
An \`Equivalence<A>\` is a function \`(self, that) => boolean\`. It must be reflexive (a value equals itself), symmetric (the order of the 2 values does not matter) and transitive (if a equals b and b equals c, then a equals c). The module gives you \`Equivalence.String\`, \`Equivalence.Number\`, \`Equivalence.Boolean\` and \`Equivalence.Date\`.

You build larger rules from these:

| Function | Result |
|---|---|
| \`Equivalence.mapInput(eq, getKey)\` | Compare records by one derived value |
| \`Equivalence.Struct({ field: eq, ... })\` | Compare records field by field |
| \`Equivalence.Tuple([eq1, eq2])\` | Compare tuples position by position |
| \`Arr.makeEquivalence(eq)\` | Compare arrays element by element |

The \`Array\` module accepts an \`Equivalence\` in \`dedupeWith\`, \`differenceWith\`, \`intersectionWith\`, \`unionWith\` and \`containsWith\`. The functions without \`With\` use \`Equal.equals\` from the previous section. Use an \`Equivalence\` when the rule is not the natural equality of the type: "same email after normalization" is a rule about contacts, not about strings.
`,
      code: `import { Array as Arr, Equivalence } from "effect"

interface Contact {
  readonly name: string
  readonly email: string
}

const contacts: ReadonlyArray<Contact> = [
  { name: "Ada", email: "ada@example.com" },
  { name: "Ada L.", email: "ADA@example.com " },
  { name: "Lin", email: "lin@example.com" }
]

// mapInput: compare the normalized email, not the raw string
const normalizedEmail = Equivalence.mapInput(Equivalence.String, (s: string) => s.trim().toLowerCase())
const sameContact = Equivalence.mapInput(normalizedEmail, (c: Contact) => c.email)

console.log(sameContact(contacts[0], contacts[1]), sameContact(contacts[0], contacts[2]))

// The Array module accepts the Equivalence
console.log(Arr.dedupeWith(contacts, sameContact).map((c) => c.name).join(","))

const imported: ReadonlyArray<Contact> = [
  { name: "Ada", email: "ada@example.com" },
  { name: "Zed", email: "zed@example.com" }
]
console.log(Arr.differenceWith(sameContact)(imported, contacts).map((c) => c.name).join(","))
console.log(Arr.containsWith(sameContact)(contacts, { name: "?", email: " LIN@EXAMPLE.COM" }))

// Struct and Tuple: build an Equivalence for a shape from one per field
const samePerson = Equivalence.Struct({ name: Equivalence.String, email: normalizedEmail })
console.log(samePerson(contacts[0], { name: "Ada", email: "ada@example.com" }))

const sameCoord = Equivalence.Tuple([Equivalence.Number, Equivalence.Number])
console.log(sameCoord([1, 2], [1, 2]), sameCoord([1, 2], [2, 1]))
`,
      expectedOutput: `true false
Ada,Lin
Zed
true
true
true false`,
      after: `\`normalizedEmail\` is an \`Equivalence<string>\` and \`sameContact\` is an \`Equivalence<Contact>\`. The second one reuses the first. Change \`Arr.dedupeWith(contacts, sameContact)\` to \`Arr.dedupe(contacts)\`: all 3 contacts stay, because structural equality sees 3 different records.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use `Arr.sort(items, Order.Number)` to sort numbers.",
      dont: "Do not call `items.sort()` without a comparator.",
      why: "The default sort compares numbers as text, so `10` comes before `9`, and it changes the array in place."
    },
    {
      do: "Build an `Order` for a record with `Order.mapInput(Order.String, (u: User) => u.name)`.",
      dont: "Do not give `Order.String` or `Order.Number` directly to `Arr.sort` for a list of records.",
      why: "The element type does not match the `Order` type, and the program does not compile."
    },
    {
      do: "Match the `Order` to the type of the key: `Order.String` for a string key.",
      dont: "Do not use `Order.Number` with a key function that returns a string.",
      why: "The program does not compile, and a numeric string such as `\"10\"` would sort as text."
    },
    {
      do: "List the orders in the sequence of importance: `Arr.sortBy(byScore, byName)`.",
      dont: "Do not list the less important `Order` first.",
      why: "The first `Order` decides each comparison, and the second is never used when the first never returns `0`."
    },
    {
      do: "Use `Arr.dedupeWith(items, equivalence)` when \"same\" means \"same key\".",
      dont: "Do not use `Arr.dedupe` when records differ in fields that do not matter.",
      why: "`Arr.dedupe` compares whole records, so 2 records with the same id and different timestamps both stay."
    },
    {
      do: "Use `Order.flip(order)` to reverse an `Order`.",
      dont: "Do not write `(b, a) => order(a, b)` by hand at each call site.",
      why: "Each copy is a place where the rule can change, and the copies can disagree."
    },
    {
      do: "Use `Order.min`, `Order.max`, `Order.clamp` and `Order.isBetween` with `DateTime.Order` or `Duration.Order`.",
      dont: "Do not convert dates to numbers to use `Math.min` or `Math.max`.",
      why: "The conversion loses the type, and the code gives numbers where the rest of the program expects a `DateTime`."
    }
  ],
  challenges: [
    {
      id: "behaviour-c1",
      title: "Numbers sorted as text",
      task: `The prices must print from the smallest to the largest: \`5 < 25 < 250 < 1000\`. The program prints a different order. Fix the sort.`,
      code: `import { Array as Arr, Order } from "effect"

const prices = [250, 25, 1000, 5]

console.log(prices.sort().join(" < "))
`,
      solution: `import { Array as Arr, Order } from "effect"

const prices = [250, 25, 1000, 5]

console.log(Arr.sort(prices, Order.Number).join(" < "))
`,
      expectedOutput: `5 < 25 < 250 < 1000`,
      hints: [
        "Look at the output: 1000 comes before 25. Which order puts \"1\" before \"2\"?",
        "The default sort() converts each number to text before it compares.",
        "Use Arr.sort(prices, Order.Number)."
      ],
      explanation: `\`Array.prototype.sort\` without a comparator converts every element to text and compares the text. \`"1000"\` comes before \`"25"\` because \`"1"\` is before \`"2"\`. \`Arr.sort(prices, Order.Number)\` compares numbers as numbers. It also returns a new array and leaves \`prices\` unchanged, so no other code that holds \`prices\` sees a different order.`
    },
    {
      id: "behaviour-c2",
      title: "The wrong Order for a string key",
      task: `The program prints the correct output, \`Ada,Moby,Zen\`, but it does not compile. Fix the type error without a change to the output.`,
      code: `import { Array as Arr, Order } from "effect"

interface Book {
  readonly title: string
  readonly pages: number
}

const books: ReadonlyArray<Book> = [
  { title: "Zen", pages: 90 },
  { title: "Ada", pages: 300 },
  { title: "Moby", pages: 600 }
]

const byTitle = Order.mapInput(Order.Number, (b: Book) => b.title)

console.log(Arr.sort(books, byTitle).map((b) => b.title).join(","))
`,
      solution: `import { Array as Arr, Order } from "effect"

interface Book {
  readonly title: string
  readonly pages: number
}

const books: ReadonlyArray<Book> = [
  { title: "Zen", pages: 90 },
  { title: "Ada", pages: 300 },
  { title: "Moby", pages: 600 }
]

const byTitle = Order.mapInput(Order.String, (b: Book) => b.title)

console.log(Arr.sort(books, byTitle).map((b) => b.title).join(","))
`,
      expectedOutput: `Ada,Moby,Zen`,
      hints: [
        "Read the type error. What type does the key function return, and what type does the Order expect?",
        "mapInput requires the key function to return the type that the Order compares.",
        "Use Order.String for a string key."
      ],
      explanation: `\`Order.mapInput(order, getKey)\` requires \`getKey\` to return the type that \`order\` compares. \`Order.Number\` compares numbers, and \`b.title\` is a string. At runtime the \`<\` operator compares strings as text, so the output looked correct. The compiler still rejects the program, and that is useful: with \`Order.Number\` a title such as \`"10"\` would compare as text without a warning. \`Order.String\` says what the key is.`
    },
    {
      id: "behaviour-c3",
      title: "The wrong sequence of orders",
      task: `The leaderboard must show the highest score first. Players with the same score must be in alphabetical order. The program uses the orders in the wrong sequence. Fix it so it prints \`Bob,Dee,Ada,Cy\`.`,
      code: `import { Array as Arr, Order } from "effect"

interface Player {
  readonly name: string
  readonly score: number
}

const players: ReadonlyArray<Player> = [
  { name: "Ada", score: 80 },
  { name: "Bob", score: 95 },
  { name: "Cy", score: 80 },
  { name: "Dee", score: 95 }
]

const byName = Order.mapInput(Order.String, (p: Player) => p.name)
const byScoreDesc = Order.mapInput(Order.flip(Order.Number), (p: Player) => p.score)

console.log(Arr.sortBy(byName, byScoreDesc)(players).map((p) => p.name).join(","))
`,
      solution: `import { Array as Arr, Order } from "effect"

interface Player {
  readonly name: string
  readonly score: number
}

const players: ReadonlyArray<Player> = [
  { name: "Ada", score: 80 },
  { name: "Bob", score: 95 },
  { name: "Cy", score: 80 },
  { name: "Dee", score: 95 }
]

const byName = Order.mapInput(Order.String, (p: Player) => p.name)
const byScoreDesc = Order.mapInput(Order.flip(Order.Number), (p: Player) => p.score)

console.log(Arr.sortBy(byScoreDesc, byName)(players).map((p) => p.name).join(","))
`,
      expectedOutput: `Bob,Dee,Ada,Cy`,
      hints: [
        "In sortBy, which Order decides first? Which one is used only when the first returns 0?",
        "Every name is different, so byName never returns 0 and byScoreDesc is never used.",
        "Write Arr.sortBy(byScoreDesc, byName)(players)."
      ],
      explanation: `\`Arr.sortBy(first, second)\` uses \`second\` only when \`first\` returns \`0\`. All names are different, so \`byName\` decided every comparison and \`byScoreDesc\` never ran. With the score first, Bob and Dee tie at 95 and \`byName\` puts Bob before Dee. The sequence of the orders is the specification of the sort. Read it as "by score, then by name".`
    },
    {
      id: "behaviour-c4",
      title: "Duplicates by id",
      task: `The same event was delivered twice with a different timestamp. Two events are the same when their \`id\` values are the same. The program counts 3 events. Make it count \`2\`.`,
      code: `import { Array as Arr, Equivalence } from "effect"

interface Event {
  readonly id: number
  readonly at: string
}

const events: ReadonlyArray<Event> = [
  { id: 1, at: "09:00" },
  { id: 2, at: "09:05" },
  { id: 1, at: "09:07" }   // a retry of event 1
]

console.log(Arr.dedupe(events).length)
`,
      solution: `import { Array as Arr, Equivalence } from "effect"

interface Event {
  readonly id: number
  readonly at: string
}

const events: ReadonlyArray<Event> = [
  { id: 1, at: "09:00" },
  { id: 2, at: "09:05" },
  { id: 1, at: "09:07" }   // a retry of event 1
]

const sameId = Equivalence.mapInput(Equivalence.Number, (e: Event) => e.id)

console.log(Arr.dedupeWith(events, sameId).length)
`,
      expectedOutput: `2`,
      hints: [
        "Arr.dedupe compares whole records. The two events with id 1 have different at fields.",
        "Build an Equivalence<Event> that looks at the id only, with Equivalence.mapInput.",
        "Use Arr.dedupeWith(events, Equivalence.mapInput(Equivalence.Number, (e: Event) => e.id))."
      ],
      explanation: `\`Arr.dedupe\` uses structural equality, and the 2 events with \`id: 1\` differ in \`at\`. The rule "same id" is not the natural equality of an \`Event\`; it is a rule for this use. \`Equivalence.mapInput(Equivalence.Number, (e) => e.id)\` states that rule as a value. \`Arr.dedupeWith\` applies it and keeps the first occurrence, so the \`09:00\` event stays and the retry is removed.`
    }
  ],
  problems: [
    {
      id: "behaviour-p1",
      title: "Leaderboard",
      spec: `
Build a leaderboard from the players below. Scores above 100 are invalid and must be limited to 100.

1. \`clampScore\` uses \`Order.clamp(Order.Number)\` with \`minimum: 0\` and \`maximum: 100\`. Apply it to every player with \`map\`.
2. \`ranking\` is an \`Order<Player>\`: score from high to low, then name from A to Z. Build it with \`Order.mapInput\`, \`Order.flip\` and \`Order.combine\`.
3. Sort with \`Arr.sort\`, take the first 3 with \`Arr.take\`, and print \`<rank>. <name> <score>\`.
4. Print the lowest player with \`Order.min(ranking)\` in a \`reduce\` over the sorted list. Note: with \`ranking\`, the "minimum" is the first player. Use \`Order.max(ranking)\` to get the last one.

Players: \`Ada 95\`, \`Bob 95\`, \`Cy 40\`, \`Dee 130\`, \`Eve 70\`.

Exact output:

\`\`\`
1. Dee 100
2. Ada 95
3. Bob 95
last: Cy 40
\`\`\`
`,
      starter: `import { Array as Arr, Order } from "effect"

interface Player {
  readonly name: string
  readonly score: number
}

const raw: ReadonlyArray<Player> = [
  { name: "Ada", score: 95 },
  { name: "Bob", score: 95 },
  { name: "Cy", score: 40 },
  { name: "Dee", score: 130 },
  { name: "Eve", score: 70 }
]

// TODO: clampScore with Order.clamp(Order.Number), then players = raw with clamped scores

// TODO: ranking = score high to low, then name A to Z

// TODO: sort, take 3, print "<rank>. <name> <score>"

// TODO: print "last: <name> <score>" with Order.max(ranking) in a reduce
`,
      solution: `import { Array as Arr, Order } from "effect"

interface Player {
  readonly name: string
  readonly score: number
}

const raw: ReadonlyArray<Player> = [
  { name: "Ada", score: 95 },
  { name: "Bob", score: 95 },
  { name: "Cy", score: 40 },
  { name: "Dee", score: 130 },
  { name: "Eve", score: 70 }
]

const clampScore = Order.clamp(Order.Number)({ minimum: 0, maximum: 100 })
const players = raw.map((p) => ({ ...p, score: clampScore(p.score) }))

const byScoreDesc = Order.mapInput(Order.flip(Order.Number), (p: Player) => p.score)
const byName = Order.mapInput(Order.String, (p: Player) => p.name)
const ranking = Order.combine(byScoreDesc, byName)

const sorted = Arr.sort(players, ranking)

Arr.take(sorted, 3).forEach((p, i) => {
  console.log((i + 1) + ". " + p.name + " " + p.score)
})

// max with respect to ranking is the player that comes last
const last = sorted.reduce((a, b) => Order.max(ranking)(a, b))
console.log("last: " + last.name + " " + last.score)
`,
      expectedOutput: `1. Dee 100
2. Ada 95
3. Bob 95
last: Cy 40`,
      hints: [
        "Order.clamp(Order.Number)({ minimum: 0, maximum: 100 }) returns a function from number to number.",
        "Order.combine(byScoreDesc, byName): the first Order decides, the second is used when the first returns 0.",
        "Arr.take(sorted, 3) returns the first 3 elements; forEach gives you the index for the rank."
      ]
    },
    {
      id: "behaviour-p2",
      title: "Contact import",
      spec: `
An import file contains contacts. Some of them already exist in the address book, and some appear twice in the file. Two contacts are the same when their emails are the same after \`trim()\` and \`toLowerCase()\`.

1. \`sameContact\` is an \`Equivalence<Contact>\` built with \`Equivalence.mapInput\` from \`Equivalence.String\`.
2. \`unique\` removes duplicates from the import with \`Arr.dedupeWith\`.
3. \`fresh\` is the contacts in \`unique\` that are not in the address book: \`Arr.differenceWith\`.
4. \`known\` is the contacts in \`unique\` that are in the address book: \`Arr.intersectionWith\`.

Print the names in each list, in input order, with \`join(",")\`. Exact output:

\`\`\`
unique: Ada,Zed,Yun
new: Zed,Yun
known: Ada
\`\`\`

Address book: \`Ada ada@example.com\`, \`Lin lin@example.com\`. Import: \`Ada ADA@example.com\`, \`Zed zed@example.com\`, \`Yun yun@example.com \`, \`Zed Again zed@example.com\`.
`,
      starter: `import { Array as Arr, Equivalence } from "effect"

interface Contact {
  readonly name: string
  readonly email: string
}

const addressBook: ReadonlyArray<Contact> = [
  { name: "Ada", email: "ada@example.com" },
  { name: "Lin", email: "lin@example.com" }
]

const imported: ReadonlyArray<Contact> = [
  { name: "Ada", email: "ADA@example.com" },
  { name: "Zed", email: "zed@example.com" },
  { name: "Yun", email: "yun@example.com " },
  { name: "Zed Again", email: "zed@example.com" }
]

const names = (cs: ReadonlyArray<Contact>) => cs.map((c) => c.name).join(",")

// TODO: sameContact: Equivalence<Contact> on the normalized email

// TODO: unique, fresh, known

// TODO: print "unique: ...", "new: ...", "known: ..."
`,
      solution: `import { Array as Arr, Equivalence } from "effect"

interface Contact {
  readonly name: string
  readonly email: string
}

const addressBook: ReadonlyArray<Contact> = [
  { name: "Ada", email: "ada@example.com" },
  { name: "Lin", email: "lin@example.com" }
]

const imported: ReadonlyArray<Contact> = [
  { name: "Ada", email: "ADA@example.com" },
  { name: "Zed", email: "zed@example.com" },
  { name: "Yun", email: "yun@example.com " },
  { name: "Zed Again", email: "zed@example.com" }
]

const names = (cs: ReadonlyArray<Contact>) => cs.map((c) => c.name).join(",")

// One rule for "same contact", used by all 3 set operations
const sameContact = Equivalence.mapInput(
  Equivalence.String,
  (c: Contact) => c.email.trim().toLowerCase()
)

const unique = Arr.dedupeWith(imported, sameContact)
const fresh = Arr.differenceWith(sameContact)(unique, addressBook)
const known = Arr.intersectionWith(sameContact)(unique, addressBook)

console.log("unique: " + names(unique))
console.log("new: " + names(fresh))
console.log("known: " + names(known))
`,
      expectedOutput: `unique: Ada,Zed,Yun
new: Zed,Yun
known: Ada`,
      hints: [
        "Equivalence.mapInput(Equivalence.String, (c: Contact) => c.email.trim().toLowerCase()) is the whole rule.",
        "Arr.dedupeWith(list, eq) keeps the first occurrence of each contact.",
        "differenceWith and intersectionWith take the Equivalence first and return a function of (self, that)."
      ]
    }
  ],
  recall: [
    {
      q: "What does an `Order<A>` return, and what do the 3 values mean?",
      a: "`-1`, `0` or `1`. `-1` means the first value comes first, `1` means the second value comes first, `0` means they are equal for this order."
    },
    {
      q: "What would the type of `Order.mapInput(Order.Number, (u: User) => u.age)` be?",
      a: "`Order<User>`. `mapInput` takes an `Order<number>` and a function from `User` to `number`, and returns an `Order` for `User`."
    },
    {
      q: "Which function would you use to sort employees by department, then by salary from high to low?",
      a: "`Arr.sortBy(byDept, Order.mapInput(Order.flip(Order.Number), (e) => e.salary))(employees)`, or `Arr.sort(employees, Order.combine(byDept, bySalaryDesc))`. The first Order decides. The second is used only when the first returns `0`."
    },
    {
      q: "What is the difference between `Arr.dedupe` and `Arr.dedupeWith`?",
      a: "`Arr.dedupe` uses structural `Equal.equals`. `Arr.dedupeWith(items, equivalence)` uses the `Equivalence` you give it, for example \"same id\" or \"same email after normalization\"."
    },
    {
      q: "When do you put equality in the type with the `Equal` trait, and when do you use an `Equivalence` value?",
      a: "Use the `Equal` trait when the type has one natural meaning of \"same\" that every collection must use. Use an `Equivalence` when the rule depends on the situation, or when you do not own the type. `Equal.asEquivalence()` converts the first into the second."
    }
  ]
}

export default section
