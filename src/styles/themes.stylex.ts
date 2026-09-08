import * as stylex from "@stylexjs/stylex"
import { colors } from "./tokens.stylex"

/**
 * Light theme: overrides the `colors` tokens (dark by default). Applied on <html> by the inline
 * script in Base.astro (before paint) and by src/client/theme.ts (toggle / OS changes), so every
 * var(--...) reference in the StyleX styles and in markdown-css.ts flips at once.
 * Values are chosen for >= 4.5:1 contrast of text colors on bg / panel / panel2 / codeBg.
 */
export const lightTheme = stylex.createTheme(colors, {
  bg: "#f7f7f9",
  panel: "#ffffff",
  panel2: "#f1f2f5",
  border: "#dcdfe6",
  text: "#1b1f27",
  muted: "#5b6475",
  accent: "#3b5bdb",
  accent2: "#0f7a55",
  danger: "#c0392b",
  warn: "#9a6414",
  ok: "#0f7a55",
  codeBg: "#f4f5f8",
  /** "white" is the emphasis color (.md strong): near-black on the light palette. */
  white: "#0b0e14",
  doneBorder: "rgba(15, 122, 85, .5)",
  flashRing: "rgba(59, 91, 219, .25)",
  scrim: "rgba(15, 17, 21, .35)"
})
