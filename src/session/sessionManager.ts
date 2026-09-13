import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { HistoricalMessage, SessionMetadata } from '../shared/messages';

export class SessionManager {
    private brainDir: string;

    constructor() {
        this.brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
    }

    /**
     * Lists recent conversations stored in ~/.gemini/antigravity-cli/brain/
     */
    public async listSessions(limit = 40): Promise<SessionMetadata[]> {
        if (!fs.existsSync(this.brainDir)) {
            return [];
        }

        try {
            const entries = fs.readdirSync(this.brainDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && d.name.length === 36); // UUID length

            const sessions: SessionMetadata[] = [];
            const now = Date.now();

            for (const entry of entries) {
                const transcriptPath = path.join(this.brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(transcriptPath)) {
                    try {
                        const stat = fs.statSync(transcriptPath);
                        const title = this.extractTitleFromTranscript(transcriptPath);

                        sessions.push({
                            id: entry.name,
                            title: title || 'Conversation',
                            updatedAt: stat.mtimeMs,
                            dateLabel: this.formatDateLabel(stat.mtimeMs, now),
                        });
                    } catch {
                        // Skip unreadable files
                    }
                }
            }

            // Sort newest first
            sessions.sort((a, b) => b.updatedAt - a.updatedAt);
            return sessions.slice(0, limit);
        } catch (err) {
            console.warn('Failed to list sessions from brain directory:', err);
            return [];
        }
    }

    /**
     * Reads and parses transcript.jsonl into chat turns
     */
    public async loadSessionTranscript(sessionId: string): Promise<HistoricalMessage[]> {
        const transcriptPath = path.join(this.brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptPath)) {
            return [];
        }

        const messages: HistoricalMessage[] = [];
        let currentAgentText = '';

        try {
            const fileStream = fs.createReadStream(transcriptPath);
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

            for await (const line of rl) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }

                try {
                    const entry = JSON.parse(trimmed);
                    if (entry.type === 'USER_INPUT') {
                        if (currentAgentText) {
                            messages.push({ role: 'agent', text: currentAgentText.trim() });
                            currentAgentText = '';
                        }
                        const rawContent = entry.content || '';
                        const cleanContent = this.cleanUserPrompt(rawContent);
                        if (cleanContent) {
                            messages.push({
                                role: 'user',
                                text: cleanContent,
                                timestamp: entry.created_at ? new Date(entry.created_at).getTime() : undefined,
                            });
                        }
                    } else if (entry.type === 'PLANNER_RESPONSE') {
                        if (typeof entry.content === 'string' && entry.content.trim()) {
                            currentAgentText = (currentAgentText ? currentAgentText + '\n\n' : '') + entry.content;
                        }
                    }
                } catch {
                    // Skip malformed JSONL line
                }
            }

            if (currentAgentText) {
                messages.push({ role: 'agent', text: currentAgentText.trim() });
            }
        } catch (err) {
            console.warn(`Failed to read transcript for session ${sessionId}:`, err);
        }

        return messages;
    }

    private extractTitleFromTranscript(transcriptPath: string): string {
        try {
            const fd = fs.openSync(transcriptPath, 'r');
            const buf = Buffer.alloc(8192);
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);

            const str = buf.toString('utf8', 0, bytesRead);
            const match = str.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (match) {
                let prompt = match[1]
                    .replace(/\\n/g, ' ')
                    .replace(/\\r/g, ' ')
                    .replace(/\\t/g, ' ')
                    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (prompt.length > 70) {
                    prompt = prompt.substring(0, 67) + '...';
                }
                if (prompt) {
                    return prompt;
                }
            }
        } catch {
            // Ignore
        }
        return 'Conversation';
    }

    private cleanUserPrompt(text: string): string {
        return text
            .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
            .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
            .replace(/<USER_REQUEST>\s*/g, '')
            .replace(/\s*<\/USER_REQUEST>/g, '')
            .trim();
    }

    private formatDateLabel(timestamp: number, now: number): string {
        const diffMs = now - timestamp;
        const diffHours = diffMs / (1000 * 60 * 60);

        if (diffHours < 24) {
            return 'Today';
        } else if (diffHours < 48) {
            return 'Yesterday';
        } else if (diffHours < 24 * 7) {
            return 'Previous 7 Days';
        } else {
            return 'Older';
        }
    }
}
