import * as vscode from 'vscode';
import { AgyProcessManager } from '../process/agyProcessManager';
import { ContextManager } from '../context/contextManager';
import { DiffManager } from '../diff/diffManager';
import { HostToWebviewMessage, WebviewToHostMessage } from '../shared/messages';

export class AgentViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity.welcomeView';
    private webviewView: vscode.WebviewView | undefined;
    private webviewPanel: vscode.WebviewPanel | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly processManager: AgyProcessManager,
        private readonly contextManager: ContextManager,
        private readonly diffManager: DiffManager,
        private readonly version: string
    ) {
        this.registerProcessListeners();
        this.registerContextListeners();
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
            await this.handleWebviewMessage(message, webviewView.webview);
        });
    }

    /**
     * Opens the Agent interface as an Editor Tab beside current editor (Codex style)
     */
    public openAsEditorTab(): void {
        if (this.webviewPanel) {
            this.webviewPanel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        this.webviewPanel = vscode.window.createWebviewPanel(
            'antigravity.agentPanel',
            'Antigravity Agent',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri],
            }
        );

        this.webviewPanel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'icon.png');
        this.webviewPanel.webview.html = this.getHtmlContent(this.webviewPanel.webview);

        this.webviewPanel.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
            await this.handleWebviewMessage(message, this.webviewPanel!.webview);
        });

        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = undefined;
        });
    }

    private registerProcessListeners(): void {
        this.processManager.events.onTextDelta((delta) => {
            this.postToAllWebviews({ command: 'text_delta', delta });
        });

        this.processManager.events.onToolEvent((event) => {
            const isEditTool = [
                'replace_file_content',
                'write_to_file',
                'edit_file',
                'create_file',
            ].includes(event.toolName);

            if (isEditTool && event.state === 'ACTIVE' && event.toolInfo?.parameters) {
                const target = (event.toolInfo.parameters.TargetFile ||
                    event.toolInfo.parameters.path ||
                    event.toolInfo.parameters.file ||
                    event.toolInfo.parameters.target ||
                    event.toolInfo.parameters.filePath) as string;
                if (target) {
                    this.diffManager.recordOriginal(target);
                }
            }

            this.postToAllWebviews({
                command: 'tool_event',
                toolName: event.toolName,
                state: event.state,
                toolInfo: event.toolInfo,
                durationSeconds: event.durationSeconds,
            });

            if (isEditTool && event.state === 'DONE' && event.toolInfo?.parameters) {
                const target = (event.toolInfo.parameters.TargetFile ||
                    event.toolInfo.parameters.path ||
                    event.toolInfo.parameters.file ||
                    event.toolInfo.parameters.target ||
                    event.toolInfo.parameters.filePath) as string;
                if (target) {
                    const record = this.diffManager.getChangeRecord(target);
                    if (record) {
                        this.postToAllWebviews({ command: 'file_changed', change: record });
                    }
                }
            }
        });

        this.processManager.events.onTurnComplete(async (event) => {
            this.postToAllWebviews({
                command: 'turn_complete',
                status: event.status,
                usage: event.usage,
                durationSeconds: event.durationSeconds,
            });

            const quota = await this.processManager.fetchQuota();
            if (quota) {
                this.postToAllWebviews({ command: 'quota_update', quota });
            }
        });

        this.processManager.events.onStatusChange((status) => {
            this.postToAllWebviews({ command: 'status_change', status });
        });

        this.processManager.events.onError((message) => {
            this.postToAllWebviews({ command: 'error', message });
        });
    }

    private registerContextListeners(): void {
        this.contextManager.onDidChangeContext((items) => {
            this.postToAllWebviews({ command: 'context_update', items });
        });
    }

    private postToAllWebviews(message: HostToWebviewMessage): void {
        this.webviewView?.webview.postMessage(message);
        this.webviewPanel?.webview.postMessage(message);
    }

    private async handleWebviewMessage(
        message: WebviewToHostMessage,
        targetWebview: vscode.Webview
    ): Promise<void> {
        switch (message.command) {
            case 'ready': {
                const [models, currentModel, quota] = await Promise.all([
                    this.processManager.fetchAvailableModels(),
                    this.processManager.fetchCurrentModel(),
                    this.processManager.fetchQuota(),
                ]);

                const stateMsg: HostToWebviewMessage = {
                    command: 'init_state',
                    models,
                    currentModel,
                    currentEffort: this.processManager.getActiveEffort(),
                    quota,
                    conversationId: this.processManager.getConversationId(),
                    activeContext: this.contextManager.getActiveContext(),
                };
                targetWebview.postMessage(stateMsg);
                break;
            }

            case 'send_prompt': {
                const contextItems = message.contextItems || this.contextManager.getActiveContext();
                const formatted = this.contextManager.formatPromptWithContext(
                    message.text,
                    contextItems
                );
                this.postToAllWebviews({ command: 'turn_start', prompt: message.text });
                await this.processManager.sendPrompt(formatted);
                break;
            }

            case 'cancel_turn': {
                this.processManager.cancelTurn();
                break;
            }

            case 'select_model': {
                this.processManager.setModel(message.modelId);
                break;
            }

            case 'select_effort': {
                this.processManager.setEffort(message.effort);
                break;
            }

            case 'open_diff': {
                await this.diffManager.openDiff(message.filePath);
                break;
            }

            case 'open_file': {
                try {
                    const doc = await vscode.workspace.openTextDocument(message.filePath);
                    const editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.ViewColumn.One,
                    });
                    if (message.line) {
                        const pos = new vscode.Position(message.line - 1, 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos));
                    }
                } catch {
                    vscode.window.showErrorMessage(`Could not open file: ${message.filePath}`);
                }
                break;
            }

            case 'open_terminal': {
                vscode.commands.executeCommand('antigravity.openTerminal');
                break;
            }

            case 'open_settings': {
                vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity');
                break;
            }

            case 'pick_context_file': {
                await this.contextManager.pickWorkspaceFile();
                break;
            }

            case 'clear_conversation': {
                this.processManager.newSession();
                break;
            }
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const mermaidUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'mermaid.min.js')
        );

        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '    <meta charset="UTF-8">',
            '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\' \'unsafe-eval\' ' + webview.cspSource + ';">',
            '    <title>Antigravity Agent</title>',
            '    <style>',
            '        :root {',
            '            --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif);',
            '            --code-font: var(--vscode-editor-font-family, Menlo, Monaco, \'Courier New\', monospace);',
            '        }',
            '        * { box-sizing: border-box; margin: 0; padding: 0; }',
            '        body {',
            '            font-family: var(--font-family);',
            '            color: var(--vscode-foreground);',
            '            background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));',
            '            display: flex; flex-direction: column; height: 100vh; overflow: hidden; font-size: 12px;',
            '        }',
            '        .app-header {',
            '            display: flex; align-items: center; justify-content: space-between;',
            '            padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));',
            '            background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.05));',
            '            user-select: none; flex-shrink: 0;',
            '        }',
            '        .header-title-group { display: flex; align-items: center; gap: 8px; }',
            '        .status-dot {',
            '            width: 8px; height: 8px; border-radius: 50%;',
            '            background: var(--vscode-terminal-ansiGreen, #4CAF50); transition: background 0.2s;',
            '        }',
            '        .status-dot.thinking { background: var(--vscode-terminal-ansiYellow, #FFC107); animation: pulse 1.5s infinite; }',
            '        .status-dot.executing_tool { background: var(--vscode-terminal-ansiCyan, #00BCD4); animation: pulse 1s infinite; }',
            '        .status-dot.error { background: var(--vscode-terminal-ansiRed, #F44336); }',
            '        @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }',
            '        .header-title { font-weight: 600; font-size: 12px; }',
            '        .header-actions { display: flex; gap: 4px; }',
            '        .icon-btn {',
            '            background: none; border: none; color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));',
            '            cursor: pointer; padding: 4px 6px; border-radius: 3px; font-size: 11px; display: flex; align-items: center; gap: 4px;',
            '        }',
            '        .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-foreground); }',
            '        .chat-container { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }',
            '        .empty-state { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; color: var(--vscode-descriptionForeground); padding: 20px; max-width: 320px; }',
            '        .empty-icon { font-size: 36px; }',
            '        .quick-prompts { display: flex; flex-direction: column; gap: 6px; width: 100%; margin-top: 10px; }',
            '        .quick-prompt-btn {',
            '            background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.1));',
            '            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));',
            '            border: 1px solid var(--vscode-widget-border, transparent);',
            '            padding: 7px 10px; border-radius: 4px; cursor: pointer; text-align: left; font-size: 11px;',
            '        }',
            '        .quick-prompt-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.2)); }',
            '        .message-row { display: flex; flex-direction: column; gap: 4px; }',
            '        .message-row.user { align-self: flex-end; max-width: 90%; }',
            '        .message-row.agent { align-self: flex-start; width: 100%; }',
            '        .user-bubble {',
            '            background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff);',
            '            padding: 8px 12px; border-radius: 8px 8px 2px 8px; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;',
            '        }',
            '        .agent-turn-wrapper { display: flex; flex-direction: column; gap: 6px; width: 100%; }',
            '        .agent-bubble {',
            '            background: var(--vscode-editor-background, rgba(128,128,128,0.05));',
            '            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));',
            '            padding: 10px 12px; border-radius: 4px 8px 8px 8px; font-size: 12px; line-height: 1.5;',
            '            color: var(--vscode-foreground); word-break: break-word;',
            '        }',
            '        .agent-bubble p { margin-bottom: 8px; }',
            '        .agent-bubble p:last-child { margin-bottom: 0; }',
            '        .agent-bubble h1, .agent-bubble h2, .agent-bubble h3, .agent-bubble h4 { margin: 10px 0 4px; font-weight: 600; color: var(--vscode-foreground); }',
            '        .agent-bubble h1 { font-size: 15px; } .agent-bubble h2 { font-size: 13px; } .agent-bubble h3 { font-size: 12px; }',
            '        .agent-bubble ul, .agent-bubble ol { margin: 6px 0 6px 18px; }',
            '        .agent-bubble li { margin-bottom: 3px; }',
            '        .agent-bubble a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: underline; cursor: pointer; }',
            '        .agent-bubble a:hover { color: var(--vscode-textLink-activeForeground, #3794ff); }',
            '        .md-hr { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); margin: 8px 0; }',
            '        pre {',
            '            background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));',
            '            padding: 8px 10px; border-radius: 4px; overflow-x: auto; font-family: var(--code-font); font-size: 11px; margin: 8px 0; position: relative;',
            '            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1));',
            '        }',
            '        code { font-family: var(--code-font); background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.15)); padding: 1px 4px; border-radius: 3px; }',
            '        pre code { background: transparent; padding: 0; }',
            '        .copy-code-btn {',
            '            position: absolute; top: 4px; right: 4px; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));',
            '            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: none; padding: 2px 6px; font-size: 9px; border-radius: 3px; cursor: pointer;',
            '        }',
            '        /* ── Mermaid Visualizer Container ────────────────────────── */',
            '        .mermaid-block {',
            '            background: var(--vscode-editor-background, rgba(0,0,0,0.2));',
            '            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));',
            '            border-radius: 4px; margin: 8px 0; overflow: hidden;',
            '        }',
            '        .mermaid-toolbar {',
            '            display: flex; align-items: center; justify-content: space-between; padding: 4px 8px;',
            '            background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1));',
            '            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));',
            '        }',
            '        .mermaid-badge { font-size: 10px; font-weight: 600; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 4px; }',
            '        .mermaid-action-btn {',
            '            background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));',
            '            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));',
            '            border: none; padding: 2px 6px; font-size: 9px; border-radius: 3px; cursor: pointer;',
            '        }',
            '        .mermaid-action-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }',
            '        .mermaid-diagram { padding: 12px 8px; display: flex; justify-content: center; overflow-x: auto; background: rgba(0,0,0,0.05); }',
            '        .mermaid-diagram svg { max-width: 100%; height: auto; }',
            '        /* ── Unified Collapsible Activity Container ───────────────── */',
            '        .activity-accordion {',
            '            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));',
            '            background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06));',
            '            border-radius: 4px; overflow: hidden; margin-bottom: 6px;',
            '        }',
            '        .activity-summary {',
            '            display: flex; align-items: center; justify-content: space-between;',
            '            padding: 6px 10px; cursor: pointer; user-select: none; font-size: 11px; font-weight: 500;',
            '        }',
            '        .activity-summary:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }',
            '        .activity-chevron { transition: transform 0.2s; font-size: 10px; margin-right: 6px; display: inline-block; }',
            '        .activity-accordion.expanded .activity-chevron { transform: rotate(90deg); }',
            '        .activity-content { display: none; padding: 4px 8px 8px; flex-direction: column; gap: 4px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1)); }',
            '        .activity-accordion.expanded .activity-content { display: flex; }',
            '        .tool-row {',
            '            display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border-radius: 3px;',
            '            background: var(--vscode-editor-background, rgba(0,0,0,0.1)); font-size: 11px;',
            '        }',
            '        .tool-row-header { display: flex; align-items: center; justify-content: space-between; }',
            '        .tool-row-name { display: flex; align-items: center; gap: 6px; font-weight: 500; font-family: var(--code-font); }',
            '        .tool-row-dur { color: var(--vscode-descriptionForeground); font-size: 10px; }',
            '        .tool-row-details {',
            '            font-family: var(--code-font); font-size: 10px; max-height: 80px; overflow-y: auto; white-space: pre-wrap;',
            '            color: var(--vscode-descriptionForeground); padding: 2px 4px; background: rgba(0,0,0,0.15); border-radius: 2px; margin-top: 2px;',
            '        }',
            '        /* ── Inline Code Diff Preview ────────────────────────────── */',
            '        .diff-card {',
            '            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));',
            '            border-left: 3px solid var(--vscode-terminal-ansiGreen, #4CAF50);',
            '            background: var(--vscode-editor-background, rgba(0,0,0,0.2));',
            '            border-radius: 4px;',
            '            margin: 8px 0;',
            '            overflow: hidden;',
            '            font-size: 11px;',
            '        }',
            '        .diff-card-header {',
            '            display: flex; align-items: center; justify-content: space-between;',
            '            padding: 6px 10px; background: rgba(128,128,128,0.08);',
            '            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));',
            '            cursor: pointer; user-select: none;',
            '        }',
            '        .diff-card-header:hover { background: rgba(128,128,128,0.14); }',
            '        .diff-card-left {',
            '            display: flex; align-items: center; gap: 6px; overflow: hidden;',
            '            text-overflow: ellipsis; white-space: nowrap; flex: 1;',
            '        }',
            '        .diff-toggle-chevron {',
            '            font-size: 9px; color: var(--vscode-descriptionForeground);',
            '            transition: transform 0.15s ease; flex-shrink: 0;',
            '        }',
            '        .diff-card.collapsed .diff-toggle-chevron { transform: rotate(-90deg); }',
            '        .diff-file-icon { flex-shrink: 0; font-size: 11px; }',
            '        .diff-path {',
            '            font-weight: 600; color: var(--vscode-foreground); font-family: var(--code-font);',
            '            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '        }',
            '        .diff-stats {',
            '            display: flex; align-items: center; gap: 4px; font-size: 10px;',
            '            font-weight: 600; flex-shrink: 0; margin-left: 4px;',
            '        }',
            '        .diff-stats .add { color: var(--vscode-terminal-ansiGreen, #4CAF50); }',
            '        .diff-stats .del { color: var(--vscode-terminal-ansiRed, #F44336); }',
            '        .diff-card-actions { display: flex; align-items: center; gap: 5px; flex-shrink: 0; margin-left: 8px; }',
            '        .diff-btn {',
            '            background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));',
            '            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));',
            '            border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.3));',
            '            padding: 2px 7px; border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: 500;',
            '        }',
            '        .diff-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.35)); }',
            '        .diff-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }',
            '        .diff-btn.primary:hover { background: var(--vscode-button-hoverBackground); }',
            '        .diff-preview-body {',
            '            max-height: 260px; overflow-y: auto; overflow-x: auto;',
            '            font-family: var(--code-font); font-size: 11px; line-height: 1.45;',
            '            background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));',
            '        }',
            '        .diff-card.collapsed .diff-preview-body { display: none; }',
            '        .diff-hunk-banner {',
            '            padding: 2px 8px; background: rgba(56, 139, 253, 0.12);',
            '            color: var(--vscode-terminal-ansiCyan, #58a6ff); font-size: 10px;',
            '            border-bottom: 1px solid rgba(128,128,128,0.1); user-select: none;',
            '        }',
            '        .diff-line-row { display: flex; white-space: pre; min-width: 100%; padding: 0; }',
            '        .diff-gutter-num {',
            '            width: 32px; color: var(--vscode-descriptionForeground); user-select: none;',
            '            text-align: right; padding-right: 6px; flex-shrink: 0; opacity: 0.55; font-size: 10px;',
            '        }',
            '        .diff-line-type { width: 14px; text-align: center; user-select: none; flex-shrink: 0; font-weight: 600; }',
            '        .diff-line-text { flex: 1; padding-right: 8px; tab-size: 4; }',
            '        .diff-line-row.added { background: rgba(46, 160, 67, 0.16); color: var(--vscode-terminal-ansiGreen, #3fb950); }',
            '        .diff-line-row.added .diff-line-type { color: var(--vscode-terminal-ansiGreen, #3fb950); }',
            '        .diff-line-row.deleted { background: rgba(248, 81, 73, 0.16); color: var(--vscode-terminal-ansiRed, #f85149); }',
            '        .diff-line-row.deleted .diff-line-type { color: var(--vscode-terminal-ansiRed, #f85149); }',
            '        .diff-line-row.context { color: var(--vscode-foreground); opacity: 0.85; }',
            '        .diff-empty-msg { padding: 8px 12px; color: var(--vscode-descriptionForeground); font-style: italic; font-size: 11px; }',
            '        .context-tray {',
            '            display: flex; align-items: center; gap: 6px; padding: 6px 12px;',
            '            border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));',
            '            background: var(--vscode-sideBarSectionHeader-background, transparent); overflow-x: auto; flex-shrink: 0;',
            '        }',
            '        .context-chip {',
            '            background: var(--vscode-badge-background, rgba(128,128,128,0.2)); color: var(--vscode-badge-foreground, var(--vscode-foreground));',
            '            padding: 2px 6px; border-radius: 12px; font-size: 10px; display: flex; align-items: center; gap: 4px; white-space: nowrap;',
            '        }',
            '        .context-chip .remove-chip { cursor: pointer; opacity: 0.6; }',
            '        .context-chip .remove-chip:hover { opacity: 1; }',
            '        .add-context-btn {',
            '            background: none; border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.3));',
            '            color: var(--vscode-descriptionForeground); padding: 2px 6px; border-radius: 12px; font-size: 10px; cursor: pointer; white-space: nowrap;',
            '        }',
            '        .composer-container {',
            '            position: relative; padding: 8px 12px 10px;',
            '            background: var(--vscode-sideBar-background, var(--vscode-editor-background));',
            '            border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));',
            '            display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;',
            '        }',
            '        .slash-popover {',
            '            position: absolute; bottom: 100%; left: 12px; right: 12px;',
            '            background: var(--vscode-menu-background, var(--vscode-editor-background));',
            '            border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));',
            '            border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 100; max-height: 180px;',
            '            overflow-y: auto; display: none; flex-direction: column;',
            '        }',
            '        .slash-item {',
            '            display: flex; align-items: center; justify-content: space-between;',
            '            padding: 6px 10px; cursor: pointer; font-size: 11px;',
            '        }',
            '        .slash-item:hover {',
            '            background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));',
            '            color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));',
            '        }',
            '        .slash-name { font-weight: 600; font-family: var(--code-font); }',
            '        .slash-desc { color: var(--vscode-descriptionForeground); font-size: 10px; }',
            '        .composer-input-wrapper {',
            '            background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));',
            '            border-radius: 4px; padding: 6px 8px; transition: border-color 0.15s;',
            '        }',
            '        .composer-input-wrapper:focus-within { border-color: var(--vscode-focusBorder); }',
            '        textarea {',
            '            width: 100%; background: transparent; border: none;',
            '            color: var(--vscode-input-foreground); font-family: var(--font-family);',
            '            font-size: 12px; resize: none; outline: none; min-height: 44px; max-height: 140px; line-height: 1.4;',
            '        }',
            '        .composer-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }',
            '        .composer-hint { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; }',
            '        .send-btn {',
            '            background: var(--vscode-button-background); color: var(--vscode-button-foreground);',
            '            border: none; padding: 5px 12px; border-radius: 3px; cursor: pointer;',
            '            font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 4px;',
            '        }',
            '        .send-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }',
            '        .send-btn.stop { background: var(--vscode-terminal-ansiRed, #d9534f); }',
            '        .status-footer {',
            '            display: flex; align-items: center; justify-content: space-between; padding: 4px 12px;',
            '            background: var(--vscode-statusBar-background, rgba(0,0,0,0.1));',
            '            color: var(--vscode-statusBar-foreground, var(--vscode-descriptionForeground));',
            '            font-size: 10px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.1));',
            '            user-select: none; flex-shrink: 0;',
            '        }',
            '        .footer-selectors { display: flex; align-items: center; gap: 8px; }',
            '        select {',
            '            background: transparent; color: inherit; border: 1px solid transparent;',
            '            border-radius: 3px; font-size: 10px; padding: 1px 4px; cursor: pointer; outline: none;',
            '        }',
            '        select:hover { border-color: var(--vscode-widget-border, rgba(128,128,128,0.4)); }',
            '        .quota-indicator { display: flex; align-items: center; gap: 6px; }',
            '        .quota-bar { width: 40px; height: 5px; background: var(--vscode-progressBar-background, rgba(128,128,128,0.2)); border-radius: 3px; overflow: hidden; }',
            '        .quota-fill { height: 100%; background: var(--vscode-terminal-ansiGreen, #4CAF50); width: 100%; transition: width 0.3s; }',
            '    </style>',
            '</head>',
            '<body>',
            '    <header class="app-header">',
            '        <div class="header-title-group">',
            '            <div id="statusDot" class="status-dot"></div>',
            '            <span class="header-title">Antigravity Agent</span>',
            '            <span id="statusText" style="color: var(--vscode-descriptionForeground); font-size: 10px;">(Idle)</span>',
            '        </div>',
            '        <div class="header-actions">',
            '            <button class="icon-btn" title="Open terminal CLI (Cmd+Shift+A)" onclick="vscode.postMessage({ command: \'open_terminal\' })">',
            '                ⌨️ Terminal',
            '            </button>',
            '            <button class="icon-btn" title="New conversation" onclick="clearChat()">',
            '                ↺ New',
            '            </button>',
            '        </div>',
            '    </header>',
            '    <main id="chatContainer" class="chat-container">',
            '        <div id="emptyState" class="empty-state">',
            '            <div class="empty-icon">🚀</div>',
            '            <div style="font-weight: 600; font-size: 13px;">How can Antigravity assist you?</div>',
            '            <div style="font-size: 11px; line-height: 1.4;">',
            '                Ask questions, generate features, or refactor code with full workspace context.',
            '            </div>',
            '            <div class="quick-prompts">',
            '                <button class="quick-prompt-btn" onclick="sendQuickPrompt(\'Explain the architecture of this project\')">',
            '                    💡 Explain project architecture',
            '                </button>',
            '                <button class="quick-prompt-btn" onclick="sendQuickPrompt(\'Suggest code refactoring opportunities\')">',
            '                    ⚡ Suggest refactoring opportunities',
            '                </button>',
            '                <button class="quick-prompt-btn" onclick="sendQuickPrompt(\'/help\')">',
            '                    📖 View slash commands (/help)',
            '                </button>',
            '            </div>',
            '        </div>',
            '    </main>',
            '    <div id="contextTray" class="context-tray">',
            '        <span style="font-size: 10px; color: var(--vscode-descriptionForeground);">Context:</span>',
            '        <div id="contextChips" style="display: flex; gap: 4px;"></div>',
            '        <button class="add-context-btn" onclick="vscode.postMessage({ command: \'pick_context_file\' })">+ Attach</button>',
            '    </div>',
            '    <div class="composer-container">',
            '        <div id="slashPopover" class="slash-popover">',
            '            <div class="slash-item" onclick="insertSlashCommand(\'/help\')"><span class="slash-name">/help</span><span class="slash-desc">Show available commands</span></div>',
            '            <div class="slash-item" onclick="insertSlashCommand(\'/clear\')"><span class="slash-name">/clear</span><span class="slash-desc">Reset conversation turn</span></div>',
            '            <div class="slash-item" onclick="insertSlashCommand(\'/model\')"><span class="slash-name">/model</span><span class="slash-desc">View or switch model</span></div>',
            '            <div class="slash-item" onclick="insertSlashCommand(\'/effort\')"><span class="slash-name">/effort</span><span class="slash-desc">Set reasoning effort</span></div>',
            '            <div class="slash-item" onclick="insertSlashCommand(\'/quota\')"><span class="slash-name">/quota</span><span class="slash-desc">Check usage limits</span></div>',
            '        </div>',
            '        <div class="composer-input-wrapper">',
            '            <textarea id="promptInput" placeholder="Ask Antigravity... (Type / for commands, Enter to send)"></textarea>',
            '        </div>',
            '        <div class="composer-footer">',
            '            <span class="composer-hint">Shift+Enter for newline</span>',
            '            <button id="sendBtn" class="send-btn" onclick="submitPrompt()">Send ▶</button>',
            '        </div>',
            '    </div>',
            '    <footer class="status-footer">',
            '        <div class="footer-selectors">',
            '            <select id="modelSelect" onchange="onModelChange(this.value)">',
            '                <option value="gemini-3.8-flash-high">Gemini 3.8 Flash</option>',
            '            </select>',
            '            <span>|</span>',
            '            <select id="effortSelect" onchange="onEffortChange(this.value)">',
            '                <option value="low">Low Effort</option>',
            '                <option value="medium">Med Effort</option>',
            '                <option value="high" selected>High Effort</option>',
            '            </select>',
            '        </div>',
            '        <div id="quotaContainer" class="quota-indicator">',
            '            <span id="quotaLabel">5h: 100%</span>',
            '            <div class="quota-bar"><div id="quotaFill" class="quota-fill"></div></div>',
            '        </div>',
            '    </footer>',
            '    <script src="' + mermaidUri + '"></script>',
            '    <script>',
            '        const vscode = acquireVsCodeApi();',
            '        const chatContainer = document.getElementById("chatContainer");',
            '        const emptyState = document.getElementById("emptyState");',
            '        const promptInput = document.getElementById("promptInput");',
            '        const sendBtn = document.getElementById("sendBtn");',
            '        const statusDot = document.getElementById("statusDot");',
            '        const statusText = document.getElementById("statusText");',
            '        const modelSelect = document.getElementById("modelSelect");',
            '        const effortSelect = document.getElementById("effortSelect");',
            '        const contextChips = document.getElementById("contextChips");',
            '        const quotaLabel = document.getElementById("quotaLabel");',
            '        const quotaFill = document.getElementById("quotaFill");',
            '        const slashPopover = document.getElementById("slashPopover");',
            '        let isRunning = false;',
            '        let currentTurnWrapper = null;',
            '        let currentAgentBubble = null;',
            '        let currentActivityAccordion = null;',
            '        let currentActivityContent = null;',
            '        let currentActivitySummary = null;',
            '        let currentToolRows = new Map();',
            '        let currentAgentText = "";',
            '        let contextItems = [];',
            '        let mermaidTimer = null;',
            '        if (window.mermaid) {',
            '            window.mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });',
            '        }',
            '        promptInput.focus();',
            '        promptInput.addEventListener("keydown", (e) => {',
            '            if (e.key === "Enter" && !e.shiftKey) {',
            '                e.preventDefault();',
            '                slashPopover.style.display = "none";',
            '                submitPrompt();',
            '            } else if (e.key === "Escape") {',
            '                slashPopover.style.display = "none";',
            '            }',
            '        });',
            '        promptInput.addEventListener("input", () => {',
            '            promptInput.style.height = "auto";',
            '            promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + "px";',
            '            const val = promptInput.value;',
            '            if (val.startsWith("/") && !val.includes(" ")) {',
            '                slashPopover.style.display = "flex";',
            '            } else {',
            '                slashPopover.style.display = "none";',
            '            }',
            '        });',
            '        function insertSlashCommand(cmd) {',
            '            promptInput.value = cmd + " ";',
            '            slashPopover.style.display = "none";',
            '            promptInput.focus();',
            '        }',
            '        function submitPrompt() {',
            '            if (isRunning) {',
            '                vscode.postMessage({ command: "cancel_turn" });',
            '                return;',
            '            }',
            '            const text = promptInput.value.trim();',
            '            if (!text) return;',
            '            emptyState.style.display = "none";',
            '            appendUserMessage(text);',
            '            prepareAgentTurn();',
            '            vscode.postMessage({ command: "send_prompt", text: text, contextItems: contextItems });',
            '            promptInput.value = "";',
            '            promptInput.style.height = "44px";',
            '            setRunningState(true);',
            '        }',
            '        function sendQuickPrompt(text) {',
            '            promptInput.value = text;',
            '            submitPrompt();',
            '        }',
            '        function appendUserMessage(text) {',
            '            const row = document.createElement("div");',
            '            row.className = "message-row user";',
            '            const bubble = document.createElement("div");',
            '            bubble.className = "user-bubble";',
            '            bubble.textContent = text;',
            '            row.appendChild(bubble);',
            '            chatContainer.appendChild(row);',
            '            scrollToBottom();',
            '        }',
            '        function prepareAgentTurn() {',
            '            currentTurnWrapper = document.createElement("div");',
            '            currentTurnWrapper.className = "message-row agent agent-turn-wrapper";',
            '            currentActivityAccordion = null;',
            '            currentActivityContent = null;',
            '            currentActivitySummary = null;',
            '            currentToolRows.clear();',
            '            currentAgentBubble = document.createElement("div");',
            '            currentAgentBubble.className = "agent-bubble";',
            '            currentAgentBubble.innerHTML = \'<span style="color: var(--vscode-descriptionForeground);">Thinking...</span>\';',
            '            currentTurnWrapper.appendChild(currentAgentBubble);',
            '            chatContainer.appendChild(currentTurnWrapper);',
            '            currentAgentText = "";',
            '            scrollToBottom();',
            '        }',
            '        function ensureActivityAccordion() {',
            '            if (!currentActivityAccordion && currentTurnWrapper) {',
            '                currentActivityAccordion = document.createElement("div");',
            '                currentActivityAccordion.className = "activity-accordion expanded";',
            '                currentActivitySummary = document.createElement("div");',
            '                currentActivitySummary.className = "activity-summary";',
            '                currentActivitySummary.onclick = function() { currentActivityAccordion.classList.toggle("expanded"); };',
            '                currentActivityContent = document.createElement("div");',
            '                currentActivityContent.className = "activity-content";',
            '                currentActivityAccordion.appendChild(currentActivitySummary);',
            '                currentActivityAccordion.appendChild(currentActivityContent);',
            '                currentTurnWrapper.insertBefore(currentActivityAccordion, currentAgentBubble);',
            '            }',
            '        }',
            '        function updateActivitySummary() {',
            '            if (!currentActivitySummary) return;',
            '            const count = currentToolRows.size;',
            '            currentActivitySummary.innerHTML = \'<span style="display:flex;align-items:center;"><span class="activity-chevron">▶</span> ⚙️ Executed \' + count + \' tool\' + (count === 1 ? \'\' : \'s\') + \'</span><span style="font-size:10px;color:var(--vscode-descriptionForeground);">(Click to toggle)</span>\';',
            '        }',
            '        function setRunningState(running) {',
            '            isRunning = running;',
            '            if (running) {',
            '                sendBtn.textContent = "■ Stop";',
            '                sendBtn.classList.add("stop");',
            '                statusDot.className = "status-dot thinking";',
            '                statusText.textContent = "(Thinking...)";',
            '            } else {',
            '                sendBtn.textContent = "Send ▶";',
            '                sendBtn.classList.remove("stop");',
            '                statusDot.className = "status-dot";',
            '                statusText.textContent = "(Idle)";',
            '                if (currentActivityAccordion) {',
            '                    currentActivityAccordion.classList.remove("expanded");',
            '                }',
            '                scheduleMermaidRender(0);',
            '            }',
            '        }',
            '        function scrollToBottom() { chatContainer.scrollTop = chatContainer.scrollHeight; }',
            '        function clearChat() {',
            '            chatContainer.innerHTML = "";',
            '            chatContainer.appendChild(emptyState);',
            '            emptyState.style.display = "flex";',
            '            currentTurnWrapper = null;',
            '            currentAgentBubble = null;',
            '            currentActivityAccordion = null;',
            '            currentToolRows.clear();',
            '            currentAgentText = "";',
            '            setRunningState(false);',
            '            vscode.postMessage({ command: "clear_conversation" });',
            '        }',
            '        function onModelChange(val) { vscode.postMessage({ command: "select_model", modelId: val }); }',
            '        function onEffortChange(val) { vscode.postMessage({ command: "select_effort", effort: val }); }',
            '        function escapeHtml(s) {',
            '            return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");',
            '        }',
            '        function renderMarkdown(rawText) {',
            '            if (!rawText) return "";',
            '            const blocks = [];',
            '            const codeBlockRegex = /```+[ \\t]*([a-zA-Z0-9_-]*)[^\\r\\n]*[\\r\\n]+([\\s\\S]*?)(?:```+|$)/g;',
            '            let text = rawText.replace(codeBlockRegex, function(match, lang, code) {',
            '                const idx = blocks.length;',
            '                blocks.push({',
            '                    lang: (lang || "").toLowerCase().trim(),',
            '                    code: code',
            '                });',
            '                return "___CODEBLOCK_" + idx + "___";',
            '            });',
            '            text = escapeHtml(text);',
            '            text = text.replace(/^### (.*$)/gim, "<h3>$1</h3>");',
            '            text = text.replace(/^## (.*$)/gim, "<h2>$1</h2>");',
            '            text = text.replace(/^# (.*$)/gim, "<h1>$1</h1>");',
            '            text = text.replace(/^---$/gim, "<hr class=\\"md-hr\\">");',
            '            text = text.replace(/\\*\\*([^\\*]+)\\*\\*/g, "<strong>$1</strong>");',
            '            text = text.replace(/\\*([^\\*]+)\\*/g, "<em>$1</em>");',
            '            text = text.replace(/`([^`]+)`/g, "<code>$1</code>");',
            '            text = text.replace(/\\[([^\\]]+)\\]\\(([^\\)]+)\\)/g, function(_, label, url) {',
            '                return \'<a href="javascript:void(0)" onclick="vscode.postMessage({command:\\\'open_file\\\', filePath:\\\'\' + url + \'\\\'})">\' + label + \'</a>\';',
            '            });',
            '            text = text.replace(/\\n\\n/g, "</p><p>");',
            '            text = "<p>" + text + "</p>";',
            '            for (let i = 0; i < blocks.length; i++) {',
            '                const b = blocks[i];',
            '                const placeholder = "___CODEBLOCK_" + i + "___";',
            '                if (b.lang === "mermaid") {',
            '                    const rawCode = b.code.trim();',
            '                    const escapedCode = escapeHtml(rawCode);',
            '                    const encoded = encodeURIComponent(rawCode);',
            '                    const mermaidHtml = \'<div class="mermaid-block">\' +',
            '                        \'<div class="mermaid-toolbar">\' +',
            '                        \'<span class="mermaid-badge">📊 Architecture Diagram</span>\' +',
            '                        \'<div style="display:flex;gap:4px;">\' +',
            '                        \'<button class="mermaid-action-btn" onclick="toggleMermaidSource(this)">View Code</button>\' +',
            '                        \'<button class="copy-code-btn" style="position:static;" onclick="navigator.clipboard.writeText(decodeURIComponent(\\\'\' + encoded + \'\\\')); this.textContent=\\\'Copied!\\\'; setTimeout(() => this.textContent=\\\'Copy\\\', 1500)">Copy</button>\' +',
            '                        \'</div></div>\' +',
            '                        \'<div class="mermaid-diagram" data-code="\' + encoded + \'">Rendering diagram...</div>\' +',
            '                        \'<pre class="mermaid-code" style="display:none;"><code>\' + escapedCode + \'</code></pre>\' +',
            '                        \'</div>\';',
            '                    text = text.replace(placeholder, () => mermaidHtml);',
            '                } else {',
            '                    const escapedCode = escapeHtml(b.code);',
            '                    const preHtml = \'<pre><button class="copy-code-btn" onclick="navigator.clipboard.writeText(this.nextElementSibling.innerText); this.textContent=\\\'Copied!\\\'; setTimeout(() => this.textContent=\\\'Copy\\\', 1500)">Copy</button><code>\' + escapedCode + \'</code></pre>\';',
            '                    text = text.replace(placeholder, () => preHtml);',
            '                }',
            '            }',
            '            return text;',
            '        }',
            '        function toggleMermaidSource(btn) {',
            '            const block = btn.closest(".mermaid-block");',
            '            const diagram = block.querySelector(".mermaid-diagram");',
            '            const code = block.querySelector(".mermaid-code");',
            '            if (code.style.display === "none") {',
            '                code.style.display = "block";',
            '                diagram.style.display = "none";',
            '                btn.textContent = "View Diagram";',
            '            } else {',
            '                code.style.display = "none";',
            '                diagram.style.display = "flex";',
            '                btn.textContent = "View Code";',
            '            }',
            '        }',
            '        function scheduleMermaidRender(delayMs) {',
            '            if (mermaidTimer) clearTimeout(mermaidTimer);',
            '            mermaidTimer = setTimeout(renderMermaidDiagrams, delayMs || 100);',
            '        }',
            '        async function renderMermaidDiagrams() {',
            '            if (!window.mermaid) return;',
            '            const diagrams = document.querySelectorAll(".mermaid-diagram:not(.rendered)");',
            '            for (const el of diagrams) {',
            '                const raw = decodeURIComponent(el.getAttribute("data-code") || "");',
            '                if (!raw || raw.trim().length < 5) continue;',
            '                try {',
            '                    const id = "mermaid_" + Math.random().toString(36).substring(2, 9);',
            '                    const res = await window.mermaid.render(id, raw);',
            '                    el.innerHTML = res.svg;',
            '                    el.classList.add("rendered");',
            '                } catch (err) {',
            '                    console.warn("Mermaid render error:", err);',
            '                    if (!isRunning) {',
            '                        el.classList.add("rendered");',
            '                        el.innerHTML = \'<span style="color:var(--vscode-terminal-ansiYellow); font-size:11px;">⚠️ Diagram preview unavailable</span>\';',
            '                        const pre = el.nextElementSibling;',
            '                        if (pre) pre.style.display = "block";',
            '                    }',
            '                }',
            '            }',
            '        }',
            '        function toggleDiffCard(headerEl) {',
            '            const card = headerEl.closest(".diff-card");',
            '            if (card) {',
            '                card.classList.toggle("collapsed");',
            '            }',
            '        }',
            '        function renderDiffCard(change) {',
            '            if (!currentTurnWrapper) prepareAgentTurn();',
            '            const displayPath = change.relativePath || change.filePath.split("/").pop();',
            '            const filePathSafe = change.filePath.replace(/"/g, "&quot;");',
            '            let card = currentTurnWrapper.querySelector(\'.diff-card[data-file="\' + filePathSafe + \'"]\');',
            '            if (!card) {',
            '                card = document.createElement("div");',
            '                card.className = "diff-card";',
            '                card.setAttribute("data-file", change.filePath);',
            '                currentTurnWrapper.appendChild(card);',
            '            }',
            '            let hunksHtml = "";',
            '            if (change.hunks && change.hunks.length > 0) {',
            '                for (let h = 0; h < change.hunks.length; h++) {',
            '                    const hunk = change.hunks[h];',
            '                    hunksHtml += \'<div class="diff-hunk-banner">@@ -\' + hunk.oldStart + \',\' + hunk.oldLines + \' +\' + hunk.newStart + \',\' + hunk.newLines + \' @@</div>\';',
            '                    let oldNo = hunk.oldStart;',
            '                    let newNo = hunk.newStart;',
            '                    for (let l = 0; l < hunk.lines.length; l++) {',
            '                        const line = hunk.lines[l];',
            '                        const typeChar = line.charAt(0);',
            '                        const codeText = escapeHtml(line.slice(1));',
            '                        if (typeChar === "+") {',
            '                            hunksHtml += \'<div class="diff-line-row added">\' +',
            '                                \'<span class="diff-gutter-num"></span>\' +',
            '                                \'<span class="diff-gutter-num">\' + (newNo++) + \'</span>\' +',
            '                                \'<span class="diff-line-type">+</span>\' +',
            '                                \'<span class="diff-line-text">\' + codeText + \'</span>\' +',
            '                                \'</div>\';',
            '                        } else if (typeChar === "-") {',
            '                            hunksHtml += \'<div class="diff-line-row deleted">\' +',
            '                                \'<span class="diff-gutter-num">\' + (oldNo++) + \'</span>\' +',
            '                                \'<span class="diff-gutter-num"></span>\' +',
            '                                \'<span class="diff-line-type">-</span>\' +',
            '                                \'<span class="diff-line-text">\' + codeText + \'</span>\' +',
            '                                \'</div>\';',
            '                        } else {',
            '                            hunksHtml += \'<div class="diff-line-row context">\' +',
            '                                \'<span class="diff-gutter-num">\' + (oldNo++) + \'</span>\' +',
            '                                \'<span class="diff-gutter-num">\' + (newNo++) + \'</span>\' +',
            '                                \'<span class="diff-line-type"> </span>\' +',
            '                                \'<span class="diff-line-text">\' + codeText + \'</span>\' +',
            '                                \'</div>\';',
            '                        }',
            '                    }',
            '                }',
            '            } else {',
            '                hunksHtml = \'<div class="diff-empty-msg">File created or replaced. Click Review Diff to view full file in editor.</div>\';',
            '            }',
            '            const encPath = encodeURIComponent(change.filePath);',
            '            card.innerHTML = \'<div class="diff-card-header" onclick="toggleDiffCard(this)">\' +',
            '                \'<div class="diff-card-left">\' +',
            '                \'<span class="diff-toggle-chevron">▼</span>\' +',
            '                \'<span class="diff-file-icon">📄</span>\' +',
            '                \'<span class="diff-path" title="\' + escapeHtml(change.filePath) + \'">\' + escapeHtml(displayPath) + \'</span>\' +',
            '                \'<div class="diff-stats">\' +',
            '                \'<span class="add">+\' + change.additions + \'</span>\' +',
            '                \'<span class="del">-\' + change.deletions + \'</span>\' +',
            '                \'</div>\' +',
            '                \'</div>\' +',
            '                \'<div class="diff-card-actions" onclick="event.stopPropagation()">\' +',
            '                \'<button class="diff-btn" title="Open File in Editor" onclick="vscode.postMessage({ command: \\\'open_file\\\', filePath: decodeURIComponent(\\\'\' + encPath + \'\\\') })">Open</button>\' +',
            '                \'<button class="diff-btn primary" title="Open Side-by-Side Diff" onclick="vscode.postMessage({ command: \\\'open_diff\\\', filePath: decodeURIComponent(\\\'\' + encPath + \'\\\') })">Review Diff</button>\' +',
            '                \'</div>\' +',
            '                \'</div>\' +',
            '                \'<div class="diff-preview-body">\' + hunksHtml + \'</div>\';',
            '            scrollToBottom();',
            '        }',
            '        window.addEventListener("message", (event) => {',
            '            const msg = event.data;',
            '            switch (msg.command) {',
            '                case "init_state": {',
            '                    if (msg.models && msg.models.length > 0) {',
            '                        modelSelect.innerHTML = "";',
            '                        msg.models.forEach(m => {',
            '                            const opt = document.createElement("option");',
            '                            opt.value = m.id;',
            '                            opt.textContent = m.label;',
            '                            if (m.id === msg.currentModel) opt.selected = true;',
            '                            modelSelect.appendChild(opt);',
            '                        });',
            '                    }',
            '                    if (msg.currentEffort) effortSelect.value = msg.currentEffort;',
            '                    if (msg.quota) updateQuotaUI(msg.quota);',
            '                    if (msg.activeContext) updateContextUI(msg.activeContext);',
            '                    break;',
            '                }',
            '                case "text_delta": {',
            '                    if (!currentAgentBubble) prepareAgentTurn();',
            '                    currentAgentText += msg.delta;',
            '                    currentAgentBubble.innerHTML = renderMarkdown(currentAgentText);',
            '                    statusDot.className = "status-dot thinking";',
            '                    statusText.textContent = "(Writing...)";',
            '                    scheduleMermaidRender(300);',
            '                    scrollToBottom();',
            '                    break;',
            '                }',
            '                case "tool_event": {',
            '                    if (!currentTurnWrapper) prepareAgentTurn();',
            '                    ensureActivityAccordion();',
            '                    if (msg.state === "ACTIVE") {',
            '                        statusDot.className = "status-dot executing_tool";',
            '                        statusText.textContent = "(" + msg.toolName + "...)";',
            '                    }',
            '                    const toolKey = msg.toolName + "_" + (msg.toolInfo && msg.toolInfo.parameters ? (msg.toolInfo.parameters.TargetFile || msg.toolInfo.parameters.path || msg.toolInfo.parameters.CommandLine || "") : "");',
            '                    let row = currentToolRows.get(toolKey);',
            '                    if (!row) {',
            '                        row = document.createElement("div");',
            '                        row.className = "tool-row";',
            '                        currentToolRows.set(toolKey, row);',
            '                        currentActivityContent.appendChild(row);',
            '                    }',
            '                    const icon = msg.state === "ACTIVE" ? "⚙️" : (msg.state === "DONE" ? "✓" : "✗");',
            '                    const dur = msg.durationSeconds ? (msg.durationSeconds * 1000).toFixed(0) + "ms" : "running...";',
            '                    row.innerHTML = \'<div class="tool-row-header">\' +',
            '                        \'<span class="tool-row-name"><span>\' + icon + \'</span> \' + escapeHtml(msg.toolName) + \'</span>\' +',
            '                        \'<span class="tool-row-dur">\' + dur + \'</span></div>\';',
            '                    if (msg.toolInfo && msg.toolInfo.parameters) {',
            '                        const pre = document.createElement("div");',
            '                        pre.className = "tool-row-details";',
            '                        pre.textContent = JSON.stringify(msg.toolInfo.parameters, null, 2);',
            '                        row.appendChild(pre);',
            '                    }',
            '                    updateActivitySummary();',
            '                    scrollToBottom();',
            '                    break;',
            '                }',
            '                case "file_changed": {',
            '                    renderDiffCard(msg.change);',
            '                    break;',
            '                }',
            '                case "turn_complete": {',
            '                    setRunningState(false);',
            '                    scheduleMermaidRender(0);',
            '                    break;',
            '                }',
            '                case "status_change": {',
            '                    if (msg.status === "idle") {',
            '                        setRunningState(false);',
            '                        scheduleMermaidRender(0);',
            '                    }',
            '                    break;',
            '                }',
            '                case "context_update": { updateContextUI(msg.items); break; }',
            '                case "quota_update": { updateQuotaUI(msg.quota); break; }',
            '                case "error": {',
            '                    setRunningState(false);',
            '                    const errRow = document.createElement("div");',
            '                    errRow.style.color = "var(--vscode-terminal-ansiRed)";',
            '                    errRow.style.padding = "8px";',
            '                    errRow.textContent = "Error: " + msg.message;',
            '                    chatContainer.appendChild(errRow);',
            '                    scrollToBottom();',
            '                    break;',
            '                }',
            '            }',
            '        });',
            '        function updateContextUI(items) {',
            '            contextItems = items || [];',
            '            contextChips.innerHTML = "";',
            '            contextItems.forEach(item => {',
            '                const chip = document.createElement("div");',
            '                chip.className = "context-chip";',
            '                chip.innerHTML = \'<span>\' + escapeHtml(item.label) + \'</span><span class="remove-chip" onclick="removeContext(\\\'\' + item.id + \'\\\')">×</span>\';',
            '                contextChips.appendChild(chip);',
            '            });',
            '        }',
            '        function removeContext(id) {',
            '            contextItems = contextItems.filter(c => c.id !== id);',
            '            updateContextUI(contextItems);',
            '        }',
            '        function updateQuotaUI(quota) {',
            '            if (!quota || !quota.groups || !quota.groups[0] || !quota.groups[0].buckets) return;',
            '            const b = quota.groups[0].buckets.find(x => x.window === "5h") || quota.groups[0].buckets[0];',
            '            if (b) {',
            '                const pct = Math.round(b.remaining_fraction * 100);',
            '                quotaLabel.textContent = "5h: " + pct + "%";',
            '                quotaFill.style.width = pct + "%";',
            '            }',
            '        }',
            '        vscode.postMessage({ command: "ready" });',
            '    </script>',
            '</body>',
            '</html>',
        ].join('\n');
    }
}
