# Gabo — Improvements Backlog

> Living document. Ideas ordered roughly by impact vs effort. Status: 💡 idea · 🔨 planned · 🚧 in progress · ✅ done

---

## 🤖 AI Integration (highest priority, most impact)

### Concept: Contextual AI Menu

Select text → right-click (or ⌘J) → floating AI panel appears with preset actions and a free-form prompt. AI rewrites, corrects, expands, or generates in-place. User accepts, rejects, or inserts below.

**Trigger options (can support all three):**
- Right-click on selected text → native-style context menu with "Ask AI…" + presets
- Floating toolbar that appears above any selection (Notion-style)
- Keyboard shortcut ⌘J opens the AI panel with or without selection

**Preset actions:**
| Action | Prompt sent to model |
|---|---|
| ✨ Improve writing | Rewrite this to be clearer and more engaging, keeping the same meaning |
| 📝 Fix grammar | Fix grammar, spelling and punctuation. Return only the corrected text |
| 📏 Make shorter | Shorten this while keeping all key ideas |
| 📖 Expand | Expand this with more detail and examples |
| 🎯 Make formal | Rewrite in a professional, formal tone |
| 💬 Make casual | Rewrite in a conversational, natural tone |
| 🌍 Translate… | Translate to [user specifies language] |
| 💡 Summarize | Summarize in 1–3 sentences |
| ❓ Explain | Explain this clearly as if to a non-expert |
| 🔄 Rephrase | Rewrite in a completely different way with the same meaning |
| 💬 Custom prompt | User types their own instruction |

**Response UI:**
- Streams output into an overlay panel next to the selection
- Shows original vs proposed side by side (or below)
- Actions: **Replace** · **Insert below** · **Copy** · **Discard**
- Escape always discards

---

### Connection Options

#### Option A — Ollama (local, recommended default)
- Runs on `http://localhost:11434`
- OpenAI-compatible endpoint: `/v1/chat/completions`
- No API key needed, fully private, works offline
- Models: `llama3.2`, `mistral`, `phi4`, `gemma3`, etc.
- **Best for**: privacy-first users, offline writing

```
Endpoint: http://localhost:11434/v1
Model:    llama3.2
Key:      (none)
```

#### Option B — Anthropic Claude API
- `https://api.anthropic.com/v1/messages`
- Requires `ANTHROPIC_API_KEY`
- Models: `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`
- Different request format from OpenAI (needs adapter in main process)
- **Best for**: highest quality prose improvement

#### Option C — OpenAI API
- `https://api.openai.com/v1/chat/completions`
- Requires `OPENAI_API_KEY`
- Models: `gpt-4o`, `gpt-4o-mini`
- **Best for**: users already paying for OpenAI

#### Option D — Groq / Together / any OpenAI-compatible provider
- Same format as OpenAI, just a different base URL
- Groq: ultra-fast inference, generous free tier
- **Best for**: fast responses on a budget

#### Option E — Hermes Agent (internal/MCP call)
- If Hermes exposes a local REST API or MCP server, call it directly
- Could pass document context as an MCP resource
- Gabo would act as an MCP client, Hermes as the AI host
- **Best for**: tight integration with existing Hermes setup, shared context across apps
- **Needs**: Hermes API spec / MCP endpoint details

---

### Technical Implementation Plan

```
Renderer (user action)
  → IPC: 'ai-complete' { action, selectedText, customPrompt, context }
Main process (ai-complete handler)
  → reads config (endpoint, key, model) from userData/config.json
  → makes POST to provider API
  → streams chunks back via webContents.send('ai-chunk', text)
Renderer
  → appends chunks to response panel in real time
  → on done: shows Accept / Insert / Discard
```

**Key points:**
- API keys live **only** in the main process — never exposed to the renderer (security)
- Keys stored in `app.getPath('userData')/config.json` (not localStorage)
- Streaming via SSE keeps the UI responsive for long responses
- Provider is abstracted: a single adapter normalises Ollama / OpenAI / Anthropic formats

**Settings modal** (⌘, or via palette):
- Provider dropdown: Ollama · Claude · OpenAI · Custom
- Base URL field (pre-filled per provider)
- API key field (stored securely, masked)
- Model name field
- Test connection button

---

## ✍️ Editor Quality

### Smarter list continuation 💡
When pressing Enter inside a list, auto-continue the list marker (`-`, `1.`, `- [ ]`). Currently Enter just creates a blank line.

### Better heading spacing ✅
Add visible margin above/below heading lines in visual mode so the document feels more like a rendered page.

### Word wrap at sentence boundary 💡
Optionally soft-wrap at sentence ends (`. `) rather than arbitrary column width, for easier paragraph reading.

### Typewriter mode improvements 💡
Current typewriter scroll keeps cursor at 40% of viewport. Should pause when user scrolls manually and resume on next keypress.

### Find & Replace panel 💡
CodeMirror has `@codemirror/search` already bundled. Wire Cmd+H to open the replace panel (currently only Cmd+F/search is available).

### Code block language highlighting 💡
Add `@codemirror/language-data` support so fenced code blocks (```js, ```python) get syntax-highlighted.

---

## 📁 File Management

### Folder sidebar / drawer 💡
A collapsible left sidebar listing all `.md` files in the current folder. Toggle with Cmd+Shift+E. Inspired by iA Writer's library panel.

### Pinned / recent files 💡
Command palette "Browse Files" could show a "Pinned" section at the top (manually pinned files) and "Recent" (last 10 opened).

### File templates 💡
New Note (Cmd+N) could offer optional templates: Daily note, Meeting notes, Blog post outline, etc.

### iCloud / Obsidian vault support 💡
Let the user point Gabo at an iCloud Drive or Obsidian vault folder and treat it as the file library. No sync logic needed — just open files from there.

### External change detection 💡
Watch the current file with `fs.watch`. If it changes on disk (another editor, sync), prompt the user to reload.

---

## 🎨 Visual & UX

### Custom accent color 💡
Let the user pick their accent colour (currently hardcoded blue/purple). A small colour picker in settings.

### Font size control 💡
Cmd+Plus / Cmd+Minus to increase/decrease `--editor-font-size`. Persist in localStorage.

### Typeface picker 💡
Offer 2–3 editor font options: Bricolage Grotesque (current), a serif (e.g. Lora), a monospace (JetBrains Mono). Toggle in settings.

### Focus sentence mode 💡
A tighter variant of focus mode that dims everything except the **current sentence**, not just the current line.

### Progress / goal bar 💡
Optional word-count goal (e.g. 500 words). Shows a thin accent-coloured progress bar at the bottom as you write toward the target.

### Smooth dark/light transition ✅
Animate the colour change on theme toggle with CSS transitions on `body`, `.cm-editor`, titlebar, and key UI elements.

---

## 📤 Export & Sharing

### Export to HTML 💡
Save a self-contained `.html` file (inline CSS, fonts as base64) that renders correctly without internet.

### Copy as rich text 💡
"Copy as Rich Text" menu item — converts markdown to RTF/HTML for pasting into email clients, Notion, etc.

### Better PDF export 💡
Current implementation loads HTML in a hidden window. Improve with proper page margins, running headers (filename), page numbers.

### Share to Apple Notes 💡
One-click "Send to Apple Notes" via AppleScript (`osascript`). Useful as a quick way to archive a note.

---

## ⚙️ Settings & Config

### Settings modal (Cmd+,) 💡
A structured settings screen instead of editing code. Would cover:
- AI provider & API key
- Default font & size
- Editor line height
- Accent colour
- Default new-note directory
- Auto-save interval

### Multiple windows 💡
Allow opening a second Gabo window (Cmd+Shift+N) to edit two files side by side.

### Session restore 💡
On relaunch, restore all previously open files and scroll positions.

---

## 🔒 Security / Technical Debt

### Preload sandbox 🔨
Currently `sandbox: false` is required for `preload.js` to use `require('electron')`. Migrate to a pure `contextBridge` approach compatible with `sandbox: true`.

### Config file encryption 💡
API keys in `config.json` are plaintext. Use Electron's `safeStorage` API to encrypt them at rest.

### Error boundaries 💡
Unhandled promise rejections in file ops (rename, save, open) should show a non-blocking toast notification rather than failing silently.

### Bundle splitting 💡
`renderer.bundle.js` is 1.1 MB. Split CodeMirror and marked into separate chunks loaded on demand to improve startup time.

---

*Last updated: 2026-04-26*
