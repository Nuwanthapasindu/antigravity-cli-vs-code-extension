import * as vscode from 'vscode';

export class StatusBarManager {
    private statusBarItem!: vscode.StatusBarItem;

    /**
     * Creates the status bar item and adds it to subscriptions so it is
     * disposed when the extension deactivates.
     */
    initialize(context: vscode.ExtensionContext): void {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'antigravity.openTerminal';
        this.setIdle();
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);
    }

    /** Shows a spinning icon while AGY is running. */
    setRunning(): void {
        this.statusBarItem.text = '$(sync~spin) AGY';
        this.statusBarItem.tooltip =
            'Antigravity CLI is running — click to focus terminal';
    }

    /** Shows the default idle state. */
    setIdle(): void {
        this.statusBarItem.text = '$(hubot) AGY';
        this.statusBarItem.tooltip =
            'Click to open Antigravity CLI terminal  |  ⌘⇧A';
    }
}
