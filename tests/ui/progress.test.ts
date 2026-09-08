// @vitest-environment happy-dom
/**
 * src/client/progress.ts: localStorage persistence (Interface 5 keys) and the progress event.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  PROGRESS_EVENT,
  clearDraft,
  doneMap,
  getDraft,
  getHeight,
  isDone,
  markDone,
  resetAll,
  setDraft,
  setHeight
} from "../../src/client/progress"

const DONE_KEY = "effect-playground:done"

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("completion (effect-playground:done)", () => {
  it("isDone is false for unknown ids and doneMap is empty", () => {
    expect(isDone("x")).toBe(false)
    expect(doneMap()).toEqual({})
  })

  it("markDone stores a timestamp under the id and isDone becomes true", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    markDone("lesson-1")
    expect(isDone("lesson-1")).toBe(true)
    expect(isDone("lesson-2")).toBe(false)
    expect(JSON.parse(localStorage.getItem(DONE_KEY)!)).toEqual({ "lesson-1": 1_700_000_000_000 })
  })

  it("markDone keeps earlier completions", () => {
    markDone("a")
    markDone("b")
    expect(Object.keys(doneMap()).sort()).toEqual(["a", "b"])
  })

  it("markDone dispatches PROGRESS_EVENT on document", () => {
    const listener = vi.fn()
    document.addEventListener(PROGRESS_EVENT, listener)
    markDone("a")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]![0]).toBeInstanceOf(CustomEvent)
    document.removeEventListener(PROGRESS_EVENT, listener)
  })

  it("treats corrupt JSON in the done key as empty", () => {
    localStorage.setItem(DONE_KEY, "{not json")
    expect(doneMap()).toEqual({})
    expect(isDone("a")).toBe(false)
  })
})

describe("drafts (effect-playground:draft:<id>)", () => {
  it("getDraft is null when nothing is saved", () => {
    expect(getDraft("x")).toBeNull()
  })

  it("setDraft / getDraft round-trip and use the documented key", () => {
    setDraft("ch-1", 'console.log("hi")\n')
    expect(getDraft("ch-1")).toBe('console.log("hi")\n')
    expect(localStorage.getItem("effect-playground:draft:ch-1")).toBe(JSON.stringify('console.log("hi")\n'))
    expect(getDraft("ch-2")).toBeNull()
  })

  it("clearDraft removes only that draft", () => {
    setDraft("a", "1")
    setDraft("b", "2")
    clearDraft("a")
    expect(getDraft("a")).toBeNull()
    expect(getDraft("b")).toBe("2")
  })
})

describe("heights (effect-playground:height:<id>)", () => {
  it("getHeight is null when nothing is saved", () => {
    expect(getHeight("x")).toBeNull()
  })

  it("setHeight / getHeight round-trip as numbers", () => {
    setHeight("ch-1", 420)
    expect(getHeight("ch-1")).toBe(420)
    expect(localStorage.getItem("effect-playground:height:ch-1")).toBe("420")
  })
})

describe("resetAll", () => {
  it("removes every effect-playground key but leaves other keys alone", () => {
    markDone("a")
    setDraft("a", "code")
    setHeight("a", 300)
    localStorage.setItem("other-app:key", "keep me")

    resetAll()

    expect(isDone("a")).toBe(false)
    expect(getDraft("a")).toBeNull()
    expect(getHeight("a")).toBeNull()
    expect(Object.keys(localStorage).filter((k) => k.startsWith("effect-playground:"))).toEqual([])
    expect(localStorage.getItem("other-app:key")).toBe("keep me")
  })

  it("dispatches PROGRESS_EVENT", () => {
    const listener = vi.fn()
    document.addEventListener(PROGRESS_EVENT, listener)
    resetAll()
    expect(listener).toHaveBeenCalledTimes(1)
    document.removeEventListener(PROGRESS_EVENT, listener)
  })
})

describe("storage unavailable", () => {
  it("markDone still dispatches the event and getters fall back when localStorage throws", () => {
    const blocked = () => { throw new Error("blocked") }
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked })
    const listener = vi.fn()
    document.addEventListener(PROGRESS_EVENT, listener)

    expect(() => markDone("a")).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isDone("a")).toBe(false)
    expect(getDraft("a")).toBeNull()
    expect(getHeight("a")).toBeNull()
    expect(() => setDraft("a", "x")).not.toThrow()
    expect(() => clearDraft("a")).not.toThrow()
    expect(() => resetAll()).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(2)
    document.removeEventListener(PROGRESS_EVENT, listener)
    vi.unstubAllGlobals()
  })
})
