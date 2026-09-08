import * as stylex from "@stylexjs/stylex"

/** Palette from the legacy dark design (legacy/style.css :root). */
export const colors = stylex.defineVars({
  bg: "#0f1115",
  panel: "#171a21",
  panel2: "#1e222b",
  border: "#2a2f3a",
  text: "#e6e8ee",
  muted: "#8b93a7",
  accent: "#7c9cff",
  accent2: "#5ee0b3",
  danger: "#ff7b7b",
  warn: "#ffcc66",
  ok: "#5ee0b3",
  codeBg: "#0b0d12",
  white: "#fff",
  doneBorder: "rgba(94, 224, 179, .45)",
  flashRing: "rgba(124, 156, 255, .25)",
  scrim: "rgba(0, 0, 0, .5)"
})

export const fonts = stylex.defineVars({
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif'
})

export const radii = stylex.defineVars({
  sm: "4px",
  md: "6px",
  lg: "8px",
  xl: "10px",
  pill: "999px"
})

/** Breakpoint shared by the responsive rules (defineConsts so StyleX can inline it). */
export const bp = stylex.defineConsts({ mobile: "@media (max-width: 800px)" })
