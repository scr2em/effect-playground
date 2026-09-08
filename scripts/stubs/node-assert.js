// Browser stand-in for `node:assert`, which effect/testing/TestSchema.js imports. Only
// deepStrictEqual is used there. Structural comparison by own enumerable keys and prototype.
class AssertionError extends Error {
  constructor(message) {
    super(message)
    this.name = "AssertionError"
    this.code = "ERR_ASSERTION"
  }
}

function isDeepStrictEqual(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (seen.get(a) === b) return true
  seen.set(a, b)
  if (a instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof RegExp) return String(a) === String(b)
  if (a instanceof Map) {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !isDeepStrictEqual(v, b.get(k), seen)) return false
    return true
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }
  const ka = Reflect.ownKeys(a).filter((k) => Object.prototype.propertyIsEnumerable.call(a, k))
  const kb = Reflect.ownKeys(b).filter((k) => Object.prototype.propertyIsEnumerable.call(b, k))
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.propertyIsEnumerable.call(b, k)) return false
    if (!isDeepStrictEqual(a[k], b[k], seen)) return false
  }
  return true
}

function describe(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function deepStrictEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new AssertionError(message ?? `Expected values to be strictly deep-equal:\n${describe(actual)}\n\nshould equal\n\n${describe(expected)}`)
  }
}

export function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(message ?? `Expected values to be strictly equal:\n${describe(actual)} !== ${describe(expected)}`)
  }
}

export function ok(value, message) {
  if (!value) throw new AssertionError(message ?? "The expression evaluated to a falsy value")
}

export function fail(message) {
  throw new AssertionError(message ?? "Failed")
}

export { AssertionError }
export default Object.assign(ok, { deepStrictEqual, strictEqual, ok, fail, AssertionError })
