import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as Diff from 'diff';
import { FileChangeRecord } from '../shared/messages';

export class DiffManager implements vscode.Disposable {
    private originalSnapshots = new Map<string, string>();
    private tempDir: string;

    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'antigravity-diffs');
        if (!fs.existsSync(this.tempDir)) {
            try {
                fs.mkdirSync(this.tempDir, { recursive: true });
            } catch (err) {
                console.error('Failed to create diff temp dir:', err);
            }
        }
    }

    /**
     * Stash the current state of a file before Antigravity modifies it
     */
    public recordOriginal(filePath: string): void {
        if (this.originalSnapshots.has(filePath)) {
            return; // Keep initial state for session
        }
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                this.originalSnapshots.set(filePath, content);
            } else {
                // Newly created file
                this.originalSnapshots.set(filePath, '');
            }
        } catch (err) {
            console.warn('Could not record original snapshot for:', filePath, err);
        }
    }

    /**
     * Compute unified diff hunks and stats between snapshot and current file content
     */
    public getChangeRecord(filePath: string): FileChangeRecord | undefined {
        const original = this.originalSnapshots.get(filePath);
        if (original === undefined) {
            return undefined;
        }

        try {
            const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
            const fileName = path.basename(filePath);
            const patch = Diff.structuredPatch(fileName, fileName, original, current, '', '', { context: 3 });

            let additions = 0;
            let deletions = 0;
            for (const hunk of patch.hunks) {
                for (const line of hunk.lines) {
                    if (line.startsWith('+')) {
                        additions++;
                    } else if (line.startsWith('-')) {
                        deletions++;
                    }
                }
            }

            const relativePath = vscode.workspace.asRelativePath(filePath);

            return {
                filePath,
                relativePath,
                originalContent: original,
                modifiedContent: current,
                additions,
                deletions,
                hunks: patch.hunks,
            };
        } catch (err) {
            console.warn('Failed to compute diff hunks for:', filePath, err);
            return undefined;
        }
    }

    /**
     * Launch VS Code's native diff editor comparing the pre-modification snapshot with current disk file
     */
    public async openDiff(filePath: string): Promise<void> {
        const originalContent = this.originalSnapshots.get(filePath);
        if (originalContent === undefined) {
            // Fallback: open file directly
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
            return;
        }

        const fileName = path.basename(filePath);
        const snapshotPath = path.join(this.tempDir, `original-${fileName}`);
        fs.writeFileSync(snapshotPath, originalContent, 'utf-8');

        const originalUri = vscode.Uri.file(snapshotPath);
        const currentUri = vscode.Uri.file(filePath);

        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            currentUri,
            `${fileName} (Antigravity Proposed Changes)`,
            { viewColumn: vscode.ViewColumn.One }
        );
    }

    /**
     * Revert file back to original snapshot
     */
    public async revertFile(filePath: string): Promise<boolean> {
        const original = this.originalSnapshots.get(filePath);
        if (original === undefined) {
            return false;
        }

        try {
            fs.writeFileSync(filePath, original, 'utf-8');
            this.originalSnapshots.delete(filePath);
            return true;
        } catch (err) {
            console.error('Failed to revert file:', filePath, err);
            return false;
        }
    }

    public dispose(): void {
        this.originalSnapshots.clear();
        try {
            if (fs.existsSync(this.tempDir)) {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }
    }
}
