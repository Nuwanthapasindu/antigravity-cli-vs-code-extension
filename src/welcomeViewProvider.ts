import * as vscode from 'vscode';

export class WelcomeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity.welcomeView';

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        // _context: vscode.WebviewViewResolveContext,
        // _token: vscode.CancellationToken
    ): void {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent();

        // Handle messages posted from the webview
        webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
            switch (message.command) {
                case 'openTerminal':
                    vscode.commands.executeCommand('antigravity.openTerminal');
                    break;
                case 'restartTerminal':
                    vscode.commands.executeCommand('antigravity.restartTerminal');
                    break;
                case 'stopTerminal':
                    vscode.commands.executeCommand('antigravity.stopTerminal');
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'antigravity'
                    );
                    break;
            }
        });
    }

    private getHtmlContent(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Antigravity CLI</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: transparent;
            padding: 16px 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-height: 100vh;
        }

        /* ── Header ─────────────────────────────── */
        .header {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            padding: 12px 0 8px;
        }

        .logo {
            font-size: 40px;
            line-height: 1;
        }

        .title {
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }

        .subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            line-height: 1.4;
        }

        /* ── Buttons ─────────────────────────────── */
        .btn-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 4px;
        }

        button {
            width: 100%;
            padding: 7px 12px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            display: flex;
            align-items: center;
            gap: 6px;
            transition: opacity 0.1s ease;
        }

        button:hover {
            opacity: 0.9;
        }

        button:active {
            opacity: 0.75;
        }

        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 600;
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        /* ── Divider ─────────────────────────────── */
        .divider {
            border: none;
            border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            margin: 4px 0;
        }

        /* ── Shortcuts ───────────────────────────── */
        .shortcut-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .shortcut-label {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        kbd {
            background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.15));
            border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,0.4));
            border-radius: 3px;
            padding: 1px 5px;
            font-size: 10px;
            font-family: var(--vscode-editor-font-family, monospace);
        }

        /* ── Info section ────────────────────────── */
        .info-section {
            background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
            border-left: 3px solid var(--vscode-textLink-activeForeground, #569cd6);
            padding: 8px 10px;
            border-radius: 0 3px 3px 0;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
        }

        .info-section strong {
            color: var(--vscode-foreground);
        }

        /* ── Settings link ───────────────────────── */
        .settings-link {
            font-size: 11px;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            background: none;
            border: none;
            padding: 0;
            text-decoration: underline;
            width: auto;
            display: inline;
        }

        .settings-link:hover {
            opacity: 0.8;
        }

        .footer {
            margin-top: auto;
            padding-top: 8px;
            text-align: center;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <!-- Header -->
    <div class="header">
        <div class="logo">🚀</div>
        <span class="title">Antigravity CLI</span>
        <span class="subtitle">AI-powered coding assistant<br>in your terminal</span>
    </div>

    <!-- Primary actions -->
    <div class="btn-group">
        <button class="btn-primary" onclick="send('openTerminal')">
            ▶ Open AGY Terminal
        </button>
        <button class="btn-secondary" onclick="send('restartTerminal')">
            ↺ Restart Terminal
        </button>
        <button class="btn-secondary" onclick="send('stopTerminal')">
            ■ Stop Terminal
        </button>
    </div>

    <hr class="divider">

    <!-- Keyboard shortcut info -->
    <div class="shortcut-row">
        <span>Open terminal</span>
        <span class="shortcut-label">
            <kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd>
        </span>
    </div>

    <hr class="divider">

    <!-- Info block -->
    <div class="info-section">
        Launches <strong>agy</strong> in a dedicated terminal in your current workspace directory.
    </div>

    <!-- Settings -->
    <div style="font-size:11px; color: var(--vscode-descriptionForeground);">
        Executable path or args? 
        <button class="settings-link" onclick="send('openSettings')">
            Open Settings →
        </button>
    </div>

    <div class="footer">Antigravity CLI v0.0.1</div>

    <script>
        // eslint-disable-next-line no-undef
        const vscode = acquireVsCodeApi();
        function send(command) {
            vscode.postMessage({ command });
        }
    </script>
</body>
</html>`;
    }
}
