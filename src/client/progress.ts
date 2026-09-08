/**
 * localStorage persistence (Interface 5 keys):
 *   effect-playground:done          { [itemId]: timestamp }
 *   effect-playground:draft:<id>    editor contents
 *   effect-playground:height:<id>   editor height in px
 */
const PREFIX = "effect-playground:"
const DONE_KEY = `${PREFIX}done`
export const PROGRESS_EVENT = "effect-playground:progress"

function get<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function set(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
function del(key: string): void {
  try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
}

export function doneMap(): Record<string, number> {
  return get<Record<string, number>>(DONE_KEY, {})
}
export function isDone(id: string): boolean {
  return doneMap()[id] != null
}
export function markDone(id: string): void {
  const d = doneMap()
  d[id] = Date.now()
  set(DONE_KEY, d)
  document.dispatchEvent(new CustomEvent(PROGRESS_EVENT))
}

export function getDraft(id: string): string | null {
  return get<string | null>(`${PREFIX}draft:${id}`, null)
}
export function setDraft(id: string, code: string): void {
  set(`${PREFIX}draft:${id}`, code)
}
export function clearDraft(id: string): void {
  del(`${PREFIX}draft:${id}`)
}

export function getHeight(id: string): number | null {
  return get<number | null>(`${PREFIX}height:${id}`, null)
}
export function setHeight(id: string, px: number): void {
  set(`${PREFIX}height:${id}`, px)
}

/** Removes every key this app owns (completion marks, drafts, heights). */
export function resetAll(): void {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach(del)
  } catch { /* storage unavailable */ }
  document.dispatchEvent(new CustomEvent(PROGRESS_EVENT))
}
