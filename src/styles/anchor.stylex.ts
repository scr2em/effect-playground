import * as stylex from "@stylexjs/stylex"
import { colors } from "./tokens.stylex"

/** Put `heading` on the h1/h2/h3/summary so the "#" link appears when it is hovered. */
export const heading = stylex.defineMarker()

export const anchor = stylex.create({
  link: {
    color: { default: colors.muted, ":hover": colors.accent },
    textDecoration: "none",
    fontWeight: 400,
    opacity: { default: 0, [stylex.when.ancestor(":hover", heading)]: 1, ":focus": 1 },
    transition: "opacity .15s",
    fontSize: ".85em",
    marginLeft: 2
  },
  copied: {
    "::after": { content: '" copied"', fontSize: 11, color: colors.ok }
  }
})
