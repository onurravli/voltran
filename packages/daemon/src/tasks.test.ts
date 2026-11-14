import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaneStatus } from '@voltran/shared';
import { Store } from './store.ts';
import { asksUser, composePrompt, TaskBoard, type HandoffContext } from './tasks.ts';

class FakeRunner {
    statuses = new Map<string, PaneStatus>();
    alive = new Set<string>();
    woken: string[] = [];
    sent: { paneId: string; text: string }[] = [];

    status(paneId: string): PaneStatus | null {
        return this.statuses.get(paneId) ?? null;
    }

    running(paneId: string): boolean {
        return this.alive.has(paneId);
    }

    wake(paneId: string): void {
        this.woken.push(paneId);
    }

    submit(paneId: string, text: string): boolean {
        this.sent.push({ paneId, text });
        return true;
    }

    entered: string[] = [];
    quiet = new Map<string, number>();

    enter(paneId: string): void {
        this.entered.push(paneId);
    }

    quietFor(paneId: string): number {
        return this.quiet.get(paneId) ?? Number.POSITIVE_INFINITY;
    }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('TaskBoard', () => {
    let dir: string;
    let store: Store;
    let runner: FakeRunner;
    let board: TaskBoard;
    let handoffs: Map<string, HandoffContext>;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'voltran-tasks-'));
        store = new Store(join(dir, 'state.db'));
        store.insertProject({ id: 'p', name: 'p', path: dir, color: '#000000', createdAt: 1 });
        runner = new FakeRunner();
        handoffs = new Map();
        board = new TaskBoard({
            store,
            runner,
            onChange: () => undefined,
            handoff: (paneId) => handoffs.get(paneId) ?? null,
        });
        for (const pane of ['a', 'b']) {
            runner.alive.add(pane);
            runner.statuses.set(pane, 'idle');
        }
    });

    afterEach(() => {
        board.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });

    // The pane goes through a turn the way hooks report it.
    const turn = async (paneId: string, reply: string): Promise<void> => {
        runner.statuses.set(paneId, 'working');
        board.statusChanged(paneId, 'idle', 'working', null);
        board.reply(paneId, reply);
        runner.statuses.set(paneId, 'done');
        board.statusChanged(paneId, 'working', 'done', reply);
        await flush();
    };

    it("runs a pane's queue one task at a time, in order", async () => {
        const first = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        const second = board.create({ projectId: 'p', paneId: 'a', prompt: 'two' });
        await flush();
        expect(runner.sent).toEqual([{ paneId: 'a', text: 'one' }]);
        expect(board.get(first.id)?.status).toBe('running');
        expect(board.get(second.id)?.status).toBe('queued');

        await turn('a', 'did one');
        expect(board.get(first.id)).toMatchObject({ status: 'done', result: 'did one' });
        expect(runner.sent.map((entry) => entry.text)).toEqual(['one', 'two']);
    });

    it('waits for the agent to be ready, and wakes a pane whose process is not running', async () => {
        runner.statuses.set('a', 'working');
        board.create({ projectId: 'p', paneId: 'a', prompt: 'later' });
        runner.alive.delete('b');
        runner.statuses.set('b', 'suspended');
        board.create({ projectId: 'p', paneId: 'b', prompt: 'wake' });
        await flush();
        expect(runner.sent).toEqual([]);
        expect(runner.woken).toEqual(['b']);

        runner.statuses.set('a', 'done');
        board.statusChanged('a', 'working', 'done', null);
        await flush();
        expect(runner.sent).toEqual([{ paneId: 'a', text: 'later' }]);
    });

    it('types a prompt only once the pane has gone quiet, or after a cap', async () => {
        board.close();
        board = new TaskBoard({
            store,
            runner,
            onChange: () => undefined,
            handoff: () => null,
            timing: { settleMs: 30, settleCapMs: 150, confirmMs: 10_000 },
        });
        runner.quiet.set('a', 0);
        runner.quiet.set('b', 0);
        board.create({ projectId: 'p', paneId: 'a', prompt: 'quiet' });
        board.create({ projectId: 'p', paneId: 'b', prompt: 'busy' });
        await flush();
        expect(runner.sent).toEqual([]);
        runner.quiet.set('a', 40);
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(runner.sent).toEqual([{ paneId: 'a', text: 'quiet' }]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(runner.sent.map((entry) => entry.text)).toEqual(['quiet', 'busy']);
    });

    it('starts the settle wait over for a prompt queued after the last one was removed', async () => {
        board.close();
        board = new TaskBoard({
            store,
            runner,
            onChange: () => undefined,
            handoff: () => null,
            timing: { settleMs: 30, settleCapMs: 60, confirmMs: 10_000 },
        });
        runner.quiet.set('a', 0);
        const first = board.create({ projectId: 'p', paneId: 'a', prompt: 'first' });
        await flush();
        board.remove(first.id);
        await new Promise((resolve) => setTimeout(resolve, 80));
        board.create({ projectId: 'p', paneId: 'a', prompt: 'second' });
        await flush();
        expect(runner.sent).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(runner.sent).toEqual([{ paneId: 'a', text: 'second' }]);
    });

    it('presses Enter again, then types the prompt again, when the agent never starts on it', async () => {
        board.close();
        board = new TaskBoard({
            store,
            runner,
            onChange: () => undefined,
            handoff: () => null,
            timing: { settleMs: 0, confirmMs: 20 },
        });
        const lost = board.create({ projectId: 'p', paneId: 'a', prompt: 'lost' });
        const taken = board.create({ projectId: 'p', paneId: 'b', prompt: 'taken' });
        await flush();
        runner.statuses.set('b', 'working');
        board.statusChanged('b', 'idle', 'working', null);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(runner.entered).toEqual(['a']);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(runner.sent.map((entry) => entry.text)).toEqual(['lost', 'taken', 'lost']);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(runner.entered).toEqual(['a']);
        expect(runner.sent).toHaveLength(3);
        expect(board.get(lost.id)?.status).toBe('running');
        expect(board.get(taken.id)?.status).toBe('running');
    });

    it('starts a dependent task after the one it waits for, with that result in front', async () => {
        const research = board.create({ projectId: 'p', paneId: 'a', prompt: 'find the bug', title: 'Find' });
        const fix = board.create({ projectId: 'p', paneId: 'b', prompt: 'fix it', dependsOn: [research.id] });
        await flush();
        expect(runner.sent.map((entry) => entry.paneId)).toEqual(['a']);

        await turn('a', 'It is in parse().');
        expect(board.get(fix.id)?.status).toBe('running');
        expect(runner.sent[1].text).toBe(
            'Results of the tasks this one waited for:\n- Find:\nIt is in parse().\n\nYour task:\nfix it',
        );
    });

    it('fails what waits for a task that failed or was cancelled', async () => {
        runner.statuses.set('a', 'working');
        const first = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        const after = board.create({ projectId: 'p', paneId: 'b', prompt: 'two', dependsOn: [first.id] });
        board.act(first.id, 'cancel');
        await flush();
        expect(board.get(after.id)).toMatchObject({ status: 'failed' });
        expect(board.get(after.id)?.result).toContain('was cancelled');
    });

    it('keeps a task running when the turn ends with a question, until the next turn ends', async () => {
        const task = board.create({ projectId: 'p', paneId: 'a', prompt: 'refactor' });
        const next = board.create({ projectId: 'p', paneId: 'a', prompt: 'then this' });
        await flush();
        await turn('a', 'Should I also update the tests?');
        expect(board.get(task.id)).toMatchObject({ status: 'running', result: 'Should I also update the tests?' });
        expect(board.get(next.id)?.status).toBe('queued');

        await turn('a', 'Updated the tests too.');
        expect(board.get(task.id)).toMatchObject({ status: 'done', result: 'Updated the tests too.' });
        expect(board.get(next.id)?.status).toBe('running');
    });

    it('fails the running task when the agent exits, and cancels when the user interrupts', async () => {
        const one = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        const two = board.create({ projectId: 'p', paneId: 'b', prompt: 'two' });
        await flush();
        board.statusChanged('a', 'idle', 'exited', 'exit code 1');
        board.statusChanged('b', 'idle', 'working', null);
        board.statusChanged('b', 'working', 'idle', null);
        expect(board.get(one.id)).toMatchObject({ status: 'failed', result: 'exit code 1' });
        expect(board.get(two.id)?.status).toBe('cancelled');
    });

    it('does not end a task when the pane only went quiet for a while', async () => {
        const task = board.create({ projectId: 'p', paneId: 'a', prompt: 'long' });
        await flush();
        board.statusChanged('a', 'idle', 'working', null);
        board.statusChanged('a', 'working', 'idle', 'No activity, possibly interrupted');
        expect(board.get(task.id)?.status).toBe('running');
    });

    it('refuses dependencies that would loop or cross projects', () => {
        const one = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        expect(() => board.create({ projectId: 'p', paneId: 'a', prompt: 'x', dependsOn: ['missing'] })).toThrow(
            'same project',
        );
        expect(board.create({ projectId: 'p', paneId: 'b', prompt: 'two', dependsOn: [one.id] }).dependsOn).toEqual([
            one.id,
        ]);
    });

    it('fails tasks that were running when the daemon stopped', () => {
        const task = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        store.updateTask(task.id, { status: 'running' });
        const again = new TaskBoard({ store, runner, onChange: () => undefined, handoff: () => null });
        expect(again.get(task.id)?.status).toBe('failed');
        again.close();
    });

    it('cancels the queue of a closed pane', () => {
        runner.statuses.set('a', 'working');
        const task = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        board.paneRemoved('a');
        expect(board.get(task.id)).toMatchObject({ status: 'cancelled', result: 'Its pane was closed.' });
    });

    it('moves a queued task within its pane', () => {
        runner.statuses.set('a', 'working');
        const one = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        const two = board.create({ projectId: 'p', paneId: 'a', prompt: 'two' });
        board.move(two.id, one.id);
        const order = board
            .list()
            .filter((task) => task.paneId === 'a')
            .map((task) => task.prompt);
        expect(order).toEqual(['two', 'one']);
        board.act(one.id, 'cancel');
        expect(() => board.move(one.id, null)).toThrow('only a queued task can move');
    });

    it('rewires what a queued task waits for and whose subtask it is, refusing loops', () => {
        runner.statuses.set('a', 'working');
        runner.statuses.set('b', 'working');
        const one = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        const two = board.create({ projectId: 'p', paneId: 'b', prompt: 'two' });
        expect(board.link(two.id, { dependsOn: [one.id], parentId: one.id })).toMatchObject({
            dependsOn: [one.id],
            parentId: one.id,
        });
        expect(() => board.link(one.id, { dependsOn: [two.id] })).toThrow('wait for itself');
        expect(() => board.link(one.id, { parentId: one.id })).toThrow('wait for itself');
        expect(() => board.link(one.id, { dependsOn: ['missing'] })).toThrow('same project');
        board.remove(one.id);
        expect(board.get(two.id)).toMatchObject({ dependsOn: [], parentId: null });
        board.act(two.id, 'cancel');
        expect(() => board.link(two.id, { dependsOn: [] })).toThrow('only a queued task');
        expect(board.link(two.id, { parentId: null }).parentId).toBeNull();
    });

    it('keeps the pane last reply for a handoff when a finished task is deleted', async () => {
        const first = board.create({ projectId: 'p', paneId: 'a', prompt: 'one' });
        await flush();
        await turn('a', 'the parser is ported');
        board.remove(first.id);
        expect(board.lastReply('a')).toBe('the parser is ported');
    });
});

describe('composePrompt', () => {
    it('puts the handed-off context in front of the prompt', () => {
        const task = {
            id: 't',
            projectId: 'p',
            paneId: 'b',
            title: 't',
            prompt: 'continue',
            parentId: null,
            dependsOn: [],
            handoffFrom: 'a',
            status: 'queued' as const,
            result: null,
            createdBy: null,
            position: 0,
            createdAt: 0,
            startedAt: null,
            finishedAt: null,
        };
        expect(composePrompt(task, new Map(), { label: 'Claude', reply: 'half done', notes: '- step 2' })).toBe(
            'Context handed off from Claude:\n\nIts last reply:\nhalf done\n\nIts notes:\n- step 2\n\nYour task:\ncontinue',
        );
    });
});

describe('asksUser', () => {
    it('reads a reply that ends with a question as one', () => {
        expect(asksUser('Should I update the tests?')).toBe(true);
        expect(asksUser('Want me to go on? **')).toBe(true);
        expect(asksUser('Done. Is it fine? I fixed it.')).toBe(false);
        expect(asksUser(null)).toBe(false);
    });
});
