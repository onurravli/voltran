import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { PaneView, Project, Session, SubagentView, Workspace } from '@voltran/shared';
import { aggregateStatus, needsAttention, paneIds } from '@voltran/shared';
import { api } from '../api.ts';
import { PANE_DRAG_TYPE, PROJECT_DRAG_TYPE, SESSION_DRAG_TYPE } from '../drag.ts';
import { enableNotifications, notificationsSupported, revealPane } from '../notify.ts';
import {
    DEFAULT_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    SIDEBAR_WIDTH_STEP,
    draggedSidebarWidth,
    dropBefore,
    dropSide,
    type DropSide,
} from '../sidebar.ts';
import { gitLabels } from '../labels.ts';
import { paneMenu, projectMenu, sessionMenu, sidebarMenu, workspaceMenu } from '../menus.ts';
import { keys, orderedSessions, togglePalette } from '../shortcuts.ts';
import { attentionPanes, panesOf, reportError, useUi } from '../store.ts';
import { isReset, resetCountdown, usageLevel, usageRows } from '../usage.ts';
import { createWorkspace, draggedItem, dropIntoWorkspace, endDrag } from '../workspace-actions.ts';
import { workspaceStatus } from '../workspaces.ts';
import { ContextMenuArea, InlineEdit, MoreMenu, type MenuItem } from './Controls.tsx';
import { BellIcon, BranchIcon, ChevronIcon, FolderIcon, KeyboardIcon, LinkIcon, PlusIcon, SearchIcon, VoltranMark } from './Icons.tsx';
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

function sideOf(event: DragEvent<HTMLElement>): DropSide {
    const rect = event.currentTarget.getBoundingClientRect();
    return dropSide(event.clientY - rect.top, rect.height);
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
                    <ContextMenuArea label={agent.description} items={() => [{ label: 'Open in a pane', onSelect: () => open(agent, paneId) }]}>
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
                    </ContextMenuArea>
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
                    <ContextMenuArea label={pane.title} items={() => paneMenu(pane)}>
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
                    </ContextMenuArea>
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
    const reorders = useUi((state) => {
        const moving = state.reordering?.kind === 'session' ? state.app?.sessions.find((entry) => entry.id === state.reordering?.id) : undefined;
        return Boolean(moving && moving.id !== session.id && moving.projectId === session.projectId);
    });
    const worktreeBranch = useUi((state) => (session.worktree ? state.app?.git[session.cwd]?.branch ?? null : null));
    const [over, setOver] = useState(false);
    const [side, setSide] = useState<DropSide | null>(null);
    const [renaming, setRenaming] = useState(false);
    const lead = leadPane(panes);
    const status = lead?.status ?? null;
    const failed = status === 'exited' && lead?.exitCode !== 0 && lead?.exitCode !== null;
    const showDetail = lead && (needsAttention(lead.status) || lead.status === 'working') && lead.detail;
    const agents = panes.flatMap((pane) => (pane.subagents ?? []).map((agent) => ({ agent, paneId: pane.id })));

    useEffect(() => {
        if (!reorders) {
            setSide(null);
        }
    }, [reorders]);

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
            <ContextMenuArea
                label={session.title}
                items={() => sessionMenu(session, { rename: () => setRenaming(true), editLink: () => useUi.getState().editSessionLink(session.id) }, 'sidebar')}
            >
                <button
                    type="button"
                    className={`session-row${selected ? ' is-selected' : ''}${session.archived ? ' is-archived' : ''}${accepts ? ' is-drop-candidate' : ''}${accepts && over ? ' is-drop-target' : ''}${reorders && side ? ` is-drop-${side}` : ''}`}
                    onClick={() => selectSession(session.id)}
                    onDoubleClick={() => setRenaming(true)}
                    title="Double-click to rename. Drag to reorder, or onto a workspace to show its panes there"
                    draggable
                    onDragStart={(event) => {
                        event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
                        event.dataTransfer.effectAllowed = 'copyMove';
                        const ui = useUi.getState();
                        ui.setReordering({ kind: 'session', id: session.id });
                        if (panes.length > 0) {
                            ui.setDraggingSession(session.id);
                        }
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(event) => {
                        if (accepts) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            setOver(true);
                        } else if (reorders) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            setSide(sideOf(event));
                        }
                    }}
                    onDragLeave={() => {
                        setOver(false);
                        setSide(null);
                    }}
                    onDrop={(event) => {
                        const { draggingPaneId: moving, reordering, app, showArchived } = useUi.getState();
                        setOver(false);
                        setSide(null);
                        if (reorders && reordering) {
                            event.preventDefault();
                            endDrag();
                            const siblings = orderedSessions(app, showArchived).filter((entry) => entry.projectId === session.projectId).map((entry) => entry.id);
                            api.updateSession(reordering.id, { moveBefore: dropBefore(siblings, session.id, sideOf(event)) }).catch(reportError);
                            return;
                        }
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
                        <span className={`session-row__title${session.titleSource === 'pending' ? ' title--pending' : ''}`}>{session.title}</span>
                        {showDetail ? (
                            <span className="session-row__detail">{lead.detail}</span>
                        ) : worktreeBranch ? (
                            <span className="session-row__detail session-row__branch" title={`Works in its own worktree: ${session.worktree}`}>
                                <BranchIcon size={11} />
                                <span className="session-row__branch-name">{worktreeBranch}</span>
                            </span>
                        ) : null}
                    </span>
                    {session.link ? <LinkIcon size={13} className="session-row__link" /> : null}
                </button>
            </ContextMenuArea>
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
            <ContextMenuArea label={workspace.title} items={() => workspaceMenu(workspace, () => setRenaming(true), 'sidebar')}>
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
            </ContextMenuArea>
        </li>
    );
}

function Workspaces() {
    const workspaces = useUi((state) => state.app?.workspaces);

    if (!workspaces || workspaces.length === 0) {
        return null;
    }
    return (
        <section className="workspaces" aria-label="Workspaces">
            <div className="sidebar-section">
                <span className="workspaces__heading">Workspaces</span>
                <button type="button" className="icon-button" title="New workspace: panes from any project, side by side" onClick={createWorkspace}>
                    <PlusIcon size={13} />
                </button>
            </div>
            <ul className="project__sessions">
                {workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
            </ul>
        </section>
    );
}

function ProjectGroup({ project, sessions }: { project: Project; sessions: Session[] }) {
    const app = useUi((state) => state.app);
    const collapsed = useUi((state) => Boolean(state.collapsedProjects[project.id]));
    const git = useUi((state) => state.app?.git[project.path]);
    const gitLabel = git ? gitLabels(git) : null;
    const toggleProject = useUi((state) => state.toggleProject);
    const openDialog = useUi((state) => state.openDialog);
    const reorders = useUi((state) => state.reordering?.kind === 'project' && state.reordering.id !== project.id);
    const [side, setSide] = useState<DropSide | null>(null);
    const [renaming, setRenaming] = useState(false);
    const waiting = sessions.filter((session) => panesOf(app, session.id).some((pane) => needsAttention(pane.status))).length;

    useEffect(() => {
        if (!reorders) {
            setSide(null);
        }
    }, [reorders]);

    const menu = (): MenuItem[] => projectMenu(project, () => setRenaming(true));

    return (
        <section
            className={`project${reorders && side ? ` is-drop-${side}` : ''}`}
            style={{ '--project-color': project.color } as React.CSSProperties}
            onDragOver={(event) => {
                if (reorders) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setSide(sideOf(event));
                }
            }}
            onDragLeave={() => setSide(null)}
            onDrop={(event) => {
                const { reordering, app: current } = useUi.getState();
                setSide(null);
                if (!reorders || !reordering) {
                    return;
                }
                event.preventDefault();
                endDrag();
                const ids = (current?.projects ?? []).map((entry) => entry.id);
                api.updateProject(reordering.id, { moveBefore: dropBefore(ids, project.id, sideOf(event)) }).catch(reportError);
            }}
        >
            <ContextMenuArea label={project.name} items={menu}>
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
                            title={`${project.path}\nDouble-click to rename, drag to reorder`}
                            draggable
                            onDragStart={(event) => {
                                event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
                                event.dataTransfer.effectAllowed = 'move';
                                useUi.getState().setReordering({ kind: 'project', id: project.id });
                            }}
                            onDragEnd={endDrag}
                        >
                            <ChevronIcon size={12} className={`project__chevron${collapsed ? '' : ' is-open'}`} />
                            <span className="project__name">{project.name}</span>
                            {collapsed && waiting > 0 ? <span className="project__waiting">{waiting}</span> : null}
                            {gitLabel ? (
                                <span className="project__git" title={gitLabel.detail}>
                                    <span className="project__git-branch">{gitLabel.branch}</span>
                                    {gitLabel.changes ? <span className={`git-count${git?.conflicted ? ' git-count--conflict' : ''}`}>{gitLabel.changes}</span> : null}
                                </span>
                            ) : null}
                        </button>
                    )}
                    <div className="project__actions">
                        <button type="button" className="icon-button" title={`New session in ${project.name}`} onClick={() => openDialog({ kind: 'session', projectId: project.id })}>
                            <PlusIcon size={14} />
                        </button>
                        <MoreMenu small label={`${project.name} actions`} items={menu} />
                    </div>
                </div>
            </ContextMenuArea>
            {collapsed ? null : sessions.length === 0 ? (
                <button type="button" className="project__empty" onClick={() => openDialog({ kind: 'session', projectId: project.id })}>
                    <PlusIcon size={12} /> New session
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
        return null;
    }

    return (
        <section className="inbox" aria-label="Needs you">
            <h2 className="inbox__heading">
                Needs you <span className="inbox__count">{queue.length}</span>
            </h2>
            <ul className="inbox__list">
                {queue.map((pane) => (
                    <li key={pane.id}>
                        <ContextMenuArea label={pane.title} items={() => paneMenu(pane)}>
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
                        </ContextMenuArea>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function UsageMeters() {
    const usage = useUi((state) => state.app?.usage ?? null);
    const now = useNow(30_000);
    const rows = usageRows(usage);

    if (rows.length === 0) {
        return null;
    }

    return (
        <div className="usage" aria-label="Claude usage limits">
            {rows.map(({ label, name, window }) => {
                const reset = isReset(window, now);
                const percent = Math.round(window.usedPercent);
                const resetsAt = window.resetsAt === null ? '' : `, resets ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
                return (
                    <div key={label} className="usage__row" title={reset ? `${name} has reset` : `${name}: ${percent}% used${resetsAt}`}>
                        <span className="usage__label">{label}</span>
                        <span
                            className={`usage__bar usage__bar--${usageLevel(percent)}`}
                            role="meter"
                            aria-label={name}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={reset ? 0 : percent}
                            aria-valuetext={reset ? 'reset' : `${percent}% used`}
                        >
                            <span className="usage__fill" style={{ width: `${reset ? 0 : window.usedPercent}%` }} />
                        </span>
                        <span className="usage__percent">{reset ? '' : `${percent}%`}</span>
                        <span className="usage__reset">{reset ? 'reset' : window.resetsAt === null ? '' : resetCountdown(window.resetsAt, now)}</span>
                    </div>
                );
            })}
        </div>
    );
}

function Footer() {
    const connection = useUi((state) => state.connection);
    const showArchived = useUi((state) => state.showArchived);
    const setShowArchived = useUi((state) => state.setShowArchived);
    const openDialog = useUi((state) => state.openDialog);
    const archivedCount = useUi((state) => state.app?.sessions.filter((session) => session.archived).length ?? 0);
    const quiet = useUi((state) => attentionPanes(state.app).length === 0);
    const [permission, setPermission] = useState(() => (notificationsSupported() ? Notification.permission : 'denied'));

    return (
        <footer className="sidebar__footer">
            <UsageMeters />
            {connection === 'offline' ? <span className="connection connection--offline">Reconnecting to the daemon…</span> : null}
            <div className="sidebar__footer-row">
                {quiet && connection !== 'offline' ? <span className="sidebar__quiet">Nothing needs you</span> : null}
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
                <button type="button" className="icon-button sidebar__keys" title={`Keyboard shortcuts (${keys('⌃⌥/')})`} onClick={() => openDialog({ kind: 'shortcuts' })}>
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

// A shortcut shown as separate keys, so ⌘K reads as two caps and Ctrl+Shift+K as three.
export function Hotkey({ keys: label }: { keys: string }) {
    const parts = label.includes('+') ? label.split('+').filter(Boolean) : [...label];
    return (
        <span className="hotkey" aria-hidden="true">
            {parts.map((part, index) => <kbd key={index}>{part}</kbd>)}
        </span>
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
                    <VoltranMark size={18} form />
                    <span>Voltran</span>
                </div>
                <button
                    type="button"
                    className="icon-button icon-button--bar"
                    onClick={() => openDialog({ kind: projects.length === 0 ? 'project' : 'session' })}
                    title={`New session (${keys('⌃⌥N')})`}
                    aria-label="New session"
                >
                    <PlusIcon size={15} />
                </button>
            </header>
            <button type="button" className="sidebar__search" onClick={togglePalette} title="Jump to a session or run a command">
                <SearchIcon size={13} />
                <span>Search or run…</span>
                <Hotkey keys={keys('⌘K')} />
            </button>

            <ContextMenuArea label="Sidebar" items={sidebarMenu} render={<nav className="sidebar__projects" aria-label="Projects and sessions" />}>
                <Workspaces />
                {projects.length > 0 ? <div className="sidebar-section"><span>Projects</span></div> : null}
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
            </ContextMenuArea>

            <Inbox />
            <Footer />
            <SidebarResizer />
        </aside>
    );
}
