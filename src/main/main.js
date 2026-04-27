const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const { loadConfig, saveConfig } = require('./ai-config')
const { streamChat } = require('./ai-adapter')

// Set app name explicitly (needed for macOS menu bar)
app.name = 'Gabo'

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 500,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    transparent: false,
    backgroundColor: '#1a1a1e', // matches --bg-main in dark mode (default); avoids flash
    title: 'Gabo',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      sandbox: false // Required: preload.js uses require('electron') for contextBridge
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  const isMac = process.platform === 'darwin'

  const template = [
    // macOS: App menu (first item uses app.name)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu-new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu-save') },
        { type: 'separator' },
        { label: 'Export PDF…', accelerator: 'CmdOrCtrl+Shift+P', click: () => mainWindow.webContents.send('menu-export-pdf') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Focus Mode', accelerator: 'CmdOrCtrl+D', click: () => mainWindow.webContents.send('menu-focus') },
        { label: 'Toggle Markdown Mode', accelerator: 'CmdOrCtrl+Shift+M', click: () => mainWindow.webContents.send('menu-preview') },
        { label: 'Toggle Zen Mode', accelerator: 'CmdOrCtrl+Shift+Z', click: () => mainWindow.webContents.send('menu-zen') },
        { type: 'separator' },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+Shift+D', click: () => mainWindow.webContents.send('menu-dark-mode') },
        { type: 'separator' },
        { label: 'AI Assist', accelerator: 'CmdOrCtrl+J', click: () => mainWindow.webContents.send('menu-ai') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.webContents.send('menu-settings') },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
        { role: 'togglefullscreen' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// IPC: Open file dialog
ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const content = fs.readFileSync(filePath, 'utf-8')
  return { path: filePath, content }
})

// IPC: Save file
ipcMain.handle('save-file', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// IPC: Save as
ipcMain.handle('save-file-as', async (event, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (result.canceled) return null
  fs.writeFileSync(result.filePath, content, 'utf-8')
  return result.filePath
})

// IPC: List files
ipcMain.handle('list-files', async (event, dirPath) => {
  try {
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md') || f.endsWith('.markdown') || f.endsWith('.txt'))
      .map(f => {
        const fullPath = path.join(dirPath, f)
        try {
          const stat = fs.statSync(fullPath)
          return { name: f, path: fullPath, modified: stat.mtimeMs }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.modified - a.modified)
    return files
  } catch (e) {
    return []
  }
})

// IPC: Get default directory
ipcMain.handle('get-default-dir', () => app.getPath('documents'))

// IPC: Open file by path (for switcher)
ipcMain.handle('open-file-by-path', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return { path: filePath, content }
  } catch (e) {
    return null
  }
})

// IPC: Rename file
ipcMain.handle('rename-file', async (event, oldPath, newPath) => {
  try {
    fs.renameSync(oldPath, newPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// IPC: Export PDF — renders the provided HTML in a hidden window, exports to PDF
ipcMain.handle('export-pdf', async (event, html) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: 'document.pdf'
  })
  if (result.canceled) return null

  // Create a hidden BrowserWindow to render the styled HTML for PDF
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } })
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

  try {
    const pdfData = await pdfWin.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'printableArea' }
    })
    fs.writeFileSync(result.filePath, pdfData)
    return result.filePath
  } finally {
    pdfWin.destroy()
  }
})

// ═══ AI Integration IPC Handlers ═══

// Prompt builders
const ACTION_PROMPTS = {
  'improve':  'Rewrite this to be clearer and more engaging, keeping the same meaning. Return only the rewritten text, nothing else.',
  'grammar':  'Fix grammar, spelling, and punctuation. Return only the corrected text, nothing else.',
  'shorter':  'Shorten this while keeping all key ideas. Return only the shortened text, nothing else.',
  'expand':   'Expand this with more detail and examples. Return only the expanded text, nothing else.',
  'formal':   'Rewrite in a professional, formal tone. Return only the rewritten text, nothing else.',
  'casual':   'Rewrite in a conversational, natural tone. Return only the rewritten text, nothing else.',
  'summarize':'Summarize in 1-3 sentences. Return only the summary, nothing else.',
  'simplify': 'Rewrite this in plain, simple language. Remove jargon and complexity. Return only the simplified text, nothing else.',
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

// Track in-flight AI request for cancellation via AbortController
let currentAiAbortController = null

// AI: Send request (streaming)
ipcMain.handle('ai-request', async (event, { action, selectedText, customPrompt }) => {
  const config = loadConfig()
  if (!config.enabled) {
    event.sender.send('ai-error', 'AI is disabled. Enable it in Settings (⌘,)')
    return
  }

  // Check Ollama availability first
  if (config.provider === 'ollama') {
    try {
      const ollamaHttp = require('http')
      await new Promise((resolve, reject) => {
        const url = new URL('/', config.baseURL)
        const req = ollamaHttp.get({ hostname: url.hostname, port: url.port, path: '/', timeout: 3000 }, (res) => {
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

  const systemPrompt = buildSystemPrompt(action)
  const userPrompt = customPrompt || buildUserPrompt(action, selectedText)

  try {
    // Create AbortController so this request can be cancelled from ai-cancel
    currentAiAbortController = new AbortController()
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
      signal: currentAiAbortController.signal,
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
    // Don't send error if the request was aborted (user cancelled)
    if (err.message !== 'Request aborted') {
      event.sender.send('ai-error', err.message)
    }
  } finally {
    currentAiAbortController = null
  }
})

// AI: Get config
ipcMain.handle('ai-get-config', () => {
  const config = loadConfig()
  // Never send API key to renderer — only show masked version
  return {
    ...config,
    apiKey: config.apiKey ? '••••••••' : ''
  }
})

// AI: Save config
ipcMain.handle('ai-save-config', (event, newConfig) => {
  const current = loadConfig()
  // If apiKey is the masked placeholder, keep the existing key
  if (newConfig.apiKey === '••••••••' || newConfig.apiKey === '') {
    newConfig.apiKey = current.apiKey
  }
  saveConfig({ ...current, ...newConfig })
  return { ok: true }
})

// AI: Test connection
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

// AI: Cancel in-flight request
ipcMain.handle('ai-cancel', () => {
  if (currentAiAbortController) {
    currentAiAbortController.abort()
    currentAiAbortController = null
    return { ok: true }
  }
  return { ok: false }
})

// AI: List Ollama models
ipcMain.handle('ai-list-models', async () => {
  const config = loadConfig()
  if (config.provider !== 'ollama') return { models: [] }

  try {
    const url = new URL('/api/tags', config.baseURL.replace('/v1', ''))
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(3000) })
    const data = await response.json()
    return { models: data.models?.map(m => m.name) || [] }
  } catch (e) {
    return { models: [], error: e.message }
  }
})

// ═══ End AI Integration ═══

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })