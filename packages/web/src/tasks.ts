import type { AppState, PaneView, Task } from '@voltran/shared';
import { duration } from './agents.ts';

// What the graph shows for a task: a queued task is blocked while something it waits for is not done,
// and a running task whose turn ended with a question is asking the user.
export type TaskPhase = 'blocked' | 'queued' | 'running' | 'asking' | 'done' | 'failed' | 'cancelled';

export const PHASE_LABEL: Record<TaskPhase, string> = {
    blocked: 'Waiting',
    queued: 'Queued',
    running: 'Running',
    asking: 'Asking you',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
};

export function taskPhase(task: Task, byId: Map<string, Task>): TaskPhase {
    if (task.status === 'queued') {
        return task.dependsOn.some((id) => byId.has(id) && byId.get(id)?.status !== 'done') ? 'blocked' : 'queued';
    }
    if (task.status === 'running') {
        return task.result ? 'asking' : 'running';
    }
    return task.status;
}

export function elapsed(task: Task, now: number): string | null {
    return task.startedAt === null ? null : duration((task.finishedAt ?? now) - task.startedAt);
}

// The agent panes of a project that are not archived: the ones a task can go to.
export function agentPanes(app: AppState, projectId: string): PaneView[] {
    const kinds = new Map(app.adapters.map((adapter) => [adapter.id, adapter.kind]));
    const sessions = new Map(
        app.sessions
            .filter((session) => session.projectId === projectId && !session.archived)
            .map((session) => [session.id, session]),
    );
    return app.panes.filter((pane) => sessions.has(pane.sessionId) && kinds.get(pane.adapter) === 'agent');
}

export interface Point {
    x: number;
    y: number;
}

export interface Rect extends Point {
    width: number;
    height: number;
}

// A curve that leaves `from` and enters `to` along one axis, in the direction the target lies.
export function edgePath(from: Point, to: Point, axis: 'x' | 'y' = 'x'): string {
    const span = axis === 'x' ? to.x - from.x : to.y - from.y;
    const sign = span < 0 ? -1 : 1;
    const bend = sign * Math.max(24, Math.abs(span) / 2);
    const [bx, by] = axis === 'x' ? [bend, 0] : [0, bend];
    return `M ${from.x} ${from.y} C ${from.x + bx} ${from.y + by}, ${to.x - bx} ${to.y - by}, ${to.x} ${to.y}`;
}

// Joins two cards at the sides that face each other: left and right while they are further apart
// across than down, top and bottom otherwise.
export function connect(a: Rect, b: Rect): string {
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    const gapX = Math.abs(bx - ax) - (a.width + b.width) / 2;
    const gapY = Math.abs(by - ay) - (a.height + b.height) / 2;
    if (gapX >= gapY) {
        const right = bx >= ax;
        return edgePath({ x: right ? a.x + a.width : a.x, y: ay }, { x: right ? b.x : b.x + b.width, y: by }, 'x');
    }
    const down = by >= ay;
    return edgePath({ x: ax, y: down ? a.y + a.height : a.y }, { x: bx, y: down ? b.y : b.y + b.height }, 'y');
}

export type GraphPositions = Record<string, Point>;

// Where the user dragged a project's cards, from localStorage: { [projectId]: { [taskId]: [x, y] } }.
export function parsePositions(raw: string | null, projectId: string): GraphPositions {
    try {
        const all: unknown = JSON.parse(raw ?? '{}');
        const own = all && typeof all === 'object' ? (all as Record<string, unknown>)[projectId] : undefined;
        if (!own || typeof own !== 'object') {
            return {};
        }
        const positions: GraphPositions = {};
        for (const [id, value] of Object.entries(own)) {
            if (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n))) {
                positions[id] = { x: value[0], y: value[1] };
            }
        }
        return positions;
    } catch {
        return {};
    }
}

// The stored text with this project's positions replaced, keeping only tasks that still exist.
export function storePositions(
    raw: string | null,
    projectId: string,
    positions: GraphPositions,
    ids: Set<string>,
): string {
    let all: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(raw ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            all = parsed as Record<string, unknown>;
        }
    } catch {}
    const own = Object.fromEntries(
        Object.entries(positions)
            .filter(([id]) => ids.has(id))
            .map(([id, at]) => [id, [Math.round(at.x), Math.round(at.y)]]),
    );
    if (Object.keys(own).length === 0) {
        delete all[projectId];
    } else {
        all[projectId] = own;
    }
    return JSON.stringify(all);
}

const SUBAGENT_PREFIX = 'subagent:';

export interface SubagentRef {
    paneId: string;
    agentId: string;
}

export function subagentRef(id: string): SubagentRef | null {
    if (!id.startsWith(SUBAGENT_PREFIX)) {
        return null;
    }
    const rest = id.slice(SUBAGENT_PREFIX.length);
    const at = rest.indexOf(':');
    return at < 0 ? null : { paneId: rest.slice(0, at), agentId: rest.slice(at + 1) };
}

// The subagents a pane's agent runs while it works on a task show in the graph as that task's
// subtasks, for as long as they run.
export function withSubagents(tasks: Task[], panes: Map<string, PaneView>): Task[] {
    const extra = tasks
        .filter((task) => task.status === 'running')
        .flatMap((task) =>
            (panes.get(task.paneId)?.subagents ?? []).map(
                (agent): Task => ({
                    id: `${SUBAGENT_PREFIX}${task.paneId}:${agent.id}`,
                    projectId: task.projectId,
                    paneId: task.paneId,
                    title: agent.description || agent.type,
                    prompt: `${agent.type} subagent${agent.background ? ' in the background' : ''}: ${agent.description}`,
                    parentId: task.id,
                    dependsOn: [],
                    handoffFrom: null,
                    status: 'running',
                    result: null,
                    createdBy: task.paneId,
                    position: task.position,
                    createdAt: agent.startedAt,
                    startedAt: agent.startedAt,
                    finishedAt: null,
                }),
            ),
        );
    return extra.length === 0 ? tasks : [...tasks, ...extra];
}
