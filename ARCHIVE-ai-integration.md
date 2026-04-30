# Gabo — Archived AI Integration

_Removed 2026-04-29. AI features caused freezes and instability. 
Core editor refocused as a distraction-free markdown creator.
All code below can be restored if needed._

---

## Files Deleted

### 1. `src/main/ai-adapter.js` (entire file)
Streaming SSE adapter for OpenAI-compatible endpoints.

```js
File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.
```

### 2. `src/main/ai-config.js` (entire file)
AI config load/save with safeStorage encryption.

```js
File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.
```

---

## Removed from `src/main/main.js`

### Imports (lines 4-5)
```js
const { loadConfig, saveConfig, validateConfig } = require('./ai-config')
const { streamChat } = require('./ai-adapter')
```

### Menu items (line 77-78)
```js
{ label: 'AI Assist', accelerator: 'CmdOrCtrl+J', click: () => mainWindow.webContents.send('menu-ai') },
{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.webContents.send('menu-settings') },
```

### IPC handlers (lines 196-512)
Full AI IPC handlers including:
- `ai-request` — streaming AI completion
- `ai-get-config` — read AI config
- `ai-save-config` — save AI config with validation
- `ai-test` — test AI connection
- `ai-cancel` — cancel in-flight request
- `ai-request-variations` — 3 parallel temperature-offset streams
- `ai-list-models` — list Ollama models
- `ACTION_PROMPTS`, `buildSystemPrompt`, `buildUserPrompt`
- `currentAiAbortController`, `variationAbortControllers`

```js
   196|// ═══ AI Integration IPC Handlers ═══
   197|
   198|// Prompt builders
   199|const ACTION_PROMPTS = {
   200|  'improve':  'Rewrite this to be clearer and more engaging, keeping the same meaning. Return only the rewritten text, nothing else.',
   201|  'grammar':  'Fix grammar, spelling, and punctuation. Return only the corrected text, nothing else.',
   202|  'shorter':  'Shorten this while keeping all key ideas. Return only the shortened text, nothing else.',
   203|  'expand':   'Expand this with more detail and examples. Return only the expanded text, nothing else.',
   204|  'formal':   'Rewrite in a professional, formal tone. Return only the rewritten text, nothing else.',
   205|  'casual':   'Rewrite in a conversational, natural tone. Return only the rewritten text, nothing else.',
   206|  'summarize':'Summarize in 1-3 sentences. Return only the summary, nothing else.',
   207|  'simplify': 'Rewrite this in plain, simple language. Remove jargon and complexity. Return only the simplified text, nothing else.',
   208|  'rephrase': 'Rewrite in a completely different way preserving the meaning. Return only the rewritten text, nothing else.',
   209|  'custom':   ''  // User provides their own prompt
   210|}
   211|
   212|function buildSystemPrompt(action, docContext) {
   213|  let prompt = `You are a writing assistant inside a markdown editor called Gabo. You help the user improve their text. Format your output using markdown when appropriate. Be concise. Do NOT wrap your response in code blocks. Do NOT add introductory text like "Here is..." or "I've rewritten...". Just output the result directly.`
   214|  if (docContext) {
   215|    prompt += `\n\n---\nDocument context (for reference only — do NOT include this in your output):\n${docContext}`
   216|  }
   217|  return prompt
   218|}
   219|
   220|function buildUserPrompt(action, selectedText) {
   221|  const instruction = ACTION_PROMPTS[action] || ACTION_PROMPTS['custom']
   222|  if (action === 'custom' || action === 'translate') {
   223|    return selectedText  // For custom/translate, customPrompt is provided separately
   224|  }
   225|  return `${instruction}\n\n${selectedText}`
   226|}
   227|
   228|// Track in-flight AI request for cancellation via AbortController
   229|let currentAiAbortController = null
   230|const variationAbortControllers = []
   231|
   232|// AI: Send request (streaming)
   233|ipcMain.handle('ai-request', async (event, { action, selectedText, customPrompt, docContext }) => {
   234|  const config = loadConfig()
   235|  if (!config.enabled) {
   236|    event.sender.send('ai-error', 'AI is disabled. Enable it in Settings (⌘,)')
   237|    return
   238|  }
   239|
   240|  // Check Ollama availability first
   241|  if (config.provider === 'ollama') {
   242|    try {
   243|      const ollamaHttp = require('http')
   244|      await new Promise((resolve, reject) => {
   245|        const url = new URL('/', config.baseURL)
   246|        const req = ollamaHttp.get({ hostname: url.hostname, port: url.port, path: '/', timeout: 3000 }, (res) => {
   247|          resolve()
   248|        })
   249|        req.on('error', reject)
   250|        req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')) })
   251|      })
   252|    } catch (e) {
   253|      event.sender.send('ai-error', 'Ollama is not running. Start Ollama and try again, or change the AI provider in Settings (⌘,)')
   254|      return
   255|    }
   256|  }
   257|
   258|  const systemPrompt = buildSystemPrompt(action, docContext)
   259|  const userPrompt = customPrompt
   260|    ? `${customPrompt}\n\n${selectedText}`
   261|    : buildUserPrompt(action, selectedText)
   262|
   263|  try {
   264|    // Create AbortController so this request can be cancelled from ai-cancel
   265|    currentAiAbortController = new AbortController()
   266|    const { signal } = currentAiAbortController
   267|
   268|    // Chunk timeout: abort if no chunk received in 15 seconds
   269|    const CHUNK_TIMEOUT_MS = 15000
   270|    let chunkTimer = setTimeout(() => {
   271|      currentAiAbortController?.abort()
   272|      event.sender.send('ai-error', 'Model is taking too long to respond. Try again or use a different model.')
   273|    }, CHUNK_TIMEOUT_MS)
   274|
   275|    const resetChunkTimer = () => {
   276|      clearTimeout(chunkTimer)
   277|      chunkTimer = setTimeout(() => {
   278|        currentAiAbortController?.abort()
   279|        event.sender.send('ai-error', 'Model is taking too long to respond. Try again or use a different model.')
   280|      }, CHUNK_TIMEOUT_MS)
   281|    }
   282|
   283|    await streamChat({
   284|      baseURL: config.baseURL,
   285|      apiKey: config.apiKey,
   286|      model: config.model,
   287|      messages: [
   288|        { role: 'system', content: systemPrompt },
   289|        { role: 'user', content: userPrompt }
   290|      ],
   291|      temperature: config.temperature,
   292|      maxTokens: config.maxTokens,
   293|      signal,
   294|      onChunk: (text) => {
   295|        resetChunkTimer()
   296|        event.sender.send('ai-chunk', text)
   297|      },
   298|      onDone: () => {
   299|        clearTimeout(chunkTimer)
   300|        event.sender.send('ai-done')
   301|      },
   302|      onError: (err) => {
   303|        clearTimeout(chunkTimer)
   304|        event.sender.send('ai-error', err.message)
   305|      }
   306|    })
   307|  } catch (err) {
   308|    // Don't send error if the request was aborted (user cancelled)
   309|    if (err.message === 'Request aborted') return
   310|    // Friendly network error messages
   311|    let msg = err.message
   312|    if (err.code === 'ECONNREFUSED') {
   313|      msg = `Cannot connect to ${config.baseURL}. Is the server running?`
   314|    } else if (err.code === 'ENOTFOUND') {
   315|      msg = `Cannot resolve host at ${config.baseURL}. Check the Base URL in Settings.`
   316|    } else if (err.code === 'ECONNRESET') {
   317|      msg = 'Connection was reset by the server. Try again.'
   318|    } else if (err.code === 'ETIMEDOUT') {
   319|      msg = 'Connection timed out. The server may be down or unreachable.'
   320|    }
   321|    event.sender.send('ai-error', msg)
   322|  } finally {
   323|    clearTimeout(chunkTimer)
   324|    currentAiAbortController = null
   325|  }
   326|})
   327|
   328|// AI: Get config
   329|ipcMain.handle('ai-get-config', () => {
   330|  const config = loadConfig()
   331|  // Never send API key to renderer — only show masked version
   332|  return {
   333|    ...config,
   334|    apiKey: config.apiKey ? '••••••••' : ''
   335|  }
   336|})
   337|
   338|// AI: Save config (with validation)
   339|ipcMain.handle('ai-save-config', (event, newConfig) => {
   340|  const current = loadConfig()
   341|  // If apiKey is the masked placeholder, keep the existing key
   342|  // (user didn't change it). Treat '' as intentional clear.
   343|  if (newConfig.apiKey === '••••••••') {
   344|    newConfig.apiKey = current.apiKey
   345|  }
   346|  const { clean, errors } = validateConfig({ ...current, ...newConfig })
   347|  if (errors.length > 0) {
   348|    return { ok: false, errors }
   349|  }
   350|  saveConfig(clean)
   351|  return { ok: true }
   352|})
   353|
   354|// AI: Test connection
   355|ipcMain.handle('ai-test', async (event) => {
   356|  const config = loadConfig()
   357|  try {
   358|    await streamChat({
   359|      baseURL: config.baseURL,
   360|      apiKey: config.apiKey,
   361|      model: config.model,
   362|      messages: [{ role: 'user', content: 'Say "Connection successful" and nothing else.' }],
   363|      temperature: 0,
   364|      maxTokens: 20,
   365|      onChunk: () => {},
   366|      onDone: () => {},
   367|      onError: () => {}
   368|    })
   369|    return { ok: true, message: `Connected to ${config.model} at ${config.baseURL}` }
   370|  } catch (err) {
   371|    return { ok: false, error: err.message }
   372|  }
   373|})
   374|
   375|// AI: Cancel in-flight request
   376|ipcMain.handle('ai-cancel', () => {
   377|  let cancelled = false
   378|  if (currentAiAbortController) {
   379|    currentAiAbortController.abort()
   380|    currentAiAbortController = null
   381|    cancelled = true
   382|  }
   383|  variationAbortControllers.forEach(c => c?.abort())
   384|  variationAbortControllers.length = 0
   385|  return { ok: cancelled }
   386|})
   387|
   388|// AI: Variations — 3 parallel requests with offset temperatures
   389|const VARIATION_TEMPS = [0, +0.2, +0.5] // base, slightly creative, more creative
   390|
   391|ipcMain.handle('ai-request-variations', async (event, { action, selectedText, customPrompt, docContext }) => {
   392|  const config = loadConfig()
   393|  if (!config.enabled) {
   394|    event.sender.send('ai-error', 'AI is disabled. Enable it in Settings (⌘,)')
   395|    return
   396|  }
   397|
   398|  // Check Ollama availability
   399|  if (config.provider === 'ollama') {
   400|    try {
   401|      const ollamaHttp = require('http')
   402|      await new Promise((resolve, reject) => {
   403|        const url = new URL('/', config.baseURL)
   404|        const req = ollamaHttp.get({ hostname: url.hostname, port: url.port, path: '/', timeout: 3000 }, (res) => {
   405|          resolve()
   406|        })
   407|        req.on('error', reject)
   408|        req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')) })
   409|      })
   410|    } catch (e) {
   411|      event.sender.send('ai-error', 'Ollama is not running. Start Ollama and try again, or change the AI provider in Settings (⌘,)')
   412|      return
   413|    }
   414|  }
   415|
   416|  const systemPrompt = buildSystemPrompt(action, docContext)
   417|  const userPrompt = customPrompt
   418|    ? `${customPrompt}\n\n${selectedText}`
   419|    : buildUserPrompt(action, selectedText)
   420|
   421|  // Cancel any previous variations
   422|  variationAbortControllers.forEach(c => c?.abort())
   423|  variationAbortControllers.length = 0
   424|
   425|  const CHUNK_TIMEOUT_MS = 15000
   426|
   427|  const allDone = VARIATION_TEMPS.map((tempOffset, i) => {
   428|    return new Promise((resolve) => {
   429|      const ac = new AbortController()
   430|      variationAbortControllers[i] = ac
   431|
   432|      let chunkTimer = setTimeout(() => {
   433|        ac.abort()
   434|        event.sender.send('ai-variation-error', { index: i, error: 'Model is taking too long to respond.' })
   435|        resolve()
   436|      }, CHUNK_TIMEOUT_MS)
   437|
   438|      const resetChunkTimer = () => {
   439|        clearTimeout(chunkTimer)
   440|        chunkTimer = setTimeout(() => {
   441|          ac.abort()
   442|          event.sender.send('ai-variation-error', { index: i, error: 'Model is taking too long to respond.' })
   443|          resolve()
   444|        }, CHUNK_TIMEOUT_MS)
   445|      }
   446|
   447|      const temp = Math.min(Math.max(config.temperature + tempOffset, 0), 2)
   448|
   449|      streamChat({
   450|        baseURL: config.baseURL,
   451|        apiKey: config.apiKey,
   452|        model: config.model,
   453|        messages: [
   454|          { role: 'system', content: systemPrompt },
   455|          { role: 'user', content: userPrompt }
   456|        ],
   457|        temperature: temp,
   458|        maxTokens: config.maxTokens,
   459|        signal: ac.signal,
   460|        onChunk: (text) => {
   461|          resetChunkTimer()
   462|          event.sender.send('ai-variation-chunk', { index: i, text })
   463|        },
   464|        onDone: () => {
   465|          clearTimeout(chunkTimer)
   466|          event.sender.send('ai-variation-done', { index: i })
   467|          resolve()
   468|        },
   469|        onError: (err) => {
   470|          clearTimeout(chunkTimer)
   471|          // Don't send if aborted (user cancel)
   472|          if (ac.signal.aborted) { resolve(); return }
   473|          event.sender.send('ai-variation-error', { index: i, error: err.message })
   474|          resolve()
   475|        }
   476|      }).catch(err => {
   477|        clearTimeout(chunkTimer)
   478|        if (ac.signal.aborted) { resolve(); return }
   479|        let msg = err.message
   480|        if (err.code === 'ECONNREFUSED') msg = `Cannot connect to ${config.baseURL}. Is the server running?`
   481|        else if (err.code === 'ENOTFOUND') msg = `Cannot resolve host at ${config.baseURL}. Check the Base URL in Settings.`
   482|        else if (err.code === 'ECONNRESET') msg = 'Connection was reset by the server.'
   483|        else if (err.code === 'ETIMEDOUT') msg = 'Connection timed out. The server may be down.'
   484|        event.sender.send('ai-variation-error', { index: i, error: msg })
   485|        resolve()
   486|      })
   487|    })
   488|  })
   489|
   490|  await Promise.all(allDone)
   491|  variationAbortControllers.length = 0
   492|})
   493|
   494|// AI: List Ollama models
   495|ipcMain.handle('ai-list-models', async () => {
   496|  const config = loadConfig()
   497|  if (config.provider !== 'ollama') return { models: [] }
   498|
   499|  try {
   500|    const url = new URL('/api/tags', config.baseURL.replace('/v1', ''))
   501|    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) })
   502|    const data = await response.json()
   503|    return { models: data.models?.map(m => m.name) || [] }
   504|  } catch (e) {
   505|    return { models: [], error: e.message }
   506|  }
   507|})
   508|
   509|// ═══ End AI Integration ═══
   510|
   511|app.whenReady().then(createWindow)
   512|app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
   513|app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
```

---

## Removed from `src/renderer/preload.js`

### AI bridge methods (lines 22-37)
```js
    22|  // ── AI Integration ──
    23|  aiRequest: (action, selectedText, customPrompt, docContext) => ipcRenderer.invoke('ai-request', { action, selectedText, customPrompt, docContext }),
    24|  aiRequestVariations: (action, selectedText, customPrompt, docContext) => ipcRenderer.invoke('ai-request-variations', { action, selectedText, customPrompt, docContext }),
    25|  aiGetConfig: () => ipcRenderer.invoke('ai-get-config'),
    26|  aiSaveConfig: (config) => ipcRenderer.invoke('ai-save-config', config),
    27|  aiTest: () => ipcRenderer.invoke('ai-test'),
    28|  aiCancel: () => ipcRenderer.invoke('ai-cancel'),
    29|  aiListModels: () => ipcRenderer.invoke('ai-list-models'),
    30|  onAiChunk: (cb) => { ipcRenderer.removeAllListeners('ai-chunk'); ipcRenderer.on('ai-chunk', (_, text) => cb(text)) },
    31|  onAiDone: (cb) => { ipcRenderer.removeAllListeners('ai-done'); ipcRenderer.on('ai-done', () => cb()) },
    32|  onAiError: (cb) => { ipcRenderer.removeAllListeners('ai-error'); ipcRenderer.on('ai-error', (_, err) => cb(err)) },
    33|  onAiVariationChunk: (cb) => { ipcRenderer.removeAllListeners('ai-variation-chunk'); ipcRenderer.on('ai-variation-chunk', (_, data) => cb(data)) },
    34|  onAiVariationDone: (cb) => { ipcRenderer.removeAllListeners('ai-variation-done'); ipcRenderer.on('ai-variation-done', (_, data) => cb(data)) },
    35|  onAiVariationError: (cb) => { ipcRenderer.removeAllListeners('ai-variation-error'); ipcRenderer.on('ai-variation-error', (_, data) => cb(data)) },
    36|  onMenuAi: (cb) => { ipcRenderer.removeAllListeners('menu-ai'); ipcRenderer.on('menu-ai', cb) },
    37|  onMenuSettings: (cb) => { ipcRenderer.removeAllListeners('menu-settings'); ipcRenderer.on('menu-settings', cb) }
    38|})
```

---

## Removed from `src/renderer/renderer.js`

### AI keybinding (line 561)
```js
{ key: 'Mod-j', run: () => { openAiPanel(); return true } },
```

### Settings keybinding (line 563)
```js
{ key: 'Mod-,', run: () => { openSettings(); return true } },
```

### Palette commands (lines 729-730)
```js
{ icon: '✨', label: 'AI Assist', kbd: '⌘J', action: () => openAiPanel() },
{ icon: '⚙️', label: 'Settings', kbd: '⌘,', action: () => openSettings() },
```

### AI panel state + functions + event wiring (lines 908-1476)
All AI panel logic, settings modal, variations, translate, document context.

```js
   908|// ── AI Panel State & Functions ──
   909|let aiOriginalText = ''
   910|let aiResultText = ''
   911|let aiSelectionFrom = null
   912|let aiSelectionTo = null
   913|let aiCurrentAction = null
   914|let aiCurrentCustomPrompt = null
   915|let aiIsStreaming = false
   916|
   917|// ── Variations state ──
   918|let aiVariationMode = false        // whether variations checkbox is on
   919|let aiVariationResults = ['', '', ''] // accumulated text per variation
   920|let aiVariationDone = [false, false, false]
   921|let aiVariationError = [null, null, null]
   922|let aiActiveVariation = 0           // currently visible tab (0-2)
   923|
   924|function openAiPanel() {
   925|  if (editor) {
   926|    const sel = editor.state.selection.main
   927|    aiSelectionFrom = sel.from
   928|    aiSelectionTo = sel.to
   929|    aiOriginalText = editor.state.sliceDoc(sel.from, sel.to)
   930|  } else {
   931|    aiOriginalText = ''
   932|    aiSelectionFrom = null
   933|    aiSelectionTo = null
   934|  }
   935|
   936|  // Reset UI
   937|  document.getElementById('ai-original-text').textContent = aiOriginalText || '(no text selected)'
   938|  document.getElementById('ai-result-text').textContent = ''
   939|  document.getElementById('ai-prompt-input').value = ''
   940|  document.getElementById('ai-response').classList.add('hidden')
   941|  document.getElementById('ai-actions-bar').classList.add('hidden')
   942|  document.getElementById('ai-stop-bar').classList.add('hidden')
   943|  document.getElementById('ai-loading').classList.add('hidden')
   944|  document.getElementById('ai-error').classList.add('hidden')
   945|  document.getElementById('ai-variations-tabs').classList.add('hidden')
   946|  document.getElementById('ai-variations-toggle').classList.remove('hidden')
   947|  document.getElementById('ai-translate-row').classList.add('hidden')
   948|  aiResultText = ''
   949|  aiIsStreaming = false
   950|  aiVariationMode = document.getElementById('ai-variations-check').checked
   951|  aiVariationResults = ['', '', '']
   952|  aiVariationDone = [false, false, false]
   953|  aiVariationError = [null, null, null]
   954|  aiActiveVariation = 0
   955|
   956|  // Show/hide actions section based on selection
   957|  const actionsDiv = document.getElementById('ai-actions')
   958|  const customDiv = document.getElementById('ai-custom')
   959|  if (aiOriginalText) {
   960|    actionsDiv.classList.remove('hidden')
   961|    customDiv.classList.remove('hidden')
   962|  } else {
   963|    actionsDiv.classList.add('hidden')
   964|    customDiv.classList.remove('hidden')
   965|  }
   966|
   967|  document.getElementById('ai-overlay').classList.add('open')
   968|  if (!aiOriginalText) {
   969|    document.getElementById('ai-prompt-input').focus()
   970|  }
   971|}
   972|
   973|function closeAiPanel() {
   974|  document.getElementById('ai-overlay').classList.remove('open')
   975|  // Cancel any in-flight request
   976|  if (aiIsStreaming) {
   977|    window.gaboAPI.aiCancel()
   978|    aiIsStreaming = false
   979|  }
   980|  // Hide variation tabs
   981|  document.getElementById('ai-variations-tabs').classList.add('hidden')
   982|  if (editor) editor.focus()
   983|}
   984|
   985|// ── Document Context ──
   986|// Extracts an outline (headings) + text surrounding the cursor/selection
   987|// so the AI understands where in the document it's editing.
   988|function buildDocContext() {
   989|  if (!editor) return ''
   990|  const doc = editor.state.doc
   991|  const pos = editor.state.selection.main.head
   992|  const selEnd = editor.state.selection.main.to
   993|  const text = doc.toString()
   994|
   995|  // 1. Build outline from ATX headings (# to ######)
   996|  const outlineLines = []
   997|  const headingRegex = /^(#{1,6})\s+(.+)$/gm
   998|  let match
   999|  while ((match = headingRegex.exec(text)) !== null) {
  1000|    const level = match[1].length
  1001|    const title = match[2].trim()
  1002|    const lineNum = text.substring(0, match.index).split('\n').length
  1003|    outlineLines.push(`${'  '.repeat(level - 1)}${'#'.repeat(level)} ${title}  (L${lineNum})`)
  1004|  }
  1005|  const outline = outlineLines.length > 0
  1006|    ? 'Document outline:\n' + outlineLines.join('\n')
  1007|    : ''
  1008|
  1009|  // 2. Text before selection (~500 chars)
  1010|  const contextBeforeStart = Math.max(0, pos - 500)
  1011|  const contextBefore = doc.sliceString(contextBeforeStart, pos).trim()
  1012|
  1013|  // 3. Text after selection (~200 chars)
  1014|  const contextAfterEnd = Math.min(doc.length, selEnd + 200)
  1015|  const contextAfter = doc.sliceString(selEnd, contextAfterEnd).trim()
  1016|
  1017|  // 4. Assemble
  1018|  const parts = []
  1019|  if (outline) parts.push(outline)
  1020|  if (contextBefore) parts.push('Text before selection:\n' + contextBefore)
  1021|  if (contextAfter) parts.push('Text after selection:\n' + contextAfter)
  1022|
  1023|  return parts.join('\n\n')
  1024|}
  1025|
  1026|async function sendAiRequest(action, customPromptText) {
  1027|  if (aiIsStreaming) return
  1028|  aiCurrentAction = action
  1029|  aiCurrentCustomPrompt = customPromptText || null
  1030|  aiIsStreaming = true
  1031|  aiResultText = ''
  1032|
  1033|  let textToSend = aiOriginalText
  1034|  if (!textToSend && editor) {
  1035|    const pos = editor.state.selection.main.head
  1036|    const start = Math.max(0, pos - 2000)
  1037|    const end = Math.min(editor.state.doc.length, pos + 2000)
  1038|    textToSend = editor.state.sliceDoc(start, end)
  1039|  }
  1040|
  1041|  // Show loading spinner initially, before first chunk arrives
  1042|  document.getElementById('ai-actions').classList.add('hidden')
  1043|  document.getElementById('ai-custom').classList.add('hidden')
  1044|  document.getElementById('ai-variations-toggle').classList.add('hidden')
  1045|  document.getElementById('ai-translate-row').classList.add('hidden')
  1046|  document.getElementById('ai-response').classList.add('hidden')
  1047|  document.getElementById('ai-loading').classList.remove('hidden')
  1048|  document.getElementById('ai-streaming-cursor').classList.remove('hidden')
  1049|  document.getElementById('ai-actions-bar').classList.add('hidden')
  1050|  document.getElementById('ai-stop-bar').classList.remove('hidden')
  1051|  document.getElementById('ai-error').classList.add('hidden')
  1052|  document.getElementById('ai-variations-tabs').classList.add('hidden')
  1053|
  1054|  let firstChunkReceived = false
  1055|  const promptForCustom = action === 'custom' ? customPromptText : null
  1056|
  1057|  // ── Refresh variation mode (may have changed between requests) ──
  1058|  aiVariationMode = document.getElementById('ai-variations-check').checked
  1059|  if (aiVariationMode) {
  1060|    aiVariationResults = ['', '', '']
  1061|    aiVariationDone = [false, false, false]
  1062|    aiVariationError = [null, null, null]
  1063|    aiActiveVariation = 0
  1064|  }
  1065|
  1066|  if (aiVariationMode) {
  1067|    // ── VARIATIONS MODE: 3 parallel streams ──
  1068|    window.gaboAPI.onAiVariationChunk(({ index, text }) => {
  1069|      if (!aiIsStreaming) return
  1070|      if (!firstChunkReceived) {
  1071|        firstChunkReceived = true
  1072|        document.getElementById('ai-loading').classList.add('hidden')
  1073|        document.getElementById('ai-response').classList.remove('hidden')
  1074|        document.getElementById('ai-variations-tabs').classList.remove('hidden')
  1075|        document.getElementById('ai-original-text').textContent = textToSend.slice(0, 500) + (textToSend.length > 500 ? '…' : '')
  1076|        updateVariationTabStyles()
  1077|      }
  1078|      aiVariationResults[index] += text
  1079|      if (index === aiActiveVariation) {
  1080|        aiResultText = aiVariationResults[index]
  1081|        document.getElementById('ai-result-text').textContent = aiResultText
  1082|        const el = document.getElementById('ai-result-text')
  1083|        el.scrollTop = el.scrollHeight
  1084|      }
  1085|    })
  1086|
  1087|    window.gaboAPI.onAiVariationDone(({ index }) => {
  1088|      aiVariationDone[index] = true
  1089|      updateVariationTabStyles()
  1090|      if (index === aiActiveVariation) {
  1091|        aiResultText = aiVariationResults[index]
  1092|      }
  1093|      // When all 3 done, finish streaming
  1094|      if (aiVariationDone.every(Boolean)) {
  1095|        aiIsStreaming = false
  1096|        document.getElementById('ai-streaming-cursor').classList.add('hidden')
  1097|        document.getElementById('ai-stop-bar').classList.add('hidden')
  1098|        document.getElementById('ai-actions-bar').classList.remove('hidden')
  1099|      }
  1100|    })
  1101|
  1102|    window.gaboAPI.onAiVariationError(({ index, error }) => {
  1103|      aiVariationError[index] = error
  1104|      aiVariationDone[index] = true // treat as done so we don't wait forever
  1105|      updateVariationTabStyles()
  1106|      if (index === aiActiveVariation) {
  1107|        // Show error in result area
  1108|        document.getElementById('ai-result-text').textContent = '⚠ ' + error
  1109|        aiResultText = ''
  1110|      }
  1111|      if (aiVariationDone.every(Boolean)) {
  1112|        aiIsStreaming = false
  1113|        document.getElementById('ai-streaming-cursor').classList.add('hidden')
  1114|        document.getElementById('ai-stop-bar').classList.add('hidden')
  1115|        document.getElementById('ai-actions-bar').classList.remove('hidden')
  1116|      }
  1117|    })
  1118|
  1119|    const docContext = buildDocContext()
  1120|    await window.gaboAPI.aiRequestVariations(action, textToSend, promptForCustom, docContext)
  1121|
  1122|  } else {
  1123|    // ── SINGLE REQUEST MODE (original behavior) ──
  1124|    window.gaboAPI.onAiChunk((text) => {
  1125|      if (!aiIsStreaming) return
  1126|      if (!firstChunkReceived) {
  1127|        firstChunkReceived = true
  1128|        document.getElementById('ai-loading').classList.add('hidden')
  1129|        document.getElementById('ai-response').classList.remove('hidden')
  1130|        document.getElementById('ai-original-text').textContent = textToSend.slice(0, 500) + (textToSend.length > 500 ? '…' : '')
  1131|        document.getElementById('ai-result-text').textContent = ''
  1132|      }
  1133|      aiResultText += text
  1134|      document.getElementById('ai-result-text').textContent = aiResultText
  1135|      const resultEl = document.getElementById('ai-result-text')
  1136|      resultEl.scrollTop = resultEl.scrollHeight
  1137|    })
  1138|
  1139|    window.gaboAPI.onAiDone(() => {
  1140|      aiIsStreaming = false
  1141|      document.getElementById('ai-streaming-cursor').classList.add('hidden')
  1142|      document.getElementById('ai-stop-bar').classList.add('hidden')
  1143|      document.getElementById('ai-actions-bar').classList.remove('hidden')
  1144|    })
  1145|
  1146|    window.gaboAPI.onAiError((errMsg) => {
  1147|      aiIsStreaming = false
  1148|      document.getElementById('ai-response').classList.add('hidden')
  1149|      document.getElementById('ai-loading').classList.add('hidden')
  1150|      document.getElementById('ai-stop-bar').classList.add('hidden')
  1151|      document.getElementById('ai-error-text').textContent = errMsg
  1152|      document.getElementById('ai-error').classList.remove('hidden')
  1153|    })
  1154|
  1155|    const docContext = buildDocContext()
  1156|    await window.gaboAPI.aiRequest(action, textToSend, promptForCustom, docContext)
  1157|  }
  1158|}
  1159|
  1160|// ── Variations tab helpers ──
  1161|function updateVariationTabStyles() {
  1162|  const tabs = document.querySelectorAll('.ai-var-tab')
  1163|  tabs.forEach((tab, i) => {
  1164|    tab.classList.remove('active', 'streaming', 'done', 'error')
  1165|    if (i === aiActiveVariation) tab.classList.add('active')
  1166|    if (aiVariationError[i]) tab.classList.add('error')
  1167|    else if (aiVariationDone[i]) tab.classList.add('done')
  1168|    else tab.classList.add('streaming')
  1169|  })
  1170|}
  1171|
  1172|function switchVariationTab(index) {
  1173|  if (index === aiActiveVariation) return
  1174|  aiActiveVariation = index
  1175|  // Update result text to reflect the active tab
  1176|  if (aiVariationError[index]) {
  1177|    document.getElementById('ai-result-text').textContent = '⚠ ' + aiVariationError[index]
  1178|    aiResultText = ''
  1179|  } else {
  1180|    aiResultText = aiVariationResults[index]
  1181|    document.getElementById('ai-result-text').textContent = aiResultText
  1182|  }
  1183|  // Show/hide streaming cursor based on whether this variation is still streaming
  1184|  const cursorHidden = aiVariationDone[index]
  1185|  document.getElementById('ai-streaming-cursor').classList.toggle('hidden', cursorHidden)
  1186|  updateVariationTabStyles()
  1187|}
  1188|
  1189|function aiReplace() {
  1190|  if (!editor || !aiResultText) return
  1191|  if (aiOriginalText && aiSelectionFrom !== null) {
  1192|    editor.dispatch({
  1193|      changes: { from: aiSelectionFrom, to: aiSelectionTo, insert: aiResultText },
  1194|      annotations: Transaction.userEvent.of('input.ai')
  1195|    })
  1196|  } else {
  1197|    const pos = editor.state.selection.main.head
  1198|    editor.dispatch({
  1199|      changes: { from: pos, insert: aiResultText },
  1200|      annotations: Transaction.userEvent.of('input.ai')
  1201|    })
  1202|  }
  1203|  closeAiPanel()
  1204|}
  1205|
  1206|function aiInsertBelow() {
  1207|  if (!editor || !aiResultText) return
  1208|  const pos = editor.state.selection.main.head
  1209|  const line = editor.state.doc.lineAt(pos)
  1210|  editor.dispatch({
  1211|    changes: { from: line.to, insert: '\n\n' + aiResultText },
  1212|    annotations: Transaction.userEvent.of('input.ai')
  1213|  })
  1214|  closeAiPanel()
  1215|}
  1216|
  1217|function aiCopy() {
  1218|  if (!aiResultText) return
  1219|  navigator.clipboard.writeText(aiResultText)
  1220|  closeAiPanel()
  1221|}
  1222|
  1223|function aiDiscard() {
  1224|  closeAiPanel()
  1225|}
  1226|
  1227|function aiStop() {
  1228|  window.gaboAPI.aiCancel()
  1229|  aiIsStreaming = false
  1230|  document.getElementById('ai-streaming-cursor').classList.add('hidden')
  1231|  document.getElementById('ai-stop-bar').classList.add('hidden')
  1232|  if (aiResultText) {
  1233|    document.getElementById('ai-actions-bar').classList.remove('hidden')
  1234|  } else {
  1235|    document.getElementById('ai-response').classList.add('hidden')
  1236|  }
  1237|}
  1238|
  1239|// ── AI Panel Event Wiring ──
  1240|document.querySelectorAll('.ai-action').forEach(btn => {
  1241|  btn.addEventListener('click', () => {
  1242|    if (btn.dataset.action === 'translate') {
  1243|      // Show language selector instead of sending immediately
  1244|      document.getElementById('ai-actions').classList.add('hidden')
  1245|      document.getElementById('ai-translate-row').classList.remove('hidden')
  1246|    } else {
  1247|      sendAiRequest(btn.dataset.action)
  1248|    }
  1249|  })
  1250|})
  1251|// Translate: "Go" button sends translate request with selected language
  1252|document.getElementById('ai-translate-go').addEventListener('click', () => {
  1253|  const lang = document.getElementById('ai-translate-lang').value
  1254|  sendAiRequest('translate', `Translate the following text to ${lang}`)
  1255|  document.getElementById('ai-translate-row').classList.add('hidden')
  1256|})
  1257|// Translate: Escape/cancel returns to actions
  1258|document.getElementById('ai-translate-lang').addEventListener('keydown', (e) => {
  1259|  if (e.key === 'Escape') {
  1260|    e.preventDefault()
  1261|    document.getElementById('ai-translate-row').classList.add('hidden')
  1262|    document.getElementById('ai-actions').classList.remove('hidden')
  1263|  }
  1264|})
  1265|document.getElementById('ai-custom-submit').addEventListener('click', () => {
  1266|  const prompt = document.getElementById('ai-prompt-input').value.trim()
  1267|  if (prompt) sendAiRequest('custom', prompt)
  1268|})
  1269|document.getElementById('ai-prompt-input').addEventListener('keydown', (e) => {
  1270|  if (e.key === 'Enter') {
  1271|    e.preventDefault()
  1272|    const prompt = document.getElementById('ai-prompt-input').value.trim()
  1273|    if (prompt) sendAiRequest('custom', prompt)
  1274|  }
  1275|  if (e.key === 'Escape') closeAiPanel()
  1276|})
  1277|document.getElementById('ai-replace').addEventListener('click', aiReplace)
  1278|document.getElementById('ai-insert').addEventListener('click', aiInsertBelow)
  1279|document.getElementById('ai-copy').addEventListener('click', aiCopy)
  1280|document.getElementById('ai-discard').addEventListener('click', aiDiscard)
  1281|document.getElementById('ai-stop').addEventListener('click', aiStop)
  1282|document.getElementById('ai-close').addEventListener('click', closeAiPanel)
  1283|// Variation tab switching
  1284|document.querySelectorAll('.ai-var-tab').forEach(tab => {
  1285|  tab.addEventListener('click', () => {
  1286|    const index = parseInt(tab.dataset.variation, 10)
  1287|    switchVariationTab(index)
  1288|  })
  1289|})
  1290|document.getElementById('ai-error-retry').addEventListener('click', () => {
  1291|  sendAiRequest(aiCurrentAction, aiCurrentCustomPrompt || undefined)
  1292|})
  1293|document.getElementById('ai-overlay').addEventListener('click', (e) => {
  1294|  if (e.target === document.getElementById('ai-overlay')) closeAiPanel()
  1295|})
  1296|
  1297|// ── Menu/IPC: AI ──
  1298|window.gaboAPI.onMenuAi(() => openAiPanel())
  1299|
  1300|// Global Escape to close AI panel (works during streaming too)
  1301|document.addEventListener('keydown', (e) => {
  1302|  if (e.key === 'Escape' && document.getElementById('ai-overlay').classList.contains('open')) {
  1303|    e.preventDefault()
  1304|    closeAiPanel()
  1305|  }
  1306|})
  1307|
  1308|// ═══════════════════════════════════════
  1309|// ── Settings ──
  1310|// ═══════════════════════════════════════
  1311|let currentAiConfig = null
  1312|
  1313|const PROVIDER_DEFAULTS = {
  1314|  'ollama': { baseURL: 'http://localhost:11434/v1', model: 'llama3.2' },
  1315|  'openai-compatible': { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  1316|  'hermes': { baseURL: 'http://localhost:8642/v1', model: 'glm-5.1:cloud' }
  1317|}
  1318|
  1319|async function openSettings() {
  1320|  currentAiConfig = await window.gaboAPI.aiGetConfig()
  1321|
  1322|  document.getElementById('settings-provider').value = currentAiConfig.provider
  1323|  document.getElementById('settings-baseurl').value = currentAiConfig.baseURL
  1324|  document.getElementById('settings-apikey').value = currentAiConfig.apiKey
  1325|  document.getElementById('settings-model').value = currentAiConfig.model
  1326|  document.getElementById('settings-temperature').value = currentAiConfig.temperature
  1327|  document.getElementById('settings-temperature-val').textContent = currentAiConfig.temperature
  1328|  document.getElementById('settings-maxtokens').value = currentAiConfig.maxTokens
  1329|  document.getElementById('settings-ai-enabled').checked = currentAiConfig.enabled
  1330|
  1331|  updateSettingsDefaults()
  1332|  await loadOllamaModels()
  1333|  document.getElementById('settings-test-result').classList.add('hidden')
  1334|  document.getElementById('settings-overlay').classList.add('open')
  1335|}
  1336|
  1337|function closeSettings() {
  1338|  document.getElementById('settings-overlay').classList.remove('open')
  1339|  if (editor) editor.focus()
  1340|}
  1341|
  1342|function updateSettingsDefaults() {
  1343|  const provider = document.getElementById('settings-provider').value
  1344|  const defaults = PROVIDER_DEFAULTS[provider]
  1345|  if (!defaults) return
  1346|  const baseURLInput = document.getElementById('settings-baseurl')
  1347|  const modelInput = document.getElementById('settings-model')
  1348|  const allDefaults = Object.values(PROVIDER_DEFAULTS)
  1349|  if (allDefaults.some(d => d.baseURL === baseURLInput.value)) {
  1350|    baseURLInput.value = defaults.baseURL
  1351|  }
  1352|  if (allDefaults.some(d => d.model === modelInput.value)) {
  1353|    modelInput.value = defaults.model
  1354|  }
  1355|}
  1356|
  1357|async function loadOllamaModels() {
  1358|  const provider = document.getElementById('settings-provider').value
  1359|  const selectEl = document.getElementById('settings-model-select')
  1360|  const inputEl = document.getElementById('settings-model')
  1361|
  1362|  if (provider === 'ollama') {
  1363|    // Show dropdown, hide text input
  1364|    selectEl.classList.remove('hidden')
  1365|    inputEl.classList.add('hidden')
  1366|
  1367|    selectEl.innerHTML = '<option value="">Loading models…</option>'
  1368|
  1369|    const result = await window.gaboAPI.aiListModels()
  1370|    const currentModel = inputEl.value
  1371|
  1372|    if (result.models && result.models.length > 0) {
  1373|      selectEl.innerHTML = ''
  1374|      result.models.forEach(m => {
  1375|        const opt = document.createElement('option')
  1376|        opt.value = m
  1377|        opt.textContent = m
  1378|        if (m === currentModel) opt.selected = true
  1379|        selectEl.appendChild(opt)
  1380|      })
  1381|      // Add custom option if current model not in list
  1382|      if (currentModel && !result.models.includes(currentModel)) {
  1383|        const opt = document.createElement('option')
  1384|        opt.value = currentModel
  1385|        opt.textContent = currentModel + ' (custom)'
  1386|        opt.selected = true
  1387|        selectEl.prepend(opt)
  1388|      }
  1389|    } else {
  1390|      // Fallback to text input if no models found
  1391|      selectEl.classList.add('hidden')
  1392|      inputEl.classList.remove('hidden')
  1393|    }
  1394|
  1395|    // Sync dropdown → text input on change
  1396|    selectEl.onchange = () => { inputEl.value = selectEl.value }
  1397|    selectEl.value = currentModel
  1398|  } else {
  1399|    // Non-Ollama: show text input, hide dropdown
  1400|    selectEl.classList.add('hidden')
  1401|    inputEl.classList.remove('hidden')
  1402|  }
  1403|}
  1404|
  1405|function gatherSettingsConfig() {
  1406|  return {
  1407|    provider: document.getElementById('settings-provider').value,
  1408|    baseURL: document.getElementById('settings-baseurl').value.trim(),
  1409|    apiKey: document.getElementById('settings-apikey').value,
  1410|    model: document.getElementById('settings-model').value.trim(),
  1411|    temperature: parseFloat(document.getElementById('settings-temperature').value),
  1412|    maxTokens: parseInt(document.getElementById('settings-maxtokens').value),
  1413|    enabled: document.getElementById('settings-ai-enabled').checked
  1414|  }
  1415|}
  1416|
  1417|document.getElementById('settings-provider').addEventListener('change', async () => {
  1418|  updateSettingsDefaults()
  1419|  await loadOllamaModels()
  1420|})
  1421|
  1422|document.getElementById('settings-temperature').addEventListener('input', (e) => {
  1423|  document.getElementById('settings-temperature-val').textContent = e.target.value
  1424|})
  1425|
  1426|document.getElementById('settings-save').addEventListener('click', async () => {
  1427|  const newConfig = gatherSettingsConfig()
  1428|  const result = await window.gaboAPI.aiSaveConfig(newConfig)
  1429|  if (result.ok) {
  1430|    closeSettings()
  1431|  } else {
  1432|    const resultEl = document.getElementById('settings-test-result')
  1433|    resultEl.classList.remove('hidden', 'success', 'error')
  1434|    resultEl.classList.add('error')
  1435|    resultEl.textContent = '❌ ' + (result.errors || []).join(', ')
  1436|  }
  1437|})
  1438|
  1439|document.getElementById('settings-test').addEventListener('click', async () => {
  1440|  const resultEl = document.getElementById('settings-test-result')
  1441|  resultEl.classList.remove('hidden', 'success', 'error')
  1442|  resultEl.textContent = 'Testing…'
  1443|
  1444|  const newConfig = gatherSettingsConfig()
  1445|  const saveResult = await window.gaboAPI.aiSaveConfig(newConfig)
  1446|  if (!saveResult.ok) {
  1447|    resultEl.classList.add('error')
  1448|    resultEl.textContent = '❌ ' + (saveResult.errors || []).join(', ')
  1449|    return
  1450|  }
  1451|
  1452|  const testResult = await window.gaboAPI.aiTest()
  1453|  if (testResult.ok) {
  1454|    resultEl.classList.add('success')
  1455|    resultEl.textContent = `✅ ${testResult.message}`
  1456|  } else {
  1457|    resultEl.classList.add('error')
  1458|    resultEl.textContent = `❌ ${testResult.error}`
  1459|  }
  1460|})
  1461|
  1462|document.getElementById('settings-close').addEventListener('click', closeSettings)
  1463|document.getElementById('settings-overlay').addEventListener('click', (e) => {
  1464|  if (e.target === document.getElementById('settings-overlay')) closeSettings()
  1465|})
  1466|
  1467|// Global Escape to close Settings
  1468|document.addEventListener('keydown', (e) => {
  1469|  if (e.key === 'Escape' && document.getElementById('settings-overlay').classList.contains('open')) {
  1470|    e.preventDefault()
  1471|    closeSettings()
  1472|  }
  1473|})
  1474|
  1475|window.gaboAPI.onMenuSettings(() => openSettings())
  1476|
  1477|// ── Initialize ──
  1478|document.addEventListener('DOMContentLoaded', async () => {
  1479|  // Try to restore the last opened file
  1480|  const lastFile = localStorage.getItem('gabo-last-file')
  1481|  if (lastFile) {
  1482|    try {
  1483|      const result = await window.gaboAPI.openFileByPath(lastFile)
  1484|      if (result) {
  1485|        currentFilePath = result.path
  1486|        isDirty = false
  1487|        createEditor(result.content)
  1488|        updateTitle()
  1489|        return // Skip welcome screen
  1490|      }
  1491|    } catch (_) {
  1492|      // File may have been moved/deleted — fall through to welcome screen
  1493|    }
  1494|  }
  1495|
  1496|  createEditor(`# Welcome to Gabo
  1497|
  1498|A minimalist, distraction-free markdown editor.
  1499|
  1500|- [ ] Try focus mode with \`Cmd+D\`
  1501|- [ ] Toggle markdown mode with the .MD button
  1502|- [ ] Enter zen mode with \`Cmd+Enter\`
  1503|- [ ] Start writing
  1504|
  1505|## Focus
  1506|
  1507|Only the paragraph you're writing matters. Press \`Cmd+D\` to dim everything else.
  1508|
```

---

## Removed from `src/renderer/index.html`

### AI Panel CSS (lines 454-611)
Styles for the AI overlay backdrop, panel container, action buttons grid,
custom prompt input, translate language selector, variations toggle & tabs,
streaming response area, streaming cursor animation, action/stop/copy/discard
buttons, loading dots animation, and error state display.

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
    #ai-actions {
      display: grid; grid-template-columns: repeat(3, 1fr);
      gap: 8px; padding: 16px 20px 8px;
    }
    .ai-action {
      font-family: var(--font-body); font-size: 13px; font-weight: 500;
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
      flex: 1; font-family: var(--font-body); font-size: 14px;
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
    #ai-translate-row {
      display: flex; align-items: center; gap: 8px; padding: 4px 20px 8px;
    }
    #ai-translate-label {
      font-family: var(--font-body); font-size: 12px; color: var(--text-dim);
      white-space: nowrap;
    }
    #ai-translate-lang {
      flex: 1; font-family: var(--font-body); font-size: 13px;
      background: var(--bg-main); color: var(--text-primary);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 6px 10px; outline: none; cursor: pointer;
    }
    #ai-translate-lang:focus { border-color: var(--accent); }
    #ai-translate-go { padding: 6px 16px !important; }
    #ai-variations-toggle {
      padding: 6px 20px 10px; user-select: none;
    }
    #ai-variations-toggle label {
      font-family: var(--font-body); font-size: 12px; color: var(--text-dim);
      cursor: pointer; display: flex; align-items: center; gap: 6px;
    }
    #ai-variations-check { accent-color: var(--accent); cursor: pointer; }
    .ai-variations-hint { color: var(--text-dim); opacity: 0.6; }
    #ai-variations-tabs {
      display: flex; gap: 4px; margin-bottom: 8px;
    }
    .ai-var-tab {
      flex: 1; font-family: var(--font-body); font-size: 11px; font-weight: 500;
      padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border);
      background: transparent; color: var(--text-dim); cursor: pointer;
      transition: all 0.15s; text-align: center;
    }
    .ai-var-tab:hover { border-color: var(--accent); color: var(--text-primary); }
    .ai-var-tab.active {
      background: var(--accent); color: #fff; border-color: var(--accent);
    }
    .ai-var-tab.streaming { opacity: 0.5; }
    .ai-var-tab.done { opacity: 1; }
    .ai-var-tab.error { text-decoration: line-through; opacity: 0.4; }
    #ai-response {
      padding: 16px 20px; display: flex; flex-direction: column; gap: 12px;
    }
    #ai-original-label, #ai-result-label {
      font-family: var(--font-display); font-size: 10px; font-weight: 600;
      letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-dim);
      margin-bottom: 4px;
    }
    #ai-original-text {
      font-family: var(--font-body); font-size: 14px; line-height: 1.6;
      color: var(--text-secondary); padding: 10px 14px; border-radius: 8px;
      background: var(--bg-main); border: 1px solid var(--border);
      max-height: 120px; overflow-y: auto;
    }
    #ai-result-text {
      font-family: var(--font-body); font-size: 14px; line-height: 1.6;
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
    #ai-stop-bar {
      display: flex; justify-content: center; padding: 12px 20px 16px;
    }
    .ai-btn {
      font-family: var(--font-body); font-size: 13px; font-weight: 500;
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
      color: #e5534b; font-family: var(--font-body); font-size: 14px;
    }
    #ai-error-text { flex: 1; }
```

### Settings Modal CSS (lines 613-675)
Styles for the settings overlay backdrop, panel container, header, groups,
form rows, inputs/selects/ranges/checkboxes, test result feedback.

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
    .settings-group { padding: 12px 20px; }
    .settings-group + .settings-group { border-top: 1px solid var(--border); }
    .settings-group-label {
      font-family: var(--font-display); font-size: 10px; font-weight: 600;
      letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-dim);
      margin-bottom: 12px;
    }
    .settings-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .settings-row-buttons { margin-top: 16px; justify-content: flex-end; }
    .settings-label {
      font-family: var(--font-body); font-size: 13px; font-weight: 500;
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
    #settings-content input:focus, #settings-content select:focus { border-color: var(--accent); }
    #settings-content input[type="range"] { flex: 1; }
    #settings-temperature-val {
      font-family: var(--font-mono); font-size: 13px; color: var(--text-secondary);
      min-width: 30px;
    }
    #settings-content input[type="checkbox"] {
      width: 18px; height: 18px; accent-color: var(--accent);
    }
    #settings-test-result {
      font-family: var(--font-body); font-size: 13px; margin-top: 8px;
      padding: 8px 12px; border-radius: 8px;
    }
    #settings-test-result.success { background: #d4edda; color: #155724; }
    #settings-test-result.error { background: #f8d7da; color: #721c24; }
    #settings-model-wrap { flex: 1; display: flex; position: relative; }
    #settings-model-wrap select,
    #settings-model-wrap input { width: 100%; }
    #settings-model-wrap > :not(.hidden) { display: block; }
```

### AI Panel HTML (lines 782-879)
Complete AI overlay with header, preset action buttons (Improve, Grammar,
Shorter, Expand, Formal, Casual, Summarize, Simplify, Rephrase, Translate),
translate language selector, variations toggle with 3-tab interface
(Precise/Balanced/Creative), custom prompt input, streaming response area
with original text + AI result + blinking cursor, action bar (Replace/Insert
Below/Copy/Discard), stop button, loading dots, and error state with retry.

```html
  <div id="ai-overlay">
    <div id="ai-panel">
      <div id="ai-header">
        <span id="ai-title">✦ AI Assist</span>
        <button id="ai-close" class="icon-btn" title="Close (Esc)">✕</button>
      </div>

      <!-- Preset actions (shown when text is selected) -->
      <div id="ai-actions">
        <button class="ai-action" data-action="improve">Improve</button>
        <button class="ai-action" data-action="grammar">Grammar</button>
        <button class="ai-action" data-action="shorter">Shorter</button>
        <button class="ai-action" data-action="expand">Expand</button>
        <button class="ai-action" data-action="formal">Formal</button>
        <button class="ai-action" data-action="casual">Casual</button>
        <button class="ai-action" data-action="summarize">Summarize</button>
        <button class="ai-action" data-action="simplify">Simplify</button>
        <button class="ai-action" data-action="rephrase">Rephrase</button>
        <button class="ai-action" data-action="translate">Translate</button>
      </div>

      <!-- Translate language selector (shown when Translate action picked) -->
      <div id="ai-translate-row" class="hidden">
        <span id="ai-translate-label">To:</span>
        <select id="ai-translate-lang">
          <option value="Spanish">Spanish</option>
          <option value="French">French</option>
          <option value="German">German</option>
          <option value="Portuguese">Portuguese</option>
          <option value="Italian">Italian</option>
          <option value="Dutch">Dutch</option>
          <option value="Japanese">Japanese</option>
          <option value="Chinese">Chinese</option>
          <option value="Korean">Korean</option>
          <option value="Russian">Russian</option>
          <option value="Arabic">Arabic</option>
          <option value="English">English</option>
        </select>
        <button class="ai-action" id="ai-translate-go">Go</button>
      </div>

      <!-- Variations toggle -->
      <div id="ai-variations-toggle">
        <label><input type="checkbox" id="ai-variations-check"> ✦ Variations <span class="ai-variations-hint">(3 takes)</span></label>
      </div>

      <!-- Custom prompt -->
      <div id="ai-custom">
        <input type="text" id="ai-prompt-input" placeholder="Ask anything about your text…" spellcheck="false" autocomplete="off">
        <button id="ai-custom-submit" title="Send">→</button>
      </div>

      <!-- Streaming response area -->
      <div id="ai-response" class="hidden">
        <div id="ai-original">
          <div id="ai-original-label">Selected</div>
          <div id="ai-original-text"></div>
        </div>
        <div id="ai-result">
          <div id="ai-variations-tabs" class="hidden">
            <button class="ai-var-tab active" data-variation="0">Precise</button>
            <button class="ai-var-tab" data-variation="1">Balanced</button>
            <button class="ai-var-tab" data-variation="2">Creative</button>
          </div>
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

      <!-- Stop button (shown during streaming) -->
      <div id="ai-stop-bar" class="hidden">
        <button id="ai-stop" class="ai-btn ai-btn-secondary">⏹ Stop</button>
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

### Settings Modal HTML (lines 885-944)
Settings overlay with AI provider config (Ollama/OpenAI-Compatible/Hermes Agent),
base URL, API key, model (with Ollama auto-list), Save & Test / Save Settings
buttons, AI behavior group (temperature slider, max tokens, enable AI checkbox).

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
            <div id="settings-model-wrap">
              <select id="settings-model-select" class="hidden">
                <option value="">Loading models…</option>
              </select>
              <input type="text" id="settings-model" placeholder="llama3.2" spellcheck="false" autocomplete="off">
            </div>
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

---

## IPC Channels Removed

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `ai-request` | renderer→main | AI completion (streaming) |
| `ai-request-variations` | renderer→main | 3 parallel AI streams |
| `ai-get-config` | renderer→main | Read AI config |
| `ai-save-config` | renderer→main | Save AI config |
| `ai-test` | renderer→main | Test AI connection |
| `ai-cancel` | renderer→main | Cancel in-flight request |
| `ai-list-models` | renderer→main | List Ollama models |
| `ai-chunk` | main→renderer | Streaming text chunk |
| `ai-done` | main→renderer | Stream completed |
| `ai-error` | main→renderer | Error message |
| `ai-variation-chunk` | main→renderer | Variation chunk |
| `ai-variation-done` | main→renderer | Variation completed |
| `ai-variation-error` | main→renderer | Variation error |
| `menu-ai` | main→renderer | AI shortcut trigger |
| `menu-settings` | main→renderer | Settings shortcut trigger |

---

## Key Architecture Notes for Restoration

1. **AbortController pattern** — `ai-request` creates one, threads `signal` into `streamChat`. `ai-cancel` calls `.abort()`.
2. **Double onDone bug** — Guard with `let done = false` flag in ai-adapter.js.
3. **URL path bug** — `new URL('chat/completions', baseURL + '/')` not `new URL('/chat/completions', baseURL)`.
4. **safeStorage encryption** — API keys stored as `'enc:' + base64`. Legacy plaintext auto-migrates.
5. **Chunk timeout** — 15s timer resets per chunk, aborts on expiry.
6. **VariationAbortControllers** — Must be declared before `ai-cancel` handler (const hoisting trap).
7. **Settings modal is 100% AI** — No non-AI settings exist. Would need new design if non-AI settings are needed.
8. **Document context** — `buildDocContext()` sends heading outline + surrounding text as system prompt context.