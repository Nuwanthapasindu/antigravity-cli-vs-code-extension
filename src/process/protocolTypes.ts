/**
 * Antigravity CLI stream-json and headless JSON protocol types.
 * Based on verified output from agy --input-format stream-json --output-format stream-json
 */

export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
}

export interface AgyInitEvent {
    event: 'init';
    conversation_id: string;
    init: {
        cwd: string;
        tools: string[];
        permission_mode: string;
    };
}

export type StepState = 'ACTIVE' | 'DONE' | 'ERROR';
export type StepType = 'user_input' | 'agent_response' | 'tool';

export interface ToolInfo {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
    error?: {
        type?: string;
        message?: string;
    };
}

export interface StepUpdateData {
    conversation_id: string;
    step_index: number;
    state: StepState;
    step_type: StepType;
    text_delta?: string;
    duration_seconds?: number;
    usage?: TokenUsage;
    tool_name?: string;
    tool_info?: ToolInfo;
}

export interface AgyStepUpdateEvent {
    event: 'step_update';
    step_update: StepUpdateData;
}

export interface AgyResultEvent {
    event: 'result';
    result: {
        conversation_id: string;
        status: 'SUCCESS' | 'ERROR';
        response: string;
        duration_seconds: number;
        num_turns: number;
        usage: TokenUsage;
        error?: string;
        denied_actions?: Array<{ action: string; display_name: string }>;
    };
}

export type AgyServerEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export interface StreamInputUserMessage {
    event: 'user';
    message: {
        content: string;
    };
}

export interface ModelDescriptor {
    id: string;
    label: string;
}

export interface EffortData {
    adjustable: boolean;
    current: 'low' | 'medium' | 'high';
    available: Array<'low' | 'medium' | 'high'>;
}

export interface QuotaBucket {
    id: string;
    name: string;
    description?: string;
    window: string;
    remaining_fraction: number;
    reset_time?: string;
}

export interface QuotaGroup {
    name: string;
    description?: string;
    buckets: QuotaBucket[];
}

export interface QuotaData {
    groups: QuotaGroup[];
}
