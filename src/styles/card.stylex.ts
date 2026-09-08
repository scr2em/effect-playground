import * as stylex from "@stylexjs/stylex"
import { colors, fonts, radii } from "./tokens.stylex"

/** Marker on <details> so the summary can react to the [open] state. */
export const recallDetails = stylex.defineMarker()

export const card = stylex.create({
  item: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.xl,
    padding: "18px 20px",
    margin: "14px 0 26px",
    scrollMarginTop: 16
  },
  itemDone: { borderColor: colors.doneBorder },
  itemFlash: { borderColor: colors.accent, boxShadow: `0 0 0 2px ${colors.flashRing}`, transition: "box-shadow .3s" },
  itemHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 },
  h3: { fontSize: 20, margin: 0 },
  status: { fontSize: 12, fontFamily: fonts.mono, color: colors.muted },
  statusOk: { color: colors.ok },
  expected: {
    fontFamily: fonts.mono,
    fontSize: 12,
    backgroundColor: colors.panel2,
    borderRadius: radii.md,
    padding: "8px 10px",
    whiteSpace: "pre-wrap",
    margin: "6px 0 0",
    color: colors.muted
  },
  reveal: {
    marginTop: 12,
    padding: "12px 14px",
    backgroundColor: colors.panel2,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border
  },
  label: { fontSize: 12, color: colors.muted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 },
  recall: { margin: "10px 0", scrollMarginTop: 16 },
  recallSummary: {
    cursor: "pointer",
    padding: "10px 14px",
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderBottomLeftRadius: { default: radii.lg, [stylex.when.ancestor("[open]", recallDetails)]: 0 },
    borderBottomRightRadius: { default: radii.lg, [stylex.when.ancestor("[open]", recallDetails)]: 0 },
    fontWeight: 500
  },
  recallSummaryFlash: { borderColor: colors.accent, boxShadow: `0 0 0 2px ${colors.flashRing}`, transition: "box-shadow .3s" },
  recallBody: {
    padding: "10px 14px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderTopStyle: "none",
    borderRadius: `0 0 ${radii.lg} ${radii.lg}`,
    backgroundColor: colors.panel2
  }
})
