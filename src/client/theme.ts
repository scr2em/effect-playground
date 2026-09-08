/**
 * Color theme: "system" (follow prefers-color-scheme), "light" or "dark", stored under
 * `effect-playground:theme` ("light" | "dark"; absent = system). The resolved theme is applied on
 * <html> as the StyleX light theme class (src/styles/themes.stylex.ts), `data-theme`, and
 * `color-scheme`; `effect-playground:theme` is dispatched on document with the resolved theme so
 * other modules (the CodeMirror editor) can follow. Base.astro inlines the same logic in <head> to
 * paint the right theme before this module loads.
 */
import * as stylex from "@stylexjs/stylex"
import { lightTheme } from "../styles/themes.stylex"

export type ThemeMode = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export const THEME_KEY = "effect-playground:theme"
export const THEME_EVENT = "effect-playground:theme"
export const LIGHT_QUERY = "(prefers-color-scheme: light)"
/** Class names that switch the StyleX tokens to the light palette (space separated). */
export const lightThemeClass = stylex.props(lightTheme).className ?? ""
const lightClasses = lightThemeClass.split(/\s+/).filter(Boolean)

const MODES: ReadonlyArray<ThemeMode> = ["system", "light", "dark"]
export const MODE_LABELS: Record<ThemeMode, string> = { system: "◐ System", light: "☀ Light", dark: "☾ Dark" }

export function getStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

export function systemPrefersLight(): boolean {
  return typeof matchMedia === "function" && matchMedia(LIGHT_QUERY).matches
}

export function resolveTheme(mode: ThemeMode, prefersLight: boolean = systemPrefersLight()): ResolvedTheme {
  return mode === "system" ? (prefersLight ? "light" : "dark") : mode
}

export function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark"
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  if (theme === "light") root.classList.add(...lightClasses)
  else root.classList.remove(...lightClasses)
  root.dataset.theme = theme
  root.style.colorScheme = theme
  document.dispatchEvent(new CustomEvent<ResolvedTheme>(THEME_EVENT, { detail: theme }))
}

export function setMode(mode: ThemeMode): ResolvedTheme {
  try {
    if (mode === "system") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, mode)
  } catch { /* storage unavailable: still apply for this page */ }
  const theme = resolveTheme(mode)
  applyTheme(theme)
  return theme
}

export function nextMode(mode: ThemeMode): ThemeMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]!
}

/** System -> Light -> Dark -> System; persists and applies. Returns the new mode. */
export function cycleMode(): ThemeMode {
  const mode = nextMode(getStoredMode())
  setMode(mode)
  return mode
}

/** Applies the stored mode now and keeps "system" in sync with OS changes. Returns an unsubscribe. */
export function initTheme(): () => void {
  applyTheme(resolveTheme(getStoredMode()))
  if (typeof matchMedia !== "function") return () => {}
  const mq = matchMedia(LIGHT_QUERY)
  const onChange = () => { if (getStoredMode() === "system") applyTheme(resolveTheme("system", mq.matches)) }
  mq.addEventListener("change", onChange)
  return () => mq.removeEventListener("change", onChange)
}
