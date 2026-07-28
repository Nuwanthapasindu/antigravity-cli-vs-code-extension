# Antigravity CLI

A VS Code extension that opens the [Antigravity CLI](https://antigravity.google) (`agy`) in a dedicated terminal — bringing AI-powered coding assistance directly into your editor, just like Claude Code, but powered by Antigravity.

## Features

- 🚀 **One-click launch** — Open `agy` in a dedicated terminal from the Activity Bar, Status Bar, or Command Palette
- ⌨️ **Keyboard shortcut** — `Cmd+Shift+A` (Mac) / `Ctrl+Shift+A` (Windows/Linux)
- 🔁 **Smart terminal reuse** — Re-focuses an existing AGY terminal instead of creating a duplicate
- 🔄 **Restart/Stop** — Full lifecycle management via Command Palette
- 📌 **Status Bar** — Always-visible AGY indicator at the bottom of your editor
- ⚙️ **Configurable** — Set a custom executable path and default arguments

## Requirements

- `agy` must be installed and available in your `PATH` (or configure the path in settings)
- Install Antigravity CLI: follow the [official docs](https://antigravity.google/docs)

## Usage

| Action | Method |
|---|---|
| Open AGY terminal | Click **🚀 AGY** in the status bar |
| Open AGY terminal | Click the rocket icon in the Activity Bar → **Open AGY Terminal** |
| Open AGY terminal | `Cmd+Shift+A` (Mac) / `Ctrl+Shift+A` (Windows/Linux) |
| Open AGY terminal | Command Palette → `Antigravity CLI: Open Terminal` |
| Restart terminal | Command Palette → `Antigravity CLI: Restart Terminal` |
| Stop terminal | Command Palette → `Antigravity CLI: Stop Terminal` |

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `antigravity.executable` | `"agy"` | Path to the `agy` binary |
| `antigravity.defaultArgs` | `[]` | Arguments passed to `agy` on every launch |

### Example: custom path

```json
{
  "antigravity.executable": "/Users/you/.local/bin/agy",
  "antigravity.defaultArgs": []
}
```

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (used by F5 debug)
npm run watch

# Package as .vsix
npm run package
```

Press **F5** in VS Code to launch the Extension Development Host.
