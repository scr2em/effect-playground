/**
 * Page-level behavior outside the React island: sidebar progress badges, reset progress,
 * mobile sidebar toggle, card "done" state, and heading anchors (copy link + flash on load).
 * Elements are server-rendered by the .astro templates; state changes recompute their StyleX class.
 */
import * as stylex from "@stylexjs/stylex"
import { doneMap, PROGRESS_EVENT, resetAll } from "./progress"
import { sidebar } from "../styles/sidebar.stylex"
import { card } from "../styles/card.stylex"
import { layout } from "../styles/layout.stylex"
import { anchor } from "../styles/anchor.stylex"

const cls = (...styles: Array<stylex.StyleXStyles | false>) => stylex.props(...styles).className ?? ""

function renderBadges(): void {
  const done = doneMap()
  for (const a of document.querySelectorAll<HTMLAnchorElement>("#nav a[data-items]")) {
    const items = (a.dataset.items ?? "").split(",").filter(Boolean)
    const n = items.filter((id) => done[id] != null).length
    const badge = a.querySelector<HTMLElement>("[data-badge]")
    if (!badge) continue
    badge.textContent = items.length ? `${n}/${items.length}` : ""
    badge.className = cls(sidebar.badge, items.length > 0 && n === items.length && sidebar.badgeDone)
  }
}

const flashing = new Set<Element>()

function applyCard(item: HTMLElement): void {
  const ok = doneMap()[item.dataset.card ?? ""] != null
  item.className = cls(card.item, ok && card.itemDone, flashing.has(item) && card.itemFlash)
  const status = item.querySelector<HTMLElement>("[data-status]")
  if (status) { status.className = cls(card.status, ok && card.statusOk); status.textContent = ok ? "✓ completed" : "" }
}

function applyCards(): void {
  document.querySelectorAll<HTMLElement>("[data-card]").forEach(applyCard)
}

function flash(id: string): void {
  const target = id ? document.getElementById(id) : null
  if (!target) return
  const summary = target.querySelector<HTMLElement>(":scope > summary")
  const paint = (on: boolean) => {
    if (target.hasAttribute("data-card")) { on ? flashing.add(target) : flashing.delete(target); applyCard(target) }
    else if (target.hasAttribute("data-recall") && summary) summary.className = cls(card.recallSummary, on && card.recallSummaryFlash)
    else if (target.tagName === "H2") target.className = cls(layout.part, on && layout.partFlash)
  }
  paint(true)
  setTimeout(() => paint(false), 1500)
}

function setupAnchors(): void {
  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a[data-anchor]")
    if (!a) return
    e.preventDefault()
    const hash = a.getAttribute("href") ?? ""
    const url = location.origin + location.pathname + (hash.startsWith("#") ? hash : "")
    if (hash.startsWith("#")) {
      history.replaceState(null, "", hash)
      document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" })
      flash(hash.slice(1))
    }
    try { void navigator.clipboard.writeText(url) } catch { /* clipboard unavailable */ }
    a.className = cls(anchor.link, anchor.copied)
    setTimeout(() => { a.className = cls(anchor.link) }, 1200)
  })
  const onHash = () => {
    const id = decodeURIComponent(location.hash.slice(1))
    const target = id ? document.getElementById(id) : null
    if (target?.tagName === "DETAILS") (target as HTMLDetailsElement).open = true
    flash(id)
  }
  window.addEventListener("hashchange", onHash)
  onHash()
}

function setupSidebar(): void {
  document.getElementById("reset-progress")?.addEventListener("click", () => {
    if (!confirm("Clear all completion marks and drafts?")) return
    resetAll()
    location.reload()
  })
  const aside = document.getElementById("sidebar")
  const toggle = document.getElementById("sidebar-toggle")
  let open = false
  const setOpen = (v: boolean) => {
    open = v
    if (aside) aside.className = cls(sidebar.root, open && sidebar.open)
    toggle?.setAttribute("aria-expanded", String(open))
  }
  toggle?.addEventListener("click", () => setOpen(!open))
  aside?.addEventListener("click", (e) => { if ((e.target as Element).closest("a")) setOpen(false) })
  document.addEventListener(PROGRESS_EVENT, () => { renderBadges(); applyCards() })
  renderBadges()
}

setupSidebar()
applyCards()
setupAnchors()
