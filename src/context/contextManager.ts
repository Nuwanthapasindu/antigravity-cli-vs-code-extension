import * as vscode from 'vscode';
import { ContextItem } from '../shared/messages';

export class ContextManager implements vscode.Disposable {
    private activeContext: ContextItem[] = [];
    private disposables: vscode.Disposable[] = [];
    private readonly _onDidChangeContext = new vscode.EventEmitter<ContextItem[]>();
    public readonly onDidChangeContext = this._onDidChangeContext.event;

    constructor() {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveContext()),
            vscode.window.onDidChangeTextEditorSelection(() => this.updateActiveContext())
        );
        this.updateActiveContext();
    }

    public getActiveContext(): ContextItem[] {
        return [...this.activeContext];
    }

    public removeContextItem(id: string): void {
        this.activeContext = this.activeContext.filter((item) => item.id !== id);
        this._onDidChangeContext.fire(this.activeContext);
    }

    public addContextItem(item: ContextItem): void {
        if (!this.activeContext.some((existing) => existing.id === item.id)) {
            this.activeContext.push(item);
            this._onDidChangeContext.fire(this.activeContext);
        }
    }

    public async pickWorkspaceFile(): Promise<ContextItem | undefined> {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Attach to Antigravity Context',
        });

        if (uris && uris.length > 0) {
            const uri = uris[0];
            const relativePath = vscode.workspace.asRelativePath(uri);
            const item: ContextItem = {
                id: `file:${uri.fsPath}`,
                type: 'workspace_file',
                label: relativePath,
                path: uri.fsPath,
            };
            this.addContextItem(item);
            return item;
        }
        return undefined;
    }

    private updateActiveContext(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            // Keep manual attachments, remove active_file/selection
            this.activeContext = this.activeContext.filter(
                (item) => item.type === 'workspace_file'
            );
            this._onDidChangeContext.fire(this.activeContext);
            return;
        }

        const document = editor.document;
        const relativePath = vscode.workspace.asRelativePath(document.uri);
        const selection = editor.selection;

        // Retain any manual attachments
        const manualItems = this.activeContext.filter(
            (item) => item.type === 'workspace_file'
        );

        if (!selection.isEmpty) {
            const startLine = selection.start.line + 1;
            const endLine = selection.end.line + 1;
            const selectedText = document.getText(selection);

            const selectionItem: ContextItem = {
                id: `selection:${document.uri.fsPath}:${startLine}-${endLine}`,
                type: 'selection',
                label: `${relativePath} (${startLine}–${endLine})`,
                path: document.uri.fsPath,
                lineRange: [startLine, endLine],
                content: selectedText,
            };

            this.activeContext = [selectionItem, ...manualItems];
        } else {
            const fileItem: ContextItem = {
                id: `active:${document.uri.fsPath}`,
                type: 'active_file',
                label: relativePath,
                path: document.uri.fsPath,
            };

            this.activeContext = [fileItem, ...manualItems];
        }

        this._onDidChangeContext.fire(this.activeContext);
    }

    /**
     * Formats prompt with attached context blocks
     */
    public formatPromptWithContext(prompt: string, contextItems: ContextItem[]): string {
        const trimmed = prompt.trim();
        // Slash commands must remain at the very start of the input for agy to recognize them
        if (trimmed.startsWith('/') || !contextItems || contextItems.length === 0) {
            return prompt;
        }

        const contextBlocks: string[] = [];
        for (const item of contextItems) {
            if (item.content && item.lineRange) {
                contextBlocks.push(
                    `[Context: File ${item.label} lines ${item.lineRange[0]}-${item.lineRange[1]}]:\n\`\`\`\n${item.content}\n\`\`\``
                );
            } else {
                contextBlocks.push(`[Context: Active file: ${item.label} (${item.path})]`);
            }
        }

        return `<context>\n${contextBlocks.join('\n\n')}\n</context>\n\n${prompt}`;
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this._onDidChangeContext.dispose();
    }
}
