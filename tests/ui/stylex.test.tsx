// @vitest-environment happy-dom
/**
 * Smoke test: the StyleX unplugin (wired through astro.config.mjs -> getViteConfig) compiles the
 * style sheets under Vitest, so stylex.props() returns real class names instead of throwing.
 */
import { describe, expect, it } from "vitest"
import * as stylex from "@stylexjs/stylex"
import { render } from "@testing-library/react"
import { runner } from "../../src/styles/runner.stylex"
import { card } from "../../src/styles/card.stylex"
import { layout } from "../../src/styles/layout.stylex"
import { sidebar } from "../../src/styles/sidebar.stylex"
import { colors, fonts, radii } from "../../src/styles/tokens.stylex"

const classNameOf = ({ className }: { className?: string | undefined }): string => {
  expect(className).toBeTypeOf("string")
  expect(className!.trim()).not.toBe("")
  return className!
}

describe("StyleX compiles under Vitest", () => {
  it("stylex.props on a single style returns a className", () => {
    classNameOf(stylex.props(runner.root))
    classNameOf(stylex.props(card.item))
    classNameOf(stylex.props(layout.app))
    classNameOf(stylex.props(sidebar.root))
  })

  it("combining styles yields more classes than one style alone", () => {
    const one = classNameOf(stylex.props(runner.btn)).split(/\s+/)
    const two = classNameOf(stylex.props(runner.btn, runner.btnPrimary)).split(/\s+/)
    expect(two.length).toBeGreaterThan(0)
    // btnPrimary overrides backgroundColor/color, so the merged set differs from btn alone.
    expect(new Set(two)).not.toEqual(new Set(one))
  })

  it("falsy conditional styles are ignored", () => {
    const tall = false
    const plain = classNameOf(stylex.props(runner.editor))
    const cond = classNameOf(stylex.props(runner.editor, tall && runner.editorTall))
    expect(cond).toBe(plain)
    expect(classNameOf(stylex.props(runner.editor, runner.editorTall))).not.toBe(plain)
  })

  it("design tokens compile to CSS custom property references", () => {
    expect(colors.accent).toMatch(/^var\(--/)
    expect(fonts.mono).toMatch(/^var\(--/)
    expect(radii.lg).toMatch(/^var\(--/)
  })

  it("the className lands on a rendered React element", () => {
    const { container } = render(<div data-testid="x" {...stylex.props(runner.toolbar)} />)
    const el = container.firstElementChild!
    expect(el.className).toBe(classNameOf(stylex.props(runner.toolbar)))
  })
})
