// @vitest-environment happy-dom
/**
 * src/client/theme.ts: resolving system/light/dark from storage + media query, cycling,
 * persistence, the theme event, and the class / data attribute on <html>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LIGHT_QUERY,
  THEME_EVENT,
  THEME_KEY,
  applyTheme,
  currentTheme,
  cycleMode,
  getStoredMode,
  initTheme,
  lightThemeClass,
  nextMode,
  resolveTheme,
  setMode
} from "../../src/client/theme"

const lightClasses = lightThemeClass.split(" ")

/** Fake matchMedia: `prefersLight` drives `.matches`; `fire()` simulates an OS change. */
function fakeMedia(prefersLight: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: prefersLight,
    media: LIGHT_QUERY,
    addEventListener: vi.fn((_: string, cb: () => void) => { listeners.add(cb) }),
    removeEventListener: vi.fn((_: string, cb: () => void) => { listeners.delete(cb) })
  }
  const fn = vi.fn((q: string) => { expect(q).toBe(LIGHT_QUERY); return mql })
  vi.stubGlobal("matchMedia", fn)
  return { mql, fire: (matches: boolean) => { mql.matches = matches; listeners.forEach((cb) => cb()) }, listeners }
}

const html = () => document.documentElement

beforeEach(() => {
  localStorage.clear()
  html().className = ""
  delete html().dataset.theme
  html().style.colorScheme = ""
})
afterEach(() => vi.unstubAllGlobals())

describe("theme class", () => {
  it("is a non-empty StyleX theme class", () => {
    expect(lightThemeClass.trim()).not.toBe("")
    expect(lightClasses.length).toBeGreaterThan(0)
  })
})

describe("resolving", () => {
  it("system follows the media query, light/dark ignore it", () => {
    expect(resolveTheme("system", true)).toBe("light")
    expect(resolveTheme("system", false)).toBe("dark")
    expect(resolveTheme("light", false)).toBe("light")
    expect(resolveTheme("dark", true)).toBe("dark")
  })

  it("getStoredMode reads the storage key; unknown values mean system", () => {
    expect(getStoredMode()).toBe("system")
    localStorage.setItem(THEME_KEY, "light")
    expect(getStoredMode()).toBe("light")
    localStorage.setItem(THEME_KEY, "dark")
    expect(getStoredMode()).toBe("dark")
    localStorage.setItem(THEME_KEY, "blue")
    expect(getStoredMode()).toBe("system")
  })

  it("initTheme applies the OS preference when nothing is stored", () => {
    fakeMedia(true)
    initTheme()
    expect(currentTheme()).toBe("light")
    expect(html().dataset.theme).toBe("light")
    for (const c of lightClasses) expect(html().classList.contains(c)).toBe(true)
    expect(html().style.colorScheme).toBe("light")
  })

  it("initTheme prefers the stored choice over the OS preference", () => {
    fakeMedia(true)
    localStorage.setItem(THEME_KEY, "dark")
    initTheme()
    expect(currentTheme()).toBe("dark")
    for (const c of lightClasses) expect(html().classList.contains(c)).toBe(false)
  })
})

describe("applyTheme", () => {
  it("adds the class, data attribute and color-scheme for light and removes them for dark", () => {
    html().classList.add("keep-me")
    applyTheme("light")
    for (const c of lightClasses) expect(html().classList.contains(c)).toBe(true)
    expect(html().dataset.theme).toBe("light")
    expect(html().style.colorScheme).toBe("light")
    applyTheme("dark")
    for (const c of lightClasses) expect(html().classList.contains(c)).toBe(false)
    expect(html().classList.contains("keep-me")).toBe(true)
    expect(html().dataset.theme).toBe("dark")
    expect(html().style.colorScheme).toBe("dark")
  })

  it("dispatches THEME_EVENT on document with the resolved theme", () => {
    const listener = vi.fn()
    document.addEventListener(THEME_EVENT, listener)
    applyTheme("light")
    applyTheme("dark")
    expect(listener).toHaveBeenCalledTimes(2)
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toBe("light")
    expect((listener.mock.calls[1]![0] as CustomEvent).detail).toBe("dark")
    document.removeEventListener(THEME_EVENT, listener)
  })
})

describe("cycling", () => {
  it("nextMode goes System -> Light -> Dark -> System", () => {
    expect(nextMode("system")).toBe("light")
    expect(nextMode("light")).toBe("dark")
    expect(nextMode("dark")).toBe("system")
  })

  it("cycleMode persists each step and applies it immediately", () => {
    fakeMedia(false)
    expect(cycleMode()).toBe("light")
    expect(localStorage.getItem(THEME_KEY)).toBe("light")
    expect(currentTheme()).toBe("light")
    expect(cycleMode()).toBe("dark")
    expect(localStorage.getItem(THEME_KEY)).toBe("dark")
    expect(currentTheme()).toBe("dark")
    expect(cycleMode()).toBe("system")
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(currentTheme()).toBe("dark") // OS is dark
  })

  it("setMode('system') resolves through the media query", () => {
    fakeMedia(true)
    expect(setMode("system")).toBe("light")
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(currentTheme()).toBe("light")
  })
})

describe("OS changes", () => {
  it("system mode follows prefers-color-scheme changes; explicit modes do not", () => {
    const media = fakeMedia(false)
    const stop = initTheme()
    expect(currentTheme()).toBe("dark")
    media.fire(true)
    expect(currentTheme()).toBe("light")
    setMode("dark")
    media.fire(true)
    expect(currentTheme()).toBe("dark")
    stop()
    expect(media.listeners.size).toBe(0)
  })
})

describe("storage unavailable", () => {
  it("still applies the theme when localStorage throws", () => {
    fakeMedia(false)
    const blocked = () => { throw new Error("blocked") }
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked })
    expect(getStoredMode()).toBe("system")
    expect(() => setMode("light")).not.toThrow()
    expect(currentTheme()).toBe("light")
  })
})
