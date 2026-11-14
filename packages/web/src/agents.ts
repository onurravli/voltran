import { type AdapterId, isFinished, type PaneView, type Task } from '@voltran/shared';

export interface AgentsExchange {
    projectId: string;
    since: number;
    open: boolean;
    finished: boolean;
}

export const YOU = 'you';

export function exchangeTasks(tasks: Task[], exchange: Pick<AgentsExchange, 'projectId' | 'since'>): Task[] {
    const own = tasks.filter((task) => task.projectId === exchange.projectId);
    const byId = new Map(own.map((task) => [task.id, task]));
    const picked = new Set<string>();
    const stack = own.filter((task) => task.createdAt >= exchange.since).map((task) => task.id);
    while (stack.length > 0) {
        const id = stack.pop()!;
        const task = byId.get(id);
        if (!task || picked.has(id)) {
            continue;
        }
        picked.add(id);
        stack.push(...task.dependsOn, ...(task.parentId ? [task.parentId] : []));
    }
    return own.filter((task) => picked.has(task.id)).sort((a, b) => a.createdAt - b.createdAt);
}

export const exchangeFinished = (tasks: Task[]): boolean =>
    tasks.length > 0 && tasks.every((t) => isFinished(t.status));

const exchangeLive = (tasks: Task[]): boolean => tasks.some((task) => !isFinished(task.status));

export function exchangeSince(tasks: Task[], projectId: string): number {
    const own = tasks.filter((task) => task.projectId === projectId);
    const open = own.filter((task) => !isFinished(task.status));
    if (open.length > 0) {
        return Math.min(...open.map((task) => task.createdAt));
    }
    const delegated = own.filter((task) => task.createdBy !== null);
    if (delegated.length === 0) {
        return Number.MAX_SAFE_INTEGER;
    }
    const byId = new Map(own.map((task) => [task.id, task]));
    const root = (task: Task): string => {
        let current = task;
        const visited = new Set<string>();
        while (current.parentId && byId.has(current.parentId) && !visited.has(current.id)) {
            visited.add(current.id);
            current = byId.get(current.parentId)!;
        }
        return current.id;
    };
    const last = delegated.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const group = root(last);
    return Math.min(...own.filter((task) => root(task) === group).map((task) => task.createdAt));
}

// The first state only marks what already exists as seen, so a reload never opens the view for old work.
export function followDelegations(
    exchange: AgentsExchange | null,
    seen: Set<string> | null,
    tasks: Task[],
    enabled: boolean,
): { exchange: AgentsExchange | null; seen: Set<string> } {
    const ids = new Set(tasks.map((task) => task.id));
    if (seen === null) {
        return { exchange, seen: ids };
    }
    let next = exchange;
    const fresh = tasks
        .filter((task) => !seen.has(task.id) && task.createdBy !== null)
        .sort((a, b) => a.createdAt - b.createdAt);
    if (fresh.length > 0) {
        const first = fresh[0];
        const known = tasks.filter((task) => seen.has(task.id));
        const ongoing = next !== null && exchangeLive(exchangeTasks(known, next));
        const sameProject = next?.projectId === first.projectId;
        if (next && ongoing && sameProject) {
            next = enabled && !next.open ? { ...next, open: true } : next;
        } else if (enabled ? !(ongoing && next?.open) : next?.open && sameProject) {
            next = { projectId: first.projectId, since: first.createdAt, open: true, finished: false };
        }
    }
    if (next) {
        const finished = exchangeFinished(exchangeTasks(tasks, next));
        if (finished !== next.finished) {
            next = { ...next, finished, open: next.open || (finished && enabled) };
        }
    }
    return { exchange: next, seen: ids };
}

export interface Participant {
    id: string;
    pane: PaneView | null;
    name: string;
    adapter: AdapterId | null;
    color: string;
}

const COLORS = [
    'var(--finished)',
    'var(--working)',
    'var(--live)',
    'var(--signal)',
    'var(--syntax-type)',
    'var(--syntax-tag)',
    'var(--syntax-keyword)',
    'var(--syntax-string)',
];

export function participantsOf(
    tasks: Task[],
    panes: Map<string, PaneView>,
    labels: Map<AdapterId, string>,
): Participant[] {
    const order: string[] = [];
    for (const task of tasks) {
        for (const id of [task.createdBy ?? YOU, task.paneId]) {
            if (!order.includes(id)) {
                order.push(id);
            }
        }
    }
    const counts = new Map<string, number>();
    let agents = 0;
    return order.map((id) => {
        if (id === YOU) {
            return { id, pane: null, name: 'You', adapter: null, color: 'var(--text-muted)' };
        }
        const pane = panes.get(id) ?? null;
        const label = pane ? (labels.get(pane.adapter) ?? pane.title) : 'Closed pane';
        const count = (counts.get(label) ?? 0) + 1;
        counts.set(label, count);
        const color = COLORS[agents % COLORS.length];
        agents += 1;
        return { id, pane, name: count > 1 ? `${label} ${count}` : label, adapter: pane?.adapter ?? null, color };
    });
}

export type MessageKind = 'ask' | 'question' | 'reply' | 'failed' | 'cancelled';

export type ExchangeLine =
    | {
          type: 'message';
          key: string;
          kind: MessageKind;
          task: Task;
          from: string;
          to: string;
          at: number;
          text: string;
          waitsFor: string[];
      }
    | { type: 'started'; key: string; task: Task; who: string; at: number };

const NO_REPLY: Record<'reply' | 'failed' | 'cancelled', string> = {
    reply: 'Done, without a reply.',
    failed: 'Failed, without a reason.',
    cancelled: 'Cancelled.',
};

export function conversationOf(tasks: Task[]): ExchangeLine[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const lines: ExchangeLine[] = [];
    for (const task of tasks) {
        const giver = task.createdBy ?? YOU;
        lines.push({
            type: 'message',
            key: `${task.id}:ask`,
            kind: 'ask',
            task,
            from: giver,
            to: task.paneId,
            at: task.createdAt,
            text: task.prompt,
            waitsFor: task.dependsOn.map((id) => byId.get(id)?.title ?? 'a removed task'),
        });
        if (task.startedAt !== null) {
            lines.push({ type: 'started', key: `${task.id}:start`, task, who: task.paneId, at: task.startedAt });
        }
        const kind: MessageKind | null =
            task.status === 'running' && task.result
                ? 'question'
                : task.status === 'done'
                  ? 'reply'
                  : task.status === 'failed' || task.status === 'cancelled'
                    ? task.status
                    : null;
        if (kind) {
            lines.push({
                type: 'message',
                key: `${task.id}:${kind}`,
                kind,
                task,
                from: task.paneId,
                to: giver,
                at: task.finishedAt ?? task.startedAt ?? task.createdAt,
                text: task.result ?? (kind === 'question' ? '' : NO_REPLY[kind]),
                waitsFor: [],
            });
        }
    }
    return lines
        .map((line, index) => ({ line, index }))
        .sort((a, b) => a.line.at - b.line.at || a.index - b.index)
        .map(({ line }) => line);
}

export interface AgentTally {
    participant: string;
    tasks: number;
    done: number;
    failed: number;
    busyMs: number;
}

export interface ExchangeSummary {
    tasks: number;
    done: number;
    failed: number;
    cancelled: number;
    running: number;
    spanMs: number;
    agents: AgentTally[];
}

export function summarize(tasks: Task[], now: number): ExchangeSummary {
    const agents = new Map<string, AgentTally>();
    for (const task of tasks) {
        const tally = agents.get(task.paneId) ?? { participant: task.paneId, tasks: 0, done: 0, failed: 0, busyMs: 0 };
        tally.tasks += 1;
        tally.done += task.status === 'done' ? 1 : 0;
        tally.failed += task.status === 'failed' ? 1 : 0;
        tally.busyMs += task.startedAt === null ? 0 : (task.finishedAt ?? now) - task.startedAt;
        agents.set(task.paneId, tally);
    }
    const start = Math.min(...tasks.map((task) => task.createdAt));
    const end = tasks.every((task) => isFinished(task.status))
        ? Math.max(...tasks.map((task) => task.finishedAt ?? task.createdAt))
        : now;
    const count = (status: Task['status']): number => tasks.filter((task) => task.status === status).length;
    return {
        tasks: tasks.length,
        done: count('done'),
        failed: count('failed'),
        cancelled: count('cancelled'),
        running: count('running') + count('queued'),
        spanMs: tasks.length === 0 ? 0 : Math.max(0, end - start),
        agents: [...agents.values()],
    };
}

export function duration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type FlowLinkKind = 'delegates' | 'waits' | 'runs';

export interface FlowLink {
    from: string;
    to: string;
    kind: FlowLinkKind;
    status: Task['status'];
    titles: string[];
}

const STATUS_WEIGHT: Record<Task['status'], number> = { running: 4, queued: 3, failed: 2, cancelled: 1, done: 0 };

export const subagentNodeId = (paneId: string, agentId: string): string => `subagent:${paneId}:${agentId}`;

export function flowLinks(tasks: Task[], panes: Map<string, PaneView>): FlowLink[] {
    const links = new Map<string, FlowLink>();
    const add = (from: string, to: string, kind: FlowLinkKind, status: Task['status'], title: string): void => {
        if (from === to) {
            return;
        }
        const key = `${kind}:${from}:${to}`;
        const link = links.get(key);
        if (!link) {
            links.set(key, { from, to, kind, status, titles: [title] });
            return;
        }
        link.titles.push(title);
        if (STATUS_WEIGHT[status] > STATUS_WEIGHT[link.status]) {
            link.status = status;
        }
    };
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
        add(task.createdBy ?? YOU, task.paneId, 'delegates', task.status, task.title);
    }
    for (const task of tasks) {
        for (const id of task.dependsOn) {
            const dep = byId.get(id);
            if (dep && !links.has(`delegates:${dep.paneId}:${task.paneId}`)) {
                const state = dep.status === 'running' ? 'queued' : dep.status;
                add(dep.paneId, task.paneId, 'waits', state, dep.title);
            }
        }
    }
    const agents = new Set(tasks.flatMap((task) => [task.paneId, ...(task.createdBy ? [task.createdBy] : [])]));
    for (const id of agents) {
        for (const agent of panes.get(id)?.subagents ?? []) {
            add(id, subagentNodeId(id, agent.id), 'runs', 'running', agent.description || agent.type);
        }
    }
    return [...links.values()];
}

export interface FlowBox {
    width: number;
    height: number;
    gapX: number;
    gapY: number;
    pad: number;
}

export interface FlowLayout {
    at: Map<string, { x: number; y: number; level: number }>;
    width: number;
    height: number;
}

export function layoutFlow(ids: string[], links: FlowLink[], box: FlowBox): FlowLayout {
    const known = new Set(ids);
    const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const link of links) {
        if (known.has(link.from) && known.has(link.to)) {
            parents.get(link.to)!.push(link.from);
        }
    }
    const levels = new Map<string, number>();
    const visiting = new Set<string>();
    const levelOf = (id: string): number => {
        const level = levels.get(id);
        if (level !== undefined) {
            return level;
        }
        if (visiting.has(id)) {
            return 0;
        }
        visiting.add(id);
        const own = Math.max(-1, ...parents.get(id)!.map(levelOf)) + 1;
        visiting.delete(id);
        levels.set(id, own);
        return own;
    };
    const sparse: string[][] = [];
    for (const id of ids) {
        const level = levelOf(id);
        sparse[level] = [...(sparse[level] ?? []), id];
    }
    const rows = Array.from(sparse, (row) => row ?? []).filter((row) => row.length > 0);
    const slot = new Map<string, number>();
    const at = new Map<string, { x: number; y: number; level: number }>();
    const widest = Math.max(0, ...rows.map((row) => row.length));
    const width = box.pad * 2 + widest * box.width + Math.max(0, widest - 1) * box.gapX;
    rows.forEach((row, level) => {
        const centre = (id: string): number => {
            const placed = parents.get(id)!.filter((parent) => slot.has(parent));
            return placed.length === 0
                ? Number.POSITIVE_INFINITY
                : placed.reduce((sum, parent) => sum + slot.get(parent)!, 0) / placed.length;
        };
        const ordered = row
            .map((id, index) => ({ id, index, centre: centre(id) }))
            .sort((a, b) => a.centre - b.centre || a.index - b.index);
        const span = ordered.length * box.width + Math.max(0, ordered.length - 1) * box.gapX;
        const left = (width - span) / 2;
        ordered.forEach(({ id }, index) => {
            const x = left + index * (box.width + box.gapX);
            slot.set(id, x + box.width / 2);
            at.set(id, { x, y: box.pad + level * (box.height + box.gapY), level });
        });
    });
    const height = box.pad * 2 + rows.length * box.height + Math.max(0, rows.length - 1) * box.gapY;
    return { at, width, height: rows.length === 0 ? 0 : height };
}

export function elbow(
    from: { x: number; y: number },
    to: { x: number; y: number },
    box: Pick<FlowBox, 'width' | 'height' | 'gapY'>,
    lane = 0,
): string {
    const sx = from.x + box.width / 2;
    const sy = from.y + box.height;
    const tx = to.x + box.width / 2;
    const ty = to.y;
    if (ty <= sy) {
        return `M ${sx} ${sy} C ${sx} ${sy + 40}, ${tx} ${ty - 40}, ${tx} ${ty}`;
    }
    const mid = ty - box.gapY / 2 + lane;
    return `M ${sx} ${sy} V ${mid} H ${tx} V ${ty}`;
}

export function excerpt(text: string, max = 160): string {
    const plain = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[`*_#>|]/g, '')
        .replace(/^\s*[-+]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
