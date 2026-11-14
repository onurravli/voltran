import { useEffect, useMemo, useRef, useState } from 'react';
import { isFinished, layoutTasks, type PaneView, type Task } from '@voltran/shared';
import { api } from '../api.ts';
import { reportError, useUi } from '../store.ts';
import {
    agentPanes,
    connect,
    elapsed,
    type GraphPositions,
    PHASE_LABEL,
    type Point,
    parsePositions,
    storePositions,
    subagentRef,
    taskPhase,
    type TaskPhase,
    withSubagents,
} from '../tasks.ts';

const NO_TASKS: Task[] = [];
const CARD_W = 220;
const CARD_H = 66;
const GAP_X = 64;
const GAP_Y = 14;
const PAD = 20;
const DRAG_THRESHOLD = 4;
const POSITIONS_KEY = 'voltran.taskGraph';

function loadPositions(projectId: string): GraphPositions {
    try {
        return parsePositions(localStorage.getItem(POSITIONS_KEY), projectId);
    } catch {
        return {};
    }
}

function savePositions(projectId: string, positions: GraphPositions, ids: Set<string>): void {
    try {
        localStorage.setItem(
            POSITIONS_KEY,
            storePositions(localStorage.getItem(POSITIONS_KEY), projectId, positions, ids),
        );
    } catch {}
}

interface Drag {
    id: string;
    pointer: number;
    start: Point;
    origin: Point;
    at: Point | null;
}

type Mode = 'graph' | 'queues';

function revealPane(pane: PaneView | undefined): void {
    if (pane) {
        useUi.getState().selectSession(pane.sessionId);
        useUi.getState().focusPane(pane.id);
    }
}

function openSubagent(id: string): void {
    const ref = subagentRef(id);
    if (ref) {
        api.viewSubagent(ref.paneId, ref.agentId)
            .then((viewer) => {
                useUi.getState().selectSession(viewer.sessionId);
                useUi.getState().focusPane(viewer.id);
            })
            .catch(reportError);
    }
}

function act(task: Task, action: 'cancel' | 'retry' | 'complete'): void {
    api.updateTask(task.id, { action }).catch(reportError);
}

function TaskCard({
    task,
    phase,
    pane,
    now,
    selected,
    dragging = false,
    subagent = false,
    style,
    onSelect,
    onPointerDown,
}: {
    task: Task;
    phase: TaskPhase;
    pane: PaneView | undefined;
    now: number;
    selected: boolean;
    dragging?: boolean;
    subagent?: boolean;
    style?: React.CSSProperties;
    onSelect: () => void;
    onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
    const time = elapsed(task, now);
    return (
        <button
            type="button"
            className={`task-card task-card--${phase}${subagent ? ' task-card--subagent' : ''}${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
            style={style}
            onClick={onSelect}
            onPointerDown={onPointerDown}
            title={task.prompt}
        >
            <span className="task-card__top">
                <span className="task-card__dot" aria-hidden />
                <span className="task-card__phase">{subagent ? 'Subagent' : PHASE_LABEL[phase]}</span>
                {time ? <span className="task-card__time">{time}</span> : null}
            </span>
            <span className="task-card__title">{task.title}</span>
            <span className="task-card__agent">
                {pane ? pane.title : 'closed pane'}
                {task.createdBy && !subagent ? ' · delegated' : ''}
                {task.handoffFrom ? ' · handoff' : ''}
            </span>
        </button>
    );
}

function TaskGraph({
    projectId,
    tasks,
    byId,
    panes,
    now,
    selected,
    onSelect,
}: {
    projectId: string;
    tasks: Task[];
    byId: Map<string, Task>;
    panes: Map<string, PaneView>;
    now: number;
    selected: string | null;
    onSelect: (id: string) => void;
}) {
    const graph = layoutTasks(withSubagents(tasks, panes));
    const [positions, setPositions] = useState<GraphPositions>(() => loadPositions(projectId));
    const [dragAt, setDragAt] = useState<{ id: string; at: Point } | null>(null);
    const drag = useRef<Drag | null>(null);
    const swallowClick = useRef(false);
    useEffect(() => setPositions(loadPositions(projectId)), [projectId]);
    const place = new Map(
        graph.nodes.map((node) => [
            node.task.id,
            dragAt?.id === node.task.id
                ? dragAt.at
                : (positions[node.task.id] ?? {
                      x: PAD + node.column * (CARD_W + GAP_X),
                      y: PAD + node.row * (CARD_H + GAP_Y),
                  }),
        ]),
    );
    const spots = [...place.values()];
    const width = Math.max(PAD * 2 + CARD_W, ...spots.map((at) => at.x + CARD_W + PAD));
    const height = Math.max(PAD * 2 + CARD_H, ...spots.map((at) => at.y + CARD_H + PAD));
    const moved = graph.nodes.some((node) => positions[node.task.id]);
    const rect = (at: Point) => ({ ...at, width: CARD_W, height: CARD_H });

    const startDrag = (id: string) => (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) {
            return;
        }
        swallowClick.current = false;
        drag.current = {
            id,
            pointer: event.pointerId,
            start: { x: event.clientX, y: event.clientY },
            origin: place.get(id)!,
            at: null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const moveDrag = (event: React.PointerEvent) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) {
            return;
        }
        const dx = event.clientX - current.start.x;
        const dy = event.clientY - current.start.y;
        if (!current.at && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
            return;
        }
        current.at = { x: Math.max(0, current.origin.x + dx), y: Math.max(0, current.origin.y + dy) };
        setDragAt({ id: current.id, at: current.at });
    };
    const endDrag = (event: React.PointerEvent) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) {
            return;
        }
        drag.current = null;
        setDragAt(null);
        if (!current.at) {
            return;
        }
        swallowClick.current = true;
        const next = { ...positions, [current.id]: current.at };
        setPositions(next);
        savePositions(projectId, next, new Set(byId.keys()));
    };
    const resetLayout = () => {
        setPositions({});
        savePositions(projectId, {}, new Set());
    };

    const near = selected
        ? new Set(
              graph.edges
                  .filter((edge) => edge.from === selected || edge.to === selected)
                  .flatMap((edge) => [edge.from, edge.to]),
          )
        : null;
    return (
        <div className="task-graph">
            <div className="task-graph__scroll">
                <div
                    className={`task-graph__canvas${dragAt ? ' is-dragging' : ''}`}
                    style={{ width, height }}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                >
                    <svg className="task-graph__edges" width={width} height={height} aria-hidden>
                        <defs>
                            <marker
                                id="task-arrow"
                                viewBox="0 0 8 8"
                                refX="7"
                                refY="4"
                                markerWidth="7"
                                markerHeight="7"
                                orient="auto-start-reverse"
                            >
                                <path d="M0,0 L8,4 L0,8 z" className="task-graph__arrow" />
                            </marker>
                        </defs>
                        {graph.edges.map((edge) => {
                            const from = place.get(edge.from)!;
                            const to = place.get(edge.to)!;
                            const done = byId.get(edge.from)?.status === 'done';
                            const lit = near?.has(edge.from) && near.has(edge.to);
                            return (
                                <path
                                    key={`${edge.kind}:${edge.from}:${edge.to}`}
                                    className={`task-graph__edge task-graph__edge--${edge.kind}${done ? ' is-met' : ''}${lit ? ' is-lit' : ''}`}
                                    d={connect(rect(from), rect(to))}
                                    markerEnd={edge.kind === 'dependency' ? 'url(#task-arrow)' : undefined}
                                />
                            );
                        })}
                    </svg>
                    {graph.nodes.map((node) => {
                        const at = place.get(node.task.id)!;
                        if (subagentRef(node.task.id)) {
                            return (
                                <TaskCard
                                    key={node.task.id}
                                    task={node.task}
                                    phase="running"
                                    pane={panes.get(node.task.paneId)}
                                    now={now}
                                    selected={false}
                                    subagent
                                    style={{ left: at.x, top: at.y, width: CARD_W, height: CARD_H }}
                                    onSelect={() => openSubagent(node.task.id)}
                                />
                            );
                        }
                        return (
                            <TaskCard
                                key={node.task.id}
                                task={node.task}
                                phase={taskPhase(node.task, byId)}
                                pane={panes.get(node.task.paneId)}
                                now={now}
                                selected={selected === node.task.id}
                                dragging={dragAt?.id === node.task.id}
                                style={{ left: at.x, top: at.y, width: CARD_W, height: CARD_H }}
                                onSelect={() => {
                                    if (swallowClick.current) {
                                        swallowClick.current = false;
                                        return;
                                    }
                                    onSelect(node.task.id);
                                }}
                                onPointerDown={startDrag(node.task.id)}
                            />
                        );
                    })}
                </div>
            </div>
            <div className="task-graph__legend">
                <span>
                    <svg width="28" height="8" aria-hidden>
                        <path d="M0 4 H28" className="task-graph__edge task-graph__edge--dependency" />
                    </svg>
                    waits for
                </span>
                <span>
                    <svg width="28" height="8" aria-hidden>
                        <path d="M0 4 H28" className="task-graph__edge task-graph__edge--parent" />
                    </svg>
                    subtask of
                </span>
                <span className="task-graph__hint">Drag cards to arrange them</span>
                {moved ? (
                    <button type="button" className="task-graph__reset" onClick={resetLayout}>
                        Reset layout
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function TaskQueues({
    tasks,
    byId,
    lanes,
    now,
    selected,
    onSelect,
}: {
    tasks: Task[];
    byId: Map<string, Task>;
    lanes: PaneView[];
    now: number;
    selected: string | null;
    onSelect: (id: string) => void;
}) {
    const panes = new Map(lanes.map((pane) => [pane.id, pane]));
    const closed = tasks.filter((task) => !panes.has(task.paneId));
    return (
        <div className="task-lanes">
            {lanes.map((pane) => {
                const own = tasks.filter((task) => task.paneId === pane.id).sort((a, b) => a.position - b.position);
                const queued = own.filter((task) => task.status === 'queued');
                return (
                    <section key={pane.id} className="task-lane">
                        <header className="task-lane__head">
                            <button type="button" className="task-lane__name" onClick={() => revealPane(pane)}>
                                {pane.title}
                            </button>
                            <span className="task-lane__status">{pane.status}</span>
                            <button
                                type="button"
                                className="icon-button task-lane__add"
                                title={`Queue a task for ${pane.title}`}
                                onClick={() => openComposer(pane, { paneIds: [pane.id] })}
                            >
                                +
                            </button>
                        </header>
                        {own.length === 0 ? <p className="task-lane__empty">Nothing queued</p> : null}
                        {own.map((task) => {
                            const index = queued.indexOf(task);
                            return (
                                <div key={task.id} className="task-lane__item">
                                    <TaskCard
                                        task={task}
                                        phase={taskPhase(task, byId)}
                                        pane={pane}
                                        now={now}
                                        selected={selected === task.id}
                                        onSelect={() => onSelect(task.id)}
                                    />
                                    {index >= 0 && queued.length > 1 ? (
                                        <span className="task-lane__move">
                                            <button
                                                type="button"
                                                className="icon-button"
                                                title="Run earlier"
                                                disabled={index === 0}
                                                onClick={() =>
                                                    api
                                                        .updateTask(task.id, { moveBefore: queued[index - 1].id })
                                                        .catch(reportError)
                                                }
                                            >
                                                ↑
                                            </button>
                                            <button
                                                type="button"
                                                className="icon-button"
                                                title="Run later"
                                                disabled={index === queued.length - 1}
                                                onClick={() =>
                                                    api
                                                        .updateTask(task.id, {
                                                            moveBefore: queued[index + 2]?.id ?? null,
                                                        })
                                                        .catch(reportError)
                                                }
                                            >
                                                ↓
                                            </button>
                                        </span>
                                    ) : null}
                                </div>
                            );
                        })}
                    </section>
                );
            })}
            {closed.length > 0 ? (
                <section className="task-lane">
                    <header className="task-lane__head">
                        <span className="task-lane__name">Closed panes</span>
                    </header>
                    {closed.map((task) => (
                        <TaskCard
                            key={task.id}
                            task={task}
                            phase={taskPhase(task, byId)}
                            pane={undefined}
                            now={now}
                            selected={selected === task.id}
                            onSelect={() => onSelect(task.id)}
                        />
                    ))}
                </section>
            ) : null}
        </div>
    );
}

export function openComposer(
    from: { sessionId: string } | null,
    extra: { paneIds?: string[]; handoffFrom?: string; dependsOn?: string[]; parentId?: string },
    projectId?: string,
): void {
    const state = useUi.getState();
    const session = state.app?.sessions.find((entry) => entry.id === from?.sessionId);
    const project = projectId ?? session?.projectId;
    if (project) {
        state.openDialog({ kind: 'task', projectId: project, sessionId: session?.id, ...extra });
    }
}

function TaskDetails({
    task,
    byId,
    panes,
    now,
    onClose,
}: {
    task: Task;
    byId: Map<string, Task>;
    panes: Map<string, PaneView>;
    now: number;
    onClose: () => void;
}) {
    const pane = panes.get(task.paneId);
    const phase = taskPhase(task, byId);
    const time = elapsed(task, now);
    const subtasks = [...byId.values()].filter((entry) => entry.parentId === task.id);
    const link = (id: string) => {
        const other = byId.get(id);
        return other ? (
            <li key={id}>
                <span className={`task-dot task-dot--${taskPhase(other, byId)}`} aria-hidden />
                {other.title}
            </li>
        ) : null;
    };
    return (
        <aside className="task-details">
            <header className="task-details__head">
                <span className={`task-dot task-dot--${phase}`} aria-hidden />
                <span className="task-details__phase">{PHASE_LABEL[phase]}</span>
                {time ? <span className="task-details__time">{time}</span> : null}
                <button type="button" className="icon-button task-details__close" title="Close" onClick={onClose}>
                    ×
                </button>
            </header>
            <h3 className="task-details__title">{task.title}</h3>
            <dl className="task-details__facts">
                <dt>Agent</dt>
                <dd>
                    {pane ? (
                        <button type="button" className="task-details__link" onClick={() => revealPane(pane)}>
                            {pane.title}
                        </button>
                    ) : (
                        'closed pane'
                    )}
                </dd>
                <dt>From</dt>
                <dd>{task.createdBy ? `delegated by ${panes.get(task.createdBy)?.title ?? 'an agent'}` : 'you'}</dd>
                {task.handoffFrom ? (
                    <>
                        <dt>Context</dt>
                        <dd>handed off from {panes.get(task.handoffFrom)?.title ?? 'a closed pane'}</dd>
                    </>
                ) : null}
            </dl>
            {task.dependsOn.length > 0 ? (
                <section className="task-details__section">
                    <h4>Waits for</h4>
                    <ul className="task-details__list">{task.dependsOn.map(link)}</ul>
                </section>
            ) : null}
            {task.parentId ? (
                <section className="task-details__section">
                    <h4>Subtask of</h4>
                    <ul className="task-details__list">{link(task.parentId)}</ul>
                </section>
            ) : null}
            {subtasks.length > 0 ? (
                <section className="task-details__section">
                    <h4>Subtasks</h4>
                    <ul className="task-details__list">{subtasks.map((entry) => link(entry.id))}</ul>
                </section>
            ) : null}
            <section className="task-details__section">
                <h4>Prompt</h4>
                <pre className="task-details__text">{task.prompt}</pre>
            </section>
            {task.result ? (
                <section className="task-details__section">
                    <h4>{phase === 'asking' ? 'The agent asks' : 'Last reply'}</h4>
                    <pre className="task-details__text">{task.result}</pre>
                </section>
            ) : null}
            <div className="task-details__actions">
                {task.status === 'running' ? (
                    <button type="button" className="button button--small" onClick={() => act(task, 'complete')}>
                        Mark done
                    </button>
                ) : null}
                {!isFinished(task.status) ? (
                    <button
                        type="button"
                        className="button button--small button--ghost"
                        onClick={() => act(task, 'cancel')}
                    >
                        Cancel
                    </button>
                ) : null}
                {task.status === 'failed' || task.status === 'cancelled' ? (
                    <button type="button" className="button button--small" onClick={() => act(task, 'retry')}>
                        Retry
                    </button>
                ) : null}
                {task.status === 'done' ? (
                    <>
                        <button
                            type="button"
                            className="button button--small"
                            onClick={() => openComposer(pane ?? null, { dependsOn: [task.id] }, task.projectId)}
                        >
                            Follow up
                        </button>
                        {pane ? (
                            <button
                                type="button"
                                className="button button--small"
                                onClick={() => openComposer(pane, { handoffFrom: pane.id })}
                            >
                                Hand off
                            </button>
                        ) : null}
                    </>
                ) : null}
                {task.status !== 'running' ? (
                    <button
                        type="button"
                        className="button button--small button--ghost"
                        onClick={() => {
                            api.deleteTask(task.id).then(onClose).catch(reportError);
                        }}
                    >
                        Remove
                    </button>
                ) : null}
                <button
                    type="button"
                    className="button button--small button--ghost"
                    onClick={() => openComposer(pane ?? null, { parentId: task.id }, task.projectId)}
                >
                    Add subtask
                </button>
            </div>
        </aside>
    );
}

export function TasksView({ pane }: { pane: PaneView }) {
    const app = useUi((state) => state.app);
    const allTasks = useUi((state) => state.app?.tasks ?? NO_TASKS);
    const session = app?.sessions.find((entry) => entry.id === pane.sessionId);
    const projectId = session?.projectId ?? '';
    const [mode, setMode] = useState<Mode>('graph');
    const [selected, setSelected] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());
    const tasks = useMemo(() => allTasks.filter((task) => task.projectId === projectId), [allTasks, projectId]);
    const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
    const lanes = app ? agentPanes(app, projectId) : [];
    const panes = new Map((app?.panes ?? []).map((entry) => [entry.id, entry]));
    const running = tasks.some((task) => task.status === 'running');
    const counts = {
        open: tasks.filter((task) => !isFinished(task.status)).length,
        done: tasks.filter((task) => task.status === 'done').length,
        finished: tasks.filter((task) => isFinished(task.status)).length,
    };

    useEffect(() => {
        if (!running) {
            return undefined;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);

    const chosen = selected ? byId.get(selected) : undefined;

    return (
        <div className="tasks">
            <div className="tasks__bar">
                <span className="tasks__title">Tasks</span>
                <span className="tasks__count">
                    {counts.open} open · {counts.done} done
                </span>
                <div className="tasks__modes" role="tablist">
                    {(['graph', 'queues'] as const).map((entry) => (
                        <button
                            key={entry}
                            type="button"
                            role="tab"
                            aria-selected={mode === entry}
                            className={`tasks__mode${mode === entry ? ' is-active' : ''}`}
                            onClick={() => setMode(entry)}
                        >
                            {entry === 'graph' ? 'Graph' : 'Queues'}
                        </button>
                    ))}
                </div>
                <span className="tasks__spacer" />
                {counts.finished > 0 ? (
                    <button
                        type="button"
                        className="button button--small button--ghost"
                        onClick={() => api.clearTasks(projectId).catch(reportError)}
                    >
                        Clear finished
                    </button>
                ) : null}
                <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={!projectId}
                    onClick={() => openComposer(pane, {})}
                >
                    New task
                </button>
            </div>
            <div className={`tasks__body${chosen ? ' tasks__body--details' : ''}`}>
                {tasks.length === 0 && mode === 'graph' ? (
                    <div className="tasks__empty">
                        <p className="tasks__empty-title">No tasks yet</p>
                        <p>
                            Queue prompts for the agents of this project. They run one after another in each pane, can
                            wait for each other and carry results and notes along.
                        </p>
                        <p>
                            Agents can delegate too: Claude Code and OpenCode panes are told how to run{' '}
                            <code>$VOLTRAN_TASK delegate --agent codex …</code>.
                        </p>
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={lanes.length === 0}
                            onClick={() => openComposer(pane, {})}
                        >
                            {lanes.length === 0 ? 'Open an agent pane first' : 'New task'}
                        </button>
                    </div>
                ) : mode === 'graph' ? (
                    <TaskGraph
                        projectId={projectId}
                        tasks={tasks}
                        byId={byId}
                        panes={panes}
                        now={now}
                        selected={selected}
                        onSelect={setSelected}
                    />
                ) : (
                    <TaskQueues
                        tasks={tasks}
                        byId={byId}
                        lanes={lanes}
                        now={now}
                        selected={selected}
                        onSelect={setSelected}
                    />
                )}
                {chosen ? (
                    <TaskDetails task={chosen} byId={byId} panes={panes} now={now} onClose={() => setSelected(null)} />
                ) : null}
            </div>
        </div>
    );
}
