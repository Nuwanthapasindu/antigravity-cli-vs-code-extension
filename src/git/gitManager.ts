import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface GitStatus {
    branch?: string;
    dirtyCount?: number;
}

interface GitRepoState {
    HEAD?: {
        name?: string;
        commit?: string;
    };
    workingTreeChanges?: unknown[];
    indexChanges?: unknown[];
    onDidChange: (listener: () => void) => vscode.Disposable;
}

interface GitRepository {
    state?: GitRepoState;
}

interface GitApi {
    repositories?: GitRepository[];
    onDidOpenRepository: (listener: (r: GitRepository) => void) => vscode.Disposable;
}

export class GitManager implements vscode.Disposable {
    private currentStatus: GitStatus = {};
    private disposables: vscode.Disposable[] = [];
    private readonly _onDidChangeGitStatus = new vscode.EventEmitter<GitStatus>();
    public readonly onDidChangeGitStatus = this._onDidChangeGitStatus.event;

    constructor() {
        this.initGitIntegration();
    }

    public getStatus(): GitStatus {
        return { ...this.currentStatus };
    }

    public openGit(): void {
        vscode.commands.executeCommand('workbench.view.scm');
    }

    private async initGitIntegration(): Promise<void> {
        // Try built-in VS Code Git extension API first
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const exportsObj = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
                const git = (exportsObj && typeof exportsObj.getAPI === 'function') ? (exportsObj.getAPI(1) as GitApi) : undefined;
                if (git && git.repositories && git.repositories.length > 0) {
                    const repo = git.repositories[0];
                    this.updateFromGitApiRepo(repo);

                    repo.state?.onDidChange(() => {
                        this.updateFromGitApiRepo(repo);
                    });

                    git.onDidOpenRepository((r: GitRepository) => {
                        this.updateFromGitApiRepo(r);
                        r.state?.onDidChange(() => this.updateFromGitApiRepo(r));
                    });
                    return;
                }
            }
        } catch {
            // Fall back to direct file inspection
        }

        // Direct filesystem fallback
        this.inspectGitDirectory();
        this.setupFileSystemWatcher();
    }

    private updateFromGitApiRepo(repo: GitRepository): void {
        if (!repo || !repo.state) {
            return;
        }
        const branch = repo.state.HEAD?.name || (repo.state.HEAD?.commit ? repo.state.HEAD.commit.substring(0, 7) : undefined);
        const dirtyCount = (repo.state.workingTreeChanges?.length || 0) + (repo.state.indexChanges?.length || 0);

        this.currentStatus = { branch, dirtyCount };
        this._onDidChangeGitStatus.fire(this.currentStatus);
    }

    private inspectGitDirectory(): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            return;
        }

        const gitDir = path.join(root, '.git');
        const headPath = path.join(gitDir, 'HEAD');

        if (!fs.existsSync(headPath)) {
            this.currentStatus = {};
            this._onDidChangeGitStatus.fire(this.currentStatus);
            return;
        }

        try {
            const headContent = fs.readFileSync(headPath, 'utf-8').trim();
            let branch: string | undefined;
            if (headContent.startsWith('ref: refs/heads/')) {
                branch = headContent.replace('ref: refs/heads/', '');
            } else if (headContent.length >= 7) {
                branch = headContent.substring(0, 7);
            }

            this.currentStatus = { branch, dirtyCount: this.currentStatus.dirtyCount || 0 };
            this._onDidChangeGitStatus.fire(this.currentStatus);
        } catch {
            // ignore
        }
    }

    private setupFileSystemWatcher(): void {
        try {
            const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,index}');
            watcher.onDidChange(() => this.inspectGitDirectory());
            watcher.onDidCreate(() => this.inspectGitDirectory());
            watcher.onDidDelete(() => this.inspectGitDirectory());
            this.disposables.push(watcher);
        } catch {
            // ignore
        }
    }

    public dispose(): void {
        this._onDidChangeGitStatus.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
