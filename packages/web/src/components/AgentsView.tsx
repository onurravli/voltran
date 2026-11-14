import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isFinished, type PaneView, type SubagentView, type Task } from '@voltran/shared';
import {
    conversationOf,
    duration,
    elbow,
    type ExchangeLine,
    excerpt,
    exchangeTasks,
    type FlowBox,
    flowLinks,
    layoutFlow,
    type MessageKind,
    type Participant,
    participantsOf,
    subagentNodeId,
    summarize,
    YOU,
} from '../agents.ts';
import { api } from '../api.ts';
import { renderMarkdown } from '../markdown.ts';
import { reportError, useUi } from '../store.ts';
import { PHASE_LABEL, subagentRef, taskPhase } from '../tasks.ts';
import { CloseIcon } from './Icons.tsx';
import { StatusLamp } from './StatusLamp.tsx';

type Mode = 'flow' | 'summary';

const BOX: FlowBox = { width: 236, height: 116, gapX: 36, gapY: 72, pad: 40 };
const SUB_HEIGHT = 58;

const VERB: Record<MessageKind, string> = {
    ask: 'asked',
    question: 'asks',
    reply: 'replied to',
    failed: 'failed for',
    cancelled: 'stopped for',
};

const LONG_TEXT = 900;

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

function AgentNode({
    info,
    byId,
    at,
    selected,
    now,
    onSelect,
}: {
    info: NodeInfo;
    byId: Map<string, Task>;
    at: { x: number; y: number };
    selected: boolean;
    now: number;
    onSelect: () => void;
}) {
    const { who, own, current, said } = info;
    const phase = current ? taskPhase(current, byId) : null;
    const busy = own.reduce(
        (sum, task) => sum + (task.startedAt === null ? 0 : (task.finishedAt ?? now) - task.startedAt),
        0,
    );
    const done = own.filter((task) => task.status === 'done').length;
    return (
        <button
            type="button"
            className={`flow-node${selected ? ' is-selected' : ''}`}
            style={{ left: at.x, top: at.y, width: BOX.width, height: BOX.height }}
            onClick={onSelect}
            onDoubleClick={() => reveal(who.pane)}
            title={who.pane ? `${who.pane.title}\nDouble-click to open its pane` : undefined}
        >
            <span className="flow-node__head">
                <Avatar who={who} />
                <span className="flow-node__name">{who.name}</span>
                {who.pane ? <StatusLamp status={who.pane.status} size="sm" /> : null}
            </span>
            <span className="flow-node__state">
                {who.id === YOU
                    ? 'You'
                    : current && phase
                      ? `${PHASE_LABEL[phase]} · ${current.title}`
                      : own.length > 0
                        ? `${done} of ${own.length} done`
                        : 'Delegating'}
            </span>
            <span className="flow-node__said">{said ? excerpt(said) : ' '}</span>
            <span className="flow-node__foot">
                {own.length > 0 ? `${own.length} ${own.length === 1 ? 'task' : 'tasks'} · ${duration(busy)}` : ''}
            </span>
        </button>
    );
}

function Flow({
    tasks,
    byId,
    people,
    selected,
    now,
    onSelect,
}: {
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

    return (
        <div className="flow" onClick={(event) => event.target === event.currentTarget && onSelect(null)}>
            <div
                className="flow__canvas"
                style={{ width: layout.width, height: layout.height }}
                onClick={(event) => event.target === event.currentTarget && onSelect(null)}
            >
                <svg className="flow__edges" width={layout.width} height={layout.height} aria-hidden>
                    {links.map((link) => {
                        const from = layout.at.get(link.from);
                        const to = layout.at.get(link.to);
                        if (!from || !to) {
                            return null;
                        }
                        const tx = to.x + BOX.width / 2;
                        const lit = selected !== null && (link.from === selected || link.to === selected);
                        return (
                            <g
                                key={`${link.kind}:${link.from}:${link.to}`}
                                className={`flow-edge flow-edge--${link.kind} flow-edge--${link.status}${lit ? ' is-lit' : ''}`}
                            >
                                <title>{link.titles.join('\n')}</title>
                                <path d={elbow(from, to, BOX, link.kind === 'waits' ? 10 : 0)} />
                                <path
                                    className="flow-edge__head"
                                    d={`M ${tx - 4} ${to.y - 6} L ${tx} ${to.y} L ${tx + 4} ${to.y - 6}`}
                                />
                            </g>
                        );
                    })}
                </svg>
                {infos.map((info) => {
                    const at = layout.at.get(info.who.id);
                    return at ? (
                        <AgentNode
                            key={info.who.id}
                            info={info}
                            byId={byId}
                            at={at}
                            now={now}
                            selected={selected === info.who.id}
                            onSelect={() => onSelect(selected === info.who.id ? null : info.who.id)}
                        />
                    ) : null;
                })}
                {subagents.map(({ id, agent }) => {
                    const at = layout.at.get(id);
                    return at ? <SubagentNode key={id} id={id} agent={agent} at={at} /> : null;
                })}
            </div>
            <div className="flow__legend">
                <span className="flow__key flow__key--delegates">delegates to</span>
                <span className="flow__key flow__key--waits">waits for results</span>
                <span className="flow__key flow__key--running">running</span>
                <span className="flow__key flow__key--done">done</span>
                <span className="flow__key flow__key--failed">failed</span>
            </div>
        </div>
    );
}

function SubagentNode({ id, agent, at }: { id: string; agent: SubagentView; at: { x: number; y: number } }) {
    return (
        <button
            type="button"
            className="flow-node flow-node--sub"
            style={{ left: at.x, top: at.y, width: BOX.width, height: SUB_HEIGHT }}
            onClick={() => openSubagent(id)}
            title="Open its transcript"
        >
            <span className="flow-node__head">
                <span className="flow-node__kind">{agent.type}</span>
                <span className="lamp lamp--working lamp--sm" aria-hidden />
            </span>
            <span className="flow-node__said">{agent.description || 'Subagent'}</span>
        </button>
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
                {lines.map((line) => (
                    <Line key={line.key} line={line} people={people} />
                ))}
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
                    <Flow tasks={tasks} byId={byId} people={people} selected={shown} now={now} onSelect={setSelected} />
                    <Thread tasks={tasks} people={peopleById} selected={shown} onClear={() => setSelected(null)} />
                </div>
            )}
        </section>
    );
}
