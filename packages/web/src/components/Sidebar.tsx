import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { PaneView, Project, Session, SubagentView, Workspace } from '@voltran/shared';
import { PROJECT_COLORS, aggregateStatus, needsAttention, paneIds } from '@voltran/shared';
import { api } from '../api.ts';
import { PANE_DRAG_TYPE, SESSION_DRAG_TYPE } from '../drag.ts';
import { enableNotifications, notificationsSupported, revealPane } from '../notify.ts';
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STEP, draggedSidebarWidth } from '../sidebar.ts';
import { attentionPanes, panesOf, reportError, useUi } from '../store.ts';
import { createWorkspace, draggedItem, dropIntoWorkspace, endDrag } from '../workspace-actions.ts';
import { workspaceStatus } from '../workspaces.ts';
import { InlineEdit, MoreMenu } from './Controls.tsx';
import { BellIcon, ChevronIcon, FolderIcon, KeyboardIcon, LinkIcon, PlusIcon, VoltranMark } from './Icons.tsx';
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
    const open = (agent: SubagentView, paneId: string): void => {
        api.viewSubagent(paneId, agent.id)
            .then((pane) => revealPane(session.id, pane.id))
            .catch(reportError);
    };
    return (
        <ul className="subagents" aria-label="Running subagents">
            {agents.map(({ agent, paneId }) => (
                <li key={agent.id}>
                    <button
                        type="button"
                        className="subagent-row"
                        title={`${agent.description} · ${agent.type}${agent.background ? ' · in the background' : ''} · open in a pane`}
                        onClick={() => open(agent, paneId)}
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

function PaneList({ session, panes }: { session: Session; panes: PaneView[] }) {
    const order = paneIds(session.layout);
    const sorted = [...panes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return (
        <ul className="subagents" aria-label={`Panes of ${session.title}`}>
            {sorted.map((pane) => (
                <li key={pane.id}>
                    <button
                        type="button"
                        className="subagent-row pane-row"
                        title="Drag onto a workspace to show it there"
                        draggable
                        onDragStart={(event) => {
                            event.dataTransfer.setData(PANE_DRAG_TYPE, pane.id);
                            event.dataTransfer.effectAllowed = 'copyMove';
                            useUi.getState().setDraggingPane(pane.id);
                        }}
                        onDragEnd={endDrag}
                        onClick={() => revealPane(session.id, pane.id)}
                    >
                        <StatusLamp status={pane.status} size="sm" />
                        <span className="subagent-row__label">{pane.title}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

function SessionRow({ session, panes }: { session: Session; panes: PaneView[] }) {
    const selected = useUi((state) => state.selectedSessionId === session.id);
    const selectSession = useUi((state) => state.selectSession);
    const expanded = useUi((state) => Boolean(state.expandedSessions[session.id]));
    const toggleSessionPanes = useUi((state) => state.toggleSessionPanes);
    const accepts = useUi((state) => {
        const moving = state.draggingPaneId ? state.app?.panes.find((pane) => pane.id === state.draggingPaneId) : undefined;
        const from = moving ? state.app?.sessions.find((entry) => entry.id === moving.sessionId) : undefined;
        return Boolean(moving && from && moving.sessionId !== session.id && !session.archived && from.projectId === session.projectId);
    });
    const [over, setOver] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const lead = leadPane(panes);
    const status = lead?.status ?? null;
    const failed = status === 'exited' && lead?.exitCode !== 0 && lead?.exitCode !== null;
    const showDetail = lead && (needsAttention(lead.status) || lead.status === 'working') && lead.detail;
    const agents = panes.flatMap((pane) => (pane.subagents ?? []).map((agent) => ({ agent, paneId: pane.id })));

    if (renaming) {
        return (
            <li>
                <div className={`session-row${selected ? ' is-selected' : ''}`}>
                    <StatusLamp status={status} failed={failed} />
                    <InlineEdit
                        className="session-row__title"
                        label="Session name"
                        value={session.title}
                        editing
                        onEditingChange={setRenaming}
                        onSave={(title) => api.updateSession(session.id, { title })}
                    />
                </div>
            </li>
        );
    }

    return (
        <li className="session-item">
            <button
                type="button"
                className={`session-row${selected ? ' is-selected' : ''}${session.archived ? ' is-archived' : ''}${accepts ? ' is-drop-candidate' : ''}${accepts && over ? ' is-drop-target' : ''}`}
                onClick={() => selectSession(session.id)}
                onDoubleClick={() => setRenaming(true)}
                title="Double-click to rename, drag onto a workspace to show its panes there"
                draggable={panes.length > 0}
                onDragStart={(event) => {
                    event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
                    event.dataTransfer.effectAllowed = 'copy';
                    useUi.getState().setDraggingSession(session.id);
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                    if (accepts) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setOver(true);
                    }
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(event) => {
                    const moving = useUi.getState().draggingPaneId;
                    setOver(false);
                    if (!accepts || !moving) {
                        return;
                    }
                    event.preventDefault();
                    useUi.getState().setDraggingPane(null);
                    api.movePane(moving, { sessionId: session.id })
                        .then(() => useUi.getState().showToast(`Moved to ${session.title}`))
                        .catch(reportError);
                }}
                aria-current={selected ? 'true' : undefined}
            >
                <StatusLamp status={status} failed={failed} />
                <span className="session-row__text">
                    <span className="session-row__title">{session.title}</span>
                    {showDetail ? <span className="session-row__detail">{lead.detail}</span> : null}
                </span>
                {session.link ? <LinkIcon size={13} className="session-row__link" /> : null}
            </button>
            {panes.length > 0 ? (
                <button
                    type="button"
                    className="session-item__expand"
                    aria-expanded={expanded}
                    aria-label={expanded ? `Hide the panes of ${session.title}` : `Show the panes of ${session.title}`}
                    title={expanded ? 'Hide panes' : 'Show panes, to drag one onto a workspace'}
                    onClick={() => toggleSessionPanes(session.id)}
                >
                    <ChevronIcon size={11} className={`project__chevron${expanded ? ' is-open' : ''}`} />
                </button>
            ) : null}
            {expanded && panes.length > 0 ? <PaneList session={session} panes={panes} /> : null}
            {agents.length > 0 ? <SubagentList session={session} agents={agents} /> : null}
        </li>
    );
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
    const app = useUi((state) => state.app);
    const selected = useUi((state) => state.selectedWorkspaceId === workspace.id);
    const selectWorkspace = useUi((state) => state.selectWorkspace);
    const accepts = useUi((state) => state.draggingPaneId !== null || state.draggingSessionId !== null);
    const [over, setOver] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const status = workspaceStatus(app, workspace);
    const count = paneIds(workspace.layout).length;

    if (renaming) {
        return (
            <li>
                <div className={`session-row${selected ? ' is-selected' : ''}`}>
                    <StatusLamp status={status} />
                    <InlineEdit
                        className="session-row__title"
                        label="Workspace name"
                        value={workspace.title}
                        editing
                        onEditingChange={setRenaming}
                        onSave={(title) => api.updateWorkspace(workspace.id, { title })}
                    />
                </div>
            </li>
        );
    }

    return (
        <li>
            <button
                type="button"
                className={`session-row${selected ? ' is-selected' : ''}${accepts ? ' is-drop-candidate' : ''}${accepts && over ? ' is-drop-target' : ''}`}
                onClick={() => selectWorkspace(workspace.id)}
                onDoubleClick={() => setRenaming(true)}
                title="Double-click to rename"
                onDragOver={(event) => {
                    if (accepts) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'copy';
                        setOver(true);
                    }
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(event) => {
                    setOver(false);
                    const dragged = draggedItem(event.dataTransfer);
                    endDrag();
                    if (dragged) {
                        event.preventDefault();
                        dropIntoWorkspace(workspace.id, dragged, null, 'swap');
                    }
                }}
                aria-current={selected ? 'true' : undefined}
            >
                <StatusLamp status={status} />
                <span className="session-row__text">
                    <span className="session-row__title">{workspace.title}</span>
                    <span className="session-row__detail">{count === 0 ? 'Drag panes here' : count === 1 ? '1 pane' : `${count} panes`}</span>
                </span>
            </button>
        </li>
    );
}

function Workspaces() {
    const workspaces = useUi((state) => state.app?.workspaces);

    return (
        <section className="workspaces" aria-label="Workspaces">
            <div className="project__header">
                <span className="workspaces__heading">Workspaces</span>
                <div className="project__actions">
                    <button type="button" className="icon-button" title="New workspace: panes from any project, side by side" onClick={createWorkspace}>
                        <PlusIcon size={14} />
                    </button>
                </div>
            </div>
            {workspaces && workspaces.length > 0 ? (
                <ul className="project__sessions">
                    {workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
                </ul>
            ) : null}
        </section>
    );
}

function ProjectGroup({ project, sessions }: { project: Project; sessions: Session[] }) {
    const app = useUi((state) => state.app);
    const collapsed = useUi((state) => Boolean(state.collapsedProjects[project.id]));
    const toggleProject = useUi((state) => state.toggleProject);
    const openDialog = useUi((state) => state.openDialog);
    const [renaming, setRenaming] = useState(false);
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
                {renaming ? (
                    <div className="project__toggle">
                        <ChevronIcon size={12} className={`project__chevron${collapsed ? '' : ' is-open'}`} />
                        <InlineEdit
                            className="project__name"
                            label="Project name"
                            value={project.name}
                            editing
                            onEditingChange={setRenaming}
                            onSave={(name) => api.updateProject(project.id, { name })}
                        />
                    </div>
                ) : (
                    <button
                        type="button"
                        className="project__toggle"
                        onClick={() => toggleProject(project.id)}
                        onDoubleClick={() => setRenaming(true)}
                        aria-expanded={!collapsed}
                        title={`${project.path}\nDouble-click to rename`}
                    >
                        <ChevronIcon size={12} className={`project__chevron${collapsed ? '' : ' is-open'}`} />
                        <span className="project__name">{project.name}</span>
                        {collapsed && waiting > 0 ? <span className="project__waiting">{waiting}</span> : null}
                    </button>
                )}
                <div className="project__actions">
                    <button type="button" className="icon-button" title={`New session in ${project.name}`} onClick={() => openDialog({ kind: 'session', projectId: project.id })}>
                        <PlusIcon size={14} />
                    </button>
                    <MoreMenu
                        small
                        label={`${project.name} actions`}
                        items={[
                            { label: 'Rename', onSelect: () => setRenaming(true) },
                            {
                                label: 'Colour',
                                swatches: PROJECT_COLORS,
                                selected: project.color,
                                onPick: (color) => api.updateProject(project.id, { color }).catch(reportError),
                            },
                            { label: 'Remove project…', danger: true, separated: true, onSelect: remove },
                        ]}
                    />
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

function SidebarResizer() {
    const width = useUi((state) => state.sidebarWidth);
    const outward = useUi((state) => (state.sidebarPosition === 'right' ? -1 : 1));
    const setSidebarWidth = useUi((state) => state.setSidebarWidth);
    const toggleSidebar = useUi((state) => state.toggleSidebar);
    const canClose = useUi((state) => Boolean(state.app?.sessions.some((session) => session.id === state.selectedSessionId)
        || state.app?.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)));
    const drag = useRef<{ x: number; width: number } | null>(null);
    const [dragging, setDragging] = useState(false);

    const start = (event: PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        setDragging(true);
    };
    const end = (): void => {
        drag.current = null;
        setDragging(false);
    };
    const step = (event: KeyboardEvent<HTMLDivElement>): void => {
        const delta = event.key === 'ArrowLeft' ? -SIDEBAR_WIDTH_STEP : event.key === 'ArrowRight' ? SIDEBAR_WIDTH_STEP : 0;
        if (delta !== 0) {
            event.preventDefault();
            setSidebarWidth(width + delta * outward);
        }
    };

    return (
        <div
            className={`sidebar__resizer${dragging ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Sidebar width"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            title="Drag to resize, double-click to reset"
            onPointerDown={start}
            onPointerMove={(event) => {
                if (!drag.current) {
                    return;
                }
                const next = draggedSidebarWidth(drag.current.width + (event.clientX - drag.current.x) * outward);
                if (next !== null) {
                    setSidebarWidth(next);
                } else if (canClose) {
                    setSidebarWidth(drag.current.width);
                    end();
                    toggleSidebar();
                } else {
                    setSidebarWidth(MIN_SIDEBAR_WIDTH);
                }
            }}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
            onKeyDown={step}
        />
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
                    className="button button--bar"
                    onClick={() => openDialog({ kind: projects.length === 0 ? 'project' : 'session' })}
                    title="Start a new session (⌃⌥N)"
                >
                    <PlusIcon size={13} /> Session
                </button>
            </header>

            <nav className="sidebar__projects" aria-label="Projects and sessions">
                <Workspaces />
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
            <SidebarResizer />
        </aside>
    );
}
