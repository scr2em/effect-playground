import * as stylex from "@stylexjs/stylex"
import { colors, fonts, bp } from "./tokens.stylex"

export const sidebar = stylex.create({
  root: {
    backgroundColor: colors.panel,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    display: { default: "flex", [bp.mobile]: "none" },
    flexDirection: "column",
    overflowY: "auto",
    position: { default: "static", [bp.mobile]: "fixed" },
    inset: { default: "auto", [bp.mobile]: 0 },
    zIndex: { default: "auto", [bp.mobile]: 10 },
    width: { default: "auto", [bp.mobile]: "min(300px, 85vw)" },
    boxShadow: { default: "none", [bp.mobile]: `0 0 0 100vmax ${colors.scrim}` }
  },
  open: { display: "flex" },
  brand: {
    padding: "18px 18px 12px",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border
  },
  brandTitle: { fontWeight: 700, fontSize: 17 },
  brandLink: { color: "inherit", textDecoration: "none" },
  brandSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  nav: { padding: "8px 0", flex: 1 },
  link: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 18px",
    color: colors.text,
    textDecoration: "none",
    fontSize: 14,
    backgroundColor: { default: "transparent", ":hover": colors.panel2 }
  },
  linkActive: {
    backgroundColor: colors.panel2,
    borderLeftWidth: 3,
    borderLeftStyle: "solid",
    borderLeftColor: colors.accent,
    paddingLeft: 15
  },
  badge: { fontSize: 11, color: colors.muted, fontFamily: fonts.mono },
  badgeDone: { color: colors.ok },
  foot: {
    padding: "12px 18px",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    display: "flex",
    gap: 12
  },
  footLink: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: colors.accent,
    cursor: "pointer",
    padding: 0,
    fontSize: 13,
    fontFamily: fonts.sans,
    textDecoration: "none"
  },
  footLinkActive: { textDecoration: "underline" },
  danger: { color: colors.danger }
})
