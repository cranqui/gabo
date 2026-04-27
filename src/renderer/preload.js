const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gaboAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),
  saveFileAs: (content) => ipcRenderer.invoke('save-file-as', content),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  getDefaultDir: () => ipcRenderer.invoke('get-default-dir'),
  openFileByPath: (filePath) => ipcRenderer.invoke('open-file-by-path', filePath),
  exportPdf: (html) => ipcRenderer.invoke('export-pdf', html),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),

  onMenuNew: (cb) => { ipcRenderer.removeAllListeners('menu-new'); ipcRenderer.on('menu-new', cb) },
  onMenuOpen: (cb) => { ipcRenderer.removeAllListeners('menu-open'); ipcRenderer.on('menu-open', cb) },
  onMenuSave: (cb) => { ipcRenderer.removeAllListeners('menu-save'); ipcRenderer.on('menu-save', cb) },
  onMenuExportPdf: (cb) => { ipcRenderer.removeAllListeners('menu-export-pdf'); ipcRenderer.on('menu-export-pdf', cb) },
  onMenuFocus: (cb) => { ipcRenderer.removeAllListeners('menu-focus'); ipcRenderer.on('menu-focus', cb) },
  onMenuPreview: (cb) => { ipcRenderer.removeAllListeners('menu-preview'); ipcRenderer.on('menu-preview', cb) },
  onMenuZen: (cb) => { ipcRenderer.removeAllListeners('menu-zen'); ipcRenderer.on('menu-zen', cb) },
  onMenuDarkMode: (cb) => { ipcRenderer.removeAllListeners('menu-dark-mode'); ipcRenderer.on('menu-dark-mode', cb) },
})