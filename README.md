# Gabo

A minimalist, distraction-free markdown editor for macOS. Inspired by Gabriel García Márquez — and the belief that writing tools should disappear.

![Electron](https://img.shields.io/badge/Electron-34-black) ![License](https://img.shields.io/badge/License-MIT-blue)

## Philosophy

Open the app. See text. Nothing else exists.

## MVP Features

### Core Editor
1. **Focus Mode** — dim everything except the active sentence (`Cmd+D`)
2. **Typewriter Scrolling** — cursor stays vertically centered
3. **Syntax Fade** — markdown syntax rendered subtly, almost invisible
4. **Distraction-Free Chrome** — no toolbar, no sidebar. Just text.

### Markdown
5. **Live Markdown Editing** — CodeMirror 6 with syntax awareness
6. **Markdown Preview Toggle** — rendered view on demand (`Cmd+P`)
7. **Inline Checkbox Support** — `- [ ]` / `- [x]` as toggleable checkboxes

### File Management
8. **Open/Save Local `.md` Files** — native file dialog, no cloud, no database
9. **Quick File Switcher** — `Cmd+O` opens minimal overlay with file list
10. **Auto-Save** — save on every keystroke, no "Save?" dialogs

### Typography & View
11. **HEY-Inspired Design** — Bricolage Grotesque, tight spacing, refined color system
12. **Dark Mode** — follow system preference + manual toggle

### Workflow
13. **Full Screen / Zen Mode** — `Cmd+Enter` goes completely chromeless
14. **Export to PDF** — `Cmd+Shift+P` prints/PDFs rendered view

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+D` | Toggle Focus Mode |
| `Cmd+P` | Toggle Markdown Preview |
| `Cmd+O` | Quick File Switcher |
| `Cmd+Enter` | Toggle Zen Mode |
| `Cmd+Shift+P` | Export to PDF |

## Tech Stack

- **Electron** — cross-platform shell
- **CodeMirror 6** — editor engine
- **Bricolage Grotesque** — typeface
- **Local-first** — plain `.md` files, no cloud

## Development

```bash
npm install
npm start
```

## License

MIT