import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '@voltran/shared';
import { formatDuration, groupTurns, lineDiff } from './conversation.ts';

const ENTRIES: ConversationEntry[] = [
    { kind: 'notice', text: 'Conversation compacted', tone: 'info', at: 500 },
    { kind: 'prompt', text: 'Fix it', images: 0, at: 1000 },
    { kind: 'text', text: 'Looking.', model: 'claude-a', at: 1500 },
    { kind: 'tool', id: 't1', name: 'Read', summary: 'a.ts', detail: null, at: 2000 },
    { kind: 'tool', id: 't2', name: 'Grep', summary: 'x', detail: null, at: 2000 },
    { kind: 'result', toolUseId: 't1', text: 'code', error: false, at: 2500 },
    { kind: 'text', text: 'Done.', model: 'claude-b', at: 4000 },
    { kind: 'prompt', text: 'Thanks', images: 0, at: 9000 },
    { kind: 'tool', id: 't3', name: 'Bash', summary: 'ls', detail: null, at: 9500 },
];

describe('groupTurns', () => {
    it('starts a turn at each prompt and groups tool calls in a row with their results', () => {
        const turns = groupTurns(ENTRIES);
        expect(
            turns.map((turn) => [
                turn.key,
                turn.prompt?.text ?? null,
                turn.items.map((item) => item.kind),
                turn.model,
                turn.startedAt,
                turn.endedAt,
            ]),
        ).toEqual([
            ['turn-0', null, ['notice'], null, 500, 500],
            ['turn-1', 'Fix it', ['text', 'tools', 'text'], 'claude-b', 1000, 4000],
            ['turn-7', 'Thanks', ['tools'], null, 9000, 9500],
        ]);
        const tools = turns[1].items[1];
        expect(
            tools.kind === 'tools' && tools.tools.map(({ tool, result }) => [tool.id, result?.text ?? null]),
        ).toEqual([
            ['t1', 'code'],
            ['t2', null],
        ]);
    });
});

describe('formatDuration', () => {
    it('reads like a stopwatch', () => {
        expect([900, 9_340, 42_000, 121_000, 3_725_000].map(formatDuration)).toEqual([
            '0.9s',
            '9.3s',
            '42s',
            '2m 01s',
            '1h 02m',
        ]);
    });
});

describe('lineDiff', () => {
    it('keeps the lines both sides share', () => {
        expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
            { type: 'same', text: 'a' },
            { type: 'removed', text: 'b' },
            { type: 'added', text: 'B' },
            { type: 'same', text: 'c' },
            { type: 'added', text: 'd' },
        ]);
        expect(lineDiff('', 'new')).toEqual([{ type: 'added', text: 'new' }]);
    });

    it('shows a large change as removed and added lines', () => {
        const before = Array.from({ length: 600 }, (_, index) => `old ${index}`).join('\n');
        const after = Array.from({ length: 600 }, (_, index) => `new ${index}`).join('\n');
        const lines = lineDiff(before, after);
        expect(lines).toHaveLength(1200);
        expect(lines[0]).toEqual({ type: 'removed', text: 'old 0' });
        expect(lines[600]).toEqual({ type: 'added', text: 'new 0' });
    });
});
