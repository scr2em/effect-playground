import * as stylex from "@stylexjs/stylex"
import { colors, fonts, bp } from "./tokens.stylex"

export const layout = stylex.create({
  body: {
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 1.55
  },
  app: {
    display: "grid",
    gridTemplateColumns: { default: "270px 1fr", [bp.mobile]: "1fr" },
    height: "100vh"
  },
  main: { overflowY: "auto" },
  content: {
    maxWidth: 960,
    marginInline: "auto",
    padding: { default: "32px 40px 120px", [bp.mobile]: "56px 20px 80px" }
  },
  sidebarToggle: {
    display: { default: "none", [bp.mobile]: "block" },
    position: "fixed",
    top: 10,
    left: 10,
    zIndex: 20,
    backgroundColor: colors.panel2,
    color: colors.text,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: fonts.sans,
    cursor: "pointer"
  },
  h1: { fontSize: 30, margin: "0 0 4px" },
  summary: { color: colors.muted, margin: "0 0 24px", fontSize: 16 },
  part: {
    fontSize: 13,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    color: colors.muted,
    margin: "44px 0 12px",
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    scrollMarginTop: 16
  },
  partFlash: { color: colors.accent },
  nextNav: { display: "flex", justifyContent: "space-between", marginTop: 40 },
  nextLink: { color: colors.accent, textDecoration: "none" },
  muted: { color: colors.muted }
})
