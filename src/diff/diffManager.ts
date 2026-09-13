import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DiffHunk, FileChangeRecord } from '../shared/messages';

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
            const diffResult = this.computeUnifiedDiff(original, current, 3);
            const relativePath = vscode.workspace.asRelativePath(filePath);

            return {
                filePath,
                relativePath,
                originalContent: original,
                modifiedContent: current,
                additions: diffResult.additions,
                deletions: diffResult.deletions,
                hunks: diffResult.hunks,
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

    /**
     * Pure TypeScript, dependency-free unified diff computation
     */
    private computeUnifiedDiff(
        oldStr: string,
        newStr: string,
        contextLines = 3
    ): { additions: number; deletions: number; hunks: DiffHunk[] } {
        const oldArr = oldStr ? oldStr.split(/\r?\n/) : [];
        const newArr = newStr ? newStr.split(/\r?\n/) : [];

        // 1. Common prefix optimization
        let prefix = 0;
        while (prefix < oldArr.length && prefix < newArr.length && oldArr[prefix] === newArr[prefix]) {
            prefix++;
        }

        // 2. Common suffix optimization
        let suffix = 0;
        while (
            suffix < oldArr.length - prefix &&
            suffix < newArr.length - prefix &&
            oldArr[oldArr.length - 1 - suffix] === newArr[newArr.length - 1 - suffix]
        ) {
            suffix++;
        }

        const midOld = oldArr.slice(prefix, oldArr.length - suffix);
        const midNew = newArr.slice(prefix, newArr.length - suffix);

        // 3. LCS for middle segment
        const dp: number[][] = Array.from({ length: midOld.length + 1 }, () =>
            new Array(midNew.length + 1).fill(0)
        );
        for (let i = 0; i < midOld.length; i++) {
            for (let j = 0; j < midNew.length; j++) {
                if (midOld[i] === midNew[j]) {
                    dp[i + 1][j + 1] = dp[i][j] + 1;
                } else {
                    dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
        }

        const diff: { type: '+' | '-' | ' '; text: string }[] = [];
        let i = midOld.length;
        let j = midNew.length;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && midOld[i - 1] === midNew[j - 1]) {
                diff.push({ type: ' ', text: midOld[i - 1] });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                diff.push({ type: '+', text: midNew[j - 1] });
                j--;
            } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
                diff.push({ type: '-', text: midOld[i - 1] });
                i--;
            }
        }
        diff.reverse();

        // 4. Context bounding
        const startContext = oldArr
            .slice(Math.max(0, prefix - contextLines), prefix)
            .map((t) => ({ type: ' ' as const, text: t }));
        const endContext = oldArr
            .slice(oldArr.length - suffix, Math.min(oldArr.length, oldArr.length - suffix + contextLines))
            .map((t) => ({ type: ' ' as const, text: t }));

        const allLines = [...startContext, ...diff, ...endContext];
        if (allLines.length === 0) {
            return { additions: 0, deletions: 0, hunks: [] };
        }

        let additions = 0;
        let deletions = 0;
        const hunkLines = allLines.map((l) => {
            if (l.type === '+') {
                additions++;
            }
            if (l.type === '-') {
                deletions++;
            }
            return l.type + l.text;
        });

        const oldStart = Math.max(1, prefix - startContext.length + 1);
        const newStart = Math.max(1, prefix - startContext.length + 1);

        const oldHunkCount = startContext.length + midOld.length + endContext.length;
        const newHunkCount = startContext.length + midNew.length + endContext.length;

        return {
            additions,
            deletions,
            hunks: [
                {
                    oldStart,
                    oldLines: oldHunkCount,
                    newStart,
                    newLines: newHunkCount,
                    lines: hunkLines,
                },
            ],
        };
    }
}
