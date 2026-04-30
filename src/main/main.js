const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')

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


app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })