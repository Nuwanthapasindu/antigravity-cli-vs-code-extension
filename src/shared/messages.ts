import { ModelDescriptor, QuotaData, TokenUsage, ToolInfo } from '../process/protocolTypes';

export interface ContextItem {
    id: string;
    type: 'active_file' | 'selection' | 'workspace_file';
    label: string;
    path: string;
    lineRange?: [number, number];
    content?: string;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

export interface FileChangeRecord {
    filePath: string;
    relativePath?: string;
    originalContent: string;
    modifiedContent: string;
    additions: number;
    deletions: number;
    hunks?: DiffHunk[];
}

export interface SessionMetadata {
    id: string;
    title: string;
    updatedAt: number;
    dateLabel: string;
}

export interface HistoricalMessage {
    role: 'user' | 'agent';
    text: string;
    timestamp?: number;
}

export type AgentStatus = 'idle' | 'thinking' | 'streaming' | 'executing_tool' | 'error';

// Messages sent from Webview to Extension Host
export type WebviewToHostMessage =
    | { command: 'ready' }
    | { command: 'send_prompt'; text: string; contextItems?: ContextItem[] }
    | { command: 'cancel_turn' }
    | { command: 'select_model'; modelId: string }
    | { command: 'select_effort'; effort: 'low' | 'medium' | 'high' }
    | { command: 'open_diff'; filePath: string }
    | { command: 'open_file'; filePath: string; line?: number }
    | { command: 'open_terminal' }
    | { command: 'open_settings' }
    | { command: 'pick_context_file' }
    | { command: 'clear_conversation' }
    | { command: 'get_sessions' }
    | { command: 'resume_session'; sessionId: string }
    | { command: 'new_session' };

// Messages sent from Extension Host to Webview
export type HostToWebviewMessage =
    | {
          command: 'init_state';
          models: ModelDescriptor[];
          currentModel: string;
          currentEffort: 'low' | 'medium' | 'high';
          quota?: QuotaData;
          conversationId?: string;
          activeContext?: ContextItem[];
      }
    | { command: 'status_change'; status: AgentStatus }
    | { command: 'turn_start'; prompt: string }
    | { command: 'text_delta'; delta: string }
    | { command: 'turn_complete'; status: 'SUCCESS' | 'ERROR'; usage?: TokenUsage; durationSeconds?: number }
    | {
          command: 'tool_event';
          toolName: string;
          state: 'ACTIVE' | 'DONE' | 'ERROR';
          toolInfo?: ToolInfo;
          durationSeconds?: number;
      }
    | { command: 'file_changed'; change: FileChangeRecord }
    | { command: 'quota_update'; quota: QuotaData }
    | { command: 'context_update'; items: ContextItem[] }
    | { command: 'session_list'; sessions: SessionMetadata[]; activeSessionId?: string }
    | { command: 'session_loaded'; sessionId: string; messages: HistoricalMessage[] }
    | { command: 'error'; message: string };
