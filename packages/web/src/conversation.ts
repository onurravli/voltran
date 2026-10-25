import type { ConversationEntry } from '@voltran/shared';

type Entry<K extends ConversationEntry['kind']> = Extract<ConversationEntry, { kind: K }>;

export type ConversationItem =
    | { kind: 'text'; entry: Entry<'text'> }
    | { kind: 'thinking'; entry: Entry<'thinking'> }
    | { kind: 'notice'; entry: Entry<'notice'> }
    | { kind: 'tools'; tools: { tool: Entry<'tool'>; result: Entry<'result'> | null }[] };

export interface Turn {
    key: string;
    prompt: Entry<'prompt'> | null;
    items: ConversationItem[];
    model: string | null;
    startedAt: number | null;
    endedAt: number | null;
}

// Each prompt starts a turn. Tool calls in a row become one group, and each call is paired with its
// result, which arrives as a later entry.
export function groupTurns(entries: ConversationEntry[]): Turn[] {
    const results = new Map<string, Entry<'result'>>();
    for (const entry of entries) {
        if (entry.kind === 'result' && entry.toolUseId) {
            results.set(entry.toolUseId, entry);
        }
    }
    const turns: Turn[] = [];
    let turn: Turn | null = null;
    entries.forEach((entry, index) => {
        if (entry.kind === 'prompt' || !turn) {
            turn = { key: `turn-${index}`, prompt: null, items: [], model: null, startedAt: entry.at, endedAt: entry.at };
            turns.push(turn);
            if (entry.kind === 'prompt') {
                turn.prompt = entry;
                return;
            }
        }
        if (entry.at !== null) {
            turn.startedAt ??= entry.at;
            turn.endedAt = entry.at;
        }
        if (entry.kind === 'result') {
            return;
        }
        if (entry.kind === 'tool') {
            const last = turn.items.at(-1);
            const pair = { tool: entry, result: results.get(entry.id) ?? null };
            if (last?.kind === 'tools') {
                last.tools.push(pair);
            } else {
                turn.items.push({ kind: 'tools', tools: [pair] });
            }
            return;
        }
        if (entry.kind === 'text') {
            turn.model = entry.model ?? turn.model;
        }
        turn.items.push({ kind: entry.kind, entry } as ConversationItem);
    });
    return turns;
}

export function formatDuration(ms: number): string {
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    }
    const seconds = Math.round(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m ${rest}s`;
}

export interface DiffLine {
    type: 'same' | 'removed' | 'added';
    text: string;
}

const MAX_DIFF_CELLS = 250_000;

// A line diff by longest common subsequence. Past a size where that gets slow, the old lines are
// shown removed and the new ones added.
export function lineDiff(before: string, after: string): DiffLine[] {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    if (a.length * b.length > MAX_DIFF_CELLS) {
        return [...a.map((text) => ({ type: 'removed' as const, text })), ...b.map((text) => ({ type: 'added' as const, text }))];
    }
    const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
    }
    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            lines.push({ type: 'same', text: a[i] });
            i += 1;
            j += 1;
        } else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
            lines.push({ type: 'removed', text: a[i] });
            i += 1;
        } else {
            lines.push({ type: 'added', text: b[j] });
            j += 1;
        }
    }
    return lines;
}
