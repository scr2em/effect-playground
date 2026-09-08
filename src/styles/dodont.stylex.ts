import * as stylex from "@stylexjs/stylex"
import { colors } from "./tokens.stylex"

export const dodont = stylex.create({
  table: { borderCollapse: "collapse", margin: "8px 0 16px", width: "100%", fontSize: 14 },
  cell: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    padding: "7px 10px",
    textAlign: "left",
    verticalAlign: "top",
    width: "33%"
  },
  head: { backgroundColor: colors.panel2 },
  do: { borderLeftWidth: 3, borderLeftColor: colors.ok },
  dont: { borderLeftWidth: 3, borderLeftColor: colors.danger }
})
