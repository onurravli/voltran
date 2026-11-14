import { describe, expect, it } from 'vitest';
import type { AdapterId, PaneView, Task } from '@voltran/shared';
import {
    conversationOf,
    exchangeSince,
    exchangeTasks,
    flowLinks,
    followDelegations,
    layoutFlow,
    participantsOf,
    summarize,
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
    it('puts each node a row below whatever points at it, centred under its parents', () => {
        const box = { width: 100, height: 50, gapX: 10, gapY: 20, pad: 0 };
        const links = [
            { from: 'lead', to: 'a', kind: 'delegates' as const, status: 'done' as const, titles: [] },
            { from: 'lead', to: 'b', kind: 'delegates' as const, status: 'done' as const, titles: [] },
            { from: 'lead', to: 'c', kind: 'delegates' as const, status: 'queued' as const, titles: [] },
            { from: 'a', to: 'c', kind: 'waits' as const, status: 'done' as const, titles: [] },
        ];
        const { at, width, height } = layoutFlow(['lead', 'a', 'b', 'c'], links, box);
        expect([width, height]).toEqual([210, 190]);
        expect(at.get('lead')).toEqual({ x: 55, y: 0, level: 0 });
        expect(at.get('a')).toEqual({ x: 0, y: 70, level: 1 });
        expect(at.get('b')).toEqual({ x: 110, y: 70, level: 1 });
        expect(at.get('c')).toEqual({ x: 55, y: 140, level: 2 });
    });

    it('leaves no empty row when nothing points at the first node of a cycle', () => {
        const box = { width: 100, height: 50, gapX: 10, gapY: 20, pad: 0 };
        const links = [
            { from: 'a', to: 'b', kind: 'delegates' as const, status: 'done' as const, titles: [] },
            { from: 'b', to: 'a', kind: 'delegates' as const, status: 'done' as const, titles: [] },
        ];
        const { at, width, height } = layoutFlow(['a', 'b'], links, box);
        expect([width, height]).toEqual([100, 120]);
        expect(at.get('b')).toEqual({ x: 0, y: 0, level: 0 });
        expect(at.get('a')).toEqual({ x: 0, y: 70, level: 1 });
    });
});
