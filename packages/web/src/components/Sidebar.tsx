import { useEffect, useState } from 'react';
import type { PaneView, Project, Session, SubagentView } from '@voltran/shared';
import { aggregateStatus, needsAttention } from '@voltran/shared';
import { api } from '../api.ts';
import { enableNotifications, notificationsSupported, revealPane } from '../notify.ts';
import { attentionPanes, panesOf, reportError, useUi } from '../store.ts';
import { BellIcon, ChevronIcon, FolderIcon, KeyboardIcon, LinkIcon, PlusIcon, TrashIcon, VoltranMark } from './Icons.tsx';
import { StatusLamp } from './StatusLamp.tsx';

export function relativeTime(timestamp: number, now: number): string {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 45) {
        return 'now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}

function leadPane(panes: PaneView[]): PaneView | null {
    const status = aggregateStatus(panes.map((pane) => pane.status));
    return panes.find((pane) => pane.status === status) ?? null;
}

function SubagentList({ session, agents }: { session: Session; agents: { agent: SubagentView; paneId: string }[] }) {
    const now = useNow(15_000);
    return (
        <ul className="subagents" aria-label="Running subagents">
            {agents.map(({ agent, paneId }) => (
                <li key={agent.id}>
                    <button
                        type="button"
                        className="subagent-row"
                        title={`${agent.description} · ${agent.type}${agent.background ? ' · in the background' : ''}`}
                        onClick={() => revealPane(session.id, paneId)}
                    >
                        <StatusLamp status="working" size="sm" />
                        <span className="subagent-row__label">{agent.description}</span>
                        <span className="subagent-row__age">{relativeTime(agent.startedAt, now)}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

function SessionRow({ session, panes }: { session: Session; panes: PaneView[] }) {
    const selected = useUi((state) => state.selectedSessionId === session.id);
    const selectSession = useUi((state) => state.selectSession);
    const lead = leadPane(panes);
    const status = lead?.status ?? null;
    const showDetail = lead && (needsAttention(lead.status) || lead.status === 'working') && lead.detail;
    const agents = panes.flatMap((pane) => (pane.subagents ?? []).map((agent) => ({ agent, paneId: pane.id })));

    return (
        <li>
            <button
                type="button"
                className={`session-row${selected ? ' is-selected' : ''}${session.archived ? ' is-archived' : ''}`}
                onClick={() => selectSession(session.id)}
                aria-current={selected ? 'true' : undefined}
            >
                <StatusLamp status={status} failed={status === 'exited' && lead?.exitCode !== 0 && lead?.exitCode !== null} />
                <span className="session-row__text">
                    <span className="session-row__title">{session.title}</span>
                    {showDetail ? <span className="session-row__detail">{lead.detail}</span> : null}
                </span>
                {session.link ? <LinkIcon size={13} className="session-row__link" /> : null}
            </button>
            {agents.length > 0 ? <SubagentList session={session} agents={agents} /> : null}
        </li>
    );
}

function ProjectGroup({ project, sessions }: { project: Project; sessions: Session[] }) {
    const app = useUi((state) => state.app);
    const collapsed = useUi((state) => Boolean(state.collapsedProjects[project.id]));
    const toggleProject = useUi((state) => state.toggleProject);
    const openDialog = useUi((state) => state.openDialog);
    const waiting = sessions.filter((session) => panesOf(app, session.id).some((pane) => needsAttention(pane.status))).length;

    const remove = (): void => {
        openDialog({
            kind: 'confirm',
            title: `Remove ${project.name}?`,
            body: `Its ${sessions.length === 1 ? 'session' : `${sessions.length} sessions`} and every process in them stop. Files in ${project.path} are not touched.`,
            action: 'Remove project',
            onConfirm: () => api.deleteProject(project.id),
        });
    };

    return (
        <section className="project" style={{ '--project-color': project.color } as React.CSSProperties}>
            <div className="project__header">
                <button
                    type="button"
                    className="project__toggle"
                    onClick={() => toggleProject(project.id)}
                    aria-expanded={!collapsed}
                    title={project.path}
                >
                    <ChevronIcon size={12} className={`project__chevron${collapsed ? '' : ' is-open'}`} />
                    <span className="project__name">{project.name}</span>
                    {collapsed && waiting > 0 ? <span className="project__waiting">{waiting}</span> : null}
                </button>
                <div className="project__actions">
                    <button type="button" className="icon-button" title={`New session in ${project.name}`} onClick={() => openDialog({ kind: 'session', projectId: project.id })}>
                        <PlusIcon size={14} />
                    </button>
                    <button type="button" className="icon-button" title={`Remove ${project.name}`} onClick={remove}>
                        <TrashIcon size={14} />
                    </button>
                </div>
            </div>
            {collapsed ? null : sessions.length === 0 ? (
                <button type="button" className="project__empty" onClick={() => openDialog({ kind: 'session', projectId: project.id })}>
                    Start a session here
                </button>
            ) : (
                <ul className="project__sessions">
                    {sessions.map((session) => <SessionRow key={session.id} session={session} panes={panesOf(app, session.id)} />)}
                </ul>
            )}
        </section>
    );
}

function Inbox() {
    const app = useUi((state) => state.app);
    const now = useNow(30_000);
    const queue = attentionPanes(app);
    const sessions = new Map(app?.sessions.map((session) => [session.id, session]) ?? []);

    if (queue.length === 0) {
        return <div className="inbox inbox--quiet">Nothing needs you</div>;
    }

    return (
        <section className="inbox" aria-label="Needs you">
            <h2 className="inbox__heading">
                Needs you <span className="inbox__count">{queue.length}</span>
            </h2>
            <ul className="inbox__list">
                {queue.map((pane) => (
                    <li key={pane.id}>
                        <button type="button" className={`inbox__item inbox__item--${pane.status}`} onClick={() => revealPane(pane.sessionId, pane.id)}>
                            <StatusLamp status={pane.status} size="sm" />
                            <span className="inbox__text">
                                <span className="inbox__title">
                                    {sessions.get(pane.sessionId)?.title ?? 'Session'}
                                    <time className="inbox__time">{relativeTime(pane.statusAt, now)}</time>
                                </span>
                                <span className="inbox__detail">
                                    {pane.status === 'needs-input' ? '' : 'Finished · '}
                                    {pane.detail ?? pane.title}
                                </span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function Footer() {
    const connection = useUi((state) => state.connection);
    const showArchived = useUi((state) => state.showArchived);
    const setShowArchived = useUi((state) => state.setShowArchived);
    const openDialog = useUi((state) => state.openDialog);
    const archivedCount = useUi((state) => state.app?.sessions.filter((session) => session.archived).length ?? 0);
    const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : 'denied'));

    return (
        <footer className="sidebar__footer">
            {connection === 'offline' ? <span className="connection connection--offline">Reconnecting to the daemon…</span> : null}
            <div className="sidebar__footer-row">
                {permission === 'default' ? (
                    <button
                        type="button"
                        className="text-button"
                        onClick={() => enableNotifications().then(setPermission).catch(reportError)}
                    >
                        <BellIcon size={14} /> Turn on alerts
                    </button>
                ) : null}
                {archivedCount > 0 ? (
                    <button type="button" className="text-button" onClick={() => setShowArchived(!showArchived)}>
                        {showArchived ? 'Hide archived' : `Archived (${archivedCount})`}
                    </button>
                ) : null}
                <button type="button" className="icon-button sidebar__keys" title="Keyboard shortcuts (⌃⌥/)" onClick={() => openDialog({ kind: 'shortcuts' })}>
                    <KeyboardIcon size={15} />
                </button>
            </div>
        </footer>
    );
}

export function Sidebar() {
    const app = useUi((state) => state.app);
    const showArchived = useUi((state) => state.showArchived);
    const openDialog = useUi((state) => state.openDialog);
    const projects = app?.projects ?? [];

    return (
        <aside className="sidebar">
            <header className="sidebar__header">
                <div className="wordmark">
                    <VoltranMark />
                    <span>Voltran</span>
                </div>
                <button
                    type="button"
                    className="button button--small"
                    onClick={() => openDialog({ kind: projects.length === 0 ? 'project' : 'session' })}
                    title="Start a new session (⌃⌥N)"
                >
                    <PlusIcon size={13} /> Session
                </button>
            </header>

            <nav className="sidebar__projects" aria-label="Projects and sessions">
                {projects.map((project) => (
                    <ProjectGroup
                        key={project.id}
                        project={project}
                        sessions={app?.sessions.filter((session) => session.projectId === project.id && (showArchived || !session.archived)) ?? []}
                    />
                ))}
                <button type="button" className="add-project" onClick={() => openDialog({ kind: 'project' })}>
                    <FolderIcon size={14} /> Add project
                </button>
            </nav>

            <Inbox />
            <Footer />
        </aside>
    );
}
