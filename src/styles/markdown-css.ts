/**
 * Plain CSS for HTML produced by marked/shiki at build time (.md descendants). StyleX has no
 * descendant selectors and these elements are not rendered by our templates, so this block is
 * inlined by Base.astro. Colors come from the StyleX tokens (var(--...) references).
 */
import { colors, fonts, radii } from "./tokens.stylex"

export const markdownCss = `
.md p { margin: 0 0 12px; }
.md ul, .md ol { margin: 0 0 12px; padding-left: 22px; }
.md li { margin: 3px 0; }
.md code { font-family: ${fonts.mono}; font-size: 13px; background: ${colors.panel2}; padding: 1px 5px; border-radius: ${radii.sm}; }
.md pre, pre.shiki { background: ${colors.codeBg} !important; border: 1px solid ${colors.border}; border-radius: ${radii.lg}; padding: 12px 14px; overflow-x: auto; font-size: 13px; line-height: 1.5; font-family: ${fonts.mono}; margin: 0 0 12px; }
.md pre code, pre.shiki code { background: none; padding: 0; font-family: inherit; font-size: inherit; }
.md table { border-collapse: collapse; margin: 8px 0 16px; width: 100%; font-size: 14px; }
.md th, .md td { border: 1px solid ${colors.border}; padding: 7px 10px; text-align: left; vertical-align: top; }
.md th { background: ${colors.panel2}; }
.md blockquote { border-left: 3px solid ${colors.accent}; margin: 0 0 12px; padding: 4px 14px; color: ${colors.muted}; }
.md strong { color: ${colors.white}; }
.md a { color: ${colors.accent}; }
.md > :last-child { margin-bottom: 0; }
/* shiki dual themes (markdown.ts, defaultColor: false): pick the token color for the active theme
   (html[data-theme] is set by the inline script in Base.astro / src/client/theme.ts; no attribute = dark). */
html:not([data-theme="light"]) .shiki, html:not([data-theme="light"]) .shiki span { color: var(--shiki-dark); }
html[data-theme="light"] .shiki, html[data-theme="light"] .shiki span { color: var(--shiki-light); }
[data-fallback] > pre.shiki { border: none; border-radius: 0; margin: 0; min-height: 100%; }
`
