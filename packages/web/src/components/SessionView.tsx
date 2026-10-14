import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { DropEdge, Layout, PaneView, Project, Session } from '@voltran/shared';
import { STATUS_LABEL, movePane, paneIds } from '@voltran/shared';
import { api } from '../api.ts';
import { PANE_DRAG_TYPE, dropEdgeAt } from '../drag.ts';
import { linkLabel, shortPath } from '../labels.ts';
import { closePane } from '../shortcuts.ts';
import { peekTerminal, terminalFor, type LinkState } from '../terminals.ts';
import { panesOf, reportError, useUi } from '../store.ts';
import {
    ChevronDownIcon,
    ChevronUpIcon,
    CloseIcon,
    LinkIcon,
    MaximizeIcon,
    PlusIcon,
    RestartIcon,
    RestoreIcon,
    SidebarIcon,
    SplitDownIcon,
    SplitRightIcon,
    StopIcon,
} from './Icons.tsx';
import { InlineEdit, MoreMenu, type MenuItem } from './Controls.tsx';
import { StatusLamp } from './StatusLamp.tsx';

function paneSummary(pane: PaneView, kind: 'agent' | 'shell' | 'process' | undefined): string {
    if (pane.adapter === 'subagent' && pane.status === 'running') {
        return pane.detail ?? 'Following the subagent live';
    }
    if (kind !== 'agent') {
        if (pane.status === 'exited') {
            return pane.exitCode === null ? 'Not running' : `Exited with code ${pane.exitCode}`;
        }
        if (pane.status === 'suspended') {
            return STATUS_LABEL.suspended;
        }
        return pane.foreground ? `Running ${pane.foreground}` : 'Ready';
    }
    return pane.detail ? `${STATUS_LABEL[pane.status]}: ${pane.detail}` : STATUS_LABEL[pane.status];
}

function FindBar({ paneId }: { paneId: string }) {
    const token = useUi((state) => state.findToken);
    const step = useUi((state) => state.findStep);
    const closeFind = useUi((state) => state.closeFind);
    const terminal = peekTerminal(paneId);
    const [query, setQuery] = useState(() => terminal?.lastSearch ?? '');
    const [results, setResults] = useState<{ resultIndex: number; resultCount: number } | null>(null);
    const input = useRef<HTMLInputElement>(null);
    const handledStep = useRef(step?.token);

    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, [token]);

    useEffect(() => {
        if (!terminal) {
            return;
        }
        const off = terminal.onSearchResults(setResults);
        return () => {
            off();
            terminal.clearSearch();
        };
    }, [terminal]);

    useEffect(() => {
        terminal?.find(query, 'next', true);
        if (!query) {
            setResults(null);
        }
    }, [terminal, query]);

    useEffect(() => {
        if (step && step.token !== handledStep.current) {
            handledStep.current = step.token;
            terminal?.find(query, step.direction);
        }
    }, [step, terminal, query]);

    const move = (direction: 'next' | 'previous'): void => terminal?.find(query, direction);
    const close = (): void => {
        closeFind();
        terminal?.focus();
    };

    const count = results?.resultCount ?? 0;
    const status = !query ? '' : count === 0 ? 'No matches' : results && results.resultIndex >= 0 ? `${results.resultIndex + 1} of ${count}` : `${count} matches`;

    return (
        <div className="find" role="search">
            <input
                ref={input}
                className="find__input"
                aria-label="Find in terminal"
                placeholder="Find"
                value={query}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        move(event.shiftKey ? 'previous' : 'next');
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        close();
                    }
                }}
            />
            <span className="find__count" aria-live="polite">{status}</span>
            <button type="button" className="icon-button" aria-label="Previous match (⇧⌘G)" title="Previous match (⇧⌘G)" disabled={count === 0} onClick={() => move('previous')}>
                <ChevronUpIcon size={14} />
            </button>
            <button type="button" className="icon-button" aria-label="Next match (⌘G)" title="Next match (⌘G)" disabled={count === 0} onClick={() => move('next')}>
                <ChevronDownIcon size={14} />
            </button>
            <button type="button" className="icon-button" aria-label="Close (Esc)" title="Close (Esc)" onClick={close}>
                <CloseIcon size={14} />
            </button>
        </div>
    );
}

function PaneBox({ pane, session }: { pane: PaneView; session: Session }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const focused = useUi((state) => state.focusedPaneId === pane.id);
    const maximized = useUi((state) => state.maximizedPaneId === pane.id);
    const toggleMaximize = useUi((state) => state.toggleMaximize);
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const adapter = useUi((state) => state.app?.adapters.find((entry) => entry.id === pane.adapter));
    const dragging = useUi((state) => state.draggingPaneId);
    const finding = useUi((state) => state.findPaneId === pane.id);
    const [link, setLink] = useState<LinkState>('connecting');
    const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
    const pressedOn = useRef<Element | null>(null);
    const canDrop = dragging !== null && dragging !== pane.id && !maximized && !session.archived;

    useEffect(() => {
        if (!canDrop) {
            setDropEdge(null);
        }
    }, [canDrop]);

    useEffect(() => {
        const container = containerRef.current;
        if (session.archived || !container) {
            return;
        }
        const terminal = terminalFor(pane.id);
        terminal.mount(container);
        const offLink = terminal.onLinkState(setLink);
        const offFocus = terminal.onFocus(() => {
            useUi.getState().focusPane(pane.id);
            const current = useUi.getState().app?.panes.find((entry) => entry.id === pane.id);
            if (current && (current.status === 'done' || current.status === 'needs-input')) {
                api.seenPane(pane.id).catch(() => undefined);
            }
        });
        return () => {
            offLink();
            offFocus();
            terminal.unmount();
        };
    }, [pane.id, session.archived]);

    useEffect(() => {
        if (!focused) {
            return;
        }
        const terminal = peekTerminal(pane.id);
        if (terminal && document.activeElement !== terminal.term.textarea) {
            terminal.focus();
        }
    }, [focused, pane.id]);

    const split = (event: ReactMouseEvent<HTMLButtonElement>, direction: 'horizontal' | 'vertical'): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        openPaneMenu({ sessionId: session.id, splitFrom: pane.id, direction, anchor: { x: rect.right, y: rect.bottom + 4 } });
    };

    const running = pane.pid !== null;
    const failed = pane.status === 'exited' && pane.exitCode !== null && pane.exitCode !== 0;

    const edgeOf = (event: React.DragEvent<HTMLElement>): DropEdge => {
        const rect = event.currentTarget.getBoundingClientRect();
        return dropEdgeAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    };

    const drop = (event: React.DragEvent<HTMLElement>): void => {
        event.preventDefault();
        const moving = event.dataTransfer.getData(PANE_DRAG_TYPE) || dragging;
        const edge = edgeOf(event);
        setDropEdge(null);
        useUi.getState().setDraggingPane(null);
        if (!moving) {
            return;
        }
        const next = movePane(session.layout, moving, pane.id, edge);
        if (next !== session.layout) {
            api.updateSession(session.id, { layout: next }).catch(reportError);
        }
    };

    return (
        <div className={`pane${focused ? ' is-focused' : ''}${dragging === pane.id ? ' is-dragging' : ''} pane--${pane.status}`} onMouseDown={() => useUi.getState().focusPane(pane.id)}>
            <div
                className="pane__header"
                draggable={!maximized}
                onMouseDown={(event) => {
                    pressedOn.current = event.target as Element;
                }}
                onDragStart={(event) => {
                    if (pressedOn.current?.closest('button, input')) {
                        event.preventDefault();
                        return;
                    }
                    event.dataTransfer.setData(PANE_DRAG_TYPE, pane.id);
                    event.dataTransfer.effectAllowed = 'move';
                    useUi.getState().setDraggingPane(pane.id);
                }}
                onDragEnd={() => useUi.getState().setDraggingPane(null)}
            >
                <StatusLamp status={pane.status} failed={failed} size="sm" />
                <InlineEdit
                    className="pane__title"
                    label="Pane name"
                    value={pane.title}
                    onSave={(title) => api.updatePane(pane.id, { title })}
                />
                <span className="pane__summary" title={pane.detail ?? undefined}>{paneSummary(pane, adapter?.kind)}</span>
                <div className="pane__actions">
                    <button type="button" className="icon-button" title="Split right" onClick={(event) => split(event, 'horizontal')}>
                        <SplitRightIcon size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Split down" onClick={(event) => split(event, 'vertical')}>
                        <SplitDownIcon size={14} />
                    </button>
                    <button type="button" className="icon-button" title={maximized ? 'Restore (⌃⌥↩)' : 'Maximize (⌃⌥↩)'} onClick={() => toggleMaximize(pane.id)}>
                        {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
                    </button>
                    {running ? (
                        <button type="button" className="icon-button" title="Stop process" onClick={() => api.killPane(pane.id).catch(reportError)}>
                            <StopIcon size={14} />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="icon-button"
                        title={adapter?.resumable ? 'Restart and resume the conversation' : 'Restart'}
                        onClick={() => api.restartPane(pane.id).catch(reportError)}
                    >
                        <RestartIcon size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Close pane (⌃⌥W)" onClick={() => closePane(pane)}>
                        <CloseIcon size={14} />
                    </button>
                </div>
            </div>
            <div className="pane__body">
                {session.archived ? (
                    <div className="pane__placeholder">Archived. Restore the session to resume this pane.</div>
                ) : (
                    <div className="pane__terminal" ref={containerRef} />
                )}
                {finding && !session.archived ? <FindBar paneId={pane.id} /> : null}
                {canDrop ? (
                    <div
                        className="pane__drop"
                        onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            setDropEdge(edgeOf(event));
                        }}
                        onDragLeave={() => setDropEdge(null)}
                        onDrop={drop}
                    >
                        {dropEdge ? (
                            <div className={`pane__drop-zone pane__drop-zone--${dropEdge}`}>
                                <span>{dropEdge === 'swap' ? 'Swap panes' : `Place ${dropEdge === 'top' ? 'above' : dropEdge === 'bottom' ? 'below' : `on the ${dropEdge}`}`}</span>
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {link === 'reconnecting' && !session.archived ? <div className="pane__chip">Reconnecting…</div> : null}
                {link === 'gone' ? <div className="pane__chip">This pane was removed</div> : null}
                {pane.status === 'exited' && !session.archived ? (
                    <div className={`pane__exit${failed ? ' is-failed' : ''}`}>
                        <span>{pane.exitCode === null ? (pane.detail ?? 'The process did not start.') : `Exited with code ${pane.exitCode}.`}</span>
                        <button type="button" className="button button--small" onClick={() => api.restartPane(pane.id).catch(reportError)}>
                            {adapter?.resumable ? 'Restart and resume' : 'Restart'}
                        </button>
                        <button type="button" className="button button--small button--ghost" onClick={() => closePane(pane)}>
                            Close pane
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function setSizesAt(layout: Layout, path: number[], sizes: number[]): Layout {
    if (layout.type === 'pane') {
        return layout;
    }
    if (path.length === 0) {
        return { ...layout, sizes };
    }
    const [head, ...rest] = path;
    return { ...layout, children: layout.children.map((child, index) => (index === head ? setSizesAt(child, rest, sizes) : child)) };
}

const childKey = (node: Layout): string => (node.type === 'pane' ? node.paneId : `split:${paneIds(node).join(',')}`);

function LayoutNode({ node, path, session, panes, onSizes }: {
    node: Layout;
    path: number[];
    session: Session;
    panes: Map<string, PaneView>;
    onSizes: (path: number[], sizes: number[]) => void;
}) {
    if (node.type === 'pane') {
        const pane = panes.get(node.paneId);
        return pane ? <PaneBox pane={pane} session={session} /> : <div className="pane pane--missing" />;
    }

    const ids = node.children.map(childKey);
    const defaultLayout = Object.fromEntries(ids.map((id, index) => [id, node.sizes[index]]));

    return (
        <Group
            key={ids.join('|')}
            className="split"
            orientation={node.direction}
            defaultLayout={defaultLayout}
            onLayoutChanged={(layout, meta) => {
                if (meta.isUserInteraction) {
                    onSizes(path, ids.map((id) => layout[id] ?? 0));
                }
            }}
        >
            {node.children.map((child, index) => (
                <Fragment key={ids[index]}>
                    {index > 0 ? <Separator className={`separator separator--${node.direction}`} /> : null}
                    <Panel id={ids[index]} minSize="6%" className="split__panel">
                        <LayoutNode node={child} path={[...path, index]} session={session} panes={panes} onSizes={onSizes} />
                    </Panel>
                </Fragment>
            ))}
        </Group>
    );
}

function SessionHeader({ session, project }: { session: Session; project: Project | undefined }) {
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const openDialog = useUi((state) => state.openDialog);
    const sidebarHidden = useUi((state) => state.sidebarHidden);
    const toggleSidebar = useUi((state) => state.toggleSidebar);
    const projectWorking = useUi((state) => {
        const sessionIds = new Set(state.app?.sessions
            .filter((entry) => entry.projectId === session.projectId && !entry.archived)
            .map((entry) => entry.id));
        return state.app?.panes.some((pane) => pane.status === 'working' && sessionIds.has(pane.sessionId)) ?? false;
    });
    const [renaming, setRenaming] = useState(false);
    const [editingLink, setEditingLink] = useState(false);
    const [linkDraft, setLinkDraft] = useState(session.link ?? '');

    const saveLink = (): void => {
        setEditingLink(false);
        const next = linkDraft.trim();
        if (next !== (session.link ?? '')) {
            api.updateSession(session.id, { link: next || null }).catch(reportError);
        }
    };

    const copyPath = (): void => {
        navigator.clipboard.writeText(session.cwd)
            .then(() => useUi.getState().showToast('Copied the folder path'))
            .catch(reportError);
    };

    const remove = (): void => {
        openDialog({
            kind: 'confirm',
            title: `Delete ${session.title}?`,
            body: 'Every process in this session stops and its scrollback is deleted. Agent conversations stay in their own history.',
            action: 'Delete session',
            onConfirm: () => api.deleteSession(session.id),
        });
    };

    const menu: MenuItem[] = [
        { label: 'Rename', onSelect: () => setRenaming(true) },
        {
            label: session.link ? 'Edit link' : 'Add link',
            onSelect: () => {
                setLinkDraft(session.link ?? '');
                setEditingLink(true);
            },
        },
        { label: 'Copy folder path', onSelect: copyPath },
        session.archived
            ? { label: 'Restore session', separated: true, onSelect: () => api.updateSession(session.id, { archived: false }).catch(reportError) }
            : { label: 'Archive session', note: 'stops its processes', separated: true, onSelect: () => api.updateSession(session.id, { archived: true }).catch(reportError) },
        { label: 'Delete session…', danger: true, onSelect: remove },
    ];

    return (
        <header className={`session-header${projectWorking ? ' session-header--working' : ''}`} style={{ '--project-color': project?.color ?? '#7aa2f7' } as React.CSSProperties}>
            <button
                type="button"
                className="icon-button icon-button--bar"
                title={sidebarHidden ? 'Show the sidebar (⌃⌥B)' : 'Hide the sidebar (⌃⌥B)'}
                aria-label={sidebarHidden ? 'Show the sidebar' : 'Hide the sidebar'}
                aria-pressed={!sidebarHidden}
                onClick={toggleSidebar}
            >
                <SidebarIcon size={16} />
            </button>
            <div className="session-header__crumb">
                <span className="session-header__project" title={project?.path}>{project?.name}</span>
                <span className="session-header__slash" aria-hidden="true">/</span>
                <InlineEdit
                    className="session-header__title"
                    label="Session name"
                    value={session.title}
                    editing={renaming}
                    onEditingChange={setRenaming}
                    onSave={(title) => api.updateSession(session.id, { title })}
                />
            </div>
            <button type="button" className="session-header__path" title={`${session.cwd}\nClick to copy`} onClick={copyPath}>
                {shortPath(session.cwd)}
            </button>
            {editingLink ? (
                <input
                    className="session-header__link-input"
                    aria-label="Session link"
                    placeholder="Ticket or PR URL"
                    value={linkDraft}
                    autoFocus
                    onChange={(event) => setLinkDraft(event.target.value)}
                    onBlur={saveLink}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            saveLink();
                        } else if (event.key === 'Escape') {
                            setEditingLink(false);
                        }
                    }}
                />
            ) : session.link ? (
                <a className="session-header__link" href={session.link} target="_blank" rel="noreferrer noopener" title={session.link}>
                    <LinkIcon size={13} />
                    <span>{linkLabel(session.link)}</span>
                </a>
            ) : null}
            <div className="session-header__actions">
                <button
                    type="button"
                    className="button button--bar"
                    onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        openPaneMenu({ sessionId: session.id, anchor: { x: rect.right, y: rect.bottom + 4 } });
                    }}
                >
                    <PlusIcon size={13} /> Add pane
                </button>
                <MoreMenu label="Session actions" items={menu} />
            </div>
        </header>
    );
}

export function SessionView({ session }: { session: Session }) {
    const app = useUi((state) => state.app);
    const maximizedPaneId = useUi((state) => state.maximizedPaneId);
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const project = app?.projects.find((entry) => entry.id === session.projectId);
    const panes = new Map(panesOf(app, session.id).map((pane) => [pane.id, pane]));
    const maximized = maximizedPaneId ? panes.get(maximizedPaneId) : undefined;

    const onSizes = (path: number[], sizes: number[]): void => {
        if (!session.layout) {
            return;
        }
        api.updateSession(session.id, { layout: setSizesAt(session.layout, path, sizes) }).catch(reportError);
    };

    return (
        <div className="session">
            <SessionHeader session={session} project={project} />
            {session.archived ? (
                <div className="session__banner">
                    This session is archived and its processes are stopped.
                    <button type="button" className="button button--small" onClick={() => api.updateSession(session.id, { archived: false }).catch(reportError)}>
                        Restore session
                    </button>
                </div>
            ) : null}
            <div className="session__body">
                {maximized ? (
                    <PaneBox pane={maximized} session={session} />
                ) : session.layout ? (
                    <LayoutNode node={session.layout} path={[]} session={session} panes={panes} onSizes={onSizes} />
                ) : (
                    <div className="empty">
                        <p>This session has no panes.</p>
                        <button
                            type="button"
                            className="button"
                            onClick={(event) => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                openPaneMenu({ sessionId: session.id, anchor: { x: rect.right, y: rect.bottom + 4 } });
                            }}
                        >
                            <PlusIcon size={13} /> Add pane
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
