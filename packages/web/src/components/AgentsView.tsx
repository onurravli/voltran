import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type ConversationEntry, isFinished, type PaneView, type SubagentView, type Task } from '@voltran/shared';
import {
    type Activity,
    activityOf,
    conversationOf,
    duration,
    type ExchangeLine,
    excerpt,
    exchangeTasks,
    type FlowBox,
    flowLinks,
    layoutFlow,
    mergeThread,
    type MessageKind,
    type Participant,
    participantsOf,
    subagentNodeId,
    summarize,
    wire,
    YOU,
} from '../agents.ts';
import { api } from '../api.ts';
import { renderMarkdown } from '../markdown.ts';
import { reportError, useUi } from '../store.ts';
import {
    type GraphPositions,
    PHASE_LABEL,
    type Point,
    parsePositions,
    storePositions,
    subagentRef,
    taskPhase,
} from '../tasks.ts';
import { AgentsIcon, CloseIcon } from './Icons.tsx';

type Mode = 'flow' | 'summary';

const BOX: FlowBox = { size: 84, subSize: 52, label: 56, gapX: 150, gapY: 28, subGap: 36, pad: 80 };
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.8;

const VERB: Record<MessageKind, string> = {
    ask: 'asked',
    question: 'asks',
    reply: 'replied to',
    failed: 'failed for',
    cancelled: 'stopped for',
};

const LONG_TEXT = 900;
const DRAG_THRESHOLD = 4;
const POSITIONS_KEY = 'voltran.agentCanvas';
const ACTIVITY_POLL_MS = 2000;

function loadPositions(projectId: string): GraphPositions {
    try {
        return parsePositions(localStorage.getItem(POSITIONS_KEY), projectId);
    } catch {
        return {};
    }
}

function savePositions(projectId: string, positions: GraphPositions): void {
    try {
        localStorage.setItem(
            POSITIONS_KEY,
            storePositions(localStorage.getItem(POSITIONS_KEY), projectId, positions, new Set(Object.keys(positions))),
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

type DragProps = Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
>;

const Markdown = memo(function Markdown({ text }: { text: string }) {
    const html = useMemo(() => renderMarkdown(text), [text]);
    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown runs markdown-it with raw HTML off
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});

function Folded({ text }: { text: string }) {
    const [open, setOpen] = useState(false);
    const long = text.length > LONG_TEXT;
    return (
        <>
            <div className={`agents-text${long && !open ? ' is-folded' : ''}`}>
                <Markdown text={text} />
            </div>
            {long ? (
                <button type="button" className="agents-more" onClick={() => setOpen(!open)}>
                    {open ? 'Show less' : 'Show all'}
                </button>
            ) : null}
        </>
    );
}

function reveal(pane: PaneView | null): void {
    if (pane) {
        const ui = useUi.getState();
        ui.closeAgents();
        ui.selectSession(pane.sessionId);
        ui.focusPane(pane.id);
    }
}

function openSubagent(id: string): void {
    const ref = subagentRef(id);
    if (ref) {
        api.viewSubagent(ref.paneId, ref.agentId)
            .then((viewer) => {
                const ui = useUi.getState();
                ui.closeAgents();
                ui.selectSession(viewer.sessionId);
                ui.focusPane(viewer.id);
            })
            .catch(reportError);
    }
}

function Avatar({ who }: { who: Participant | undefined }) {
    return (
        <span className="agents-avatar" style={{ '--who': who?.color } as React.CSSProperties} aria-hidden>
            {(who?.name ?? '?').slice(0, 1)}
        </span>
    );
}

function time(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Line({ line, people }: { line: ExchangeLine; people: Map<string, Participant> }) {
    if (line.type === 'started') {
        return (
            <div className="agents-event">
                {people.get(line.who)?.name} started {line.task.title}
                <span className="agents-event__time">{time(line.at)}</span>
            </div>
        );
    }
    const from = people.get(line.from);
    const to = people.get(line.to);
    return (
        <article className={`agents-msg agents-msg--${line.kind}`}>
            <Avatar who={from} />
            <div className="agents-msg__main">
                <header className="agents-msg__head">
                    <span className="agents-msg__from">{from?.name}</span>
                    <span className="agents-msg__verb">{VERB[line.kind]}</span>
                    <span className="agents-msg__to">{to?.name}</span>
                    <time className="agents-msg__time">{time(line.at)}</time>
                </header>
                <div className="agents-msg__task">
                    {line.task.title}
                    {line.waitsFor.length > 0 ? ` · after ${line.waitsFor.join(', ')}` : ''}
                    {line.kind === 'ask' && line.task.handoffFrom ? ' · with a handoff' : ''}
                </div>
                <Folded text={line.text} />
            </div>
        </article>
    );
}

interface NodeInfo {
    who: Participant;
    own: Task[];
    current: Task | null;
    said: string | null;
}

interface View {
    x: number;
    y: number;
    k: number;
}

interface Pan {
    pointer: number;
    start: Point;
    origin: View;
    moved: boolean;
}

const GLYPHS: Partial<Record<string, string>> = { claude: '✻', codex: '>_', opencode: '{ }' };

const glyphOf = (who: Participant): string =>
    who.id === YOU ? '◎' : ((who.adapter && GLYPHS[who.adapter]) ?? who.name.slice(0, 1));

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

type Badge = 'running' | 'asking' | 'waiting' | 'done' | 'failed' | 'cancelled';

function badgeOf(info: NodeInfo, byId: Map<string, Task>): Badge | null {
    if (info.current) {
        const phase = taskPhase(info.current, byId);
        return phase === 'running' ? 'running' : phase === 'asking' ? 'asking' : 'waiting';
    }
    if (info.own.length === 0) {
        return null;
    }
    if (info.own.some((task) => task.status === 'failed')) {
        return 'failed';
    }
    return info.own.every((task) => task.status === 'cancelled') ? 'cancelled' : 'done';
}

const BADGE_MARK: Record<Badge, string> = {
    running: '',
    asking: '?',
    waiting: '…',
    done: '✓',
    failed: '!',
    cancelled: '–',
};

function AgentNode({
    info,
    byId,
    at,
    selected,
    dragging,
    now,
    drag,
    onSelect,
}: {
    info: NodeInfo;
    byId: Map<string, Task>;
    at: Point;
    selected: boolean;
    dragging: boolean;
    now: number;
    drag: DragProps;
    onSelect: () => void;
}) {
    const { who, own, current, said } = info;
    const phase = current ? taskPhase(current, byId) : null;
    const badge = badgeOf(info, byId);
    const busy = own.reduce(
        (sum, task) => sum + (task.startedAt === null ? 0 : (task.finishedAt ?? now) - task.startedAt),
        0,
    );
    const done = own.filter((task) => task.status === 'done').length;
    const state =
        who.id === YOU
            ? 'Gave tasks'
            : current && phase
              ? `${PHASE_LABEL[phase]} · ${current.title}`
              : own.length > 0
                ? `${done} of ${own.length} done · ${duration(busy)}`
                : 'Delegating';
    return (
        <div
            className={`canvas-node${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
            style={{ left: at.x, top: at.y, width: BOX.size }}
        >
            <button
                type="button"
                className="canvas-node__box"
                style={{ width: BOX.size, height: BOX.size, '--who': who.color } as React.CSSProperties}
                {...drag}
                onClick={onSelect}
                onDoubleClick={() => reveal(who.pane)}
                title={`${who.pane?.title ?? who.name}${said ? `\n\n${excerpt(said, 300)}` : ''}\n\nDrag to move, double-click to open its pane`}
            >
                <span className="canvas-node__glyph">{glyphOf(who)}</span>
                <span className="canvas-node__handle canvas-node__handle--in" aria-hidden />
                <span className="canvas-node__handle canvas-node__handle--out" aria-hidden />
                {badge ? (
                    <span className={`canvas-node__badge canvas-node__badge--${badge}`} aria-label={badge}>
                        {BADGE_MARK[badge]}
                    </span>
                ) : null}
            </button>
            <span className="canvas-node__label">
                <span className="canvas-node__name">{who.name}</span>
                <span className="canvas-node__state">{state}</span>
            </span>
        </div>
    );
}

function SubagentNode({
    agent,
    at,
    dragging,
    drag,
    onOpen,
}: {
    agent: SubagentView;
    at: Point;
    dragging: boolean;
    drag: DragProps;
    onOpen: () => void;
}) {
    return (
        <div
            className={`canvas-node canvas-node--sub${dragging ? ' is-dragging' : ''}`}
            style={{ left: at.x, top: at.y, width: BOX.subSize }}
        >
            <button
                type="button"
                className="canvas-node__box"
                style={{ width: BOX.subSize, height: BOX.subSize }}
                {...drag}
                onClick={onOpen}
                title={`${agent.type}: ${agent.description}\nDrag to move, click to open its transcript`}
            >
                <span className="canvas-node__glyph">{agent.type.slice(0, 1)}</span>
                <span className="canvas-node__badge canvas-node__badge--running" aria-hidden />
            </button>
            <span className="canvas-node__label">
                <span className="canvas-node__name">{agent.type}</span>
                <span className="canvas-node__state">{agent.description}</span>
            </span>
        </div>
    );
}

function Flow({
    projectId,
    tasks,
    byId,
    people,
    selected,
    now,
    onSelect,
}: {
    projectId: string;
    tasks: Task[];
    byId: Map<string, Task>;
    people: Participant[];
    selected: string | null;
    now: number;
    onSelect: (id: string | null) => void;
}) {
    const panes = useMemo(
        () => new Map(people.flatMap((who) => (who.pane ? [[who.id, who.pane] as const] : []))),
        [people],
    );
    const links = useMemo(() => flowLinks(tasks, panes), [tasks, panes]);
    const subagents = useMemo(
        () =>
            people.flatMap((who) =>
                (who.pane?.subagents ?? []).map((agent) => ({ id: subagentNodeId(who.id, agent.id), agent })),
            ),
        [people],
    );
    const ids = useMemo(() => [...people.map((who) => who.id), ...subagents.map((sub) => sub.id)], [people, subagents]);
    const layout = useMemo(() => layoutFlow(ids, links, BOX), [ids, links]);
    const lines = useMemo(() => conversationOf(tasks), [tasks]);
    const infos = useMemo(
        () =>
            people.map((who): NodeInfo => {
                const own = tasks.filter((task) => task.paneId === who.id);
                const current =
                    own.find((task) => task.status === 'running') ??
                    own.find((task) => task.status === 'queued') ??
                    null;
                const said = [...lines]
                    .reverse()
                    .find((line) => line.type === 'message' && line.from === who.id && line.text);
                return { who, own, current, said: said?.type === 'message' ? said.text : null };
            }),
        [people, tasks, lines],
    );
    const [moved, setMoved] = useState<GraphPositions>(() => loadPositions(projectId));
    const [drag, setDrag] = useState<Drag | null>(null);
    const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
    const [pan, setPan] = useState<Pan | null>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const touched = useRef(false);
    const dragged = useRef(false);

    const place = (id: string): Point | undefined =>
        drag?.id === id && drag.at ? drag.at : (moved[id] ?? layout.at.get(id));

    const extent = ids.reduce(
        (size, id) => {
            const at = place(id);
            return at
                ? {
                      width: Math.max(size.width, at.x + BOX.size + BOX.pad),
                      height: Math.max(size.height, at.y + BOX.size + BOX.label + BOX.pad),
                  }
                : size;
        },
        { width: layout.width, height: layout.height },
    );

    const fit = useCallback((): void => {
        const box = viewport.current?.getBoundingClientRect();
        if (!box || extent.width === 0) {
            return;
        }
        const k = clamp(Math.min(box.width / extent.width, box.height / extent.height), MIN_ZOOM, 1);
        setView({ k, x: (box.width - extent.width * k) / 2, y: (box.height - extent.height * k) / 2 });
    }, [extent.width, extent.height]);

    useLayoutEffect(() => {
        if (!touched.current) {
            fit();
        }
    }, [fit]);

    const zoomAt = useCallback((factor: number, cx?: number, cy?: number): void => {
        const box = viewport.current?.getBoundingClientRect();
        if (!box) {
            return;
        }
        touched.current = true;
        const px = cx ?? box.width / 2;
        const py = cy ?? box.height / 2;
        setView((current) => {
            const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
            return { k, x: px - ((px - current.x) * k) / current.k, y: py - ((py - current.y) * k) / current.k };
        });
    }, []);

    useEffect(() => {
        const element = viewport.current;
        if (!element) {
            return;
        }
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) {
                const box = element.getBoundingClientRect();
                zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top);
            } else {
                touched.current = true;
                setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
            }
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [zoomAt]);

    const dragProps = (id: string): DragProps => ({
        onPointerDown: (event) => {
            event.stopPropagation();
            dragged.current = false;
            const origin = place(id);
            if (event.button !== 0 || !origin) {
                return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ id, pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin, at: null });
        },
        onPointerMove: (event) => {
            if (!drag || drag.pointer !== event.pointerId) {
                return;
            }
            const dx = (event.clientX - drag.start.x) / view.k;
            const dy = (event.clientY - drag.start.y) / view.k;
            if (!drag.at && Math.hypot(dx, dy) * view.k < DRAG_THRESHOLD) {
                return;
            }
            touched.current = true;
            setDrag({ ...drag, at: { x: Math.max(0, drag.origin.x + dx), y: Math.max(0, drag.origin.y + dy) } });
        },
        onPointerUp: (event) => {
            if (!drag || drag.pointer !== event.pointerId) {
                return;
            }
            if (drag.at) {
                const next = { ...moved, [drag.id]: drag.at };
                setMoved(next);
                savePositions(projectId, next);
                dragged.current = true;
            }
            setDrag(null);
        },
        onPointerCancel: () => setDrag(null),
    });

    const unlessDragged =
        (run: () => void): (() => void) =>
        () => {
            if (dragged.current) {
                dragged.current = false;
                return;
            }
            run();
        };

    const reset = (): void => {
        setMoved({});
        savePositions(projectId, {});
        touched.current = false;
    };

    return (
        <div
            ref={viewport}
            className={`flow${pan?.moved ? ' is-panning' : ''}`}
            style={{
                backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
            }}
            onPointerDown={(event) => {
                if (event.button !== 0) {
                    return;
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                setPan({
                    pointer: event.pointerId,
                    start: { x: event.clientX, y: event.clientY },
                    origin: view,
                    moved: false,
                });
            }}
            onPointerMove={(event) => {
                if (!pan || pan.pointer !== event.pointerId) {
                    return;
                }
                const dx = event.clientX - pan.start.x;
                const dy = event.clientY - pan.start.y;
                if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
                    return;
                }
                touched.current = true;
                setPan({ ...pan, moved: true });
                setView({ ...pan.origin, x: pan.origin.x + dx, y: pan.origin.y + dy });
            }}
            onPointerUp={(event) => {
                if (pan && pan.pointer === event.pointerId && !pan.moved) {
                    onSelect(null);
                }
                setPan(null);
            }}
            onPointerCancel={() => setPan(null)}
        >
            <div
                className="flow__canvas"
                style={{
                    width: extent.width,
                    height: extent.height,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
                }}
            >
                <svg className="flow__edges" width={extent.width} height={extent.height} aria-hidden>
                    {links.map((link) => {
                        const from = place(link.from);
                        const to = place(link.to);
                        if (!from || !to) {
                            return null;
                        }
                        const { path, end } = wire(from, to, BOX, link.kind);
                        const lit = selected !== null && (link.from === selected || link.to === selected);
                        return (
                            <g
                                key={`${link.kind}:${link.from}:${link.to}`}
                                className={`flow-edge flow-edge--${link.kind} flow-edge--${link.status}${lit ? ' is-lit' : ''}`}
                            >
                                <title>{link.titles.join('\n')}</title>
                                <path className="flow-edge__hit" d={path} />
                                <path className="flow-edge__line" d={path} />
                                {link.kind === 'runs' ? null : (
                                    <path
                                        className="flow-edge__head"
                                        d={`M ${end.x - 7} ${end.y - 4} L ${end.x - 1} ${end.y} L ${end.x - 7} ${end.y + 4}`}
                                    />
                                )}
                            </g>
                        );
                    })}
                </svg>
                {infos.map((info) => {
                    const at = place(info.who.id);
                    return at ? (
                        <AgentNode
                            key={info.who.id}
                            info={info}
                            byId={byId}
                            at={at}
                            now={now}
                            selected={selected === info.who.id}
                            dragging={drag?.id === info.who.id && drag.at !== null}
                            drag={dragProps(info.who.id)}
                            onSelect={unlessDragged(() => onSelect(selected === info.who.id ? null : info.who.id))}
                        />
                    ) : null;
                })}
                {subagents.map(({ id, agent }) => {
                    const at = place(id);
                    return at ? (
                        <SubagentNode
                            key={id}
                            agent={agent}
                            at={at}
                            dragging={drag?.id === id && drag.at !== null}
                            drag={dragProps(id)}
                            onOpen={unlessDragged(() => openSubagent(id))}
                        />
                    ) : null;
                })}
            </div>
            <div className="flow__controls" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" className="flow__control" title="Zoom in" onClick={() => zoomAt(1.2)}>
                    +
                </button>
                <button type="button" className="flow__control" title="Zoom out" onClick={() => zoomAt(1 / 1.2)}>
                    −
                </button>
                <button
                    type="button"
                    className="flow__control flow__control--wide"
                    title="Fit the agents in view"
                    onClick={() => {
                        touched.current = false;
                        fit();
                    }}
                >
                    Fit
                </button>
                {Object.keys(moved).length > 0 ? (
                    <button type="button" className="flow__control flow__control--wide" onClick={reset}>
                        Reset layout
                    </button>
                ) : null}
            </div>
            <div className="flow__legend" aria-hidden>
                <span className="flow__key flow__key--delegates">gives work</span>
                <span className="flow__key flow__key--waits">waits for results</span>
                <span className="flow__key flow__key--runs">runs a subagent</span>
            </div>
        </div>
    );
}

const LIVE: PaneView['status'][] = ['starting', 'working', 'needs-input'];

// A Claude pane's conversation, read the way the conversation view reads it: from where the last read
// stopped, again every few seconds while the agent works and on each change of its status.
function useConversation(pane: PaneView | null): ConversationEntry[] {
    const paneId = pane?.adapter === 'claude' ? pane.id : null;
    const status = pane?.status;
    const [entries, setEntries] = useState<ConversationEntry[]>([]);
    const cursor = useRef<{ source: string | null; next: number }>({ source: null, next: 0 });
    const busy = useRef<string | null>(null);
    const shown = useRef(paneId);
    shown.current = paneId;

    const load = useCallback(async (): Promise<void> => {
        if (!paneId || busy.current === paneId) {
            return;
        }
        busy.current = paneId;
        try {
            let more = true;
            while (more) {
                const chunk = await api.conversation(paneId, cursor.current.source, cursor.current.next);
                if (shown.current !== paneId) {
                    return;
                }
                const reset = chunk.source !== cursor.current.source;
                cursor.current = { source: chunk.source, next: chunk.next };
                if (reset) {
                    setEntries(chunk.entries);
                } else if (chunk.entries.length > 0) {
                    setEntries((previous) => previous.concat(chunk.entries));
                }
                more = chunk.more;
            }
        } catch {
        } finally {
            if (busy.current === paneId) {
                busy.current = null;
            }
        }
    }, [paneId]);

    useEffect(() => {
        cursor.current = { source: null, next: 0 };
        setEntries([]);
    }, [paneId]);

    useEffect(() => {
        void load();
        if (!status || !LIVE.includes(status)) {
            return;
        }
        const timer = setInterval(() => void load(), ACTIVITY_POLL_MS);
        return () => clearInterval(timer);
    }, [load, status]);

    return entries;
}

function ActivityLine({ activity }: { activity: Activity }) {
    if (activity.kind === 'tool' || activity.kind === 'error') {
        return <div className={`agents-tool agents-tool--${activity.kind}`}>{activity.text}</div>;
    }
    return (
        <div className={`agents-activity agents-activity--${activity.kind}`}>
            {activity.kind === 'thinking' ? <span className="agents-activity__label">Thinking</span> : null}
            <Folded text={activity.text} />
        </div>
    );
}

function Thread({
    tasks,
    people,
    selected,
    onClear,
}: {
    tasks: Task[];
    people: Map<string, Participant>;
    selected: string | null;
    onClear: () => void;
}) {
    const element = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const lines = useMemo(
        () =>
            conversationOf(tasks).filter(
                (line) =>
                    selected === null ||
                    (line.type === 'message' ? line.from === selected || line.to === selected : line.who === selected),
            ),
        [tasks, selected],
    );
    const who = selected ? people.get(selected) : undefined;
    const conversation = useConversation(who?.pane ?? null);
    const items = useMemo(() => {
        if (!selected || conversation.length === 0) {
            return mergeThread(lines, []);
        }
        const involved = tasks.filter((task) => task.paneId === selected || task.createdBy === selected);
        const since = Math.min(...involved.map((task) => task.createdAt));
        const replies = tasks.flatMap((task) => (task.paneId === selected && task.result ? [task.result] : []));
        return mergeThread(lines, activityOf(conversation, since, replies));
    }, [lines, conversation, selected, tasks]);
    const working = tasks.filter(
        (task) =>
            task.status === 'running' &&
            (!task.result || people.get(task.paneId)?.pane?.status === 'working') &&
            (selected === null || task.paneId === selected),
    );

    useLayoutEffect(() => {
        if (element.current && pinned.current) {
            element.current.scrollTop = element.current.scrollHeight;
        }
    });

    return (
        <aside className="agents-thread" aria-label="Messages">
            <header className="agents-thread__head">
                <span className="agents-thread__title">{who ? who.name : 'All messages'}</span>
                {who?.pane ? (
                    <button type="button" className="agents-link" onClick={() => reveal(who.pane)}>
                        Open pane
                    </button>
                ) : null}
                {who ? (
                    <button type="button" className="agents-link" onClick={onClear}>
                        Show all
                    </button>
                ) : null}
            </header>
            <div
                ref={element}
                className="agents-thread__scroll"
                onScroll={(event) => {
                    const box = event.currentTarget;
                    pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
                }}
            >
                {who && who.pane?.adapter !== 'claude' && who.id !== YOU ? (
                    <p className="agents-thread__hint">
                        {who.name} does not share its thinking with Voltran, so only its messages show here.
                    </p>
                ) : null}
                {!who ? (
                    <p className="agents-thread__hint">Select an agent to see its thinking and tool calls.</p>
                ) : null}
                {items.map((item) =>
                    item.type === 'line' ? (
                        <Line key={item.line.key} line={item.line} people={people} />
                    ) : (
                        <ActivityLine key={`activity:${item.activity.key}`} activity={item.activity} />
                    ),
                )}
                {working.map((task) => (
                    <div key={task.id} className="agents-working">
                        <span className="agents-working__dots" aria-hidden>
                            <i />
                            <i />
                            <i />
                        </span>
                        <span className="agents-working__text">
                            {people.get(task.paneId)?.name} is working
                            {people.get(task.paneId)?.pane?.detail ? ` · ${people.get(task.paneId)?.pane?.detail}` : ''}
                        </span>
                    </div>
                ))}
            </div>
        </aside>
    );
}

function Summary({
    tasks,
    people,
    byId,
    now,
}: {
    tasks: Task[];
    people: Map<string, Participant>;
    byId: Map<string, Task>;
    now: number;
}) {
    const summary = summarize(tasks, now);
    const over = summary.running === 0;
    const headline = !over
        ? 'Still working'
        : summary.failed + summary.cancelled === 0
          ? 'All done'
          : summary.done === 0
            ? 'Nothing finished'
            : 'Done, with problems';
    const counts = [
        `${summary.done} done`,
        summary.failed > 0 ? `${summary.failed} failed` : null,
        summary.cancelled > 0 ? `${summary.cancelled} cancelled` : null,
        summary.running > 0 ? `${summary.running} to go` : null,
    ].filter(Boolean);
    return (
        <div className="agents-summary">
            <div className="agents-summary__inner">
                <h2 className="agents-summary__headline">{headline}</h2>
                <p className="agents-summary__sub">
                    {summary.tasks} {summary.tasks === 1 ? 'task' : 'tasks'} · {summary.agents.length}{' '}
                    {summary.agents.length === 1 ? 'agent' : 'agents'} · {duration(summary.spanMs)}
                    {over ? '' : ' so far'} · {counts.join(', ')}
                </p>
                <h3 className="agents-summary__section">Agents</h3>
                <div className="agents-roster">
                    {summary.agents.map((tally) => {
                        const who = people.get(tally.participant);
                        return (
                            <div key={tally.participant} className="agents-roster__row">
                                <Avatar who={who} />
                                <span className="agents-roster__name">{who?.name}</span>
                                <span className="agents-roster__count">
                                    {tally.done}/{tally.tasks} done
                                    {tally.failed > 0 ? ` · ${tally.failed} failed` : ''}
                                </span>
                                <span className="agents-roster__time">{duration(tally.busyMs)}</span>
                            </div>
                        );
                    })}
                </div>
                <h3 className="agents-summary__section">Results</h3>
                {tasks.map((task) => {
                    const phase = taskPhase(task, byId);
                    return (
                        <section key={task.id} className="agents-result">
                            <header className="agents-result__head">
                                <span className={`task-dot task-dot--${phase}`} aria-hidden />
                                <span className="agents-result__title">{task.title}</span>
                                <span className="agents-result__meta">
                                    {people.get(task.paneId)?.name} · {PHASE_LABEL[phase]}
                                    {task.startedAt !== null
                                        ? ` · ${duration((task.finishedAt ?? now) - task.startedAt)}`
                                        : ''}
                                </span>
                            </header>
                            {task.result ? (
                                <Folded text={task.result} />
                            ) : (
                                <p className="agents-result__none">
                                    {isFinished(task.status) ? 'No reply.' : 'No reply yet.'}
                                </p>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}

export function AgentsView() {
    const exchange = useUi((state) => state.agents);
    const app = useUi((state) => state.app);
    const closeAgents = useUi((state) => state.closeAgents);
    const [chosen, setChosen] = useState<Mode | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());
    const root = useRef<HTMLElement>(null);

    const tasks = useMemo(() => (app && exchange ? exchangeTasks(app.tasks, exchange) : []), [app, exchange]);
    const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
    const people = useMemo(() => {
        const panes = new Map((app?.panes ?? []).map((pane) => [pane.id, pane]));
        const labels = new Map((app?.adapters ?? []).map((adapter) => [adapter.id, adapter.label]));
        return participantsOf(tasks, panes, labels);
    }, [tasks, app]);
    const peopleById = useMemo(() => new Map(people.map((who) => [who.id, who])), [people]);
    const finished = exchange?.finished ?? false;
    const live = tasks.some((task) => !isFinished(task.status));
    const mode: Mode = chosen ?? (finished ? 'summary' : 'flow');
    const project = app?.projects.find((entry) => entry.id === exchange?.projectId);

    useEffect(() => {
        root.current?.focus();
    }, []);

    const projectId = exchange?.projectId;
    const since = exchange?.since;
    useEffect(() => {
        setChosen(null);
        setSelected(null);
    }, [projectId, since]);

    useEffect(() => {
        setChosen(null);
    }, [finished]);

    useEffect(() => {
        if (!live) {
            setNow(Date.now());
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live]);

    if (!exchange) {
        return null;
    }

    const onKeyDown = (event: React.KeyboardEvent): void => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            closeAgents();
        }
    };

    const done = tasks.filter((task) => task.status === 'done').length;
    const shown = selected !== null && peopleById.has(selected) ? selected : null;

    return (
        <section ref={root} className="agents" role="dialog" aria-label="Agents" tabIndex={-1} onKeyDown={onKeyDown}>
            <header className="agents__bar">
                <span className="agents__title">Agents</span>
                {project ? <span className="agents__project">{project.name}</span> : null}
                <span className="agents__count">
                    {people.filter((who) => who.id !== YOU).length} agents · {done} of {tasks.length} done
                </span>
                <div className="tasks__modes" role="tablist">
                    {(['flow', 'summary'] as const).map((entry) => (
                        <button
                            key={entry}
                            type="button"
                            role="tab"
                            aria-selected={mode === entry}
                            className={`tasks__mode${mode === entry ? ' is-active' : ''}`}
                            onClick={() => setChosen(entry)}
                        >
                            {entry === 'flow' ? 'Flow' : 'Summary'}
                        </button>
                    ))}
                </div>
                <span className="agents__hint">Esc closes</span>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Close"
                    title="Close (Esc)"
                    onClick={closeAgents}
                >
                    <CloseIcon size={14} />
                </button>
            </header>
            {tasks.length === 0 ? (
                <div className="tasks__empty">
                    <p className="tasks__empty-title">No agents are talking yet</p>
                    <p>This view fills in when an agent hands work to another agent.</p>
                </div>
            ) : mode === 'summary' ? (
                <Summary tasks={tasks} people={peopleById} byId={byId} now={now} />
            ) : (
                <div className="agents__body">
                    <Flow
                        key={exchange.projectId}
                        projectId={exchange.projectId}
                        tasks={tasks}
                        byId={byId}
                        people={people}
                        selected={shown}
                        now={now}
                        onSelect={setSelected}
                    />
                    <Thread tasks={tasks} people={peopleById} selected={shown} onClear={() => setSelected(null)} />
                </div>
            )}
        </section>
    );
}

// Opens the agents view of a project from the bar above the panes; its dot says agents are at work.
export function AgentsButton({ projectId }: { projectId: string | null }) {
    const openAgents = useUi((state) => state.openAgents);
    const busy = useUi((state) =>
        projectId
            ? (state.app?.tasks.some((task) => task.projectId === projectId && task.status === 'running') ?? false)
            : false,
    );
    if (!projectId) {
        return null;
    }
    return (
        <button
            type="button"
            className={`icon-button icon-button--bar agents-button${busy ? ' is-busy' : ''}`}
            title={busy ? 'Show the agents (some are working)' : 'Show the agents'}
            aria-label="Show the agents"
            onClick={() => openAgents(projectId)}
        >
            <AgentsIcon size={16} />
        </button>
    );
}
