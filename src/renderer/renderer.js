// ═══════════════════════════════════════════════
// Gabo — Minimalist Markdown Editor (Renderer)
// ═══════════════════════════════════════════════
// This file is bundled with esbuild into renderer.bundle.js
// It uses ES module imports which esbuild handles.

import { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from '@codemirror/view'
import { EditorState, StateField, StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'

// ── State ──
let currentFilePath = null
let isDirty = false
let focusModeOn = false
let mdModeOn = false       // false = visual (hide syntax), true = show raw markdown
let zenModeOn = false
let darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches
let editor = null
let autoSaveTimer = null
let switcherSelectedIndex = 0
let switcherFiles = []

// ── Dark mode init ──
if (localStorage.getItem('gabo-dark') !== null) {
  darkMode = localStorage.getItem('gabo-dark') === 'true'
}
if (darkMode) document.body.classList.add('dark')

// ── Auto-sync with system theme (only if user hasn't manually set a preference) ──
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (localStorage.getItem('gabo-dark') === null) {
    darkMode = e.matches
    document.body.classList.toggle('dark', darkMode)
  }
})

// ── Effects ──
const toggleFocusMode = StateEffect.define()
const toggleMdModeEffect = StateEffect.define()

const focusModeField = StateField.define({
  create: () => false,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(toggleFocusMode)) return e.value
    return value
  }
})

const mdModeField = StateField.define({
  create: () => mdModeOn,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(toggleMdModeEffect)) return e.value
    return value
  }
})

// ── Focus mode dimming plugin ──
const focusModePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.buildDecorations(view) }
  update(update) { this.decorations = this.buildDecorations(update.view) }
  buildDecorations(view) {
    const state = view.state.field(focusModeField)
    if (!state) return Decoration.none
    const pos = view.state.selection.main.head
    const line = view.state.doc.lineAt(pos)
    const decorations = []
    for (let i = 1; i <= view.state.doc.lines; i++) {
      if (i !== line.number) {
        const l = view.state.doc.line(i)
        decorations.push(Decoration.line({ class: 'cm-dimmed-line' }).range(l.from))
      }
    }
    return Decoration.set(decorations, true)
  }
}, { decorations: v => v.decorations })

// ── Syntax fade highlight (always applied for heading styles) ──
const syntaxFadeHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-header-1' },
  { tag: tags.heading2, class: 'cm-header-2' },
  { tag: tags.heading3, class: 'cm-header-3' },
  { tag: tags.strikethrough, class: 'cm-token-faded' },
  { tag: tags.url, class: 'cm-token-faded' },
  { tag: tags.processingInstruction, class: 'cm-token-faded' },
  { tag: tags.meta, class: 'cm-token-faded' },
  { tag: tags.strong, class: 'cm-visual-bold' },
  { tag: tags.emphasis, class: 'cm-visual-italic' },
  { tag: tags.monospace, class: 'cm-visual-code' },
  { tag: tags.link, class: 'cm-visual-link' },
])

// ── Visual mode: hide markdown syntax when not in MD mode ──
// This plugin hides `#`, `**`, `*`, `` ` ``, `~~`, `[text](url)` syntax
// when the editor is in visual mode (default).
const syntaxHidingPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.buildDecorations(view) }
  update(update) {
    if (update.docChanged || update.viewportChanged ||
        update.transactions.some(tr => tr.effects.some(e => e.is(toggleMdModeEffect)))) {
      this.decorations = this.buildDecorations(update.view)
    }
  }
  buildDecorations(view) {
    const showMd = view.state.field(mdModeField)
    if (showMd) return Decoration.none

    const decorations = []
    const doc = view.state.doc
    const lineCount = doc.lines

    for (let i = 1; i <= lineCount; i++) {
      const line = doc.line(i)
      const text = line.text
      const lineStart = line.from

      // Hide heading markers: # ## ### etc.
      const headingMatch = text.match(/^(#{1,6})\s+/)
      if (headingMatch) {
        const end = headingMatch[0].length
        decorations.push(
          Decoration.replace({}).range(lineStart, lineStart + end)
        )
      }

      // Hide bold markers: **text** or __text__
      let match
      const boldRe = /(\*\*|__)(?=\S)(.*?\S)\1/g
      while ((match = boldRe.exec(text)) !== null) {
        const markerLen = match[1].length
        // Hide opening marker
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index, lineStart + match.index + markerLen)
        )
        // Hide closing marker
        const closingStart = match.index + match[0].length - markerLen
        decorations.push(
          Decoration.replace({}).range(lineStart + closingStart, lineStart + closingStart + markerLen)
        )
      }

      // Hide italic markers: *text* or _text_ (but not inside bold)
      const italicRe = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g
      while ((match = italicRe.exec(text)) !== null) {
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index, lineStart + match.index + 1)
        )
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index + match[0].length - 1, lineStart + match.index + match[0].length)
        )
      }

      // Hide inline code backticks: `code`
      const codeRe = /`([^`]+)`/g
      while ((match = codeRe.exec(text)) !== null) {
        // Opening backtick
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index, lineStart + match.index + 1)
        )
        // Closing backtick
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index + match[0].length - 1, lineStart + match.index + match[0].length)
        )
      }

      // Hide strikethrough markers: ~~text~~
      const strikeRe = /~~(.+?)~~/g
      while ((match = strikeRe.exec(text)) !== null) {
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index, lineStart + match.index + 2)
        )
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index + match[0].length - 2, lineStart + match.index + match[0].length)
        )
      }

      // Hide link syntax, show only link text: [text](url) → text
      const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g
      while ((match = linkRe.exec(text)) !== null) {
        // Hide [ and ](url)
        decorations.push(
          Decoration.replace({}).range(lineStart + match.index, lineStart + match.index + 1)
        )
        const urlStart = match.index + 1 + match[1].length
        decorations.push(
          Decoration.replace({}).range(lineStart + urlStart, lineStart + urlStart + 3 + match[2].length)
        )
      }

      // Hide image syntax: ![alt](url) — show just alt text with image indicator
      const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
      while ((match = imgRe.exec(text)) !== null) {
        decorations.push(
          Decoration.replace({ widget: new ImageWidget(match[1], match[2]) }).range(
            lineStart + match.index, lineStart + match.index + match[0].length
          )
        )
      }

      // Horizontal rule: --- or *** or ___ → decorative line
      if (/^(---|\*\*\*|___)\s*$/.test(text.trim())) {
        decorations.push(
          Decoration.replace({ widget: new HrWidget() }).range(lineStart, lineStart + text.length)
        )
      }

      // Blockquote: hide > prefix
      const bqMatch = text.match(/^(\s*>\s?)/)
      if (bqMatch) {
        decorations.push(
          Decoration.replace({}).range(lineStart, lineStart + bqMatch[0].length)
        )
        // Add blockquote line decoration
        decorations.push(
          Decoration.line({ class: 'cm-blockquote-line' }).range(lineStart)
        )
      }

      // Unordered list: replace -, *, + with bullet, just hide marker
      const ulMatch = text.match(/^(\s*)([-*+])\s/)
      if (ulMatch && !headingMatch) {
        // Hide the marker character
        const markerPos = ulMatch[1].length
        decorations.push(
          Decoration.replace({ widget: new BulletWidget() }).range(
            lineStart + markerPos, lineStart + markerPos + 1
          )
        )
      }

      // Ordered list: replace 1. with styled number
      const olMatch = text.match(/^(\s*)(\d+\.)\s/)
      if (olMatch) {
        decorations.push(
          Decoration.replace({ widget: new NumberWidget(olMatch[2]) }).range(
            lineStart + olMatch[1].length, lineStart + olMatch[1].length + olMatch[2].length
          )
        )
      }
    }

    // Sort and build the set
    try {
      decorations.sort((a, b) => a.from - b.from || a.to - b.to)
      return Decoration.set(decorations, true)
    } catch (e) {
      return Decoration.none
    }
  }
}, { decorations: v => v.decorations })

// ── Visual mode widgets ──
class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span')
    span.textContent = '•'
    span.className = 'cm-visual-bullet'
    return span
  }
  eq() { return true }
}

class NumberWidget extends WidgetType {
  constructor(num) { super(); this.num = num }
  toDOM() {
    const span = document.createElement('span')
    span.textContent = this.num
    span.className = 'cm-visual-number'
    return span
  }
  eq(other) { return this.num === other.num }
}

class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr')
    hr.className = 'cm-visual-hr'
    return hr
  }
  eq() { return true }
}

class ImageWidget extends WidgetType {
  constructor(alt, url) { super(); this.alt = alt; this.url = url }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-visual-image'
    span.textContent = this.alt ? `🖼 ${this.alt}` : '🖼 image'
    span.title = this.url
    return span
  }
  eq(other) { return this.alt === other.alt && this.url === other.url }
}

// ── Checkbox widget ──
class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked }
  toDOM() {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.style.cssText = 'margin-right:8px;cursor:pointer;accent-color:var(--accent);width:16px;height:16px;vertical-align:middle;'
    input.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = editor.posAtDOM(input)
      const line = editor.state.doc.lineAt(pos)
      const text = line.text
      const newText = this.checked ? text.replace('[x]', '[ ]') : text.replace('[ ]', '[x]')
      editor.dispatch({ changes: { from: line.from, to: line.to, insert: newText } })
    })
    return input
  }
  eq(other) { return this.checked === other.checked }
}

const checkboxPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.buildDecorations(view) }
  update(update) { this.decorations = this.buildDecorations(update.view) }
  buildDecorations(view) {
    const decorations = []
    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i)
      const text = line.text.trimStart()
      if (text.startsWith('- [ ]') || text.startsWith('- [x]') || text.startsWith('* [ ]') || text.startsWith('* [x]')) {
        const checked = text.includes('[x]')
        const variants = checked ? ['- [x]', '* [x]'] : ['- [ ]', '* [ ]']
        for (const marker of variants) {
          const markerStart = line.text.indexOf(marker)
          if (markerStart >= 0) {
            decorations.push(
              Decoration.replace({ widget: new CheckboxWidget(checked), inclusive: false })
                .range(line.from + markerStart, line.from + markerStart + marker.length + 1)
            )
            break
          }
        }
      }
    }
    return Decoration.set(decorations, true)
  }
}, { decorations: v => v.decorations })

// ── Typewriter scrolling ──
const typewriterScroll = EditorView.updateListener.of((update) => {
  if (update.docChanged || update.selectionSet) {
    const pos = update.state.selection.main.head
    const coords = update.view.lineBlockAt(pos)
    const wrapper = document.getElementById('editor-wrapper')
    if (wrapper) {
      const targetScroll = coords.top - wrapper.clientHeight * 0.4
      if (!update.transactions.some(tr => tr.isUserEvent('scroll'))) {
        wrapper.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
      }
    }
  }
})

// ── Create Editor ──
function createEditor(content = '') {
  const container = document.getElementById('editor-container')
  if (editor) editor.destroy()

  editor = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(syntaxFadeHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        focusModeField,
        mdModeField,
        EditorView.baseTheme({
          '&': { fontSize: 'var(--editor-font-size)' },
          '.cm-content': { fontFamily: 'var(--font-display)', letterSpacing: 'var(--letter-spacing)' }
        }),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
          { key: 'Mod-s', run: () => { saveFile(); return true } },
          { key: 'Mod-d', run: () => { toggleFocus(); return true } },
          { key: 'Mod-shift-m', run: () => { toggleMdMode(); return true } },
        ]),
        closeBrackets(),
        checkboxPlugin,
        syntaxHidingPlugin,
        focusModePlugin,
        typewriterScroll,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) { markDirty(); scheduleAutoSave(); updateWordCount() }
        }),
      ]
    }),
    parent: container
  })

  // Set initial visual/md mode class
  const cmEditor = document.querySelector('.cm-editor')
  if (cmEditor) {
    cmEditor.classList.toggle('md-mode', mdModeOn)
    cmEditor.classList.toggle('visual-mode', !mdModeOn)
  }

  document.getElementById('empty-state').classList.remove('visible')
  container.style.display = 'block'
  editor.focus()
  updateWordCount()
  return editor
}

// ── Focus Mode ──
function toggleFocus() {
  focusModeOn = !focusModeOn
  if (editor) editor.dispatch({ effects: toggleFocusMode.of(focusModeOn) })
  document.getElementById('btn-focus').classList.toggle('active', focusModeOn)
  const cmEditor = document.querySelector('.cm-editor')
  if (cmEditor) cmEditor.classList.toggle('focus-mode', focusModeOn)
  if (editor && !focusModeOn) editor.focus()
}

// ── MD Mode toggle ──
function toggleMdMode() {
  mdModeOn = !mdModeOn
  if (editor) editor.dispatch({ effects: toggleMdModeEffect.of(mdModeOn) })
  const btn = document.getElementById('btn-md')
  if (btn) btn.classList.toggle('active', mdModeOn)
  const cmEditor = document.querySelector('.cm-editor')
  if (cmEditor) {
    cmEditor.classList.toggle('md-mode', mdModeOn)
    cmEditor.classList.toggle('visual-mode', !mdModeOn)
  }
}

// ── Zen Mode ──
function toggleZen() {
  zenModeOn = !zenModeOn
  document.body.classList.toggle('zen-mode', zenModeOn)
  setTimeout(() => { if (editor) editor.requestMeasure() }, 300)
}

// ── Dark Mode ──
function toggleDarkMode() {
  darkMode = !darkMode
  document.body.classList.toggle('dark', darkMode)
  localStorage.setItem('gabo-dark', darkMode)
}

// ── File Operations ──
function markDirty() {
  if (!isDirty && currentFilePath) { isDirty = true; updateTitle() }
}

function updateTitle() {
  const titleEl = document.getElementById('titlebar-title')
  const name = currentFilePath ? currentFilePath.split('/').pop() : 'Gabo'
  titleEl.textContent = isDirty ? `${name} \u2022` : name
}

async function openFile() {
  const result = await window.gaboAPI.openFile()
  if (!result) return
  currentFilePath = result.path
  isDirty = false
  createEditor(result.content)
  updateTitle()
  localStorage.setItem('gabo-last-file', result.path)
}

async function saveFile() {
  if (!editor) return
  const content = editor.state.doc.toString()
  if (currentFilePath) {
    await window.gaboAPI.saveFile(currentFilePath, content)
    isDirty = false; updateTitle()
  } else {
    const newPath = await window.gaboAPI.saveFileAs(content)
    if (newPath) { currentFilePath = newPath; isDirty = false; updateTitle(); localStorage.setItem('gabo-last-file', newPath) }
  }
}

function updateWordCount() {
  const el = document.getElementById('word-count')
  if (!el || !editor) return
  const text = editor.state.doc.toString()
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const chars = text.length
  el.textContent = words === 0 ? '' : `${words.toLocaleString()} words · ${chars.toLocaleString()} chars`
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    if (currentFilePath && editor) {
      window.gaboAPI.saveFile(currentFilePath, editor.state.doc.toString())
      isDirty = false; updateTitle()
    }
  }, 2000)
}

// ── File Switcher ──
async function openSwitcher() {
  const dir = currentFilePath
    ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/'))
    : await window.gaboAPI.getDefaultDir()
  switcherFiles = await window.gaboAPI.listFiles(dir)
  switcherSelectedIndex = 0
  document.getElementById('switcher-input').value = ''
  renderSwitcherList()
  document.getElementById('switcher-overlay').classList.add('open')
  document.getElementById('switcher-input').focus()
}

async function loadFileFromSwitcher(filePath) {
  const result = await window.gaboAPI.openFileByPath(filePath)
  if (!result) return
  currentFilePath = result.path
  isDirty = false
  createEditor(result.content)
  updateTitle()
  localStorage.setItem('gabo-last-file', result.path)
  closeSwitcher()
}

function renderSwitcherList() {
  const listEl = document.getElementById('switcher-list')
  const query = document.getElementById('switcher-input').value.toLowerCase()
  const filtered = switcherFiles.filter(f => f.name.toLowerCase().includes(query))
  listEl.innerHTML = ''
  filtered.forEach((f, i) => {
    const li = document.createElement('li')
    li.className = 'switcher-item' + (i === switcherSelectedIndex ? ' selected' : '')
    const timeStr = new Date(f.modified).toLocaleString()
    li.innerHTML = `<span class="file-icon">\uD83D\uDCC4</span><span class="file-name">${f.name}</span><span class="file-time">${timeStr}</span>`
    li.addEventListener('click', () => loadFileFromSwitcher(f.path))
    listEl.appendChild(li)
  })
}

function closeSwitcher() {
  document.getElementById('switcher-overlay').classList.remove('open')
  if (editor) editor.focus()
}

// ── Export to PDF ──
async function exportPdf() {
  if (!editor) return
  const content = editor.state.doc.toString()
  const { marked } = await import('marked')
  const body = marked.parse(content, { breaks: true, gfm: true })

  // Build a self-contained HTML document for PDF rendering.
  // Fonts are embedded via Google Fonts so the hidden BrowserWindow can load them.
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Gabo Export</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Bricolage Grotesque', sans-serif; font-size: 13pt; line-height: 1.75; color: #1a1a1e; max-width: 660px; margin: 0 auto; padding: 60px 40px; }
  h1 { font-size: 2em; font-weight: 800; letter-spacing: -0.03em; margin: 1.5em 0 0.3em; }
  h2 { font-size: 1.5em; font-weight: 700; letter-spacing: -0.03em; margin: 1.2em 0 0.25em; }
  h3 { font-size: 1.15em; font-weight: 600; letter-spacing: -0.03em; margin: 1em 0 0.2em; }
  p { margin: 0 0 0.9em; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 0.85em; background: #f5f5f7; padding: 2px 6px; border-radius: 4px; }
  pre { background: #f5f5f7; border-radius: 8px; padding: 16px 20px; overflow-x: auto; margin: 1em 0; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #2f6de1; padding-left: 16px; color: #6b6b76; margin: 1em 0; }
  a { color: #2f6de1; }
  hr { border: none; border-top: 1px solid #dfdfe6; margin: 2em 0; }
  ul, ol { padding-left: 1.5em; margin: 0 0 0.9em; }
  li { margin-bottom: 0.25em; }
  strong { font-weight: 700; }
  em { font-style: italic; }
</style>
</head><body>${body}</body></html>`

  const savedPath = await window.gaboAPI.exportPdf(html)
  if (savedPath) {
    console.log('PDF exported to:', savedPath)
  }
}

// ── Menu/IPC Handlers ──
window.gaboAPI.onMenuOpen(() => openFile())
window.gaboAPI.onMenuSave(() => saveFile())
window.gaboAPI.onMenuExportPdf(() => exportPdf())
window.gaboAPI.onMenuFocus(() => toggleFocus())
window.gaboAPI.onMenuPreview(() => toggleMdMode())
window.gaboAPI.onMenuZen(() => toggleZen())
window.gaboAPI.onMenuDarkMode(() => toggleDarkMode())

// ── Button Handlers ──
document.getElementById('btn-focus').addEventListener('click', toggleFocus)
document.getElementById('btn-md').addEventListener('click', toggleMdMode)
document.getElementById('btn-dark').addEventListener('click', toggleDarkMode)

// ── Switcher Event Handlers ──
document.getElementById('switcher-input').addEventListener('input', () => { switcherSelectedIndex = 0; renderSwitcherList() })
document.getElementById('switcher-input').addEventListener('keydown', (e) => {
  const items = document.querySelectorAll('.switcher-item')
  if (e.key === 'ArrowDown') { e.preventDefault(); switcherSelectedIndex = Math.min(switcherSelectedIndex + 1, items.length - 1); renderSwitcherList() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); switcherSelectedIndex = Math.max(switcherSelectedIndex - 1, 0); renderSwitcherList() }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const filtered = switcherFiles.filter(f => f.name.toLowerCase().includes(document.getElementById('switcher-input').value.toLowerCase()))
    if (filtered[switcherSelectedIndex]) loadFileFromSwitcher(filtered[switcherSelectedIndex].path)
  }
  else if (e.key === 'Escape') closeSwitcher()
})
document.getElementById('switcher-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('switcher-overlay')) closeSwitcher() })

// ── Initialize ──
document.addEventListener('DOMContentLoaded', async () => {
  // Try to restore the last opened file
  const lastFile = localStorage.getItem('gabo-last-file')
  if (lastFile) {
    try {
      const result = await window.gaboAPI.openFileByPath(lastFile)
      if (result) {
        currentFilePath = result.path
        isDirty = false
        createEditor(result.content)
        updateTitle()
        return // Skip welcome screen
      }
    } catch (_) {
      // File may have been moved/deleted — fall through to welcome screen
    }
  }

  createEditor(`# Welcome to Gabo

A minimalist, distraction-free markdown editor.

- [ ] Try focus mode with \`Cmd+D\`
- [ ] Toggle markdown mode with the .MD button
- [ ] Enter zen mode with \`Cmd+Enter\`
- [ ] Start writing

## Focus

Only the paragraph you're writing matters. Press \`Cmd+D\` to dim everything else.

## Visual First

By default, syntax is hidden. Click **.MD** to see raw markdown.

---

*Inspired by Gabriel Garcia Marquez. Built with love.*`);
  updateTitle();
});