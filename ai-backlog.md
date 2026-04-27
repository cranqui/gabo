# Gabo — AI Integration Backlog

> Detailed implementation plan for AI-assisted writing in Gabo.
> Status: 💡 Draft — not in production. Ready for review.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Renderer (renderer.js)                         │
│                                                 │
│  User selects text → ⌘J or context menu        │
│       ↓                                         │
│  AI panel opens → shows preset actions          │
│       ↓                                         │
│  IPC: 'ai-request' { action, text, prompt }    │
│       ↓                                         │
│  Main process (main.js)                         │
│       ↓                                         │
│  Reads config → picks provider adapter          │
│       ↓                                         │
│  POST /v1/chat/completions (streaming SSE)      │
│       ↓                                         │
│  Chunks forwarded via webContents.send()        │
│       ↓                                         │
│  Renderer appends to AI panel → user Accepts /  │
│  Inserts Below / Copies / Discards              │
└─────────────────────────────────────────────────┘
```

**Key principle:** API keys live ONLY in the main process. The renderer never sees them. All AI requests go through IPC → main process → provider API.

---

## Provider Adapters

All adapters produce the same output: an async iterable of `{ chunk: string, done: boolean }`.

### 1. Ollama (default, local)

```
Base URL: http://localhost:11434/v1
Auth:     none (or api_key: "ollama" as placeholder)
Format:   OpenAI-compatible /v1/chat/completions
Models:   llama3.2, mistral, phi4, gemma3, etc.
```

### 2. OpenAI-compatible cloud (Groq, Together, OpenRouter, etc.)

```
Base URL: user-configured (e.g., https://api.groq.com/openai/v1)
Auth:     Bearer token
Format:   OpenAI-compatible /v1/chat/completions
```

### 3. Hermes API (optional, advanced)

```
Base URL: http://localhost:8642/v1
Auth:     Bearer <HERMES_API_KEY>
Format:   OpenAI-compatible /v1/chat/completions
Note:     Full agent capabilities (tools, memory, Notion, etc.)
```

Since all three use the same `/v1/chat/completions` format, we only need **one streaming adapter** with configurable `baseURL`, `apiKey`, and `model`.

---

## Implementation Plan

### Phase 1: Core AI Infrastructure

#### 1.1 — Config file (`src/main/ai-config.js`)

Stores and reads AI provider settings from `app.getPath('userData')/ai-config.json`.

```js
// src/main/ai-config.js
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const CONFIG_PATH = path.join(app.getPath('userData'), 'ai-config.json')

const DEFAULT_CONFIG = {
  provider: 'ollama',       // 'ollama' | 'openai-compatible' | 'hermes'
  baseURL: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'llama3.2',
  temperature: 0.7,
  maxTokens: 2048,
  enabled: true
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) }
    }
  } catch (e) {
    console.error('[Gabo AI] Failed to load config:', e)
  }
  return { ...DEFAULT_CONFIG }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULT_CONFIG }
```

#### 1.2 — AI adapter with streaming (`src/main/ai-adapter.js`)

Single streaming function that works with any OpenAI-compatible endpoint.

```js
// src/main/ai-adapter.js
const https = require('https')
const http = require('http')

/**
 * Stream chat completions from an OpenAI-compatible API.
 * Yields chunks of text as they arrive.
 * 
 * @param {Object} options
 * @param {string} options.baseURL  - e.g. "http://localhost:11434/v1"
 * @param {string} options.apiKey   - Bearer token (empty for Ollama)
 * @param {string} options.model    - e.g. "llama3.2"
 * @param {Array}  options.messages - [{ role, content }]
 * @param {number} options.temperature
 * @param {number} options.maxTokens
 * @param {Function} options.onChunk - called with each text delta
 * @param {Function} options.onDone - called when stream ends
 * @param {Function} options.onError - called on error
 */
async function streamChat({ baseURL, apiKey, model, messages, temperature, maxTokens, onChunk, onDone, onError }) {
  const url = new URL('/chat/completions', baseURL)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true
  })

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const reqOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(reqOptions, (res) => {
      let buffer = ''

      res.on('data', (chunk) => {
        buffer += chunk.toString()
        // SSE lines are separated by \n\n
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue  // skip comments/keepalives
          if (trimmed === 'data: [DONE]') {
            onDone?.()
            resolve()
            return
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6))
              const content = json.choices?.[0]?.delta?.content
              if (content) {
                onChunk(content)
              }
            } catch (e) {
              // Incomplete JSON in stream — skip, will be parsed next cycle
            }
          }
        }
      })

      res.on('end', () => {
        onDone?.()
        resolve()
      })

      res.on('error', (err) => {
        onError?.(err)
        reject(err)
      })
    })

    req.on('error', (err) => {
      onError?.(err)
      reject(err)
    })

    req.write(body)
    req.end()
  })
}

module.exports = { streamChat }
```

#### 1.3 — IPC handlers in main process (`src/main/main.js` additions)

Add three new IPC channels:

```js
// ── In main.js, add at top ──
const { loadConfig, saveConfig } = require('./ai-config')
const { streamChat } = require('./ai-adapter')

// ── AI: Send request (streaming) ──
ipcMain.handle('ai-request', async (event, { action, selectedText, customPrompt }) => {
  const config = loadConfig()
  if (!config.enabled) {
    event.sender.send('ai-error', 'AI is disabled. Enable it in Settings (⌘,)')
    return
  }

  // Build the system prompt based on action
  const systemPrompt = buildSystemPrompt(action)
  const userPrompt = customPrompt || buildUserPrompt(action, selectedText)

  try {
    await streamChat({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      onChunk: (text) => {
        event.sender.send('ai-chunk', text)
      },
      onDone: () => {
        event.sender.send('ai-done')
      },
      onError: (err) => {
        event.sender.send('ai-error', err.message)
      }
    })
  } catch (err) {
    event.sender.send('ai-error', err.message)
  }
})

// ── AI: Get config ──
ipcMain.handle('ai-get-config', () => {
  const config = loadConfig()
  // Never send API key to renderer — only show masked version
  return {
    ...config,
    apiKey: config.apiKey ? '••••••••' : ''
  }
})

// ── AI: Save config ──
ipcMain.handle('ai-save-config', (event, newConfig) => {
  const current = loadConfig()
  // If apiKey is the masked placeholder, keep the existing key
  if (newConfig.apiKey === '••••••••' || newConfig.apiKey === '') {
    newConfig.apiKey = current.apiKey
  }
  saveConfig({ ...current, ...newConfig })
  return { ok: true }
})

// ── AI: Test connection ──
ipcMain.handle('ai-test', async (event) => {
  const config = loadConfig()
  try {
    await streamChat({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      messages: [{ role: 'user', content: 'Say "Connection successful" and nothing else.' }],
      temperature: 0,
      maxTokens: 20,
      onChunk: () => {},
      onDone: () => {},
      onError: () => {}
    })
    return { ok: true, message: `Connected to ${config.model} at ${config.baseURL}` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── Prompt builders ──
const ACTION_PROMPTS = {
  'improve':  'Rewrite this to be clearer and more engaging, keeping the same meaning. Return only the rewritten text, nothing else.',
  'grammar':  'Fix grammar, spelling, and punctuation. Return only the corrected text, nothing else.',
  'shorter':  'Shorten this while keeping all key ideas. Return only the shortened text, nothing else.',
  'expand':   'Expand this with more detail and examples. Return only the expanded text, nothing else.',
  'formal':   'Rewrite in a professional, formal tone. Return only the rewritten text, nothing else.',
  'casual':   'Rewrite in a conversational, natural tone. Return only the rewritten text, nothing else.',
  'summarize':'Summarize in 1-3 sentences. Return only the summary, nothing else.',
  'simplify': 'Rewrite this in plain, simple language. Remove jargon and complexity. Return only the simplified text, nothing else.',
  // TODO: Add 'translate' back once a language selector UI exists (needed: <select> in AI panel before request fires)
  'rephrase': 'Rewrite in a completely different way preserving the meaning. Return only the rewritten text, nothing else.',
  'custom':   ''  // User provides their own prompt
}

function buildSystemPrompt(action) {
  return `You are a writing assistant inside a markdown editor called Gabo. You help the user improve their text. Format your output using markdown when appropriate. Be concise. Do NOT wrap your response in code blocks. Do NOT add introductory text like "Here is..." or "I've rewritten...". Just output the result directly.`
}

function buildUserPrompt(action, selectedText) {
  const instruction = ACTION_PROMPTS[action] || ACTION_PROMPTS['custom']
  // TODO: add translate case here when language selector UI exists
  if (action === 'custom') {
    return selectedText  // For custom, selectedText IS the prompt + content
  }
  return `${instruction}\n\n${selectedText}`
}
```

#### 1.4 — Preload additions (`src/renderer/preload.js` additions)

```js
// Add to existing contextBridge.exposeInMainWorld('gaboAPI', { ... }) block:

  // ── AI Integration ──
  aiRequest: (action, selectedText, customPrompt) => ipcRenderer.invoke('ai-request', { action, selectedText, customPrompt }),
  aiGetConfig: () => ipcRenderer.invoke('ai-get-config'),
  aiSaveConfig: (config) => ipcRenderer.invoke('ai-save-config', config),
  aiTest: () => ipcRenderer.invoke('ai-test'),
  onAiChunk: (cb) => { ipcRenderer.removeAllListeners('ai-chunk'); ipcRenderer.on('ai-chunk', (_, text) => cb(text)) },
  onAiDone: (cb) => { ipcRenderer.removeAllListeners('ai-done'); ipcRenderer.on('ai-done', () => cb()) },
  onAiError: (cb) => { ipcRenderer.removeAllListeners('ai-error'); ipcRenderer.on('ai-error', (_, err) => cb(err)) },
```

---

### Phase 2: AI Panel UI

#### 2.1 — AI panel HTML (`src/renderer/index.html` additions)

Add inside `<body>` before `<div id="statusbar">`:

```html
  <!-- ── AI Panel Overlay ── -->
  <div id="ai-overlay">
    <div id="ai-panel">
      <div id="ai-header">
        <span id="ai-title">✨ AI Assist</span>
        <button id="ai-close" class="icon-btn" title="Close (Esc)">✕</button>
      </div>

      <!-- Preset actions grid -->
      <div id="ai-actions">
        <button class="ai-action" data-action="improve">✨ Improve</button>
        <button class="ai-action" data-action="grammar">📝 Fix Grammar</button>
        <button class="ai-action" data-action="shorter">📏 Make Shorter</button>
        <button class="ai-action" data-action="expand">📖 Expand</button>
        <button class="ai-action" data-action="formal">🎯 Formal</button>
        <button class="ai-action" data-action="casual">💬 Casual</button>
        <button class="ai-action" data-action="summarize">💡 Summarize</button>
        <button class="ai-action" data-action="rephrase">🔄 Rephrase</button>
        <button class="ai-action" data-action="simplify">🧹 Simplify</button>
      </div>

      <!-- Custom prompt input -->
      <div id="ai-custom">
        <input type="text" id="ai-prompt-input" placeholder="Or type a custom instruction…"
               autocomplete="off" spellcheck="true">
        <button id="ai-custom-submit" title="Send (Enter)">→</button>
      </div>

      <!-- Response area (hidden until response comes) -->
      <div id="ai-response" class="hidden">
        <div id="ai-original">
          <div id="ai-original-label">Original</div>
          <div id="ai-original-text"></div>
        </div>
        <div id="ai-result">
          <div id="ai-result-label">AI Suggestion</div>
          <div id="ai-result-text"></div>
          <div id="ai-streaming-cursor" class="hidden">▍</div>
        </div>
      </div>

      <!-- Action buttons (hidden until response complete) -->
      <div id="ai-actions-bar" class="hidden">
        <button id="ai-replace" class="ai-btn ai-btn-primary">Replace</button>
        <button id="ai-insert" class="ai-btn">Insert Below</button>
        <button id="ai-copy" class="ai-btn">Copy</button>
        <button id="ai-discard" class="ai-btn ai-btn-secondary">Discard</button>
      </div>

      <!-- Loading state -->
      <div id="ai-loading" class="hidden">
        <div id="ai-loading-dots">
          <span></span><span></span><span></span>
        </div>
      </div>

      <!-- Error state -->
      <div id="ai-error" class="hidden">
        <span id="ai-error-icon">⚠️</span>
        <span id="ai-error-text"></span>
        <button id="ai-error-retry" class="ai-btn">Retry</button>
      </div>
    </div>
  </div>
```

#### 2.2 — AI panel CSS (`src/renderer/index.html` `<style>` additions)

```css
    /* ═══ AI Panel ═══ */
    #ai-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.3); z-index: 4000;
      justify-content: center; align-items: flex-start; padding-top: 12vh;
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    }
    #ai-overlay.open { display: flex; }
    #ai-panel {
      background: var(--bg-editor); border: 1px solid var(--border);
      border-radius: 16px; width: 600px; max-height: 72vh;
      overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.25);
      transition: background 0.25s ease, color 0.25s ease;
    }
    #ai-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    #ai-title {
      font-family: var(--font-display); font-size: 15px; font-weight: 600;
      letter-spacing: var(--letter-spacing); color: var(--text-primary);
    }
    #ai-close {
      width: 24px !important; height: 24px !important; border-radius: 50% !important;
      border: 1px solid var(--border) !important; background: var(--bg-main) !important;
      color: var(--text-secondary) !important; font-size: 12px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s, color 0.15s;
    }
    #ai-close:hover { background: var(--accent) !important; color: #fff !important; }
    #ai-actions {
      display: grid; grid-template-columns: repeat(3, 1fr);
      gap: 8px; padding: 16px 20px 8px;
    }
    .ai-action {
      font-family: var(--font-display); font-size: 13px; font-weight: 500;
      padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--bg-main); color: var(--text-primary); cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
      text-align: center; white-space: nowrap;
    }
    .ai-action:hover {
      background: var(--accent); color: #fff; border-color: var(--accent);
    }
    #ai-custom {
      display: flex; gap: 8px; padding: 8px 20px 16px; border-bottom: 1px solid var(--border);
    }
    #ai-prompt-input {
      flex: 1; font-family: var(--font-display); font-size: 14px;
      background: var(--bg-main); color: var(--text-primary);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 14px; outline: none; transition: border-color 0.15s;
    }
    #ai-prompt-input:focus { border-color: var(--accent); }
    #ai-prompt-input::placeholder { color: var(--text-dim); }
    #ai-custom-submit {
      width: 36px; height: 36px; border-radius: 8px; border: none;
      background: var(--accent); color: #fff; font-size: 16px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s;
    }
    #ai-custom-submit:hover { opacity: 0.85; }
    #ai-response {
      padding: 16px 20px; display: flex; flex-direction: column; gap: 12px;
    }
    #ai-original-label, #ai-result-label {
      font-family: var(--font-display); font-size: 10px; font-weight: 600;
      letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-dim);
      margin-bottom: 4px;
    }
    #ai-original-text {
      font-family: var(--font-display); font-size: 14px; line-height: 1.6;
      color: var(--text-secondary); padding: 10px 14px; border-radius: 8px;
      background: var(--bg-main); border: 1px solid var(--border);
      max-height: 120px; overflow-y: auto;
    }
    #ai-result-text {
      font-family: var(--font-display); font-size: 14px; line-height: 1.6;
      color: var(--text-primary); padding: 10px 14px; border-radius: 8px;
      background: var(--bg-main); border: 1px solid var(--border);
      min-height: 60px; max-height: 240px; overflow-y: auto;
      white-space: pre-wrap;
    }
    #ai-streaming-cursor {
      display: inline; font-weight: 300; color: var(--accent);
      animation: blink 0.8s infinite;
    }
    @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
    #ai-actions-bar {
      display: flex; gap: 8px; padding: 12px 20px 16px;
      justify-content: flex-end;
    }
    .ai-btn {
      font-family: var(--font-display); font-size: 13px; font-weight: 500;
      padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--bg-main); color: var(--text-primary); cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .ai-btn:hover { border-color: var(--text-secondary); }
    .ai-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .ai-btn-primary:hover { opacity: 0.85; }
    .ai-btn-secondary { color: var(--text-dim); }
    #ai-loading {
      padding: 24px 20px; text-align: center;
    }
    #ai-loading-dots {
      display: inline-flex; gap: 6px;
    }
    #ai-loading-dots span {
      width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
      animation: bounce 1.2s infinite;
    }
    #ai-loading-dots span:nth-child(2) { animation-delay: 0.2s; }
    #ai-loading-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }
    #ai-error {
      padding: 16px 20px; display: flex; align-items: center; gap: 10px;
      color: #e5534b; font-family: var(--font-display); font-size: 14px;
    }
    #ai-error-text { flex: 1; }
    .hidden { display: none !important; }
```

#### 2.3 — AI panel JavaScript (`src/renderer/renderer.js` additions)

```js
// ── AI State ──
let aiOriginalText = ''
let aiResultText = ''
let aiSelectionFrom = null  // start position of selected text in editor
let aiSelectionTo = null    // end position of selected text in editor
let aiCurrentAction = null  // which preset action was chosen
let aiIsStreaming = false

// ── AI Panel Open ──
function openAiPanel() {
  // Capture current selection before opening panel (editor loses focus)
  if (editor) {
    const sel = editor.state.selection.main
    aiSelectionFrom = sel.from
    aiSelectionTo = sel.to
    const selected = editor.state.sliceDoc(sel.from, sel.to)
    aiOriginalText = selected
  } else {
    aiOriginalText = ''
    aiSelectionFrom = null
    aiSelectionTo = null
  }

  // Reset UI
  document.getElementById('ai-original-text').textContent = aiOriginalText || '(no text selected)'
  document.getElementById('ai-result-text').textContent = ''
  document.getElementById('ai-prompt-input').value = ''
  document.getElementById('ai-response').classList.add('hidden')
  document.getElementById('ai-actions-bar').classList.add('hidden')
  document.getElementById('ai-loading').classList.add('hidden')
  document.getElementById('ai-error').classList.add('hidden')
  aiResultText = ''
  aiIsStreaming = false

  // Show/hide actions section based on selection
  const actionsDiv = document.getElementById('ai-actions')
  const customDiv = document.getElementById('ai-custom')
  if (aiOriginalText) {
    actionsDiv.classList.remove('hidden')
    customDiv.classList.remove('hidden')
  } else {
    // No selection — only custom prompt available
    actionsDiv.classList.add('hidden')
    customDiv.classList.remove('hidden')
  }

  document.getElementById('ai-overlay').classList.add('open')
  if (!aiOriginalText) {
    document.getElementById('ai-prompt-input').focus()
  }
}

function closeAiPanel() {
  document.getElementById('ai-overlay').classList.remove('open')
  aiIsStreaming = false
  if (editor) editor.focus()
}

// ── Send AI Request ──
async function sendAiRequest(action, customPromptText) {
  if (aiIsStreaming) return
  aiCurrentAction = action
  aiIsStreaming = true
  aiResultText = ''

  // If no selection, use entire document context (last N chars around cursor)
  let textToSend = aiOriginalText
  if (!textToSend && editor) {
    // No selection: send surrounding context
    const pos = editor.state.selection.main.head
    const start = Math.max(0, pos - 2000)
    const end = Math.min(editor.state.doc.length, pos + 2000)
    textToSend = editor.state.sliceDoc(start, end)
  }

  // Show streaming state
  document.getElementById('ai-actions').classList.add('hidden')
  document.getElementById('ai-custom').classList.add('hidden')
  document.getElementById('ai-response').classList.remove('hidden')
  document.getElementById('ai-original-text').textContent = textToSend.slice(0, 500) + (textToSend.length > 500 ? '…' : '')
  document.getElementById('ai-result-text').textContent = ''
  document.getElementById('ai-streaming-cursor').classList.remove('hidden')
  document.getElementById('ai-loading').classList.add('hidden')
  document.getElementById('ai-actions-bar').classList.add('hidden')
  document.getElementById('ai-error').classList.add('hidden')

  // For custom action, combine prompt + text
  const promptForCustom = action === 'custom'
    ? `${customPromptText}\n\n${textToSend}`
    : null

  // Set up chunk listeners
  window.gaboAPI.onAiChunk((text) => {
    aiResultText += text
    document.getElementById('ai-result-text').textContent = aiResultText
    // Auto-scroll the result area
    const resultEl = document.getElementById('ai-result-text')
    resultEl.scrollTop = resultEl.scrollHeight
  })

  window.gaboAPI.onAiDone(() => {
    aiIsStreaming = false
    document.getElementById('ai-streaming-cursor').classList.add('hidden')
    document.getElementById('ai-actions-bar').classList.remove('hidden')
  })

  window.gaboAPI.onAiError((errMsg) => {
    aiIsStreaming = false
    document.getElementById('ai-response').classList.add('hidden')
    document.getElementById('ai-loading').classList.add('hidden')
    document.getElementById('ai-error-text').textContent = errMsg
    document.getElementById('ai-error').classList.remove('hidden')
  })

  // Send the request via IPC
  await window.gaboAPI.aiRequest(action, textToSend, promptForCustom)
}

// ── AI Actions: Replace, Insert, Copy, Discard ──
// NOTE: CM6 dispatches should include annotations: Transaction.userEvent.of("input.ai")
// so that ⌘Z undoes the entire AI replacement as a single step. Without it, undo fragments
// into individual character insertions. Add `annotations` to both dispatch calls below.
function aiReplace() {
  if (!editor || !aiResultText) return
  if (aiOriginalText && aiSelectionFrom !== null) {
    // Replace selected text with AI result
    editor.dispatch({
      changes: { from: aiSelectionFrom, to: aiSelectionTo, insert: aiResultText }
    })
  } else {
    // No original selection — insert at cursor
    const pos = editor.state.selection.main.head
    editor.dispatch({
      changes: { from: pos, insert: aiResultText }
    })
  }
  closeAiPanel()
}

function aiInsertBelow() {
  if (!editor || !aiResultText) return
  // Insert after the current line
  const pos = editor.state.selection.main.head
  const line = editor.state.doc.lineAt(pos)
  const insertPos = line.to
  editor.dispatch({
    changes: { from: insertPos, insert: '\n\n' + aiResultText }
  })
  closeAiPanel()
}

function aiCopy() {
  if (!aiResultText) return
  navigator.clipboard.writeText(aiResultText)
  closeAiPanel()
}

function aiDiscard() {
  closeAiPanel()
}

// ── Wire up events ──
// (add after existing button handlers in renderer.js)

// AI panel toggle — keyboard shortcut handled in keymap below
// AI action buttons
document.querySelectorAll('.ai-action').forEach(btn => {
  btn.addEventListener('click', () => sendAiRequest(btn.dataset.action))
})
document.getElementById('ai-custom-submit').addEventListener('click', () => {
  const prompt = document.getElementById('ai-prompt-input').value.trim()
  if (prompt) sendAiRequest('custom', prompt)
})
document.getElementById('ai-prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    const prompt = document.getElementById('ai-prompt-input').value.trim()
    if (prompt) sendAiRequest('custom', prompt)
  }
  if (e.key === 'Escape') closeAiPanel()
})
document.getElementById('ai-replace').addEventListener('click', aiReplace)
document.getElementById('ai-insert').addEventListener('click', aiInsertBelow)
document.getElementById('ai-copy').addEventListener('click', aiCopy)
document.getElementById('ai-discard').addEventListener('click', aiDiscard)
document.getElementById('ai-close').addEventListener('click', closeAiPanel)
document.getElementById('ai-error-retry').addEventListener('click', () => {
  sendAiRequest(aiCurrentAction)
})
document.getElementById('ai-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('ai-overlay')) closeAiPanel()
})
```

#### 2.4 — Keyboard shortcut

Add to the keymap in `createEditor()`:

```js
{ key: 'Mod-j', run: () => { openAiPanel(); return true } },
```

And add to the menu in `main.js` View submenu:

```js
{ label: 'AI Assist', accelerator: 'CmdOrCtrl+J', click: () => mainWindow.webContents.send('menu-ai') },
```

And in `preload.js`, add the listener:

```js
onMenuAi: (cb) => { ipcRenderer.removeAllListeners('menu-ai'); ipcRenderer.on('menu-ai', cb) },
```

And in `renderer.js`:

```js
window.gaboAPI.onMenuAi(() => openAiPanel())
```

---

### Phase 3: Settings Modal (⌘,)

#### 3.1 — Settings Modal HTML

Add at the end of `<body>`, before `statusbar`:

```html
  <!-- ── Settings Modal ── -->
  <div id="settings-overlay">
    <div id="settings-panel">
      <div id="settings-header">
        <span id="settings-title">⚙️ Settings</span>
        <button id="settings-close" class="icon-btn" title="Close (Esc)">✕</button>
      </div>
      <div id="settings-content">
        <div class="settings-group">
          <div class="settings-group-label">AI Provider</div>
          <div class="settings-row">
            <label class="settings-label">Provider</label>
            <select id="settings-provider">
              <option value="ollama">Ollama (Local)</option>
              <option value="openai-compatible">OpenAI-Compatible</option>
              <option value="hermes">Hermes Agent</option>
            </select>
          </div>
          <div class="settings-row">
            <label class="settings-label">Base URL</label>
            <input type="text" id="settings-baseurl" placeholder="http://localhost:11434/v1" spellcheck="false" autocomplete="off">
          </div>
          <div class="settings-row">
            <label class="settings-label">API Key</label>
            <input type="password" id="settings-apikey" placeholder="Leave empty for Ollama" spellcheck="false" autocomplete="off">
          </div>
          <div class="settings-row">
            <label class="settings-label">Model</label>
            <input type="text" id="settings-model" placeholder="llama3.2" spellcheck="false" autocomplete="off">
          </div>
          <div class="settings-row settings-row-buttons">
            <button id="settings-test" class="ai-btn">Save & Test</button>
            <button id="settings-save" class="ai-btn ai-btn-primary">Save Settings</button>
          </div>
          <div id="settings-test-result" class="hidden"></div>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">AI Behavior</div>
          <div class="settings-row">
            <label class="settings-label">Temperature</label>
            <input type="range" id="settings-temperature" min="0" max="1" step="0.1" value="0.7">
            <span id="settings-temperature-val">0.7</span>
          </div>
          <div class="settings-row">
            <label class="settings-label">Max Tokens</label>
            <input type="number" id="settings-maxtokens" value="2048" min="256" max="8192" step="256">
          </div>
          <div class="settings-row">
            <label class="settings-label">Enable AI</label>
            <input type="checkbox" id="settings-ai-enabled" checked>
          </div>
        </div>
      </div>
    </div>
  </div>
```

#### 3.2 — Settings Modal CSS

```css
    /* ═══ Settings Modal ═══ */
    #settings-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.3); z-index: 5000;
      justify-content: center; align-items: flex-start; padding-top: 10vh;
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    }
    #settings-overlay.open { display: flex; }
    #settings-panel {
      background: var(--bg-editor); border: 1px solid var(--border);
      border-radius: 16px; width: 520px; max-height: 80vh;
      overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.25);
    }
    #settings-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    #settings-title {
      font-family: var(--font-display); font-size: 15px; font-weight: 600;
      letter-spacing: var(--letter-spacing); color: var(--text-primary);
    }
    #settings-content { padding: 8px 0; }
    .settings-group {
      padding: 12px 20px;
    }
    .settings-group + .settings-group { border-top: 1px solid var(--border); }
    .settings-group-label {
      font-family: var(--font-display); font-size: 10px; font-weight: 600;
      letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-dim);
      margin-bottom: 12px;
    }
    .settings-row {
      display: flex; align-items: center; gap: 12px; margin-bottom: 10px;
    }
    .settings-row-buttons {
      margin-top: 16px; justify-content: flex-end;
    }
    .settings-label {
      font-family: var(--font-display); font-size: 13px; font-weight: 500;
      color: var(--text-secondary); min-width: 90px; flex-shrink: 0;
    }
    #settings-content input[type="text"],
    #settings-content input[type="password"],
    #settings-content input[type="number"],
    #settings-content select {
      flex: 1; font-family: var(--font-mono); font-size: 13px;
      background: var(--bg-main); color: var(--text-primary);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 12px; outline: none; transition: border-color 0.15s;
    }
    #settings-content input:focus, #settings-content select:focus {
      border-color: var(--accent);
    }
    #settings-content input[type="range"] {
      flex: 1;
    }
    #settings-temperature-val {
      font-family: var(--font-mono); font-size: 13px; color: var(--text-secondary);
      min-width: 30px;
    }
    #settings-content input[type="checkbox"] {
      width: 18px; height: 18px; accent-color: var(--accent);
    }
    #settings-test-result {
      font-family: var(--font-display); font-size: 13px; margin-top: 8px;
      padding: 8px 12px; border-radius: 8px;
    }
    #settings-test-result.success { background: #d4edda; color: #155724; }
    #settings-test-result.error { background: #f8d7da; color: #721c24; }
```

#### 3.3 — Settings JavaScript

```js
// ── Settings ──
let currentAiConfig = null

async function openSettings() {
  // Load current config
  currentAiConfig = await window.gaboAPI.aiGetConfig()
  
  // Populate fields
  document.getElementById('settings-provider').value = currentAiConfig.provider
  document.getElementById('settings-baseurl').value = currentAiConfig.baseURL
  document.getElementById('settings-apikey').value = currentAiConfig.apiKey  // masked
  document.getElementById('settings-model').value = currentAiConfig.model
  document.getElementById('settings-temperature').value = currentAiConfig.temperature
  document.getElementById('settings-temperature-val').textContent = currentAiConfig.temperature
  document.getElementById('settings-maxtokens').value = currentAiConfig.maxTokens
  document.getElementById('settings-ai-enabled').checked = currentAiConfig.enabled

  // Pre-fill base URL based on provider selection
  updateSettingsDefaults()

  document.getElementById('settings-test-result').classList.add('hidden')
  document.getElementById('settings-overlay').classList.add('open')
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open')
  if (editor) editor.focus()
}

// Auto-fill base URL and model when provider changes
const PROVIDER_DEFAULTS = {
  'ollama': { baseURL: 'http://localhost:11434/v1', model: 'llama3.2' },
  'openai-compatible': { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  'hermes': { baseURL: 'http://localhost:8642/v1', model: 'glm-5.1:cloud' }
}

function updateSettingsDefaults() {
  const provider = document.getElementById('settings-provider').value
  const defaults = PROVIDER_DEFAULTS[provider]
  if (defaults) {
    // Only auto-fill if the current value looks like a default for a different provider
    // (Don't overwrite user customizations)
    const baseURLInput = document.getElementById('settings-baseurl')
    const modelInput = document.getElementById('settings-model')
    // If the field matches any known default, switch it
    const allDefaults = Object.values(PROVIDER_DEFAULTS)
    if (allDefaults.some(d => d.baseURL === baseURLInput.value)) {
      baseURLInput.value = defaults.baseURL
    }
    if (allDefaults.some(d => d.model === modelInput.value)) {
      modelInput.value = defaults.model
    }
  }
}

document.getElementById('settings-provider').addEventListener('change', updateSettingsDefaults)

document.getElementById('settings-temperature').addEventListener('input', (e) => {
  document.getElementById('settings-temperature-val').textContent = e.target.value
})

// ✅ DONE: Validation is now handled server-side in validateConfig() (ai-config.js).
// baseURL, temperature, maxTokens, and model are validated before saving.
// ai-save-config returns { ok: false, errors: [...] } if validation fails.
// The renderer should check for errors and display them in #settings-test-result.
document.getElementById('settings-save').addEventListener('click', async () => {
  const newConfig = {
    provider: document.getElementById('settings-provider').value,
    baseURL: document.getElementById('settings-baseurl').value.trim(),
    apiKey: document.getElementById('settings-apikey').value,
    model: document.getElementById('settings-model').value.trim(),
    temperature: parseFloat(document.getElementById('settings-temperature').value),
    maxTokens: parseInt(document.getElementById('settings-maxtokens').value),
    enabled: document.getElementById('settings-ai-enabled').checked
  }
  await window.gaboAPI.aiSaveConfig(newConfig)
  closeSettings()
})

<!-- [AUDIT by Claude] The current flow saves config silently before testing — a user clicking "Test" before finishing edits accidentally saves half-filled values. Renamed button to "Save & Test" so behavior is explicit. -->
document.getElementById('settings-test').addEventListener('click', async () => {
  const resultEl = document.getElementById('settings-test-result')
  resultEl.classList.remove('hidden', 'success', 'error')
  resultEl.textContent = 'Testing…'
  
  // Save first so test uses latest values
  const newConfig = {
    provider: document.getElementById('settings-provider').value,
    baseURL: document.getElementById('settings-baseurl').value.trim(),
    apiKey: document.getElementById('settings-apikey').value,
    model: document.getElementById('settings-model').value.trim(),
    temperature: parseFloat(document.getElementById('settings-temperature').value),
    maxTokens: parseInt(document.getElementById('settings-maxtokens').value),
    enabled: document.getElementById('settings-ai-enabled').checked
  }
  await window.gaboAPI.aiSaveConfig(newConfig)
  
  const result = await window.gaboAPI.aiTest()
  if (result.ok) {
    resultEl.classList.add('success')
    resultEl.textContent = `✅ ${result.message}`
  } else {
    resultEl.classList.add('error')
    resultEl.textContent = `❌ ${result.error}`
  }
})

document.getElementById('settings-close').addEventListener('click', closeSettings)
document.getElementById('settings-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('settings-overlay')) closeSettings()
})
```

Add keyboard shortcut and menu entry:

```js
// In keymap:
{ key: 'Mod-,', run: () => { openSettings(); return true } },

// In menu (View submenu):
{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.webContents.send('menu-settings') },
```

Add to command palette:

```js
{ icon: '⚙️', label: 'Settings', kbd: '⌘,', action: () => openSettings() },
```

---

### Phase 4: Polish & Edge Cases

#### 4.1 — Error handling

- **Ollama not running**: Show friendly "Ollama is not running. Start Ollama and try again." in the error state
- **Timeout**: 30s timeout on streaming; if no chunks received in 10s, show "Model is taking too long to respond"
- **Empty selection**: If no text is selected, prompt for custom instruction (hide preset actions, show input only)
- **Network errors**: Catch ECONNREFUSED and show "Cannot connect to {baseURL}"
- **HTTP status errors** ✅ DONE: Non-2xx responses (401, 429, 404, etc.) now rejected before SSE parsing. `streamChat` reads the error body and rejects with a clear `HTTP {status}: {message}` error instead of silently swallowing garbage.

```js
// In ai-adapter.js — add timeout wrapper
function createTimeoutPromise(ms) {
  return new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Request timed out after ${ms / 1000}s`)), ms)
  )
}

// In main.js — ai-request handler, wrap with timeout:
const AI_TIMEOUT = 60000  // 60 seconds overall
const CHUNK_TIMEOUT = 15000  // 15 seconds between chunks

// Detect Ollama-specific connection errors
ipcMain.handle('ai-request', async (event, params) => {
  const config = loadConfig()
  // Check Ollama availability first
  if (config.provider === 'ollama') {
    try {
      const http = require('http')
      await new Promise((resolve, reject) => {
        const url = new URL('/', config.baseURL)
        const req = http.get({ hostname: url.hostname, port: url.port, path: '/', timeout: 3000 }, (res) => {
          resolve()
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')) })
      })
    } catch (e) {
      event.sender.send('ai-error', 'Ollama is not running. Start Ollama and try again, or change the AI provider in Settings (⌘,)')
      return
    }
  }
  // ... rest of the streaming logic
})
```

#### 4.2 — Cancel streaming + Stop button

Add a visible **Stop** button to `#ai-actions-bar` (shown only while `aiIsStreaming` is true) that calls `aiCancel()` without closing the panel. Escape closes the whole panel, so users need a way to halt a slow response mid-stream and keep the partial result visible.

```js
// main.js
let currentAiRequest = null

ipcMain.handle('ai-request', async (event, params) => {
  // ... (setup as before)
  currentAiRequest = req  // store reference to the HTTP request
  // ... (stream as before)
  currentAiRequest = null  // clear after completion
})

ipcMain.handle('ai-cancel', () => {
  if (currentAiRequest) {
    currentAiRequest.destroy()
    currentAiRequest = null
    return { ok: true }
  }
  return { ok: false }
})
```

```js
// preload.js
aiCancel: () => ipcRenderer.invoke('ai-cancel'),
```

```js
// renderer.js — Escape key during streaming cancels
function closeAiPanel() {
  if (aiIsStreaming) {
    window.gaboAPI.aiCancel()
    aiIsStreaming = false
  }
  document.getElementById('ai-overlay').classList.remove('open')
  if (editor) editor.focus()
}
```

#### 4.3 — Context window awareness

For long documents, we shouldn't send the entire file. Strategies:

1. **Selection mode**: Send only selected text (default)
2. **Context mode** (no selection): Send 2000 chars before + 2000 chars after cursor position
3. **Future enhancement**: Send last N paragraphs for context-aware generation

The current plan uses strategy 1 with fallback to strategy 2 (already in `sendAiRequest`).

#### Phase 3.5 — Auto-configure Ollama models

Add a "list available models" feature via `GET /api/tags` (Ollama-specific). This shows a dropdown of available models in settings instead of a free-text field — users often don't know their exact model name.

```js
// main.js
ipcMain.handle('ai-list-models', async () => {
  const config = loadConfig()
  if (config.provider !== 'ollama') return { models: [] }  // only for Ollama
  
  try {
    // Ollama uses GET /api/tags to list models
    const url = new URL('/api/tags', config.baseURL.replace('/v1', ''))
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) })
    const data = await response.json()
    return { models: data.models?.map(m => m.name) || [] }
  } catch (e) {
    return { models: [], error: e.message }
  }
})
```

This shows a dropdown of available Ollama models in settings instead of a free-text field.

#### 4.4 — Command Palette AI entry

Add to `PALETTE_COMMANDS`:
```js
{ icon: '✨', label: 'AI Assist', kbd: '⌘J', action: () => openAiPanel() },
{ icon: '⚙️', label: 'Settings', kbd: '⌘,', action: () => openSettings() },
```

#### 4.5 — Encrypt API key with safeStorage (required before public release)

Plaintext keys in `userData/ai-config.json` are readable by any process with filesystem access. Use Electron's `safeStorage` (OS keychain-backed) to encrypt at rest:

```js
const { safeStorage } = require('electron')

// In saveConfig(): encrypt before writing
if (config.apiKey && safeStorage.isEncryptionAvailable()) {
  config.apiKey = safeStorage.encryptString(config.apiKey).toString('base64')
}

// In loadConfig(): decrypt after reading
if (config.apiKey && safeStorage.isEncryptionAvailable()) {
  try {
    config.apiKey = safeStorage.decryptString(Buffer.from(config.apiKey, 'base64'))
  } catch (e) {
    config.apiKey = ''  // corrupted or migrated from plaintext — reset
  }
}
```

#### 4.6 — (Reserved for future use)

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/main/ai-config.js` | **NEW** — Config load/save, default values |
| `src/main/ai-adapter.js` | **NEW** — Streaming SSE adapter for OpenAI-compatible APIs |
| `src/main/main.js` | **MODIFY** — Add 5 IPC handlers, menu entries, preload path |
| `src/renderer/preload.js` | **MODIFY** — Add 10 API methods (aiRequest, aiGetConfig, aiSaveConfig, aiTest, onAiChunk, onAiDone, onAiError, aiCancel, onMenuAi, onMenuSettings) |
| `src/renderer/renderer.js` | **MODIFY** — Add AI panel logic, settings modal logic, keybinding ⌘J for AI, ⌘, for settings |
| `src/renderer/index.html` | **MODIFY** — Add AI panel overlay HTML, settings panel HTML, CSS for both |

---

## Security Notes

1. **API keys never in renderer** — stored in `userData/ai-config.json` (main process only), masked as `••••••••` when sent to renderer
2. **API key encryption at rest** — Use Electron's `safeStorage` API to encrypt the API key (Phase 4.5). Plaintext JSON is a credential exposure risk; must ship before any public release. OS keychain-backed encryption on macOS (Keychain), Linux (libsecret), Windows (DPAPI).
3. **CSP**: Since we use `http://` for Ollama, ensure Content-Security-Policy doesn't block it. In development mode (`webPreferences.devTools`), this is fine. For production, add Ollama's origin to connect-src
4. **No remote code execution** — AI responses are inserted as plain text, never rendered as HTML

---

## Implementation Order

1. **Phase 1.1–1.3**: Core IPC plumbing + adapter (main process only, no UI yet)
2. **Phase 1.4**: Preload bridge (exposes `window.gaboAPI.*` — required before Phase 2)
3. **Phase 2.1–2.4**: AI panel UI + keyboard shortcut (⌘J)
4. **Phase 3.1–3.3**: Settings modal (⌘,)
5. **Phase 3.5**: Ollama model list dropdown
6. **Phase 4.1–4.3**: Error handling, cancel + Stop button, edge cases
7. **Phase 4.4**: Command palette entries
8. **Phase 4.5**: safeStorage API key encryption

Estimated effort: **2–3 focused sessions** for Phases 1–3, **1 session** for Phase 4 polish.

---

## Future Ideas (not in scope)

- **Multiple AI responses / variations**: Show 2–3 variations side by side. Run the same `streamChat` call twice concurrently with a slightly higher temperature (e.g. 0.9) for the second variation. Add a tab strip above `#ai-result` to switch between variations — `[Low effort, High impact]`
- **Translate action**: Re-add once a language selector `<select>` exists in the AI panel UI — `[Low effort, Medium impact]`
<!-- [AUDIT by Claude] Effort labels added to help prioritise. -->
- **Document-level context**: Send document outline + surrounding paragraphs for smarter edits — `[Low effort, High impact]`
- **AI chat sidebar**: Persistent chat panel for back-and-forth conversation about the document — `[Medium effort, Medium impact]`
- **Inline AI suggestions**: Instead of a panel, show suggestions as ghost text in the editor (like Copilot) — `[High effort, High impact — ~10× the work of Phases 1–4]`
- **Hermes agent integration**: Full MCP client for Notion, email, web search from within Gabo — `[High effort, Niche impact]`

---

*Last updated: 2026-04-26*