import type { PaneStatus } from '@voltran/shared';
import type { ClaudeHookEvent, CodexHookEvent, OpencodeEvent } from './adapters.ts';

export interface StatusChange {
    status: PaneStatus;
    detail: string | null;
}

// Agents and hook payloads write these texts, and `voltran status` prints them to a terminal, where
// an escape sequence could hide or forge lines.
export const withoutControls = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

const oneLine = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const text = withoutControls(value.replace(/\s+/g, ' ')).trim();
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

export function codexTransition(
    event: CodexHookEvent,
    payload: Record<string, unknown>,
    current: PaneStatus,
): StatusChange | null {
    switch (event) {
        case 'SessionStart':
            return current === 'starting' ? { status: 'idle', detail: null } : null;
        case 'UserPromptSubmit':
            return { status: 'working', detail: oneLine(payload.prompt, 160) };
        case 'PreToolUse':
        case 'PostToolUse':
            return { status: 'working', detail: oneLine(payload.tool_name, 80) };
        case 'PermissionRequest': {
            const input =
                payload.tool_input && typeof payload.tool_input === 'object'
                    ? (payload.tool_input as Record<string, unknown>)
                    : {};
            const tool = oneLine(payload.tool_name, 40) ?? 'a tool';
            return { status: 'needs-input', detail: oneLine(input.description, 200) ?? `Allow ${tool}?` };
        }
        case 'Stop':
            return { status: 'done', detail: oneLine(payload.last_assistant_message, 280) };
        case 'Interrupt':
            return { status: 'idle', detail: null };
    }
}

// A subagent's permission prompt or question can be open next to the main session's, so the pane
// needs input until every one of them is answered.
const MAX_REQUEST_ID = 128;
const MAX_PENDING = 64;

export class OpencodeStatus {
    private readonly pending = new Map<string, string>();

    transition(event: OpencodeEvent, payload: Record<string, unknown>, current: PaneStatus): StatusChange | null {
        switch (event) {
            case 'Ready':
                return current === 'starting' ? { status: 'idle', detail: null } : null;
            case 'SessionCreated':
            case 'ToolEnd':
                return null;
            case 'PromptSubmit':
                return { status: 'working', detail: oneLine(payload.prompt, 160) };
            case 'TurnStart':
                return current === 'working' || current === 'needs-input' ? null : { status: 'working', detail: null };
            case 'ToolStart':
                return this.pending.size > 0 ? null : { status: 'working', detail: oneLine(payload.tool_name, 80) };
            case 'Permission': {
                const resources = Array.isArray(payload.resources)
                    ? payload.resources.filter((value) => typeof value === 'string').join(' ')
                    : '';
                const action = oneLine(payload.action, 40) ?? 'a tool';
                return this.ask(
                    payload.request_id,
                    oneLine(resources ? `Allow ${action}: ${resources}` : `Allow ${action}?`, 200) ?? '',
                );
            }
            case 'Question':
                return this.ask(payload.request_id, oneLine(payload.message, 200) ?? 'OpenCode has a question');
            case 'PermissionReplied':
            case 'QuestionAnswered': {
                if (
                    typeof payload.request_id !== 'string' ||
                    !this.pending.delete(payload.request_id) ||
                    current !== 'needs-input'
                ) {
                    return null;
                }
                const next = [...this.pending.values()][0];
                return next === undefined
                    ? { status: 'working', detail: null }
                    : { status: 'needs-input', detail: next };
            }
            case 'TurnEnd':
                this.pending.clear();
                if (payload.outcome === 'interrupted') {
                    return { status: 'idle', detail: null };
                }
                if (payload.outcome === 'failed') {
                    return {
                        status: 'done',
                        detail: oneLine(
                            `Failed: ${typeof payload.message === 'string' ? payload.message : 'unknown error'}`,
                            280,
                        ),
                    };
                }
                return { status: 'done', detail: oneLine(payload.message, 280) };
        }
    }

    reset(): void {
        this.pending.clear();
    }

    private ask(requestId: unknown, detail: string): StatusChange {
        if (typeof requestId === 'string' && requestId.length <= MAX_REQUEST_ID) {
            this.pending.set(requestId, detail);
            if (this.pending.size > MAX_PENDING) {
                this.pending.delete(this.pending.keys().next().value!);
            }
        }
        return { status: 'needs-input', detail };
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
