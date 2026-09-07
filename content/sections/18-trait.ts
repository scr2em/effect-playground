import type { Section } from "../types.ts"

const section: Section = {
  id: "trait",
  title: "Trait",
  order: 18,
  summary: "Equal and Hash: values that know how to compare themselves, and the collections that depend on it.",
  intro: `
**The problem.** JavaScript compares objects by reference. 2 objects with the same contents are not equal:

\`\`\`ts
{ a: 1 } === { a: 1 }                         // false
new Set([{ id: 1 }, { id: 1 }]).size          // 2, not 1
new Map([[{ x: 0 }, "origin"]]).get({ x: 0 }) // undefined
\`\`\`

So each codebase gets a \`deepEqual\` helper, a \`JSON.stringify\` trick for Map keys, and a \`uniqBy(list, (x) => x.id)\` function to remove duplicates. Each of them is a convention that lives next to the data, not inside it. When you add a field, some helpers compare it and some do not. Nobody sees the problem until a cache returns the wrong entry.

### The shift

Today you think of equality as something that you do to 2 objects, with a helper that you select at the call site. Effect asks you to think of equality as something that a value knows about itself. A value can implement 2 traits. A trait is an interface with a method under a known symbol. \`Equal\` answers "am I the same as that value?". \`Hash\` answers "which bucket do I belong to?". Each Effect API that compares values asks the value: \`Equal.equals\`, \`HashMap\`, \`HashSet\`, \`Array.dedupe\`, \`Array.difference\`.

In Effect v4, the default is already structural. \`Equal.equals\` compares plain objects, arrays, class instances, \`Map\`, \`Set\`, \`Date\` and \`RegExp\` by content, and \`NaN\` equals \`NaN\`. You write the 2 trait methods only when your type has its own meaning of "same": case-insensitive emails, money rounded to cents, coordinates with a tolerance. The rule then lives in one place, and each collection and comparison in the program applies it.

| Method | Where the rule lives | Objects with the same contents | Custom rule |
|---|---|---|---|
| \`===\` | The language | Not equal | Not possible |
| \`deepEqual(a, b)\` helper | The call site | Equal | Only with a new helper |
| \`Equal.equals(a, b)\` | Effect, structural by default | Equal | Implement \`[Equal.symbol]\` and \`[Hash.symbol]\` on the type |
| \`Equal.byReference(obj)\` | Effect, opt out | Not equal | For identities: connections, DOM nodes |

The next section, Behaviour, covers the case where the rule must not live inside the type: \`Equivalence\` and \`Order\` as separate, reusable values.
`,
  lessons: [
    {
      id: "trait-l1",
      title: "Equal.equals is structural by default",
      explain: `
\`Equal.equals(a, b)\` is the one comparison function to learn. It never throws, and it returns a \`boolean\`. This is what it does for each kind of value:

| Values | \`===\` | \`Equal.equals\` |
|---|---|---|
| Primitives | by value | by value, and \`NaN\` equals \`NaN\` |
| Plain objects, arrays | by reference | by content, at each level |
| \`Map\`, \`Set\` | by reference | by entries; the sequence does not matter |
| \`Date\`, \`RegExp\` | by reference | by ISO text / by source |
| Objects that implement \`Equal\` | by reference | their own \`[Equal.symbol]\` method |

If you come from v3: a structural comparison of plain objects needed \`Data.struct\`. In v4 it is the default. This is why \`Data.struct\` was removed.

Sometimes identity is what you mean. A database connection object must not be "equal" to another connection with the same configuration. \`Equal.byReference(obj)\` returns a proxy. The proxy takes that one object out of structural comparison.
`,
      code: `import { Equal } from "effect"

const a = { id: 1, tags: ["x", "y"] }
const b = { id: 1, tags: ["x", "y"] }

console.log(a === b, Equal.equals(a, b))
console.log(Equal.equals([1, [2, 3]], [1, [2, 3]]))
console.log(Equal.equals(new Map([["k", 1]]), new Map([["k", 1]])), Equal.equals(new Set([1, 2]), new Set([2, 1])))
console.log(Equal.equals(new Date("2024-01-01"), new Date("2024-01-01")), Equal.equals(NaN, NaN))

// Different shape or different value: false
console.log(Equal.equals({ id: 1 }, { id: 1, extra: true }), Equal.equals({ id: 1 }, { id: "1" }))

// Opt out when identity is what you mean (a live connection, a DOM node)
const conn = Equal.byReference({ id: 1 })
console.log(Equal.equals(conn, { id: 1 }), Equal.equals(conn, conn))
`,
      expectedOutput: `false true
true
true true
true true
false false
false true`,
      after: `Note: the JSDoc gives one rule. Results are cached per object pair, so do not change an object after you compare it. Immutable data never has this problem. Compare \`Equal.equals([1, 2], [2, 1])\`: arrays have a sequence, so the result is \`false\`. The \`Set\` version above was \`true\`.`
    },
    {
      id: "trait-l2",
      title: "A class with its own equality",
      explain: `
Structural equality compares each field. Sometimes that is wrong. The email address \`"Ada@Example.com "\` is the same address as \`"ada@example.com"\`, but the 2 strings are different. The rule "same after trim and lowercase" belongs to the \`Email\` type. It does not belong to the code that compares 2 emails.

A class opts in with 2 methods. The keys are symbols from the \`Equal\` and \`Hash\` modules:

\`\`\`ts
[Equal.symbol](that: Equal.Equal): boolean   // am I the same as that value?
[Hash.symbol](): number                       // which bucket do I belong to?
\`\`\`

\`Equal.Equal\` extends \`Hash.Hash\`. If you implement one method without the other, you get a type error. There is one law: if 2 values are equal, their hashes must be equal. Hash the exact data that you compare. The \`Hash\` module gives you \`Hash.string\`, \`Hash.number\` and \`Hash.combine\` to build a hash from fields.
`,
      code: `import { Equal, Hash } from "effect"

// An email address: equal when the same address, ignoring case and surrounding spaces
class Email implements Equal.Equal {
  readonly normalized: string

  constructor(readonly raw: string) {
    this.normalized = raw.trim().toLowerCase()
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Email && this.normalized === that.normalized
  }

  // The law: equal values must hash the same. So hash the normalized form, not raw.
  [Hash.symbol](): number {
    return Hash.string(this.normalized)
  }
}

const a = new Email("Ada@Example.com ")
const b = new Email("ada@example.com")

console.log(a.raw === b.raw, Equal.equals(a, b))
console.log(Hash.hash(a) === Hash.hash(b))
console.log(Equal.equals(a, new Email("lin@example.com")))
`,
      expectedOutput: `false true
true
false`,
      after: `The default structural rule gives \`false\`, because the \`raw\` fields are different. The class replaced the rule. Change the hash to \`Hash.string(this.raw)\`. This lesson still prints \`true\` for \`Equal.equals\`, but the \`HashSet\` in the next lesson does not find the value. This is why the law matters.`
    },
    {
      id: "trait-l3",
      title: "Value keys in HashMap and HashSet",
      explain: `
This is where the traits give a result. \`HashMap\` and \`HashSet\` first call \`[Hash.symbol]\` to find a bucket. Then they call \`[Equal.symbol]\` to confirm a match. A JS \`Map\` or \`Set\` only knows references.

\`\`\`ts
// Plain TS: the second Email object is a different key
const m = new Map([[new Email("ada@x.io"), "Ada"]])
m.get(new Email("ada@x.io"))   // undefined
\`\`\`

With \`HashMap\`, each object that is \`Equal\` to a stored key finds the entry. This includes a new instance built from user input. \`HashSet\` keeps one member per equality class. That makes the removal of duplicates 1 line. Plain objects also work as keys, because the structural equality of v4 gives them a hash and an equality without extra code.
`,
      code: `import { Equal, Hash, HashMap, HashSet, Option } from "effect"

class Email implements Equal.Equal {
  readonly normalized: string
  constructor(readonly raw: string) {
    this.normalized = raw.trim().toLowerCase()
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Email && this.normalized === that.normalized
  }
  [Hash.symbol](): number {
    return Hash.string(this.normalized)
  }
}

// JS Map: a second Email object for the same address is a different key
const jsMap = new Map<Email, string>([[new Email("ada@example.com"), "Ada"]])
console.log(jsMap.get(new Email("ADA@example.com")))

// HashMap: keys are bucketed with Hash and matched with Equal
const users = HashMap.make(
  [new Email("ada@example.com"), "Ada"],
  [new Email("lin@example.com"), "Lin"]
)
console.log(HashMap.get(users, new Email("ADA@example.com")).pipe(Option.getOrElse(() => "not found")))

// HashSet: one entry per equality class
const seen = HashSet.fromIterable([new Email("a@x.io"), new Email("A@X.IO "), new Email("b@x.io")])
console.log(HashSet.size(seen), HashSet.has(seen, new Email("b@x.io")))

// Plain objects work too, thanks to v4 structural equality
const grid = HashMap.make([{ x: 0, y: 0 }, "origin"])
console.log(HashMap.has(grid, { x: 0, y: 0 }), new Map([[{ x: 0, y: 0 }, "origin"]]).has({ x: 0, y: 0 }))
`,
      expectedOutput: `undefined
Ada
2 true
true false`,
      after: `The same \`Email\` class now drives lookups, the removal of duplicates and equality checks. The case-insensitive rule is written once. Add \`new Email("b@x.io")\` a second time to the \`HashSet\` input: the size stays \`2\`.`
    },
    {
      id: "trait-l4",
      title: "The Effect types compare by value",
      explain: `
Each data type from the previous section implements \`Equal\` and \`Hash\`: \`Option\`, \`Result\`, \`Chunk\`, \`Duration\`, \`DateTime\`, \`HashMap\`, \`HashSet\` and the \`Data\` classes. This means:

- \`Equal.equals(Option.some({ id: 1 }), Option.some({ id: 1 }))\` is \`true\`. The inner value is also compared by structure.
- \`Duration.seconds(90)\` equals \`Duration.minutes(1.5)\`: the same amount of time, a different constructor.
- 2 \`DateTime\` values are equal when they are the same instant.
- A \`Chunk\` is not equal to an array with the same elements. A different type is a different value. Convert one side first.

The last part connects to the next section. \`Equal.asEquivalence<A>()\` wraps \`Equal.equals\` as an \`Equivalence<A>\`. An \`Equivalence\` is a plain \`(a, b) => boolean\`. With it, you can give structural equality to each function that takes a comparison. The \`Array\` module functions such as \`dedupe\` use it by default.
`,
      code: `import { Array as Arr, Chunk, DateTime, Duration, Equal, Option, Result } from "effect"

console.log(Equal.equals(Option.some({ id: 1 }), Option.some({ id: 1 })), Equal.equals(Option.some(1), Option.none()))
console.log(Equal.equals(Result.succeed([1, 2]), Result.succeed([1, 2])), Equal.equals(Result.fail("x"), Result.succeed("x")))
console.log(Equal.equals(Chunk.make(1, 2, 3), Chunk.fromIterable([1, 2, 3])))
console.log(Equal.equals(Duration.seconds(90), Duration.minutes(1.5)))
console.log(Equal.equals(DateTime.makeUnsafe("2024-01-01T00:00:00Z"), DateTime.makeUnsafe("2024-01-01")))

// A Chunk is not an array, even with the same elements
console.log(Equal.equals(Chunk.make(1, 2), [1, 2]))

// Equal as an Equivalence: structural equality as a plain (a, b) => boolean
const sameRecord = Equal.asEquivalence<{ id: number }>()
console.log(sameRecord({ id: 1 }, { id: 1 }))

// Array.dedupe uses Equal by default, so objects dedupe by content
console.log(Arr.dedupe([{ id: 1 }, { id: 1 }, { id: 2 }]).length)
`,
      expectedOutput: `true false
true false
true
true
true
false
true
2`,
      after: `Note the import \`Array as Arr\`. Without the alias, the Effect \`Array\` module hides the global \`Array\` type. Compare \`Equal.equals(Chunk.toArray(Chunk.make(1, 2)), [1, 2])\`: after the conversion of the Chunk to an array, the result is \`true\`.`
    }
  ],
  dosAndDonts: [
    {
      do: "Use `Equal.equals(a, b)` to compare 2 values by content.",
      dont: "Do not use `===` for objects, arrays, Options or Chunks.",
      why: "`===` compares references, so 2 values with the same content are not equal."
    },
    {
      do: "Implement `[Equal.symbol]` and `[Hash.symbol]` together.",
      dont: "Do not implement `[Equal.symbol]` alone.",
      why: "`Equal.Equal` extends `Hash.Hash`, so the class does not compile."
    },
    {
      do: "Hash the same normalized data that you compare: `Hash.string(this.name.toLowerCase())`.",
      dont: "Do not hash the raw field when the equality compares a normalized field.",
      why: "Equal values get different hashes, and `HashSet.has` and `HashMap.get` do not find them."
    },
    {
      do: "Use `HashSet.fromIterable(records)` to remove duplicate records.",
      dont: "Do not use `new Set(records)` for objects.",
      why: "A JS `Set` compares by reference and keeps each object literal."
    },
    {
      do: "Convert with `Chunk.toArray` before you compare a `Chunk` with an array.",
      dont: "Do not compare a `Chunk` with an array in `Equal.equals`.",
      why: "A `Chunk` accepts only another `Chunk`, so the result is always `false`."
    },
    {
      do: "Use `Equal.byReference(obj)` for values that are identities, such as connections.",
      dont: "Do not depend on structural equality for objects that represent a resource.",
      why: "2 connections with the same configuration compare equal, and a `HashMap` merges them into 1 entry."
    },
    {
      do: "Treat values as immutable after you compare them.",
      dont: "Do not change an object after `Equal.equals` or `Hash.hash` saw it.",
      why: "The results are cached per object, so a later comparison returns an old result."
    }
  ],
  challenges: [
    {
      id: "trait-c1",
      title: "The duplicate visit",
      task: `2 of the 3 visits are identical and must count once. The program prints \`3\`. Change the collection so that it prints \`unique visits: 2\`.`,
      code: `import { HashSet } from "effect"

const visits = [
  { page: "/home", user: 1 },
  { page: "/home", user: 1 },
  { page: "/docs", user: 2 }
]

const unique = new Set(visits)

console.log("unique visits:", unique.size)
`,
      solution: `import { HashSet } from "effect"

const visits = [
  { page: "/home", user: 1 },
  { page: "/home", user: 1 },
  { page: "/docs", user: 2 }
]

const unique = HashSet.fromIterable(visits)

console.log("unique visits:", HashSet.size(unique))
`,
      expectedOutput: `unique visits: 2`,
      hints: [
        "A JS Set compares objects by reference. Each literal is a new reference.",
        "Lesson 3 shows a set that compares members by value.",
        "Use HashSet.fromIterable(visits) and HashSet.size."
      ],
      explanation: `\`new Set\` uses \`SameValueZero\`. For objects, that is reference equality, so the 2 \`/home\` literals are 2 members. \`HashSet\` asks each member for its hash and its equality. In v4, plain objects answer by structure, so the duplicates become 1 member. You do not need a \`JSON.stringify\` key trick or a \`uniqBy\` helper. The values carry the rule.`
    },
    {
      id: "trait-c2",
      title: "Half a trait",
      task: `\`Version\` declares that it implements \`Equal.Equal\`, but the program does not compile. Complete the implementation so that it compiles and prints \`true\`. Keep the \`implements\` clause.`,
      code: `import { Equal, Hash } from "effect"

class Version implements Equal.Equal {
  constructor(readonly major: number, readonly minor: number) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Version && this.major === that.major && this.minor === that.minor
  }
}

console.log(Equal.equals(new Version(1, 2), new Version(1, 2)))
`,
      solution: `import { Equal, Hash } from "effect"

class Version implements Equal.Equal {
  constructor(readonly major: number, readonly minor: number) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Version && this.major === that.major && this.minor === that.minor
  }

  [Hash.symbol](): number {
    return Hash.combine(Hash.number(this.major), Hash.number(this.minor))
  }
}

console.log(Equal.equals(new Version(1, 2), new Version(1, 2)))
`,
      expectedOutput: `true`,
      hints: [
        "Read the error. Which property is absent from Version?",
        "Equal.Equal extends Hash.Hash. A value that you can compare must also say which bucket it belongs to.",
        "Add [Hash.symbol]() that returns Hash.combine(Hash.number(this.major), Hash.number(this.minor))."
      ],
      explanation: `The \`Equal\` interface extends \`Hash\`. A class that implements \`Equal.Equal\` must give both \`[Equal.symbol]\` and \`[Hash.symbol]\`. At runtime the comparison alone gave the correct result. This is why the check is at the type level. Without a hash method, \`HashMap\` and \`HashSet\` use a structural hash. That hash can disagree with your equality, and then lookups fail in a way that is hard to find. The compiler makes you write the 2 methods together.`
    },
    {
      id: "trait-c3",
      title: "Equal but not found",
      task: `\`Tag\` compares names without case, and \`Equal.equals\` agrees. But the \`HashSet\` does not find \`Effect\` when \`effect\` is stored. Fix the class so that both lines print \`true\`.`,
      code: `import { Equal, Hash, HashSet } from "effect"

class Tag implements Equal.Equal {
  constructor(readonly name: string) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Tag && this.name.toLowerCase() === that.name.toLowerCase()
  }

  [Hash.symbol](): number {
    return Hash.string(this.name)
  }
}

const tags = HashSet.make(new Tag("effect"), new Tag("typescript"))

console.log(Equal.equals(new Tag("Effect"), new Tag("effect")))
console.log(HashSet.has(tags, new Tag("Effect")))
`,
      solution: `import { Equal, Hash, HashSet } from "effect"

class Tag implements Equal.Equal {
  constructor(readonly name: string) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Tag && this.name.toLowerCase() === that.name.toLowerCase()
  }

  [Hash.symbol](): number {
    return Hash.string(this.name.toLowerCase())
  }
}

const tags = HashSet.make(new Tag("effect"), new Tag("typescript"))

console.log(Equal.equals(new Tag("Effect"), new Tag("effect")))
console.log(HashSet.has(tags, new Tag("Effect")))
`,
      expectedOutput: `true
true`,
      hints: [
        "HashSet checks the hash before it checks equality. What do the 2 tags hash to?",
        "The law from lesson 2: equal values must have equal hashes. Compare the hashed data with the compared data.",
        "Hash the lower-case name: Hash.string(this.name.toLowerCase())."
      ],
      explanation: `\`HashSet.has\` computes the hash of \`Tag("Effect")\`, goes to that bucket, and compares only with the members in that bucket. \`Hash.string("Effect")\` and \`Hash.string("effect")\` are different numbers. The lookup went to an empty bucket and never called \`[Equal.symbol]\`. A hash of the normalized name restores the law "equal values have the same hash". Apply the same transformation before the hash that you apply in the equality.`
    },
    {
      id: "trait-c4",
      title: "Same elements, different type",
      task: `A stream gave a \`Chunk\`, and a test compares it with the expected array. The check prints \`false\`, but the elements are the same. Make it print \`matches: true\`. Compare values of the same type.`,
      code: `import { Chunk, Equal } from "effect"

const expected = [3, 1, 2]
const received = Chunk.make(3, 1, 2)   // what a stream handed us

console.log("matches:", Equal.equals(received, expected))
`,
      solution: `import { Chunk, Equal } from "effect"

const expected = [3, 1, 2]
const received = Chunk.make(3, 1, 2)   // what a stream handed us

console.log("matches:", Equal.equals(Chunk.toArray(received), expected))
`,
      expectedOutput: `matches: true`,
      hints: [
        "Equal.equals uses the [Equal.symbol] of the Chunk. That method accepts only another Chunk.",
        "Convert one side, so that both sides are the same kind of value.",
        "Use Chunk.toArray(received), or Chunk.fromIterable(expected)."
      ],
      explanation: `Structural equality is still typed equality. A \`Chunk\` implements \`[Equal.symbol]\`, and the first check in that method is "is that value also a Chunk?". An array is not a Chunk, so the result is \`false\` for each content. This is intended: \`Option.some([1])\` is also not equal to \`[1]\`. \`Chunk.toArray\` or \`Chunk.fromIterable\` makes the intent explicit, and then the comparison has a meaning.`
    }
  ],
  problems: [
    {
      id: "trait-p1",
      title: "GPS readings without duplicates",
      spec: `
A device reports its position every few seconds, with a small error. 2 readings are the same location when the latitude and the longitude are the same after you round them to 2 decimals.

1. Write \`class Point implements Equal.Equal\` with \`lat\` and \`lng\`. Round with \`Math.round(v * 100) / 100\` in \`[Equal.symbol]\` and in \`[Hash.symbol]\`. Use \`Hash.combine\` and \`Hash.number\`.
2. Put the 6 readings below in a \`HashSet\`. Print the number of unique locations.
3. Check membership with new points for Paris \`(48.86, 2.35)\` and Berlin \`(52.52, 13.41)\`.

Readings: \`(48.8566, 2.3522)\`, \`(48.8571, 2.3519)\`, \`(51.5074, -0.1278)\`, \`(51.51, -0.13)\`, \`(40.7128, -74.006)\`, \`(40.7135, -74.0059)\`.

Exact output:

\`\`\`
unique locations: 3
seen Paris: true
seen Berlin: false
\`\`\`
`,
      starter: `import { Equal, Hash, HashSet } from "effect"

const round2 = (v: number) => Math.round(v * 100) / 100

// TODO: class Point implements Equal.Equal, comparing and hashing rounded lat/lng
class Point {
  constructor(readonly lat: number, readonly lng: number) {}
}

const readings = [
  new Point(48.8566, 2.3522),
  new Point(48.8571, 2.3519),
  new Point(51.5074, -0.1278),
  new Point(51.51, -0.13),
  new Point(40.7128, -74.006),
  new Point(40.7135, -74.0059)
]

// TODO: build a HashSet and print "unique locations: N"
// TODO: print "seen Paris: ..." and "seen Berlin: ..." using fresh Points
`,
      solution: `import { Equal, Hash, HashSet } from "effect"

const round2 = (v: number) => Math.round(v * 100) / 100

class Point implements Equal.Equal {
  constructor(readonly lat: number, readonly lng: number) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Point
      && round2(this.lat) === round2(that.lat)
      && round2(this.lng) === round2(that.lng)
  }

  // Hash exactly what equality compares: the rounded values
  [Hash.symbol](): number {
    return Hash.combine(Hash.number(round2(this.lat)), Hash.number(round2(this.lng)))
  }
}

const readings = [
  new Point(48.8566, 2.3522),
  new Point(48.8571, 2.3519),
  new Point(51.5074, -0.1278),
  new Point(51.51, -0.13),
  new Point(40.7128, -74.006),
  new Point(40.7135, -74.0059)
]

const locations = HashSet.fromIterable(readings)

console.log("unique locations:", HashSet.size(locations))
console.log("seen Paris:", HashSet.has(locations, new Point(48.86, 2.35)))
console.log("seen Berlin:", HashSet.has(locations, new Point(52.52, 13.41)))
`,
      expectedOutput: `unique locations: 3
seen Paris: true
seen Berlin: false`,
      hints: [
        "Add `implements Equal.Equal` and the 2 symbol methods. The compiler reports a method that is absent.",
        "In [Equal.symbol], first check `that instanceof Point`. Then compare round2 of each field.",
        "Hash.combine(Hash.number(round2(this.lat)), Hash.number(round2(this.lng))) keeps the hash consistent with the equality."
      ]
    },
    {
      id: "trait-p2",
      title: "Case-insensitive usernames",
      spec: `
Usernames are unique without case: if \`ada\` exists, \`Ada\` cannot register. Build a registry on top of \`HashMap\`:

1. \`class Username implements Equal.Equal\` holds a \`raw\` string. The equality and the hash use \`raw.toLowerCase()\`.
2. \`register(registry, name, email)\` returns the **new** registry. If the name exists (\`HashMap.has\`), print \`taken: <name>\` and return the registry unchanged. Otherwise print \`registered <name>\` and return \`HashMap.set(...)\`.
3. Register \`ada\`, \`lin\`, then \`Ada\`. Print the number of users, and the email for \`ADA\`. Use \`HashMap.get\` and \`Option.getOrElse\`.

Exact output:

\`\`\`
registered ada
registered lin
taken: Ada
users: 2
lookup ADA: ada@example.com
\`\`\`
`,
      starter: `import { Equal, Hash, HashMap, Option } from "effect"

// TODO: class Username implements Equal.Equal (case-insensitive on raw)
class Username {
  constructor(readonly raw: string) {}
}

type Registry = HashMap.HashMap<Username, string>

// TODO: register(registry, name, email): Registry

let registry: Registry = HashMap.empty()
// TODO: register "ada" (ada@example.com), "lin" (lin@example.com), "Ada" (other@example.com)
// TODO: print "users: N" and "lookup ADA: <email>"
`,
      solution: `import { Equal, Hash, HashMap, Option } from "effect"

class Username implements Equal.Equal {
  constructor(readonly raw: string) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Username && this.raw.toLowerCase() === that.raw.toLowerCase()
  }

  [Hash.symbol](): number {
    return Hash.string(this.raw.toLowerCase())
  }
}

type Registry = HashMap.HashMap<Username, string>

// Returns a new registry: HashMap.set never mutates the one it was given
const register = (registry: Registry, name: string, email: string): Registry => {
  const key = new Username(name)
  if (HashMap.has(registry, key)) {
    console.log("taken: " + name)
    return registry
  }
  console.log("registered " + name)
  return HashMap.set(registry, key, email)
}

let registry: Registry = HashMap.empty()
registry = register(registry, "ada", "ada@example.com")
registry = register(registry, "lin", "lin@example.com")
registry = register(registry, "Ada", "other@example.com")

console.log("users:", HashMap.size(registry))
console.log("lookup ADA:", HashMap.get(registry, new Username("ADA")).pipe(Option.getOrElse(() => "not found")))
`,
      expectedOutput: `registered ada
registered lin
taken: Ada
users: 2
lookup ADA: ada@example.com`,
      hints: [
        "Both symbol methods must use raw.toLowerCase(), never raw.",
        "register must return the map from HashMap.set. Keep it with registry = register(...).",
        "HashMap.get returns an Option. Convert it with Option.getOrElse(() => \"not found\")."
      ]
    }
  ],
  recall: [
    {
      q: "What does `Equal.equals({ a: [1, 2] }, { a: [1, 2] })` return in Effect v4? Why was v3 different?",
      a: "`true`. v4 compares plain objects and arrays by structure by default. In v3, `Equal.equals` used reference equality for plain objects. You had to wrap them with `Data.struct`, which no longer exists."
    },
    {
      q: "Which 2 methods must a class define to take part in Effect equality? What is the law that connects them?",
      a: "`[Equal.symbol](that): boolean` and `[Hash.symbol](): number`. The law: if 2 values are equal, their hashes must be equal. Hash the same normalized data that you compare. If you do not, `HashMap` and `HashSet` lookups fail."
    },
    {
      q: "What would the type of `Equal.asEquivalence<string>()` be? When do you use it?",
      a: "`Equivalence<string>`, which is `(a: string, b: string) => boolean`. Use it to give structural equality to a function that takes a comparison function, for example `Array.dedupeWith` or `Array.differenceWith`."
    },
    {
      q: "Which collection would you use to count different `{ city, country }` records?",
      a: "`HashSet.fromIterable(records)`, then `HashSet.size`. A JS `Set` counts each object literal, because it compares by reference."
    },
    {
      q: "Why is `Equal.equals(Chunk.make(1), [1])` false? How do you compare them?",
      a: "A `Chunk` accepts only another `Chunk` as a candidate for equality. An array is a different type. Convert one side: `Equal.equals(Chunk.toArray(chunk), [1])` or `Equal.equals(chunk, Chunk.fromIterable([1]))`."
    }
  ]
}

export default section
