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
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { marked } from 'marked'

// ── State ──
let currentFilePath = null
let isDirty = false
let focusModeOn = false
let previewModeOn = false
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

// ── Effects ──
const toggleFocusMode = StateEffect.define()
const focusModeField = StateField.define({
  create: () => false,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(toggleFocusMode)) return e.value
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

// ── Markdown syntax fade highlight ──
const syntaxFadeHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-header-1' },
  { tag: tags.heading2, class: 'cm-header-2' },
  { tag: tags.heading3, class: 'cm-header-3' },
  { tag: tags.strikethrough, class: 'cm-token-faded' },
  { tag: tags.url, class: 'cm-token-faded' },
  { tag: tags.processingInstruction, class: 'cm-token-faded' },
  { tag: tags.meta, class: 'cm-token-faded' },
])

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
        EditorView.baseTheme({
          '&': { fontSize: 'var(--editor-font-size)' },
          '.cm-content': { fontFamily: 'var(--font-mono)' }
        }),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
          { key: 'Mod-s', run: () => { saveFile(); return true } },
          { key: 'Mod-d', run: () => { toggleFocus(); return true } },
          { key: 'Mod-p', run: () => { togglePreview(); return true } },
        ]),
        autocompletion(),
        closeBrackets(),
        // No line numbers — minimalist design
        checkboxPlugin,
        focusModePlugin,
        typewriterScroll,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) { markDirty(); scheduleAutoSave() }
        }),
      ]
    }),
    parent: container
  })

  document.getElementById('empty-state').classList.remove('visible')
  container.style.display = 'block'
  editor.focus()
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

// ── Preview Mode ──
function togglePreview() {
  previewModeOn = !previewModeOn
  const editorContainer = document.getElementById('editor-container')
  const previewContainer = document.getElementById('preview-container')
  const btn = document.getElementById('btn-preview')

  if (previewModeOn) {
    const content = editor ? editor.state.doc.toString() : ''
    previewContainer.innerHTML = marked.parse(content, { breaks: true, gfm: true })
    editorContainer.style.display = 'none'
    previewContainer.style.display = 'block'
    btn.classList.add('active')
  } else {
    editorContainer.style.display = 'block'
    previewContainer.style.display = 'none'
    btn.classList.remove('active')
    if (editor) editor.focus()
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
  const html = marked.parse(content, { breaks: true, gfm: true })
  
  const printWindow = window.open('', '_blank')
  printWindow.document.write(`<!DOCTYPE html><html><head><title>Gabo Export</title>
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
    <style>
      body{font-family:'Bricolage Grotesque',sans-serif;font-size:14pt;line-height:1.75;color:#1a1a1e;max-width:720px;margin:60px auto;padding:0 40px}
      h1{font-weight:800;letter-spacing:-0.03em;margin:1.5em 0 .3em}
      h2{font-weight:700;letter-spacing:-0.03em;margin:1.2em 0 .2em}
      h3{font-weight:600;letter-spacing:-0.03em;margin:1em 0 .15em}
      code{font-family:'JetBrains Mono',monospace;font-size:.85em;background:#f5f5f7;padding:2px 6px;border-radius:4px}
      pre{background:#f5f5f7;border-radius:8px;padding:16px 20px;overflow-x:auto}
      pre code{background:none;padding:0}
      blockquote{border-left:3px solid #2f6de1;padding-left:16px;color:#6b6b76}
      a{color:#2f6de1}
    </style></head><body>${html}</body></html>`)
  printWindow.document.close()
  setTimeout(() => printWindow.print(), 500)
}

// ── Menu/IPC Handlers ──
window.gaboAPI.onMenuOpen(() => openFile())
window.gaboAPI.onMenuSave(() => saveFile())
window.gaboAPI.onMenuExportPdf(() => exportPdf())
window.gaboAPI.onMenuFocus(() => toggleFocus())
window.gaboAPI.onMenuPreview(() => togglePreview())
window.gaboAPI.onMenuZen(() => toggleZen())
window.gaboAPI.onMenuDarkMode(() => toggleDarkMode())

// ── Button Handlers ──
document.getElementById('btn-focus').addEventListener('click', toggleFocus)
document.getElementById('btn-preview').addEventListener('click', togglePreview)
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

// Global keyboard
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewModeOn) togglePreview()
})

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
  createEditor(`# Welcome to Gabo

A minimalist, distraction-free markdown editor.

- [ ] Try focus mode with \`Cmd+D\`
- [ ] Toggle preview with \`Cmd+P\`
- [ ] Enter zen mode with \`Cmd+Enter\`
- [x] Start writing

## Focus

Only the sentence you're writing matters. Press \`Cmd+D\` to dim everything else.

## Write

Start typing. Auto-save has your back.

---

*Inspired by Gabriel Garcia Marquez. Built with love.*`);
  updateTitle();
});