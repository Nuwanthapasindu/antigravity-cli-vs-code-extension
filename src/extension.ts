import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';
import { StatusBarManager } from './statusBarManager';
import { WelcomeViewProvider } from './welcomeViewProvider';

export function activate(context: vscode.ExtensionContext): void {
    const terminalManager = new TerminalManager(context.extensionUri);
    const statusBarManager = new StatusBarManager();
    const welcomeViewProvider = new WelcomeViewProvider(context.extensionUri);

    // ── Commands ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openTerminal', () => {
            terminalManager.openOrFocusTerminal();
            statusBarManager.setRunning();
        }),

        vscode.commands.registerCommand('antigravity.restartTerminal', () => {
            terminalManager.restartTerminal();
            statusBarManager.setRunning();
        }),

        vscode.commands.registerCommand('antigravity.stopTerminal', () => {
            terminalManager.stopTerminal();
            statusBarManager.setIdle();
        })
    );

    // ── Sidebar webview ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'antigravity.welcomeView',
            welcomeViewProvider
        )
    );

    // ── Terminal profile provider ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(
            'antigravity.terminalProfile',
            {
                provideTerminalProfile(): vscode.TerminalProfile {
                    return new vscode.TerminalProfile(
                        terminalManager.getTerminalOptions()
                    );
                }
            }
        )
    );

    // ── Terminal lifecycle tracking ───────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
            if (terminalManager.isAntigravityTerminal(terminal)) {
                terminalManager.onTerminalClosed();
                statusBarManager.setIdle();
            }
        })
    );

    // ── Status bar ────────────────────────────────────────────────────────────
    statusBarManager.initialize(context);
}

export function deactivate(): void {
    // VS Code handles subscription cleanup via context.subscriptions
}
