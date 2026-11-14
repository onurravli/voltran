import { describe, expect, it } from 'vitest';
import type { AdapterId, ConversationEntry, PaneView, Task } from '@voltran/shared';
import {
    activityOf,
    conversationOf,
    exchangeSince,
    exchangeTasks,
    flowLinks,
    followDelegations,
    layoutFlow,
    mergeThread,
    participantsOf,
    summarize,
    wire,
} from './agents.ts';

let clock = 1000;

function task(fields: Partial<Task> & { id: string }): Task {
    clock += 10;
    return {
        projectId: 'p1',
        paneId: 'a',
        title: fields.id,
        prompt: `do ${fields.id}`,
        parentId: null,
        dependsOn: [],
        handoffFrom: null,
        status: 'queued',
        result: null,
        createdBy: null,
        position: clock,
        createdAt: clock,
        startedAt: null,
        finishedAt: null,
        ...fields,
    };
}

const pane = (id: string, adapter: AdapterId): PaneView => ({ id, adapter, title: `${adapter} pane` }) as PaneView;

describe('followDelegations', () => {
    it('marks what exists at the first state as seen without opening', () => {
        const old = task({ id: 'old', createdBy: 'lead' });
        const result = followDelegations(null, null, [old], true);
        expect(result.exchange).toBeNull();
        expect([...result.seen]).toEqual(['old']);
    });

    it('opens when an agent delegates, and not when the user queues a task', () => {
        const seen = new Set<string>();
        const mine = task({ id: 'mine' });
        expect(followDelegations(null, seen, [mine], true).exchange).toBeNull();
        const delegated = task({ id: 'delegated', createdBy: 'lead', paneId: 'b' });
        expect(followDelegations(null, seen, [delegated], true).exchange).toEqual({
            projectId: 'p1',
            since: delegated.createdAt,
            open: true,
            finished: false,
        });
    });

    it('stays shut while the setting is off', () => {
        const delegated = task({ id: 'd', createdBy: 'lead' });
        expect(followDelegations(null, new Set(), [delegated], false).exchange).toBeNull();
    });

    it('keeps an exchange going, opens it again for more delegations and for the summary once every task has finished', () => {
        const first = task({ id: 'one', createdBy: 'lead', paneId: 'b', status: 'running' });
        let state = followDelegations(null, new Set(), [first], true);
        state = { ...state, exchange: { ...state.exchange!, open: false } };
        const second = task({ id: 'two', createdBy: 'lead', paneId: 'c' });
        state = followDelegations(state.exchange, state.seen, [first, second], true);
        expect(state.exchange).toMatchObject({ since: first.createdAt, open: true, finished: false });
        state = { ...state, exchange: { ...state.exchange!, open: false } };
        const done = [
            { ...first, status: 'done' as const },
            { ...second, status: 'failed' as const },
        ];
        state = followDelegations(state.exchange, state.seen, done, true);
        expect(state.exchange).toMatchObject({ open: true, finished: true });
        const later = task({ id: 'three', createdBy: 'lead', paneId: 'b' });
        state = followDelegations(state.exchange, state.seen, [...done, later], true);
        expect(state.exchange).toMatchObject({ since: later.createdAt, finished: false, open: true });
    });
});

describe('followDelegations, after the start', () => {
    it('goes back to unfinished when a finished task is retried', () => {
        const one = task({ id: 'one', createdBy: 'lead', paneId: 'b', status: 'failed' });
        const exchange = { projectId: 'p1', since: one.createdAt, open: true, finished: true };
        const state = followDelegations(exchange, new Set(['one']), [{ ...one, status: 'queued' }], true);
        expect(state.exchange).toMatchObject({ finished: false, open: true });
    });

    it('opens a closed exchange again when its agents delegate more', () => {
        const one = task({ id: 'one', createdBy: 'lead', paneId: 'b', status: 'running' });
        const exchange = { projectId: 'p1', since: one.createdAt, open: false, finished: false };
        const two = task({ id: 'two', createdBy: 'lead', paneId: 'c' });
        const state = followDelegations(exchange, new Set(['one']), [one, two], true);
        expect(state.exchange).toEqual({ ...exchange, open: true });
    });

    it('lets go of an exchange whose tasks were all removed', () => {
        const exchange = { projectId: 'p1', since: 0, open: true, finished: false };
        const elsewhere = task({ id: 'x', projectId: 'p2', createdBy: 'lead' });
        const state = followDelegations(exchange, new Set(), [elsewhere], true);
        expect(state.exchange).toMatchObject({ projectId: 'p2', since: elsewhere.createdAt, open: true });
    });

    it('fills a view opened by hand with the next delegation even while the setting is off', () => {
        const exchange = { projectId: 'p1', since: Number.MAX_SAFE_INTEGER, open: true, finished: false };
        const delegated = task({ id: 'd', createdBy: 'lead', paneId: 'b' });
        const state = followDelegations(exchange, new Set(), [delegated], false);
        expect(state.exchange).toMatchObject({ since: delegated.createdAt, open: true });
    });
});

describe('exchangeSince', () => {
    it('starts at the oldest unfinished task', () => {
        const old = task({ id: 'old', status: 'done' });
        const open = task({ id: 'open', status: 'running' });
        expect(exchangeSince([old, open, task({ id: 'later' })], 'p1')).toBe(open.createdAt);
        expect(old.createdAt).toBeLessThan(open.createdAt);
    });

    it('otherwise takes the work around the last delegation', () => {
        const early = task({ id: 'early', status: 'done', createdBy: 'lead' });
        const root = task({ id: 'root', status: 'done' });
        const child = task({ id: 'child', status: 'done', parentId: 'root', createdBy: 'a' });
        const grandchild = task({ id: 'grand', status: 'done', parentId: 'child', createdBy: 'b' });
        expect(exchangeSince([early, root, child, grandchild], 'p1')).toBe(root.createdAt);
    });

    it('shows nothing for a project where no agent delegated', () => {
        expect(exchangeSince([task({ id: 'mine', status: 'done' })], 'p1')).toBe(Number.MAX_SAFE_INTEGER);
    });
});

describe('exchangeTasks', () => {
    it('takes the tasks since the start and what they wait for or belong to', () => {
        const parent = task({ id: 'parent' });
        const before = task({ id: 'before' });
        const unrelated = task({ id: 'unrelated' });
        const child = task({ id: 'child', parentId: parent.id, dependsOn: [before.id], createdBy: 'a' });
        const other = task({ id: 'other', projectId: 'p2' });
        const picked = exchangeTasks([parent, before, unrelated, child, other], {
            projectId: 'p1',
            since: child.createdAt,
        });
        expect(picked.map((entry) => entry.id)).toEqual(['parent', 'before', 'child']);
    });
});

describe('participantsOf', () => {
    it('lists the giver before the taker and numbers agents of the same kind', () => {
        const tasks = [task({ id: 'x', paneId: 'c1', createdBy: 'lead' }), task({ id: 'y', paneId: 'c2' })];
        const panes = new Map([
            ['lead', pane('lead', 'claude')],
            ['c1', pane('c1', 'codex')],
            ['c2', pane('c2', 'codex')],
        ]);
        const labels = new Map<AdapterId, string>([
            ['claude', 'Claude Code'],
            ['codex', 'Codex'],
        ]);
        expect(participantsOf(tasks, panes, labels).map((who) => who.name)).toEqual([
            'Claude Code',
            'Codex',
            'You',
            'Codex 2',
        ]);
    });
});

describe('conversationOf', () => {
    it('turns each task into a message out and its reply back, in time order', () => {
        const ask = task({ id: 'ask', paneId: 'b', createdBy: 'a' });
        const done = {
            ...ask,
            status: 'done' as const,
            startedAt: ask.createdAt + 1,
            finishedAt: ask.createdAt + 5,
            result: 'All good',
        };
        const lines = conversationOf([done]);
        expect(
            lines.map((line) => (line.type === 'message' ? `${line.kind}:${line.from}>${line.to}` : line.type)),
        ).toEqual(['ask:a>b', 'started', 'reply:b>a']);
    });

    it('shows a running task that asked something as a question', () => {
        const asking = task({ id: 'q', status: 'running', createdAt: 1, startedAt: 5, result: 'Which one?' });
        const kinds = conversationOf([asking]).flatMap((line) => (line.type === 'message' ? [line.kind] : []));
        expect(kinds).toEqual(['ask', 'question']);
    });
});

describe('summarize', () => {
    it('counts outcomes and time per agent', () => {
        const tasks = [
            task({ id: 'a1', paneId: 'a', status: 'done', createdAt: 0, startedAt: 0, finishedAt: 4000 }),
            task({ id: 'b1', paneId: 'b', status: 'failed', createdAt: 0, startedAt: 1000, finishedAt: 9000 }),
        ];
        const summary = summarize(tasks, 20_000);
        expect(summary).toMatchObject({ tasks: 2, done: 1, failed: 1, running: 0, spanMs: 9000 });
        expect(summary.agents).toEqual([
            { participant: 'a', tasks: 1, done: 1, failed: 0, busyMs: 4000 },
            { participant: 'b', tasks: 1, done: 0, failed: 1, busyMs: 8000 },
        ]);
    });
});

describe('flowLinks', () => {
    it('draws delegations, waits on results and running subagents once per pair', () => {
        const one = task({ id: 'one', paneId: 'codex', createdBy: 'lead', status: 'done' });
        const two = task({ id: 'two', paneId: 'helper', createdBy: 'lead', status: 'running' });
        const three = task({ id: 'three', paneId: 'helper', createdBy: 'lead' });
        const last = task({ id: 'last', paneId: 'writer', createdBy: 'lead', dependsOn: ['one', 'two'] });
        const helper = {
            ...pane('helper', 'claude'),
            subagents: [{ id: 's1', type: 'Explore', description: 'look', background: false, startedAt: 0 }],
        };
        const links = flowLinks([one, two, three, last], new Map([['helper', helper]]));
        expect(links.map((link) => `${link.kind}:${link.from}>${link.to}:${link.status}`)).toEqual([
            'delegates:lead>codex:done',
            'delegates:lead>helper:running',
            'delegates:lead>writer:queued',
            'waits:codex>writer:done',
            'waits:helper>writer:queued',
            'runs:helper>subagent:helper:s1:running',
        ]);
    });
});

describe('flowLinks, more', () => {
    it('hangs the subagents of an agent that only delegates under it', () => {
        const one = task({ id: 'one', paneId: 'codex', createdBy: 'lead' });
        const lead = {
            ...pane('lead', 'claude'),
            subagents: [{ id: 's1', type: 'Explore', description: '', background: false, startedAt: 0 }],
        };
        const links = flowLinks([one], new Map([['lead', lead]]));
        expect(links.map((link) => `${link.kind}:${link.from}>${link.to}`)).toContain('runs:lead>subagent:lead:s1');
    });

    it('marks a wait on a failed task as failed', () => {
        const one = task({ id: 'one', paneId: 'a', status: 'failed' });
        const two = task({ id: 'two', paneId: 'b', dependsOn: ['one'], status: 'failed' });
        const waits = flowLinks([one, two], new Map()).find((link) => link.kind === 'waits');
        expect(waits?.status).toBe('failed');
    });
});

describe('layoutFlow', () => {
    const box = { size: 100, subSize: 40, label: 30, gapX: 60, gapY: 20, subGap: 20, pad: 0 };
    const link = (from: string, to: string, kind: 'delegates' | 'waits' | 'runs' = 'delegates') => ({
        from,
        to,
        kind,
        status: 'done' as const,
        titles: [],
    });

    it('puts each agent a column right of whatever points at it, columns centred', () => {
        const links = [link('lead', 'a'), link('lead', 'b'), link('lead', 'c'), link('a', 'c', 'waits')];
        const { at, width, height } = layoutFlow(['lead', 'a', 'b', 'c'], links, box);
        expect([width, height]).toEqual([420, 280]);
        expect(at.get('lead')).toEqual({ x: 0, y: 75, level: 0 });
        expect(at.get('a')).toEqual({ x: 160, y: 0, level: 1 });
        expect(at.get('b')).toEqual({ x: 160, y: 150, level: 1 });
        expect(at.get('c')).toEqual({ x: 320, y: 75, level: 2 });
    });

    it('hangs subagents in a row under their agent, outside the columns', () => {
        const links = [link('lead', 'a'), link('a', 's1', 'runs'), link('a', 's2', 'runs')];
        const { at, width } = layoutFlow(['lead', 'a', 's1', 's2'], links, box);
        expect(width).toBe(260);
        expect(at.get('a')).toEqual({ x: 160, y: 0, level: 1 });
        expect(at.get('s1')).toEqual({ x: 158, y: 150, level: 1 });
        expect(at.get('s2')).toEqual({ x: 222, y: 150, level: 1 });
    });

    it('leaves no empty column when nothing points at the first node of a cycle', () => {
        const { at, width } = layoutFlow(['a', 'b'], [link('a', 'b'), link('b', 'a')], box);
        expect(width).toBe(260);
        expect(at.get('b')).toMatchObject({ x: 0, level: 0 });
        expect(at.get('a')).toMatchObject({ x: 160, level: 1 });
    });
});

describe('activityOf', () => {
    it("keeps an agent's thinking, its own words and its tools since it joined, without the replies shown already", () => {
        const entries: ConversationEntry[] = [
            { kind: 'text', text: 'before the exchange', model: null, at: 10 },
            { kind: 'prompt', text: 'the task', images: 0, at: 100 },
            { kind: 'thinking', text: 'Let me look at the script.', at: 101 },
            { kind: 'tool', id: 't1', name: 'Read', summary: 'task.sh', detail: null, at: 102 },
            { kind: 'result', toolUseId: 't1', text: 'ok', error: false, at: null },
            { kind: 'result', toolUseId: 't2', text: 'No such file\nmore', error: true, at: null },
            { kind: 'thinking', text: '  ', at: 103 },
            { kind: 'text', text: 'Checking the guide next.', model: null, at: 104 },
            { kind: 'text', text: 'The final reply, in full.', model: null, at: 105 },
        ];
        const activity = activityOf(entries, 100, ['The final reply…']);
        expect(activity.map((item) => `${item.kind}@${item.at}:${item.text}`)).toEqual([
            'thinking@101:Let me look at the script.',
            'tool@102:Read task.sh',
            'error@102:No such file',
            'text@104:Checking the guide next.',
        ]);
    });
});

describe('mergeThread', () => {
    it('puts activity between the messages by time, a message first at the same moment', () => {
        const ask = task({ id: 'm', paneId: 'b', createdBy: 'a', createdAt: 100 });
        const lines = conversationOf([{ ...ask, status: 'done', startedAt: 100, finishedAt: 300, result: 'done' }]);
        const merged = mergeThread(lines, [
            { key: '1', kind: 'tool', text: 'Read x', at: 100 },
            { key: '2', kind: 'thinking', text: 'hm', at: 200 },
        ]);
        expect(merged.map((item) => (item.type === 'line' ? item.line.type : item.activity.kind))).toEqual([
            'message',
            'started',
            'tool',
            'thinking',
            'message',
        ]);
    });
});

describe('wire', () => {
    const box = { size: 100, subSize: 40 };

    it('runs from the right handle to the left one, and from the bottom to a subagent', () => {
        expect(wire({ x: 0, y: 0 }, { x: 300, y: 100 }, box, 'delegates')).toEqual({
            path: 'M 100 50 C 200 50, 200 150, 300 150',
            end: { x: 300, y: 150 },
        });
        expect(wire({ x: 0, y: 0 }, { x: 30, y: 160 }, box, 'runs')).toEqual({
            path: 'M 50 100 C 50 130, 50 130, 50 160',
            end: { x: 50, y: 160 },
        });
    });
});
