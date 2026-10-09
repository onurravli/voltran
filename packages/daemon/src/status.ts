import type { PaneStatus } from '@voltran/shared';
import type { ClaudeHookEvent } from './adapters.ts';

export interface StatusChange {
    status: PaneStatus;
    detail: string | null;
}

const oneLine = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) {
        return null;
    }
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function claudeTransition(event: ClaudeHookEvent, payload: Record<string, unknown>): StatusChange | null {
    switch (event) {
        case 'SessionStart':
            return { status: 'idle', detail: null };
        case 'UserPromptSubmit':
            return { status: 'working', detail: oneLine(payload.prompt, 160) };
        case 'PreToolUse':
        case 'PostToolUse':
            return { status: 'working', detail: oneLine(payload.tool_name, 80) };
        case 'Notification': {
            const kind = payload.notification_type;
            if (kind === 'idle_prompt' || kind === 'auth_success') {
                return null;
            }
            return { status: 'needs-input', detail: oneLine(payload.message, 200) ?? 'Waiting for your input' };
        }
        case 'Stop':
            return { status: 'done', detail: oneLine(payload.last_assistant_message, 280) };
        case 'SubagentStart':
        case 'SubagentStop':
        case 'SessionEnd':
            return null;
    }
}

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC = /\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function visibleText(data: string): string {
    return data.replace(OSC, '').replace(CSI, '').replace(ESC, '').replace(CONTROL, '');
}

export function ringsBell(data: string): boolean {
    return data.replace(OSC, '').includes('\x07');
}

export interface ActivityOptions {
    quietMs: number;
    echoWindowMs: number;
    now?: () => number;
    onChange: (change: StatusChange) => void;
}

// Status for agent CLIs that expose no hooks: streaming output means working, a quiet period after
// work means the turn finished, a bell means the agent is asking for something.
export class ActivityTracker {
    private status: PaneStatus = 'idle';
    private lastInputAt = 0;
    private quietTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly options: ActivityOptions;
    private readonly now: () => number;

    constructor(options: ActivityOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }

    reset(status: PaneStatus): void {
        this.clearTimer();
        this.status = status;
    }

    input(): void {
        this.lastInputAt = this.now();
    }

    output(data: string): void {
        if (ringsBell(data)) {
            this.clearTimer();
            this.set({ status: 'needs-input', detail: 'Bell: the agent is asking for attention' });
            return;
        }
        if (this.now() - this.lastInputAt < this.options.echoWindowMs) {
            return;
        }
        if (visibleText(data).trim().length === 0) {
            return;
        }
        if (this.status !== 'working' && this.status !== 'starting') {
            this.set({ status: 'working', detail: null });
        }
        this.clearTimer();
        this.quietTimer = setTimeout(() => {
            this.quietTimer = null;
            if (this.status === 'working') {
                this.set({ status: 'done', detail: null });
            } else if (this.status === 'starting') {
                this.set({ status: 'idle', detail: null });
            }
        }, this.options.quietMs);
    }

    dispose(): void {
        this.clearTimer();
    }

    private set(change: StatusChange): void {
        this.status = change.status;
        this.options.onChange(change);
    }

    private clearTimer(): void {
        if (this.quietTimer) {
            clearTimeout(this.quietTimer);
            this.quietTimer = null;
        }
    }
}
