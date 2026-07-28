import * as vscode from 'vscode';

export class TerminalManager {
    private terminal: vscode.Terminal | undefined;
    private static readonly TERMINAL_NAME = 'Antigravity CLI';

    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * Opens the AGY terminal on the right side as an editor tab,
     * or focuses it if one already exists.
     */
    openOrFocusTerminal(): void {
        if (this.terminal && this.isTerminalAlive()) {
            this.terminal.show();
            return;
        }
        this.terminal = vscode.window.createTerminal(this.getTerminalOptions());
        // show() is called automatically for editor-location terminals
    }

    /**
     * Builds terminal creation options from user configuration.
     * Uses TerminalEditorLocationOptions to open on the RIGHT side,
     * matching the Claude Code / Codex experience.
     */
    getTerminalOptions(): vscode.TerminalOptions {
        const config = vscode.workspace.getConfiguration('antigravity');
        const executable = config.get<string>('executable', 'agy');
        const defaultArgs = config.get<string[]>('defaultArgs', []);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        return {
            name: TerminalManager.TERMINAL_NAME,
            shellPath: executable,
            shellArgs: defaultArgs.length > 0 ? defaultArgs : undefined,
            cwd: workspaceFolder?.uri,
            iconPath: vscode.Uri.joinPath(this.extensionUri, 'icon.png'),
            // Open as an editor tab on the RIGHT side — like Claude Code / Codex
            location: {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: false,
            },
        };
    }

    /**
     * Kills the existing terminal and launches a fresh one.
     */
    restartTerminal(): void {
        this.stopTerminal();
        // Brief delay to allow the previous terminal to fully close
        setTimeout(() => this.openOrFocusTerminal(), 300);
    }

    /**
     * Disposes the current AGY terminal.
     */
    stopTerminal(): void {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = undefined;
        }
    }

    /**
     * Called by the onDidCloseTerminal listener when the terminal is closed externally.
     */
    onTerminalClosed(): void {
        this.terminal = undefined;
    }

    /**
     * Returns true if the given terminal is the managed AGY terminal.
     */
    isAntigravityTerminal(terminal: vscode.Terminal): boolean {
        return terminal === this.terminal;
    }

    private isTerminalAlive(): boolean {
        if (!this.terminal) {
            return false;
        }
        return vscode.window.terminals.includes(this.terminal);
    }
}
