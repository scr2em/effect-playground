/* Effect Playground front-end: sections, Monaco editors, run/check, local progress. */
(() => {
  const state = { sections: [], current: null, monaco: null, editors: new Map() }
  const $ = (sel, el = document) => el.querySelector(sel)
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v)
      else if (k === "html") n.innerHTML = v
      else n.setAttribute(k, v)
    }
    for (const c of children) if (c != null) n.append(c)
    return n
  }
  const md = (s) => el("div", { class: "md", html: marked.parse(s ?? "") })
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
  const parseHash = () => { const [sec, item] = location.hash.slice(1).split("/"); return { sec, item } }
  let suppressHash = false
  function anchor(sectionId, itemId) {
    const href = "#" + sectionId + "/" + itemId
    return el("a", { class: "anchor", href, title: "Copy link to this", onclick: (e) => {
      e.preventDefault()
      suppressHash = true; location.hash = sectionId + "/" + itemId
      const url = location.origin + location.pathname + href
      try { navigator.clipboard.writeText(url) } catch {}
      e.currentTarget.classList.add("copied"); setTimeout(() => e.currentTarget?.classList?.remove("copied"), 1200)
    } }, "#")
  }
  function scrollToItem(itemId) {
    if (!itemId) return
    const target = document.getElementById("item-" + itemId)
    if (target) { target.scrollIntoView({ block: "start" }); target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 1500) }
  }

  // ---------- progress in localStorage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
    del(k) { try { localStorage.removeItem(k) } catch {} }
  }
  const doneKey = "effect-playground:done"
  const isDone = (id) => !!store.get(doneKey, {})[id]
  const markDone = (id) => { const d = store.get(doneKey, {}); d[id] = Date.now(); store.set(doneKey, d); renderNav() }
  const draftKey = (id) => `effect-playground:draft:${id}`

  // ---------- Monaco ----------
  function loadMonaco() {
    return new Promise((resolve) => {
      require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs" } })
      require(["vs/editor/editor.main"], () => {
        const ts = monaco.languages.typescript.typescriptDefaults
        // The server does real type checking with Effect's types; keep Monaco's own checker quiet.
        ts.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
        ts.setCompilerOptions({ target: monaco.languages.typescript.ScriptTarget.ES2022, allowNonTsExtensions: true, strict: true })
        monaco.editor.defineTheme("play", {
          base: "vs-dark", inherit: true, rules: [],
          colors: { "editor.background": "#0b0d12", "editorGutter.background": "#0b0d12" }
        })
        resolve(monaco)
      })
    })
  }

  function makeEditor(container, id, code, onRun) {
    const model = monaco.editor.createModel(code, "typescript", monaco.Uri.parse(`file:///${id}.ts`))
    const editor = monaco.editor.create(container, {
      model, theme: "play", fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false,
      automaticLayout: true, tabSize: 2, lineNumbersMinChars: 3, padding: { top: 10 }, renderLineHighlight: "none",
      fixedOverflowWidgets: true
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRun())
    editor.onDidChangeModelContent(() => store.set(draftKey(id), editor.getValue()))
    state.editors.set(id, editor)
    return editor
  }

  function setMarkers(editor, diagnostics) {
    monaco.editor.setModelMarkers(editor.getModel(), "server", diagnostics.map((d) => ({
      severity: monaco.MarkerSeverity.Error, message: d.message,
      startLineNumber: d.line, startColumn: d.col, endLineNumber: d.endLine, endColumn: d.endCol
    })))
  }

  // ---------- running ----------
  async function run(code) {
    const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
    return res.json()
  }
  const norm = (s) => (s ?? "").replace(/\r\n/g, "\n").trim()
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))

  function renderResult(out, r, expected) {
    const parts = []
    if (r.diagnostics.length) {
      parts.push(`<span class="diag">Type errors (fix these first, the runtime output below is what bun did anyway):\n${r.diagnostics.map((d) => `  line ${d.line}: ${esc(d.message)}`).join("\n")}</span>`)
    }
    if (norm(r.stdout)) parts.push(esc(r.stdout.trimEnd()))
    if (norm(r.stderr)) parts.push(`<span class="stderr">${esc(r.stderr.trim())}</span>`)
    if (r.timedOut) parts.push(`<span class="diag">Timed out after 10s. Is something waiting forever?</span>`)
    if (!norm(r.stdout) && !norm(r.stderr) && !r.diagnostics.length) parts.push(`<span class="meta">(no output)</span>`)
    let pass = null
    if (expected != null) {
      pass = r.diagnostics.length === 0 && !r.timedOut && r.exitCode === 0 && norm(r.stdout) === norm(expected)
      parts.push(pass ? `<span class="pass">✓ Correct</span>` : `<span class="fail">✗ Not yet</span> <span class="meta">expected output:\n${esc(norm(expected))}</span>`)
    }
    parts.push(`<span class="meta">exit ${r.exitCode}${r.timedOut ? " (killed)" : ""} · ${r.durationMs}ms</span>`)
    out.className = "output"
    out.innerHTML = parts.join("\n")
    return pass
  }

  // ---------- code block widget ----------
  function codeBlock({ id, code, expected, kind, hints = [], solution, explanation, tall }) {
    const draft = store.get(draftKey(id), null)
    const wrap = el("div")
    const editorBox = el("div", { class: "editor" + (tall ? " tall" : "") })
    const savedH = store.get("effect-playground:height:" + id, null)
    if (savedH) editorBox.style.height = savedH + "px"
    new ResizeObserver(() => { if (editorBox.offsetHeight) store.set("effect-playground:height:" + id, editorBox.offsetHeight) }).observe(editorBox)
    const out = el("div", { class: "output empty" }, "Press Run (or ⌘/Ctrl+Enter in the editor).")
    const status = el("span", { class: "status" + (isDone(id) ? " ok" : "") }, isDone(id) ? "✓ completed" : "")
    let hintIdx = 0
    const hintText = el("div", { class: "hint-text" })
    const revealBox = el("div")
    let editor

    const doRun = async () => {
      runBtn.disabled = true; runBtn.textContent = "Running…"
      out.className = "output"; out.textContent = "…"
      try {
        const r = await run(editor.getValue())
        setMarkers(editor, r.diagnostics)
        const pass = renderResult(out, r, expected)
        if (pass) { markDone(id); status.className = "status ok"; status.textContent = "✓ completed"; wrap.closest(".item")?.classList.add("done"); if (explanation && !$(".reveal.why", revealBox)) revealBox.append(el("div", { class: "reveal why" }, el("div", { class: "label" }, "Why this works"), md(explanation))) }
      } catch (e) {
        out.className = "output"; out.innerHTML = `<span class="diag">Request failed: ${esc(String(e))}</span>`
      } finally { runBtn.disabled = false; runBtn.textContent = kind === "lesson" ? "Run" : "Run & check" }
    }
    const runBtn = el("button", { class: "btn primary", onclick: doRun }, kind === "lesson" ? "Run" : "Run & check")
    const resetBtn = el("button", { class: "btn ghost", onclick: () => { editor.setValue(code); store.del(draftKey(id)); setMarkers(editor, []) } }, "Reset")
    const toolbar = el("div", { class: "toolbar" }, runBtn, resetBtn)
    if (hints.length) {
      toolbar.append(el("button", { class: "btn", onclick: () => { hintText.textContent = `Hint ${Math.min(hintIdx + 1, hints.length)}/${hints.length}: ${hints[Math.min(hintIdx, hints.length - 1)]}`; hintIdx++ } }, "Hint"))
    }
    if (solution) {
      toolbar.append(el("button", { class: "btn", onclick: () => {
        if ($(".reveal.sol", revealBox)) return
        const pre = el("pre", {}, el("code", {}, solution))
        revealBox.append(el("div", { class: "reveal sol" }, el("div", { class: "label" }, "Solution"), el("div", { class: "md" }, pre),
          el("button", { class: "btn", onclick: () => editor.setValue(solution) }, "Load solution into editor")))
      } }, "Show solution"))
    }
    toolbar.append(el("span", { class: "spacer" }), el("span", { class: "kbd" }, "⌘/Ctrl + Enter"))
    wrap.append(editorBox, toolbar, hintText, out, revealBox)
    // create editor after it's in the DOM
    queueMicrotask(() => { editor = makeEditor(editorBox, id, draft ?? code, doRun) })
    return { wrap, status }
  }

  // ---------- section rendering ----------
  function renderSection(s, itemId) {
    state.current = s.id
    suppressHash = true; location.hash = itemId ? s.id + "/" + itemId : s.id
    for (const e of state.editors.values()) e.getModel()?.dispose(), e.dispose()
    state.editors.clear()
    const c = $("#content"); c.innerHTML = ""
    c.append(el("h1", {}, s.title, " ", anchor(s.id, "top")), el("p", { class: "summary" }, s.summary), md(s.intro))

    if (s.lessons.length) c.append(el("h2", { class: "part", id: "item-learn" }, "Learn ", anchor(s.id, "learn")))
    for (const l of s.lessons) {
      const item = el("div", { class: "item", id: "item-" + l.id })
      const block = codeBlock({ id: l.id, code: l.code, kind: "lesson" })
      item.append(el("div", { class: "item-head" }, el("h3", {}, l.title, " ", anchor(s.id, l.id))), md(l.explain), block.wrap)
      if (l.after) item.append(el("div", { class: "reveal" }, el("div", { class: "label" }, "Notice"), md(l.after)))
      c.append(item)
    }

    if (s.challenges.length) c.append(el("h2", { class: "part", id: "item-fix-it" }, "Fix it ", anchor(s.id, "fix-it")), md("Each program below is broken or incomplete. Make it print the expected output with zero type errors. Use hints before the solution."))
    s.challenges.forEach((ch, i) => {
      const item = el("div", { class: "item" + (isDone(ch.id) ? " done" : ""), id: "item-" + ch.id })
      const block = codeBlock({ id: ch.id, code: ch.code, expected: ch.expectedOutput, kind: "challenge", hints: ch.hints, solution: ch.solution, explanation: ch.explanation })
      item.append(el("div", { class: "item-head" }, el("h3", {}, `${i + 1}. ${ch.title}`, " ", anchor(s.id, ch.id)), block.status), md(ch.task),
        el("div", { class: "expected" }, "expected output:\n" + ch.expectedOutput), block.wrap)
      c.append(item)
    })

    if (s.problems.length) c.append(el("h2", { class: "part", id: "item-build-it" }, "Build it ", anchor(s.id, "build-it")), md("Write the program from the spec. The output must match exactly."))
    s.problems.forEach((p, i) => {
      const item = el("div", { class: "item" + (isDone(p.id) ? " done" : ""), id: "item-" + p.id })
      const block = codeBlock({ id: p.id, code: p.starter, expected: p.expectedOutput, kind: "problem", hints: p.hints, solution: p.solution, tall: true })
      item.append(el("div", { class: "item-head" }, el("h3", {}, `${i + 1}. ${p.title}`, " ", anchor(s.id, p.id)), block.status), md(p.spec),
        el("div", { class: "expected" }, "expected output:\n" + p.expectedOutput), block.wrap)
      c.append(item)
    })

    if (s.recall.length) c.append(el("h2", { class: "part", id: "item-recall" }, "Recall ", anchor(s.id, "recall")), md("Answer in your head first, then reveal. Come back to these tomorrow."))
    s.recall.forEach((r, i) => { const rid = "recall-" + (i + 1); c.append(el("details", { class: "recall", id: "item-" + rid }, el("summary", {}, r.q, " ", anchor(s.id, rid)), md(r.a))) })

    const idx = state.sections.findIndex((x) => x.id === s.id)
    const prev = state.sections[idx - 1], next = state.sections[idx + 1]
    c.append(el("div", { class: "next-nav" },
      prev ? el("a", { href: "#" + prev.id, onclick: (e) => { e.preventDefault(); renderSection(prev); $("#main").scrollTo(0, 0) } }, "← " + prev.title) : el("span"),
      next ? el("a", { href: "#" + next.id, onclick: (e) => { e.preventDefault(); renderSection(next); $("#main").scrollTo(0, 0) } }, next.title + " →") : el("span")))
    renderNav()
    if (itemId && itemId !== "top") requestAnimationFrame(() => scrollToItem(itemId))
  }

  function renderScratch() {
    state.current = "scratch"; suppressHash = true; location.hash = "scratch"
    for (const e of state.editors.values()) e.getModel()?.dispose(), e.dispose()
    state.editors.clear()
    const c = $("#content"); c.innerHTML = ""
    c.append(el("h1", {}, "Scratchpad"), el("p", { class: "summary" }, "Try anything. Same type checker and runtime as the lessons."))
    const block = codeBlock({ id: "scratch", code: `import { Effect } from "effect"\n\nconst program = Effect.gen(function* () {\n  const n = yield* Effect.succeed(41)\n  console.log(n + 1)\n})\n\nEffect.runPromise(program)\n`, kind: "lesson", tall: true })
    c.append(el("div", { class: "item" }, block.wrap))
    renderNav()
  }

  function renderNav() {
    const nav = $("#nav"); nav.innerHTML = ""
    for (const s of state.sections) {
      const items = [...s.challenges, ...s.problems]
      const done = items.filter((i) => isDone(i.id)).length
      const a = el("a", { href: "#" + s.id, class: state.current === s.id ? "active" : "", onclick: (e) => { e.preventDefault(); renderSection(s); $("#main").scrollTo(0, 0) } },
        el("span", {}, s.title), el("span", { class: "badge" + (items.length && done === items.length ? " done" : "") }, items.length ? `${done}/${items.length}` : ""))
      nav.append(a)
    }
  }

  async function init() {
    const [sections] = await Promise.all([fetch("/api/content").then((r) => r.json()), loadMonaco()])
    state.sections = sections
    $("#scratch-btn").addEventListener("click", renderScratch)
    $("#reset-progress").addEventListener("click", () => { if (confirm("Clear all completion marks and drafts?")) { Object.keys(localStorage).filter((k) => k.startsWith("effect-playground:")).forEach((k) => store.del(k)); renderNav(); if (state.current) { const s = sections.find((x) => x.id === state.current); s ? renderSection(s) : renderScratch() } } })
    const route = () => {
      const { sec, item } = parseHash()
      if (sec === "scratch") return renderScratch()
      const target = sections.find((s) => s.id === sec)
      if (target && state.current === target.id && item) return scrollToItem(item)
      renderSection(target ?? sections[0], target ? item : undefined)
    }
    window.addEventListener("hashchange", () => { if (suppressHash) { suppressHash = false; return } route() })
    route()
  }
  init()
})()
