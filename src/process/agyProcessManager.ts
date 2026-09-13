import * as cp from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import {
    AgyServerEvent,
    AgyStepUpdateEvent,
    AgyResultEvent,
    ModelDescriptor,
    QuotaData,
    StreamInputUserMessage,
    TokenUsage,
    ToolInfo
} from './protocolTypes';
import { ExecutionMode, PermissionRequest } from '../shared/messages';

export interface ProcessStateEvents {
    onTextDelta: vscode.Event<string>;
    onToolEvent: vscode.Event<{ toolName: string; state: 'ACTIVE' | 'DONE' | 'ERROR'; toolInfo?: ToolInfo; durationSeconds?: number }>;
    onPermissionRequest: vscode.Event<PermissionRequest>;
    onPermissionResolved: vscode.Event<{ requestId: string; approved: boolean }>;
    onTurnComplete: vscode.Event<{ status: 'SUCCESS' | 'ERROR'; usage?: TokenUsage; durationSeconds?: number }>;
    onStatusChange: vscode.Event<'idle' | 'thinking' | 'streaming' | 'executing_tool' | 'error'>;
    onError: vscode.Event<string>;
}

export class AgyProcessManager implements vscode.Disposable {
    private process: cp.ChildProcessWithoutNullStreams | undefined;
    private readlineInterface: readline.Interface | undefined;
    private isTurnActive = false;
    private currentConversationId: string | undefined;

    private readonly _onTextDelta = new vscode.EventEmitter<string>();
    private readonly _onToolEvent = new vscode.EventEmitter<{
        toolName: string;
        state: 'ACTIVE' | 'DONE' | 'ERROR';
        toolInfo?: ToolInfo;
        durationSeconds?: number;
    }>();
    private readonly _onPermissionRequest = new vscode.EventEmitter<PermissionRequest>();
    private readonly _onPermissionResolved = new vscode.EventEmitter<{ requestId: string; approved: boolean }>();
    private readonly _onTurnComplete = new vscode.EventEmitter<{
        status: 'SUCCESS' | 'ERROR';
        usage?: TokenUsage;
        durationSeconds?: number;
    }>();
    private readonly _onStatusChange = new vscode.EventEmitter<'idle' | 'thinking' | 'streaming' | 'executing_tool' | 'error'>();
    private readonly _onError = new vscode.EventEmitter<string>();

    public readonly events: ProcessStateEvents = {
        onTextDelta: this._onTextDelta.event,
        onToolEvent: this._onToolEvent.event,
        onPermissionRequest: this._onPermissionRequest.event,
        onPermissionResolved: this._onPermissionResolved.event,
        onTurnComplete: this._onTurnComplete.event,
        onStatusChange: this._onStatusChange.event,
        onError: this._onError.event,
    };

    private currentModel: string | undefined;
    private currentEffort: 'low' | 'medium' | 'high' = 'high';
    private executionMode: ExecutionMode = 'accept-edits';
    private sessionApprovedTools = new Set<string>();
    private pendingPermissions = new Map<string, PermissionRequest>();

    constructor() {
        const config = vscode.workspace.getConfiguration('antigravity');
        this.executionMode = config.get<ExecutionMode>('mode', 'accept-edits');
    }

    /**
     * Retrieves the executable path configured in VS Code settings or defaults to 'agy'.
     */
    public getExecutablePath(): string {
        const config = vscode.workspace.getConfiguration('antigravity');
        return config.get<string>('executable', 'agy');
    }

    /**
     * Discovers all available models dynamically from the CLI.
     */
    public async fetchAvailableModels(): Promise<ModelDescriptor[]> {
        return new Promise((resolve) => {
            const executable = this.getExecutablePath();
            cp.exec(`${executable} models`, (error, stdout) => {
                if (error || !stdout) {
                    // Fallback to sensible defaults if CLI is unreachable
                    resolve([
                        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
                        { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
                        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
                        { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
                    ]);
                    return;
                }

                const models: ModelDescriptor[] = [];
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('Fetching')) {
                        continue;
                    }
                    const parts = trimmed.split('\t');
                    if (parts.length >= 2) {
                        models.push({ id: parts[0].trim(), label: parts[1].trim() });
                    } else if (parts.length === 1 && parts[0].length > 0) {
                        models.push({ id: parts[0].trim(), label: parts[0].trim() });
                    }
                }
                resolve(models.length > 0 ? models : [
                    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }
                ]);
            });
        });
    }

    /**
     * Fetches current model selection from the CLI.
     */
    public async fetchCurrentModel(): Promise<string> {
        return new Promise((resolve) => {
            const executable = this.getExecutablePath();
            cp.exec(`${executable} -p "/model" --output-format json`, (error, stdout) => {
                if (!error && stdout) {
                    try {
                        const parsed = JSON.parse(stdout);
                        if (parsed.command?.data?.id) {
                            this.currentModel = parsed.command.data.id;
                            resolve(parsed.command.data.id);
                            return;
                        }
                    } catch {
                        // ignore
                    }
                }
                resolve(this.currentModel || 'gemini-3.8-flash-high');
            });
        });
    }

    /**
     * Fetches real-time quota data from the CLI.
     */
    public async fetchQuota(): Promise<QuotaData | undefined> {
        return new Promise((resolve) => {
            const executable = this.getExecutablePath();
            cp.exec(`${executable} -p "/quota" --output-format json`, (error, stdout) => {
                if (!error && stdout) {
                    try {
                        const parsed = JSON.parse(stdout);
                        if (parsed.command?.data?.groups) {
                            resolve(parsed.command.data as QuotaData);
                            return;
                        }
                    } catch {
                        // ignore
                    }
                }
                resolve(undefined);
            });
        });
    }

    /**
     * Sets the active model for future sessions.
     */
    public setModel(modelId: string): void {
        if (this.currentModel !== modelId) {
            this.currentModel = modelId;
            // Restart process with new model flag if currently running
            this.restartSubprocess();
        }
    }

    /**
     * Sets the reasoning effort level.
     */
    public setEffort(effort: 'low' | 'medium' | 'high'): void {
        if (this.currentEffort !== effort) {
            this.currentEffort = effort;
            this.restartSubprocess();
        }
    }

    public getActiveModel(): string {
        return this.currentModel || 'gemini-3.8-flash-high';
    }

    public getActiveEffort(): 'low' | 'medium' | 'high' {
        return this.currentEffort;
    }

    public getExecutionMode(): ExecutionMode {
        return this.executionMode;
    }

    public setExecutionMode(mode: ExecutionMode): void {
        if (this.executionMode !== mode) {
            this.executionMode = mode;
            this.restartSubprocess();
        }
    }

    public getConversationId(): string | undefined {
        return this.currentConversationId;
    }

    /**
     * Ensures the background stream-json process is running and ready for turns.
     */
    public async ensureProcessStarted(): Promise<void> {
        if (this.process && !this.process.killed) {
            return;
        }

        const executable = this.getExecutablePath();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const args: string[] = [
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
        ];

        if (this.executionMode === 'auto-approve') {
            args.push('--dangerously-skip-permissions');
        } else {
            args.push('--mode', this.executionMode);
        }

        if (this.currentModel) {
            args.push('--model', this.currentModel);
        }
        if (this.currentEffort) {
            args.push('--effort', this.currentEffort);
        }
        if (workspaceFolder) {
            args.push('--add-dir', workspaceFolder);
        }
        if (this.currentConversationId) {
            args.push('--conversation', this.currentConversationId);
        }

        try {
            this.process = cp.spawn(executable, args, {
                cwd: workspaceFolder || process.cwd(),
                env: { ...process.env },
            });

            this.readlineInterface = readline.createInterface({
                input: this.process.stdout,
                terminal: false,
            });

            this.readlineInterface.on('line', (line) => {
                this.handleStreamLine(line);
            });

            this.process.stderr.on('data', (data) => {
                const text = data.toString().trim();
                if (text && !text.includes('warning:')) {
                    console.warn('[agy stderr]:', text);
                }
            });

            this.process.on('close', () => {
                this.process = undefined;
                this.readlineInterface = undefined;
                if (this.isTurnActive) {
                    this.isTurnActive = false;
                    this._onTurnComplete.fire({ status: 'ERROR' });
                    this._onStatusChange.fire('idle');
                }
            });

            this.process.on('error', (err) => {
                console.error('[agy process error]:', err);
                this._onError.fire(`Antigravity CLI process error: ${err.message}`);
                this._onStatusChange.fire('error');
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._onError.fire(`Failed to start Antigravity CLI: ${msg}`);
            this._onStatusChange.fire('error');
        }
    }

    /**
     * Sends a user prompt turn to the running stream-json process.
     */
    public async sendPrompt(prompt: string): Promise<void> {
        await this.ensureProcessStarted();

        if (!this.process || this.process.killed) {
            this._onError.fire('Antigravity CLI is not running.');
            return;
        }

        this.isTurnActive = true;
        this._onStatusChange.fire('thinking');

        const message: StreamInputUserMessage = {
            event: 'user',
            message: {
                content: prompt,
            },
        };

        const jsonLine = JSON.stringify(message) + '\n';
        this.process.stdin.write(jsonLine);
    }

    /**
     * Cancels the current turn by terminating and restarting the process.
     */
    public cancelTurn(): void {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = undefined;
        }
        this.isTurnActive = false;
        this._onTurnComplete.fire({ status: 'ERROR' });
        this._onStatusChange.fire('idle');
    }

    /**
     * Starts a fresh session clearing conversation ID.
     */
    public newSession(): void {
        this.currentConversationId = undefined;
        this.sessionApprovedTools.clear();
        this.pendingPermissions.clear();
        this.restartSubprocess();
    }

    /**
     * Resumes an existing conversation session by its ID.
     */
    public resumeSession(conversationId: string): void {
        this.currentConversationId = conversationId;
        this.restartSubprocess();
    }

    /**
     * Handles user permission response (allow once, allow session, or deny).
     */
    public handlePermissionResponse(
        requestId: string,
        approved: boolean,
        scope?: 'once' | 'session'
    ): void {
        const req = this.pendingPermissions.get(requestId);
        if (req && scope === 'session') {
            this.sessionApprovedTools.add(req.toolName);
            if (req.action) {
                this.sessionApprovedTools.add(req.action);
            }
        }
        this.pendingPermissions.delete(requestId);

        if (this.process && !this.process.killed) {
            const answer = approved ? 'yes' : 'no';
            const streamMsg = JSON.stringify({
                event: 'user',
                message: { content: answer },
            }) + '\n';
            try {
                this.process.stdin.write(streamMsg);
                this.process.stdin.write(approved ? 'y\n' : 'n\n');
            } catch (err) {
                console.warn('[agy permission response write error]:', err);
            }
        }

        this._onPermissionResolved.fire({ requestId, approved });
    }

    private restartSubprocess(): void {
        this.isTurnActive = false;
        if (this.process) {
            try {
                this.process.kill('SIGTERM');
            } catch {
                // ignore
            }
            this.process = undefined;
        }
        if (this.readlineInterface) {
            try {
                this.readlineInterface.close();
            } catch {
                // ignore
            }
            this.readlineInterface = undefined;
        }
        this.ensureProcessStarted();
    }

    /**
     * Parses and dispatches each NDJSON line emitted by agy.
     */
    private handleStreamLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) {
            return;
        }

        try {
            const event = JSON.parse(trimmed) as AgyServerEvent;

            switch (event.event) {
                case 'init':
                    this.currentConversationId = event.conversation_id;
                    break;

                case 'step_update': {
                    const stepUpdate = (event as AgyStepUpdateEvent).step_update;

                    if (stepUpdate.step_type === 'agent_response') {
                        if (stepUpdate.text_delta) {
                            this._onStatusChange.fire('streaming');
                            this._onTextDelta.fire(stepUpdate.text_delta);
                        }
                    } else if (stepUpdate.step_type === 'tool') {
                        const toolName = stepUpdate.tool_name || 'ask_permission';
                        const isPermTool = toolName === 'ask_permission' || toolName === 'ask_custom_permission';
                        if (isPermTool && stepUpdate.state === 'ACTIVE') {
                            const params = stepUpdate.tool_info?.parameters || {};
                            const command = (params.command || params.CommandLine || params.cmd) as string | undefined;
                            const targetPath = (params.TargetFile || params.path || params.file || params.filePath) as string | undefined;
                            const action = (command || targetPath || params.tool || params.action || '') as string;
                            const description = (params.description || params.message || params.reason || (command ? `Run command: ${command}` : (targetPath ? `Modify file: ${targetPath}` : `Permission requested for: ${toolName}`))) as string;

                            if (this.sessionApprovedTools.has(toolName) || (action && this.sessionApprovedTools.has(action))) {
                                this.handlePermissionResponse('auto_' + Date.now(), true, 'session');
                                return;
                            }

                            const req: PermissionRequest = {
                                id: 'perm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                                toolName,
                                action,
                                description,
                                command,
                                targetPath,
                                parameters: params,
                            };
                            this.pendingPermissions.set(req.id, req);
                            this._onPermissionRequest.fire(req);
                            return;
                        }

                        if (stepUpdate.state === 'ACTIVE') {
                            this._onStatusChange.fire('executing_tool');
                        }
                        this._onToolEvent.fire({
                            toolName: stepUpdate.tool_name || 'tool',
                            state: stepUpdate.state,
                            toolInfo: stepUpdate.tool_info,
                            durationSeconds: stepUpdate.duration_seconds,
                        });
                    }
                    break;
                }

                case 'result': {
                    const result = (event as AgyResultEvent).result;
                    this.isTurnActive = false;
                    this._onTurnComplete.fire({
                        status: result.status,
                        usage: result.usage,
                        durationSeconds: result.duration_seconds,
                    });
                    this._onStatusChange.fire('idle');
                    break;
                }
            }
        } catch (err) {
            console.warn('[agy stream parse error]:', err, line);
        }
    }

    public dispose(): void {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = undefined;
        }
        this.readlineInterface?.close();
        this._onTextDelta.dispose();
        this._onToolEvent.dispose();
        this._onPermissionRequest.dispose();
        this._onPermissionResolved.dispose();
        this._onTurnComplete.dispose();
        this._onStatusChange.dispose();
        this._onError.dispose();
    }
}
