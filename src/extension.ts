import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';
import { StatusBarManager } from './statusBarManager';
import { AgyProcessManager } from './process/agyProcessManager';
import { ContextManager } from './context/contextManager';
import { DiffManager } from './diff/diffManager';
import { AgentViewProvider } from './webview/agentViewProvider';

export function activate(context: vscode.ExtensionContext): void {
    const version = context.extension.packageJSON.version;

    // ── Managers ─────────────────────────────────────────────────────────────
    const terminalManager = new TerminalManager(context.extensionUri);
    const statusBarManager = new StatusBarManager();
    const processManager = new AgyProcessManager();
    const contextManager = new ContextManager();
    const diffManager = new DiffManager();

    context.subscriptions.push(processManager, contextManager, diffManager);

    // ── Agent Webview Provider (Sidebar & Editor Tab) ─────────────────────────
    const agentViewProvider = new AgentViewProvider(
        context.extensionUri,
        processManager,
        contextManager,
        diffManager,
        version
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AgentViewProvider.viewType,
            agentViewProvider
        )
    );

    // ── Existing Terminal Commands (Preserved 100%) ───────────────────────────
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

    // ── New Codex-Style Agent Commands ─────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openAgent', () => {
            agentViewProvider.openAsEditorTab();
        }),

        vscode.commands.registerCommand('antigravity.explainCode', () => {
            agentViewProvider.openAsEditorTab();
            const activeContext = contextManager.getActiveContext();
            const prompt = contextManager.formatPromptWithContext(
                'Explain the selected code and its purpose in the architecture.',
                activeContext
            );
            processManager.sendPrompt(prompt);
        }),

        vscode.commands.registerCommand('antigravity.refactorCode', () => {
            agentViewProvider.openAsEditorTab();
            const activeContext = contextManager.getActiveContext();
            const prompt = contextManager.formatPromptWithContext(
                'Refactor this code to improve clarity, performance, and best practices.',
                activeContext
            );
            processManager.sendPrompt(prompt);
        })
    );

    // ── Terminal profile provider (Preserved 100%) ────────────────────────────
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

    // ── Terminal lifecycle tracking (Preserved 100%) ──────────────────────────
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
            if (terminalManager.isAntigravityTerminal(terminal)) {
                terminalManager.onTerminalClosed();
                statusBarManager.setIdle();
            }
        })
    );

    // ── Status bar (Preserved 100%) ───────────────────────────────────────────
    statusBarManager.initialize(context);
}

export function deactivate(): void {
    // VS Code automatically cleans up context.subscriptions
}
