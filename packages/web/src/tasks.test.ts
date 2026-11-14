import { describe, expect, it } from 'vitest';
import { layoutTasks, type PaneView, type Task } from '@voltran/shared';
import {
    connect,
    edgePath,
    elapsed,
    parsePositions,
    storePositions,
    subagentRef,
    taskPhase,
    withSubagents,
} from './tasks.ts';

const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id,
    projectId: 'p',
    paneId: 'a',
    title: id,
    prompt: id,
    parentId: null,
    dependsOn: [],
    handoffFrom: null,
    status: 'queued',
    result: null,
    createdBy: null,
    position: 0,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    ...patch,
});

describe('taskPhase', () => {
    it('tells a blocked task from one that only waits its turn, and a question from work', () => {
        const done = task('done', { status: 'done' });
        const running = task('running', { status: 'running' });
        const byId = new Map([done, running].map((entry) => [entry.id, entry]));
        expect(taskPhase(task('x', { dependsOn: ['done'] }), byId)).toBe('queued');
        expect(taskPhase(task('x', { dependsOn: ['done', 'running'] }), byId)).toBe('blocked');
        expect(taskPhase(running, byId)).toBe('running');
        expect(taskPhase({ ...running, result: 'Go on?' }, byId)).toBe('asking');
    });
});

describe('layoutTasks', () => {
    it('places every task after what it waits for and its parent', () => {
        const graph = layoutTasks([
            task('a', { position: 0 }),
            task('b', { position: 1, paneId: 'b', dependsOn: ['a'] }),
            task('c', { position: 2, parentId: 'b' }),
            task('d', { position: 3, paneId: 'b' }),
        ]);
        const column = Object.fromEntries(graph.nodes.map((node) => [node.task.id, node.column]));
        expect(column).toEqual({ a: 0, b: 1, c: 2, d: 0 });
        expect(graph.columns).toBe(3);
        expect(graph.rows).toBe(2);
        expect(graph.edges).toEqual([
            { from: 'a', to: 'b', kind: 'dependency' },
            { from: 'b', to: 'c', kind: 'parent' },
        ]);
    });

    it('ignores edges to tasks that are gone', () => {
        expect(layoutTasks([task('a', { dependsOn: ['gone'] })]).edges).toEqual([]);
    });
});

describe('elapsed', () => {
    it('counts from the start to the end, or to now while it runs', () => {
        expect(elapsed(task('a'), 0)).toBeNull();
        expect(elapsed(task('a', { startedAt: 0, finishedAt: 42_000 }), 0)).toBe('42s');
        expect(elapsed(task('a', { startedAt: 0 }), 125_000)).toBe('2m 5s');
    });
});

describe('edgePath', () => {
    it('curves forward between columns', () => {
        expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 50 })).toBe('M 0 0 C 50 0, 50 50, 100 50');
    });
});

describe('connect', () => {
    const card = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

    it('joins facing sides, backwards and vertically too', () => {
        expect(connect(card(0, 0), card(200, 0))).toBe('M 100 20 C 150 20, 150 20, 200 20');
        expect(connect(card(200, 0), card(0, 0))).toBe('M 200 20 C 150 20, 150 20, 100 20');
        expect(connect(card(0, 0), card(0, 100))).toBe('M 50 40 C 50 70, 50 70, 50 100');
    });
});

describe('positions', () => {
    it('keeps each project apart and drops tasks that are gone', () => {
        const raw = storePositions(null, 'p', { a: { x: 10.4, y: 20 }, gone: { x: 1, y: 1 } }, new Set(['a']));
        const both = storePositions(raw, 'q', { b: { x: 5, y: 5 } }, new Set(['b']));
        expect(parsePositions(both, 'p')).toEqual({ a: { x: 10, y: 20 } });
        expect(parsePositions(both, 'q')).toEqual({ b: { x: 5, y: 5 } });
        expect(parsePositions(storePositions(both, 'p', {}, new Set()), 'p')).toEqual({});
    });

    it('reads broken storage as nothing moved', () => {
        expect(parsePositions('not json', 'p')).toEqual({});
        expect(parsePositions('{"p":{"a":[1,"x"],"b":[2,3]}}', 'p')).toEqual({ b: { x: 2, y: 3 } });
    });
});

describe('withSubagents', () => {
    it("shows a running task's subagents as its subtasks while they run", () => {
        const running = task('t', { status: 'running', paneId: 'a' });
        const pane = {
            id: 'a',
            subagents: [
                { id: 'x:1', type: 'Explore', description: 'find the parser', background: false, startedAt: 5 },
            ],
        } as unknown as PaneView;
        const shown = withSubagents([running, task('q', { paneId: 'a' })], new Map([['a', pane]]));
        expect(shown).toHaveLength(3);
        const node = shown[2];
        expect(node).toMatchObject({ parentId: 't', title: 'find the parser', status: 'running', startedAt: 5 });
        expect(subagentRef(node.id)).toEqual({ paneId: 'a', agentId: 'x:1' });
        expect(subagentRef('t')).toBeNull();
        expect(layoutTasks(shown).edges).toContainEqual({ from: 't', to: node.id, kind: 'parent' });
        expect(withSubagents([task('q', { paneId: 'a' })], new Map([['a', pane]]))).toHaveLength(1);
    });
});
