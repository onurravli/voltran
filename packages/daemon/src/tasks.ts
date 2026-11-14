import { randomUUID } from 'node:crypto';
import {
    isFinished,
    MAX_TASK_PROMPT,
    MAX_TASK_RESULT,
    taskTitle,
    wouldCycle,
    type PaneStatus,
    type Task,
    type TaskAction,
} from '@voltran/shared';
import type { Store, TaskPatch } from './store.ts';

export class TaskRefused extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export interface TaskRunner {
    status(paneId: string): PaneStatus | null;
    running(paneId: string): boolean;
    wake(paneId: string): void;
    submit(paneId: string, text: string): boolean;
}

export interface HandoffContext {
    label: string;
    reply: string | null;
    notes: string;
}

export interface TaskBoardOptions {
    store: Store;
    runner: TaskRunner;
    onChange: () => void;
    handoff: (paneId: string) => HandoffContext | null;
}

export interface NewTask {
    projectId: string;
    paneId: string;
    prompt: string;
    title?: string;
    parentId?: string | null;
    dependsOn?: string[];
    handoffFrom?: string | null;
    createdBy?: string | null;
}

interface Run {
    worked: boolean;
    // The turn ended with a question to the user, so the task waits for the answer and the turn after it.
    asked: boolean;
}

const READY: PaneStatus[] = ['idle', 'done'];
const CONTEXT_LIMIT = 4000;
const SILENCE_DETAIL = 'No activity, possibly interrupted';
const WAKE_RETRY_MS = 30_000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A reply that ends by asking something wants the user before the task is over.
export const asksUser = (reply: string | null): boolean => /\?\s*[*_`)"'»]*\s*$/.test(reply ?? '');

export function composePrompt(task: Task, tasks: Map<string, Task>, handoff: HandoffContext | null): string {
    const parts: string[] = [];
    if (handoff) {
        parts.push(
            [
                `Context handed off from ${handoff.label}:`,
                handoff.reply ? `Its last reply:\n${clip(handoff.reply, CONTEXT_LIMIT)}` : null,
                handoff.notes.trim() ? `Its notes:\n${clip(handoff.notes.trim(), CONTEXT_LIMIT)}` : null,
            ]
                .filter(Boolean)
                .join('\n\n'),
        );
    }
    const results = task.dependsOn
        .map((id) => tasks.get(id))
        .filter((dep): dep is Task => dep?.status === 'done' && Boolean(dep.result));
    if (results.length > 0) {
        parts.push(
            [
                'Results of the tasks this one waited for:',
                ...results.map((dep) => `- ${dep.title}:\n${clip(dep.result ?? '', CONTEXT_LIMIT)}`),
            ].join('\n'),
        );
    }
    parts.push(parts.length > 0 ? `Your task:\n${task.prompt}` : task.prompt);
    return parts.join('\n\n');
}

// Runs each agent pane's queue in order: the first queued task whose dependencies are all done goes in
// once the agent is ready, and its turn's end finishes it.
export class TaskBoard {
    private readonly options: TaskBoardOptions;
    private readonly runs = new Map<string, Run>();
    private readonly replies = new Map<string, string>();
    private readonly woken = new Map<string, number>();
    private tickTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: TaskBoardOptions) {
        this.options = options;
        for (const task of options.store.listTasks()) {
            if (task.status === 'running') {
                this.patch(task.id, {
                    status: 'failed',
                    result: 'Voltran restarted while this task ran. Retry it to run it again.',
                    finishedAt: Date.now(),
                });
            }
        }
    }

    list(): Task[] {
        return this.options.store.listTasks();
    }

    create(spec: NewTask): Task {
        const prompt = spec.prompt.trim();
        if (!prompt) {
            throw new TaskRefused(400, 'prompt is required');
        }
        if (prompt.length > MAX_TASK_PROMPT) {
            throw new TaskRefused(400, `prompt must be at most ${MAX_TASK_PROMPT} characters`);
        }
        const dependsOn = [...new Set(spec.dependsOn ?? [])];
        const parentId = spec.parentId ?? null;
        const tasks = this.check(spec.projectId, dependsOn, parentId);
        const id = randomUUID();
        if (wouldCycle(tasks, id, dependsOn, parentId)) {
            throw new TaskRefused(400, 'these dependencies would make the task wait for itself');
        }
        const task: Task = {
            id,
            projectId: spec.projectId,
            paneId: spec.paneId,
            title: spec.title?.trim() ? clip(spec.title.trim(), 200) : taskTitle(prompt),
            prompt,
            parentId,
            dependsOn,
            handoffFrom: spec.handoffFrom ?? null,
            status: 'queued',
            result: null,
            createdBy: spec.createdBy ?? null,
            position: this.options.store.nextTaskPosition(),
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
        };
        this.options.store.insertTask(task);
        this.changed();
        return task;
    }

    check(projectId: string, dependsOn: string[], parentId: string | null): Task[] {
        const tasks = this.list();
        const inProject = new Set(tasks.filter((task) => task.projectId === projectId).map((task) => task.id));
        if (dependsOn.some((id) => !inProject.has(id))) {
            throw new TaskRefused(400, 'a task can only wait for tasks of the same project');
        }
        if (parentId && !inProject.has(parentId)) {
            throw new TaskRefused(400, 'the parent task must belong to the same project');
        }
        return tasks;
    }

    get(id: string): Task | null {
        return this.options.store.getTask(id);
    }

    act(id: string, action: TaskAction): Task {
        const task = this.mustGet(id);
        if (action === 'cancel') {
            if (isFinished(task.status)) {
                throw new TaskRefused(409, 'the task has already finished');
            }
            this.finish(task, 'cancelled', task.status === 'running' ? 'Cancelled while it ran.' : null);
        } else if (action === 'complete') {
            if (task.status !== 'running') {
                throw new TaskRefused(409, 'only a running task can be marked done');
            }
            this.finish(task, 'done', this.replies.get(task.paneId) ?? task.result);
        } else {
            if (!isFinished(task.status) || task.status === 'done') {
                throw new TaskRefused(409, 'only a failed or cancelled task can be retried');
            }
            this.patch(id, { status: 'queued', result: null, startedAt: null, finishedAt: null });
        }
        return this.mustGet(id);
    }

    edit(id: string, patch: { title?: string; prompt?: string }): Task {
        const task = this.mustGet(id);
        if (task.status !== 'queued' && patch.prompt !== undefined) {
            throw new TaskRefused(409, 'only a queued task can change its prompt');
        }
        this.patch(id, {
            ...(patch.title !== undefined ? { title: clip(patch.title.trim(), 200) || task.title } : {}),
            ...(patch.prompt !== undefined
                ? { prompt: clip(patch.prompt.trim(), MAX_TASK_PROMPT) || task.prompt }
                : {}),
        });
        return this.mustGet(id);
    }

    // Rewires the graph: what a queued task waits for, and which task any task is a subtask of.
    link(id: string, patch: { dependsOn?: string[]; parentId?: string | null }): Task {
        const task = this.mustGet(id);
        if (patch.dependsOn !== undefined && task.status !== 'queued') {
            throw new TaskRefused(409, 'only a queued task can change what it waits for');
        }
        const dependsOn = patch.dependsOn === undefined ? task.dependsOn : [...new Set(patch.dependsOn)];
        const kept = task.parentId && this.get(task.parentId) ? task.parentId : null;
        const parentId = patch.parentId === undefined ? kept : patch.parentId;
        const tasks = this.check(task.projectId, dependsOn, parentId);
        if (wouldCycle(tasks, id, dependsOn, parentId)) {
            throw new TaskRefused(400, 'these links would make the task wait for itself');
        }
        this.patch(id, { dependsOn, parentId });
        return this.mustGet(id);
    }

    // Puts a queued task before another task of the same pane, or at the end of its queue.
    move(id: string, before: string | null): Task {
        const task = this.mustGet(id);
        if (task.status !== 'queued') {
            throw new TaskRefused(409, 'only a queued task can move');
        }
        const queue = this.list()
            .filter((entry) => entry.paneId === task.paneId && entry.status === 'queued' && entry.id !== id)
            .sort((a, b) => a.position - b.position);
        const at = before === null ? queue.length : queue.findIndex((entry) => entry.id === before);
        if (at < 0) {
            throw new TaskRefused(400, 'moveBefore must be a queued task of the same pane, or null for the end');
        }
        const positions = queue.map((entry) => entry.position);
        queue.splice(at, 0, task);
        positions.push(task.position);
        positions.sort((a, b) => a - b);
        queue.forEach((entry, index) => {
            if (entry.position !== positions[index]) {
                this.options.store.updateTask(entry.id, { position: positions[index] });
            }
        });
        this.changed();
        return this.mustGet(id);
    }

    remove(id: string): void {
        this.mustGet(id);
        this.runs.delete(id);
        this.options.store.deleteTask(id);
        for (const other of this.list()) {
            if (other.dependsOn.includes(id) || other.parentId === id) {
                this.options.store.updateTask(other.id, {
                    dependsOn: other.dependsOn.filter((dep) => dep !== id),
                    parentId: other.parentId === id ? null : other.parentId,
                });
            }
        }
        this.changed();
    }

    clearFinished(projectId: string): void {
        const tasks = this.list();
        const finished = tasks.filter((task) => task.projectId === projectId && isFinished(task.status));
        const kept = new Set(tasks.filter((task) => !isFinished(task.status)).flatMap((task) => task.dependsOn));
        for (const task of finished) {
            if (!kept.has(task.id)) {
                this.options.store.deleteTask(task.id);
            }
        }
        this.changed();
    }

    // A closed pane cannot run its queue; what waited for it fails on the next tick.
    paneRemoved(paneId: string): void {
        for (const task of this.list()) {
            if (task.paneId === paneId && !isFinished(task.status)) {
                this.finish(task, 'cancelled', 'Its pane was closed.');
            }
        }
        this.replies.delete(paneId);
    }

    runningOn(paneId: string): Task | null {
        return this.list().find((task) => task.paneId === paneId && task.status === 'running') ?? null;
    }

    // The agent's last reply of a turn, which hooks carry in full, unlike the pane's one-line detail.
    reply(paneId: string, text: unknown): void {
        if (typeof text === 'string' && text.trim()) {
            this.replies.set(paneId, clip(text.trim(), MAX_TASK_RESULT));
        }
    }

    lastReply(paneId: string): string | null {
        return this.replies.get(paneId) ?? null;
    }

    // Hooks report the reply right after the status change they cause, so the end of a turn is
    // handled once the hook has been read through.
    statusChanged(paneId: string, previous: PaneStatus, status: PaneStatus, detail: string | null): void {
        const task = this.runningOn(paneId);
        const run = task ? this.runs.get(task.id) : undefined;
        if (task && run) {
            if (status === 'working') {
                run.worked = true;
            } else if (status === 'exited') {
                this.finish(task, 'failed', detail ?? 'The agent exited.');
            } else if (status === 'done' && run.worked) {
                setImmediate(() => this.turnEnded(task.id, detail));
            } else if (status === 'idle' && run.worked && previous === 'working' && detail !== SILENCE_DETAIL) {
                this.finish(task, 'cancelled', 'Interrupted in the pane.');
            }
        }
        if (READY.includes(status) || status === 'exited') {
            this.schedule();
        }
    }

    private turnEnded(id: string, detail: string | null): void {
        const task = this.get(id);
        const run = this.runs.get(id);
        if (task?.status !== 'running' || !run) {
            return;
        }
        const reply = this.replies.get(task.paneId) ?? detail;
        if (/^Failed: /.test(detail ?? '')) {
            this.finish(task, 'failed', reply);
        } else if (asksUser(reply) && !run.asked) {
            run.asked = true;
            run.worked = false;
            this.patch(id, { result: reply });
        } else {
            this.finish(task, 'done', reply);
        }
    }

    schedule(): void {
        if (this.tickTimer) {
            return;
        }
        this.tickTimer = setTimeout(() => {
            this.tickTimer = null;
            this.tick();
        }, 0);
    }

    tick(): void {
        const tasks = this.list();
        const byId = new Map(tasks.map((task) => [task.id, task]));
        for (const task of tasks) {
            if (task.status !== 'queued') {
                continue;
            }
            const broken = task.dependsOn
                .map((id) => byId.get(id))
                .find((dep) => dep && (dep.status === 'failed' || dep.status === 'cancelled'));
            if (broken) {
                this.finish(
                    task,
                    'failed',
                    `It waited for "${broken.title}", which ${broken.status === 'failed' ? 'failed' : 'was cancelled'}.`,
                );
                byId.set(task.id, this.mustGet(task.id));
            }
        }
        const busy = new Set([...byId.values()].filter((task) => task.status === 'running').map((task) => task.paneId));
        const next = new Map<string, Task>();
        for (const task of [...byId.values()].sort((a, b) => a.position - b.position)) {
            if (task.status !== 'queued' || busy.has(task.paneId) || next.has(task.paneId)) {
                continue;
            }
            if (task.dependsOn.every((id) => byId.get(id)?.status === 'done' || !byId.has(id))) {
                next.set(task.paneId, task);
            }
        }
        const { runner } = this.options;
        for (const [paneId, task] of next) {
            if (!runner.running(paneId)) {
                const at = this.woken.get(paneId);
                if (at !== undefined && Date.now() - at < WAKE_RETRY_MS) {
                    if (runner.status(paneId) === 'exited') {
                        this.woken.delete(paneId);
                        this.finish(task, 'failed', 'The agent did not start in its pane.');
                    }
                    continue;
                }
                this.woken.set(paneId, Date.now());
                runner.wake(paneId);
                continue;
            }
            this.woken.delete(paneId);
            if (!READY.includes(runner.status(paneId) ?? 'exited')) {
                continue;
            }
            const handoff = task.handoffFrom ? this.options.handoff(task.handoffFrom) : null;
            if (!runner.submit(paneId, composePrompt(task, byId, handoff))) {
                continue;
            }
            this.replies.delete(paneId);
            this.runs.set(task.id, { worked: false, asked: false });
            this.patch(task.id, { status: 'running', startedAt: Date.now(), result: null });
        }
    }

    close(): void {
        if (this.tickTimer) {
            clearTimeout(this.tickTimer);
            this.tickTimer = null;
        }
    }

    private finish(task: Task, status: 'done' | 'failed' | 'cancelled', result: string | null): void {
        this.runs.delete(task.id);
        this.patch(task.id, {
            status,
            result: result ? clip(result, MAX_TASK_RESULT) : null,
            finishedAt: Date.now(),
        });
        this.schedule();
    }

    private patch(id: string, patch: TaskPatch): void {
        this.options.store.updateTask(id, patch);
        this.changed();
    }

    private changed(): void {
        this.options.onChange();
        this.schedule();
    }

    private mustGet(id: string): Task {
        const task = this.get(id);
        if (!task) {
            throw new TaskRefused(404, 'task not found');
        }
        return task;
    }
}
