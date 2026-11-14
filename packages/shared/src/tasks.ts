import type { AdapterId } from './types.ts';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

// A prompt that waits in an agent pane's queue. The daemon types it into the pane once the agent is
// ready and every task in `dependsOn` is done, and keeps the agent's last reply as `result`.
// `handoffFrom` names a pane whose last reply, notes and finished tasks go in front of the prompt.
export interface Task {
    id: string;
    projectId: string;
    paneId: string;
    title: string;
    prompt: string;
    parentId: string | null;
    dependsOn: string[];
    handoffFrom: string | null;
    status: TaskStatus;
    result: string | null;
    // The pane whose agent created the task; null when the user did.
    createdBy: string | null;
    position: number;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
}

// One task per pane in `paneIds` (a broadcast when there are several), or one for a new pane of
// `adapter` in `sessionId`.
export interface CreateTaskBody {
    prompt: string;
    title?: string;
    paneIds?: string[];
    adapter?: AdapterId;
    sessionId?: string;
    parentId?: string | null;
    dependsOn?: string[];
    handoffFrom?: string | null;
}

export type TaskAction = 'cancel' | 'retry' | 'complete';

export interface UpdateTaskBody {
    action?: TaskAction;
    title?: string;
    prompt?: string;
    moveBefore?: string | null;
    dependsOn?: string[];
    parentId?: string | null;
}

export const MAX_TASK_PROMPT = 20_000;
export const MAX_TASK_RESULT = 8000;
export const MAX_BROADCAST = 16;
export const DELEGATE_ADAPTERS: AdapterId[] = ['claude', 'codex', 'opencode'];

export const isFinished = (status: TaskStatus): boolean =>
    status === 'done' || status === 'failed' || status === 'cancelled';

export function taskTitle(prompt: string, max = 80): string {
    const line = prompt.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// What a queued task still waits for: the tasks it depends on that are not done yet.
export function waitingOn(task: Task, byId: Map<string, Task>): Task[] {
    return task.dependsOn
        .map((id) => byId.get(id))
        .filter((dep): dep is Task => dep !== undefined && dep.status !== 'done');
}

// The edges that would make `from` depend on itself, through dependencies or parents.
export function wouldCycle(tasks: Task[], from: string, dependsOn: string[], parentId: string | null): boolean {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const seen = new Set<string>();
    const stack = [...dependsOn, ...(parentId ? [parentId] : [])];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === from) {
            return true;
        }
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        const task = byId.get(id);
        if (task) {
            stack.push(...task.dependsOn, ...(task.parentId ? [task.parentId] : []));
        }
    }
    return false;
}

export interface GraphNode {
    task: Task;
    column: number;
    row: number;
}

export interface GraphEdge {
    from: string;
    to: string;
    kind: 'dependency' | 'parent';
}

export interface TaskGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    columns: number;
    rows: number;
}

// Columns follow the longest chain of dependencies and parents that leads to a task, so every edge
// points to the right; rows keep each column in queue order, grouped by pane.
export function layoutTasks(tasks: Task[]): TaskGraph {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const before = (task: Task): string[] =>
        [...task.dependsOn, ...(task.parentId ? [task.parentId] : [])].filter((id) => byId.has(id));
    const columns = new Map<string, number>();
    const visiting = new Set<string>();
    const columnOf = (task: Task): number => {
        const known = columns.get(task.id);
        if (known !== undefined) {
            return known;
        }
        if (visiting.has(task.id)) {
            return 0;
        }
        visiting.add(task.id);
        const column = Math.max(-1, ...before(task).map((id) => columnOf(byId.get(id)!))) + 1;
        visiting.delete(task.id);
        columns.set(task.id, column);
        return column;
    };
    const ordered = [...tasks].sort(
        (a, b) => a.paneId.localeCompare(b.paneId) || a.position - b.position || a.createdAt - b.createdAt,
    );
    const rowsUsed = new Map<number, number>();
    const nodes = ordered.map((task) => {
        const column = columnOf(task);
        const row = rowsUsed.get(column) ?? 0;
        rowsUsed.set(column, row + 1);
        return { task, column, row };
    });
    const edges: GraphEdge[] = tasks.flatMap((task) => [
        ...task.dependsOn
            .filter((id) => byId.has(id))
            .map((id): GraphEdge => ({ from: id, to: task.id, kind: 'dependency' })),
        ...(task.parentId && byId.has(task.parentId) && !task.dependsOn.includes(task.parentId)
            ? [{ from: task.parentId, to: task.id, kind: 'parent' } as GraphEdge]
            : []),
    ]);
    return {
        nodes,
        edges,
        columns: nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => node.column)) + 1,
        rows: Math.max(0, ...rowsUsed.values()),
    };
}
