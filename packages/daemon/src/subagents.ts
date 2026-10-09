import type { SubagentView } from '@voltran/shared';
import type { ClaudeHookEvent } from './adapters.ts';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MAX_PENDING = 32;
const MAX_RUNNING = 64;
const MAX_FINISHED = 32;
const FINISHED_TTL_MS = 10 * 60_000;
const MAX_TEXT = 120;

export interface SubagentLocation {
    transcriptPath: string | null;
    description: string | null;
    type: string | null;
}

export type LocateSubagent = (payload: Record<string, unknown>, agentId: string) => SubagentLocation | null;

export interface SubagentTranscript {
    path: string | null;
    description: string;
    finished: boolean;
}

interface Pending {
    toolUseId: string | null;
    type: string;
    description: string;
    background: boolean;
}

interface Running extends SubagentView {
    toolUseId: string | null;
    transcriptPath: string | null;
}

interface Finished {
    transcriptPath: string | null;
    description: string;
    endedAt: number;
}

const text = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) {
        return null;
    }
    return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
};

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Claude Code reports a subagent's id on SubagentStart but its description only on the Agent tool
// call before it, so starts are paired with queued calls of the same type and corrected once
// PostToolUse links the tool call to the agent id.
export class SubagentTracker {
    private pending: Pending[] = [];
    private running = new Map<string, Running>();
    private finished = new Map<string, Finished>();
    private readonly locate: LocateSubagent | null;

    constructor(locate: LocateSubagent | null = null) {
        this.locate = locate;
    }

    list(): SubagentView[] {
        return [...this.running.values()]
            .map(({ id, type, description, background, startedAt }) => ({ id, type, description, background, startedAt }))
            .sort((a, b) => a.startedAt - b.startedAt);
    }

    clear(now = Date.now()): boolean {
        const changed = this.running.size > 0;
        this.pending = [];
        for (const id of [...this.running.keys()]) {
            this.finish(id, now);
        }
        return changed;
    }

    transcript(agentId: string, now: number): SubagentTranscript | null {
        const running = this.running.get(agentId);
        if (running) {
            return { path: running.transcriptPath, description: running.description, finished: false };
        }
        this.prune(now);
        const finished = this.finished.get(agentId);
        return finished ? { path: finished.transcriptPath, description: finished.description, finished: true } : null;
    }

    isFollowing(transcriptPath: string): boolean {
        return [...this.running.values()].some((entry) => entry.transcriptPath === transcriptPath);
    }

    runningTranscripts(): Map<string, string> {
        const paths = new Map<string, string>();
        for (const entry of this.running.values()) {
            if (entry.transcriptPath) {
                paths.set(entry.id, entry.transcriptPath);
            }
        }
        return paths;
    }

    handle(event: ClaudeHookEvent, payload: Record<string, unknown>, now: number): boolean {
        switch (event) {
            case 'PreToolUse':
                return this.queue(payload);
            case 'SubagentStart':
                return this.start(payload, now);
            case 'PostToolUse':
                return this.launched(payload, now);
            case 'SubagentStop':
                return this.stop(payload, now);
            case 'Stop':
                return this.reconcile(payload, now);
            case 'UserPromptSubmit':
                this.pending = [];
                return false;
            case 'SessionStart':
            case 'SessionEnd':
                return this.clear(now);
            default:
                return false;
        }
    }

    private queue(payload: Record<string, unknown>): boolean {
        if (!AGENT_TOOLS.has(String(payload.tool_name))) {
            return false;
        }
        const input = record(payload.tool_input);
        const type = text(input.subagent_type) ?? 'general-purpose';
        this.pending.push({
            toolUseId: text(payload.tool_use_id),
            type,
            description: text(input.description) ?? type,
            background: input.run_in_background === true,
        });
        if (this.pending.length > MAX_PENDING) {
            this.pending.shift();
        }
        return false;
    }

    private start(payload: Record<string, unknown>, now: number): boolean {
        const id = text(payload.agent_id);
        if (!id || this.running.has(id)) {
            return false;
        }
        const reported = text(payload.agent_type) ?? 'agent';
        const located = this.locate?.(payload, id) ?? null;
        const type = text(located?.type) ?? reported;
        const index = this.pending.findIndex((entry) => entry.type === type);
        const [match] = index >= 0 ? this.pending.splice(index, 1) : [];
        return this.add({
            id,
            type,
            description: text(located?.description) ?? match?.description ?? type,
            background: match?.background ?? false,
            startedAt: now,
            toolUseId: match?.toolUseId ?? null,
            transcriptPath: located?.transcriptPath ?? null,
        });
    }

    private launched(payload: Record<string, unknown>, now: number): boolean {
        if (!AGENT_TOOLS.has(String(payload.tool_name))) {
            return false;
        }
        const toolUseId = text(payload.tool_use_id);
        const input = record(payload.tool_input);
        const response = record(payload.tool_response);
        const id = text(response.agentId);
        this.pending = this.pending.filter((entry) => toolUseId === null || entry.toolUseId !== toolUseId);
        if (!id) {
            return false;
        }
        if (response.status !== 'async_launched') {
            return this.finish(id, now);
        }
        const existing = this.running.get(id);
        const type = text(input.subagent_type) ?? existing?.type ?? 'general-purpose';
        return this.add({
            id,
            type,
            description: text(input.description) ?? text(response.description) ?? type,
            background: true,
            startedAt: existing?.startedAt ?? now,
            toolUseId,
            transcriptPath: existing?.transcriptPath ?? this.locate?.(payload, id)?.transcriptPath ?? null,
        });
    }

    private stop(payload: Record<string, unknown>, now: number): boolean {
        const id = text(payload.agent_id);
        return id !== null && this.finish(id, now);
    }

    private reconcile(payload: Record<string, unknown>, now: number): boolean {
        this.pending = [];
        let changed = false;
        const tasks = Array.isArray(payload.background_tasks) ? payload.background_tasks.map(record) : null;
        const live = new Map<string, Record<string, unknown>>();
        for (const task of tasks ?? []) {
            const id = text(task.id);
            if (id && task.type === 'subagent' && task.status === 'running') {
                live.set(id, task);
            }
        }
        for (const [id, entry] of [...this.running]) {
            if (!entry.background || (tasks !== null && !live.has(id))) {
                changed = this.finish(id, now) || changed;
            }
        }
        for (const [id, task] of live) {
            if (!this.running.has(id)) {
                changed = this.add({
                    id,
                    type: 'agent',
                    description: text(task.description) ?? 'Background agent',
                    background: true,
                    startedAt: now,
                    toolUseId: null,
                    transcriptPath: null,
                }) || changed;
            }
        }
        return changed;
    }

    private finish(id: string, now: number): boolean {
        const entry = this.running.get(id);
        if (!entry) {
            return false;
        }
        this.running.delete(id);
        this.finished.set(id, { transcriptPath: entry.transcriptPath, description: entry.description, endedAt: now });
        this.prune(now);
        return true;
    }

    private prune(now: number): void {
        for (const [id, entry] of this.finished) {
            if (now - entry.endedAt > FINISHED_TTL_MS || this.finished.size > MAX_FINISHED) {
                this.finished.delete(id);
            }
        }
    }

    private add(entry: Running): boolean {
        const previous = this.running.get(entry.id);
        if (!previous && this.running.size >= MAX_RUNNING) {
            return false;
        }
        this.running.set(entry.id, entry);
        return !previous
            || previous.description !== entry.description
            || previous.background !== entry.background
            || previous.type !== entry.type;
    }
}
