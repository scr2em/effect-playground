/**
 * src/runtime/format.ts: the console formatter shared by the browser worker and the Node
 * verifier. The spec in ARCHITECTURE.md (Interface 4) wins where it differs from node:util.inspect
 * (double quotes, 72-column single-line rule, depth 4).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Cause, Chunk, Data, Duration, Exit, HashMap, Option, Result, Schema } from "effect"
import { format, installConsole } from "../../src/runtime/format.ts"

class Point {
  constructor(
    public x: number,
    public y: number
  ) {}
}
class Empty {}
class NotFound extends Data.TaggedError("NotFound")<{ id: number }> {}
class Missing extends Schema.TaggedError<Missing>()("Missing", { key: Schema.String }) {}
class E2 extends Error {
  override name = "E2"
}

describe("format", () => {
  describe("primitives", () => {
    it("prints a top-level string as is", () => {
      expect(format(["hello world"])).toBe("hello world")
    })
    it("joins args with one space", () => {
      expect(format(["a", 1, "b", true])).toBe("a 1 b true")
    })
    it("prints numbers like Node", () => {
      expect(format([1, -0, 1.5, NaN, Infinity])).toBe("1 -0 1.5 NaN Infinity")
    })
    it("prints bigint with the n suffix", () => {
      expect(format([10n])).toBe("10n")
    })
    it("prints null and undefined", () => {
      expect(format([null, undefined])).toBe("null undefined")
    })
    it("prints symbols", () => {
      expect(format([Symbol("x")])).toBe("Symbol(x)")
    })
    it("prints functions and classes", () => {
      expect(format([() => 1, function named() {}, class K {}])).toBe("[Function (anonymous)] [Function: named] [class K]")
    })
    it("prints Date as ISO and RegExp as source", () => {
      expect(format([new Date(0)])).toBe("1970-01-01T00:00:00.000Z")
      expect(format([/re/g])).toBe("/re/g")
    })
  })

  describe("nested strings", () => {
    it("quotes a string inside an array", () => {
      expect(format([["x"]])).toBe('[ "x" ]')
    })
    it("escapes quotes and newlines inside nested strings", () => {
      expect(format([{ s: 'he said "hi"\n' }])).toBe('{ s: "he said \\"hi\\"\\n" }')
    })
  })

  describe("arrays and objects", () => {
    it("prints arrays Node-style", () => {
      expect(format([[1, 2, 3]])).toBe("[ 1, 2, 3 ]")
    })
    it("prints empty containers", () => {
      expect(format([[], {}])).toBe("[] {}")
    })
    it("prints plain objects", () => {
      expect(format([{ a: 1, b: "x" }])).toBe('{ a: 1, b: "x" }')
    })
    it("quotes keys that are not identifiers", () => {
      expect(format([{ "a-b": 1, 2: 3 }])).toBe('{ "2": 3, "a-b": 1 }')
    })
    it("prints typed arrays", () => {
      expect(format([new Uint8Array([1, 2])])).toBe("Uint8Array(2) [ 1, 2 ]")
    })
    it("shows 4 levels of nesting", () => {
      expect(format([{ a: { b: { c: { d: { e: 1 } } } } }])).toBe("{ a: { b: { c: { d: { e: 1 } } } } }")
    })
    it("collapses the 5th level to [Object]", () => {
      expect(format([{ a: { b: { c: { d: { e: { f: 1 } } } } } }])).toBe("{ a: { b: { c: { d: { e: [Object] } } } } }")
    })
    it("collapses deep arrays to [Array]", () => {
      expect(format([[[[[[[1]]]]]]])).toBe("[ [ [ [ [ [Array] ] ] ] ] ]")
    })
    it("marks circular references", () => {
      const circ: Record<string, unknown> = { a: 1 }
      circ.self = circ
      expect(format([circ])).toBe("{ a: 1, self: [Circular] }")
    })

    describe("line breaking at 72 characters", () => {
      it("keeps a short container on one line", () => {
        expect(format([{ min: 4, max: 42, mean: 18 }])).toBe("{ min: 4, max: 42, mean: 18 }")
      })
      it("breaks the top-level container when longer than 72 characters", () => {
        expect(
          format([{ name: "a very long string that goes on and on", list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], nested: { x: 1 } }])
        ).toBe('{\n  name: "a very long string that goes on and on",\n  list: [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ],\n  nested: { x: 1 }\n}')
      })
      it("breaks a nested container that is too long as well", () => {
        expect(format([{ words: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"] }])).toBe(
          '{\n  words: [\n    "alpha",\n    "bravo",\n    "charlie",\n    "delta",\n    "echo",\n    "foxtrot",\n    "golf",\n    "hotel",\n    "india"\n  ]\n}'
        )
      })
      it("keeps grouped arrays on one line when short", () => {
        expect(format([[[1, 2, 3], [4, 5, 6], [7]]])).toBe("[ [ 1, 2, 3 ], [ 4, 5, 6 ], [ 7 ] ]")
      })
    })
  })

  describe("class instances", () => {
    it("prefixes with the class name", () => {
      expect(format([new Point(1, 2)])).toBe("Point { x: 1, y: 2 }")
    })
    it("prints an empty instance", () => {
      expect(format([new Empty()])).toBe("Empty {}")
    })
    it("prints null-prototype objects", () => {
      expect(format([Object.create(null)])).toBe("[Object: null prototype] {}")
    })
  })

  describe("Map and Set", () => {
    it("prints Map entries with =>", () => {
      expect(format([new Map([["a", 1]])])).toBe('Map(1) { "a" => 1 }')
    })
    it("prints Set values", () => {
      expect(format([new Set([1, 2])])).toBe("Set(2) { 1, 2 }")
    })
    it("prints an empty Map", () => {
      expect(format([new Map()])).toBe("Map(0) {}")
    })
  })

  describe("Error", () => {
    it("prints Name: message without a stack", () => {
      expect(format([new Error("bad")])).toBe("Error: bad")
    })
    it("uses the subclass name", () => {
      expect(format([new E2("m")])).toBe("E2: m")
    })
    it("prints only the name when there is no message", () => {
      expect(format([new TypeError()])).toBe("TypeError")
    })
  })

  describe("Effect values (inspect.custom)", () => {
    it("Option", () => {
      expect(format([Option.some(1)])).toBe('{ _id: "Option", _tag: "Some", value: 1 }')
      expect(format([Option.none()])).toBe('{ _id: "Option", _tag: "None" }')
    })
    it("Chunk", () => {
      expect(format([Chunk.make(1, 2, 3)])).toBe('{ _id: "Chunk", values: [ 1, 2, 3 ] }')
    })
    it("Cause", () => {
      expect(format([Cause.fail("x")])).toBe('{ _id: "Cause", failures: [ { _tag: "Fail", error: "x" } ] }')
    })
    it("Exit", () => {
      expect(format([Exit.succeed(1)])).toBe('{ _id: "Exit", _tag: "Success", value: 1 }')
    })
    it("Duration", () => {
      expect(format([Duration.seconds(2)])).toBe('{ _id: "Duration", _tag: "Millis", millis: 2000 }')
    })
    it("Result", () => {
      expect(format([Result.fail("e")])).toBe('{ _id: "Result", _tag: "Failure", failure: "e" }')
    })
    it("HashMap", () => {
      expect(format([HashMap.make(["a", 1])])).toBe('{ _id: "HashMap", values: [ [ "a", 1 ] ] }')
    })
    it("Data.TaggedError uses inspect.custom, not the Error rule", () => {
      expect(format([new NotFound({ id: 1 })])).toBe('{ id: 1, _tag: "NotFound" }')
    })
    it("Schema.TaggedError uses inspect.custom, not the Error rule", () => {
      expect(format([new Missing({ key: "k" })])).toBe('{ _tag: "Missing", key: "k" }')
    })
    it("uses a string returned by inspect.custom as is", () => {
      expect(format([{ [Symbol.for("nodejs.util.inspect.custom")]: () => "<custom>" }])).toBe("<custom>")
    })
    it("formats an Effect value nested in an object", () => {
      expect(format([{ o: Option.some("x") }])).toBe('{ o: { _id: "Option", _tag: "Some", value: "x" } }')
    })
  })
})

describe("installConsole", () => {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    table: console.table,
    error: console.error,
    warn: console.warn
  }
  afterEach(() => {
    Object.assign(console, original)
  })

  const capture = () => {
    const out: Array<string> = []
    const err: Array<string> = []
    installConsole({ out: (l) => out.push(l), err: (l) => err.push(l) })
    return { out, err }
  }

  it("routes log, info and debug to out", () => {
    const { out, err } = capture()
    console.log("a", 1)
    console.info({ b: 2 })
    console.debug([3])
    expect(out).toEqual(["a 1", "{ b: 2 }", "[ 3 ]"])
    expect(err).toEqual([])
  })
  it("routes error and warn to err", () => {
    const { out, err } = capture()
    console.error("bad", new Error("x"))
    console.warn("careful")
    expect(err).toEqual(["bad Error: x", "careful"])
    expect(out).toEqual([])
  })
  it("routes table to out through format", () => {
    const { out } = capture()
    console.table([{ c: 4 }])
    expect(out).toEqual(["[ { c: 4 } ]"])
  })
})
