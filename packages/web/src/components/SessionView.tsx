import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { AdapterInfo, DropEdge, GitStatus, Layout, PaneKind, PaneView, Project, Session } from '@voltran/shared';
import { STATUS_LABEL, movePane, paneIds } from '@voltran/shared';
import { api } from '../api.ts';
import { PANE_DRAG_TYPE, dropEdgeAt } from '../drag.ts';
import { gitLabels, linkLabel, pullRequestLabel, shortPath } from '../labels.ts';
import { sessionMenu } from '../menus.ts';
import { notesFresh } from '../notes.ts';
import { FIND_STEP_KEYS, closePane, keys } from '../shortcuts.ts';
import { peekTerminal, terminalFor, type LinkState } from '../terminals.ts';
import { panesOf, reportError, useUi } from '../store.ts';
import { draggedItem, dropIntoWorkspace, endDrag, removeFromWorkspace, saveHostLayout, type PaneHost } from '../workspace-actions.ts';
import {
    BranchIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    CloseIcon,
    LinkIcon,
    MaximizeIcon,
    NotesIcon,
    OpenIcon,
    PlusIcon,
    RestartIcon,
    RestoreIcon,
    SidebarIcon,
    SplitDownIcon,
    SplitRightIcon,
    StopIcon,
} from './Icons.tsx';
import { InlineEdit, MoreMenu } from './Controls.tsx';
import { NotesDrawer } from './NotesDrawer.tsx';
import { StatusLamp } from './StatusLamp.tsx';

function paneSummary(pane: PaneView, kind: PaneKind | undefined): string {
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
            <button type="button" className="icon-button" aria-label={`Previous match (${FIND_STEP_KEYS.previous})`} title={`Previous match (${FIND_STEP_KEYS.previous})`} disabled={count === 0} onClick={() => move('previous')}>
                <ChevronUpIcon size={14} />
            </button>
            <button type="button" className="icon-button" aria-label={`Next match (${FIND_STEP_KEYS.next})`} title={`Next match (${FIND_STEP_KEYS.next})`} disabled={count === 0} onClick={() => move('next')}>
                <ChevronDownIcon size={14} />
            </button>
            <button type="button" className="icon-button" aria-label="Close (Esc)" title="Close (Esc)" onClick={close}>
                <CloseIcon size={14} />
            </button>
        </div>
    );
}

function notesHint(adapter: AdapterInfo | undefined): string {
    if (adapter?.statusSource === 'hooks') {
        return `Notes for this pane. ${adapter.label} reads them when a session starts and keeps them up to date.`;
    }
    if (adapter?.kind === 'agent') {
        return `Notes for this pane. ${adapter.label} finds them at $VOLTRAN_NOTES.`;
    }
    return 'Notes for this pane, kept until the pane is closed.';
}

// The sandbox lets a page keep its own origin, which would be Voltran's for a page Voltran serves.
function sameOrigin(url: string): boolean {
    try {
        return new URL(url).origin === window.location.origin;
    } catch {
        return true;
    }
}

function dropLabel(edge: DropEdge, joining: boolean): string {
    if (edge === 'swap') {
        return joining ? 'Place on the right' : 'Swap panes';
    }
    return `Place ${edge === 'top' ? 'above' : edge === 'bottom' ? 'below' : `on the ${edge}`}`;
}

function typingElsewhere(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.classList.contains('xterm-helper-textarea')) {
        return false;
    }
    return active.matches('input, textarea, select, [contenteditable="true"]') || active.closest('.notes, [role="dialog"]') !== null;
}

export function PaneBox({ pane, host }: { pane: PaneView; host: PaneHost }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const focused = useUi((state) => state.focusedPaneId === pane.id);
    const focusToken = useUi((state) => (state.focusedPaneId === pane.id ? state.focusToken : null));
    const maximized = useUi((state) => state.maximizedPaneId === pane.id);
    const toggleMaximize = useUi((state) => state.toggleMaximize);
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const adapter = useUi((state) => state.app?.adapters.find((entry) => entry.id === pane.adapter));
    const session = useUi((state) => state.app?.sessions.find((entry) => entry.id === pane.sessionId));
    const project = useUi((state) => state.app?.projects.find((entry) => entry.id === session?.projectId));
    const dragging = useUi((state) => state.draggingPaneId);
    const draggingSession = useUi((state) => state.draggingSessionId);
    const finding = useUi((state) => state.findPaneId === pane.id);
    const preview = pane.adapter === 'preview' ? pane.command : null;
    const hasNotes = pane.adapter !== 'subagent' && preview === null;
    const notesOpen = useUi((state) => state.notesOpen[pane.id] === true) && hasNotes;
    const [link, setLink] = useState<LinkState>('connecting');
    const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
    const [loads, setLoads] = useState(0);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const pressedOn = useRef<Element | null>(null);
    const archived = session?.archived ?? false;
    const inWorkspace = host.kind === 'workspace';
    const hosted = paneIds(host.layout);
    const joining = inWorkspace && (draggingSession !== null || (dragging !== null && !hosted.includes(dragging)));
    const canDrop = !maximized && (inWorkspace
        ? (dragging !== null && dragging !== pane.id) || draggingSession !== null
        : dragging !== null && dragging !== pane.id && !archived && hosted.includes(dragging));

    useEffect(() => {
        if (!canDrop) {
            setDropEdge(null);
        }
    }, [canDrop]);

    useEffect(() => {
        if (preview === null) {
            return;
        }
        // A click inside the frame reaches only the framed page; the window just loses focus to it.
        const onBlur = (): void => {
            setTimeout(() => {
                if (frameRef.current && document.activeElement === frameRef.current) {
                    useUi.getState().focusPane(pane.id, false);
                }
            });
        };
        window.addEventListener('blur', onBlur);
        return () => window.removeEventListener('blur', onBlur);
    }, [pane.id, preview]);

    useEffect(() => {
        const container = containerRef.current;
        if (archived || !container) {
            return;
        }
        const terminal = terminalFor(pane.id);
        terminal.mount(container);
        const offLink = terminal.onLinkState(setLink);
        const offFocus = terminal.onFocus(() => {
            useUi.getState().focusPane(pane.id, false);
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
    }, [pane.id, archived]);

    useEffect(() => {
        if (!focused) {
            return;
        }
        const terminal = peekTerminal(pane.id);
        if (terminal && document.activeElement !== terminal.term.textarea && !typingElsewhere()) {
            terminal.focus();
        }
    }, [focused, focusToken, pane.id]);

    const split = (event: ReactMouseEvent<HTMLButtonElement>, direction: 'horizontal' | 'vertical'): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        openPaneMenu({ sessionId: pane.sessionId, splitFrom: pane.id, direction, workspaceId: inWorkspace ? host.id : undefined, anchor: { x: rect.right, y: rect.bottom + 4 } });
    };

    const running = pane.pid !== null;
    const failed = pane.status === 'exited' && pane.exitCode !== null && pane.exitCode !== 0;

    const edgeOf = (event: React.DragEvent<HTMLElement>): DropEdge => {
        const rect = event.currentTarget.getBoundingClientRect();
        return dropEdgeAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    };

    const drop = (event: React.DragEvent<HTMLElement>): void => {
        event.preventDefault();
        const dragged = draggedItem(event.dataTransfer);
        const edge = edgeOf(event);
        setDropEdge(null);
        endDrag();
        if (inWorkspace) {
            if (dragged) {
                dropIntoWorkspace(host.id, dragged, pane.id, edge);
            }
            return;
        }
        if (dragged?.kind !== 'pane') {
            return;
        }
        const next = movePane(host.layout, dragged.paneId, pane.id, edge);
        if (next !== host.layout) {
            saveHostLayout(host, next);
        }
    };

    const close = (): void => (inWorkspace ? removeFromWorkspace(host.id, pane.id) : closePane(pane));

    return (
        <div className={`pane${focused ? ' is-focused' : ''}${dragging === pane.id ? ' is-dragging' : ''} pane--${pane.status}`} onMouseDown={() => useUi.getState().focusPane(pane.id, false)}>
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
                    event.dataTransfer.effectAllowed = 'copyMove';
                    useUi.getState().setDraggingPane(pane.id);
                }}
                onDragEnd={endDrag}
            >
                <StatusLamp status={pane.status} failed={failed} size="sm" />
                {inWorkspace && session ? (
                    <button
                        type="button"
                        className="pane__origin"
                        style={{ '--project-color': project?.color ?? '#7aa2f7' } as React.CSSProperties}
                        title={`Open ${session.title}`}
                        onClick={() => {
                            useUi.getState().selectSession(session.id);
                            useUi.getState().focusPane(pane.id);
                        }}
                    >
                        <span>{project ? `${project.name} / ${session.title}` : session.title}</span>
                    </button>
                ) : null}
                <InlineEdit
                    className="pane__title"
                    label="Pane name"
                    value={pane.title}
                    onSave={(title) => api.updatePane(pane.id, { title })}
                />
                {preview !== null ? (
                    <InlineEdit
                        className="pane__summary pane__address"
                        label="Page address"
                        hint="Double-click to change the address"
                        value={preview}
                        onSave={(url) => api.updatePane(pane.id, { url })}
                    />
                ) : (
                    <span className="pane__summary" title={pane.detail ?? undefined}>{paneSummary(pane, adapter?.kind)}</span>
                )}
                {hasNotes ? (
                    <button
                        type="button"
                        className={`icon-button pane__notes-toggle${pane.notes.size > 0 ? ' has-notes' : ''}${!notesOpen && notesFresh(pane.id, pane.notes) ? ' is-fresh' : ''}`}
                        aria-expanded={notesOpen}
                        title={notesOpen ? `Hide notes (${keys('⌃⌥E')})` : `Show notes (${keys('⌃⌥E')})`}
                        onClick={() => useUi.getState().toggleNotes(pane.id)}
                    >
                        <NotesIcon size={14} />
                    </button>
                ) : null}
                <div className="pane__actions">
                    <button type="button" className="icon-button" title="Split right" onClick={(event) => split(event, 'horizontal')}>
                        <SplitRightIcon size={14} />
                    </button>
                    <button type="button" className="icon-button" title="Split down" onClick={(event) => split(event, 'vertical')}>
                        <SplitDownIcon size={14} />
                    </button>
                    <button type="button" className="icon-button" title={maximized ? `Restore (${keys('⌃⌥↩')})` : `Maximize (${keys('⌃⌥↩')})`} onClick={() => toggleMaximize(pane.id)}>
                        {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
                    </button>
                    {running ? (
                        <button type="button" className="icon-button" title="Stop process" onClick={() => api.killPane(pane.id).catch(reportError)}>
                            <StopIcon size={14} />
                        </button>
                    ) : null}
                    {preview !== null ? (
                        <>
                            <button type="button" className="icon-button" title="Reload" onClick={() => setLoads((count) => count + 1)}>
                                <RestartIcon size={14} />
                            </button>
                            <a className="icon-button" href={preview} target="_blank" rel="noreferrer noopener" title="Open in a browser tab">
                                <OpenIcon size={14} />
                            </a>
                        </>
                    ) : (
                        <button
                            type="button"
                            className="icon-button"
                            title={adapter?.resumable ? 'Restart and resume the conversation' : 'Restart'}
                            onClick={() => api.restartPane(pane.id).catch(reportError)}
                        >
                            <RestartIcon size={14} />
                        </button>
                    )}
                    <button type="button" className="icon-button" title={inWorkspace ? `Remove from this workspace (${keys('⌃⌥W')})` : `Close pane (${keys('⌃⌥W')})`} onClick={close}>
                        <CloseIcon size={14} />
                    </button>
                </div>
            </div>
            <div className={`pane__body${notesOpen ? ' pane__body--notes' : ''}`}>
                {archived ? (
                    <div className="pane__placeholder">Archived. Restore the session to resume this pane.</div>
                ) : preview !== null ? (
                    sameOrigin(preview) ? (
                        <div className="pane__placeholder">Voltran does not preview itself.</div>
                    ) : (
                        <iframe
                            key={`${preview}#${loads}`}
                            ref={frameRef}
                            className="pane__frame"
                            src={preview}
                            title={pane.title}
                            referrerPolicy="no-referrer"
                            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
                        />
                    )
                ) : (
                    <div className="pane__terminal" ref={containerRef} />
                )}
                {notesOpen ? <NotesDrawer pane={pane} agent={adapter?.kind === 'agent' ? adapter.label : null} hint={notesHint(adapter)} /> : null}
                {finding && !archived ? <FindBar paneId={pane.id} /> : null}
                {canDrop ? (
                    <div
                        className="pane__drop"
                        onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = joining ? 'copy' : 'move';
                            setDropEdge(edgeOf(event));
                        }}
                        onDragLeave={() => setDropEdge(null)}
                        onDrop={drop}
                    >
                        {dropEdge ? (
                            <div className={`pane__drop-zone pane__drop-zone--${dropEdge}`}>
                                <span>{dropLabel(dropEdge, joining)}</span>
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {link === 'reconnecting' && !archived ? <div className="pane__chip">Reconnecting…</div> : null}
                {link === 'gone' ? <div className="pane__chip">This pane was removed</div> : null}
                {pane.status === 'exited' && !archived ? (
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

export function setSizesAt(layout: Layout, path: number[], sizes: number[]): Layout {
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

export function LayoutNode({ node, path, host, panes, onSizes }: {
    node: Layout;
    path: number[];
    host: PaneHost;
    panes: Map<string, PaneView>;
    onSizes: (path: number[], sizes: number[]) => void;
}) {
    if (node.type === 'pane') {
        const pane = panes.get(node.paneId);
        return pane ? <PaneBox pane={pane} host={host} /> : <div className="pane pane--missing" />;
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
                        <LayoutNode node={child} path={[...path, index]} host={host} panes={panes} onSizes={onSizes} />
                    </Panel>
                </Fragment>
            ))}
        </Group>
    );
}

function GitChips({ status, sessionId }: { status: GitStatus; sessionId: string }) {
    const labels = gitLabels(status);
    const pr = status.pullRequest;
    const prLabel = pr ? pullRequestLabel(pr) : null;
    return (
        <>
            <span className="git-chip" title={labels.detail}>
                <BranchIcon size={13} />
                <span className="git-chip__branch">{labels.branch}</span>
                {labels.sync ? <span className="git-chip__sync">{labels.sync}</span> : null}
                {labels.changes ? (
                    <button
                        type="button"
                        className={`git-count${status.conflicted > 0 ? ' git-count--conflict' : ''}`}
                        title={`Show the changes (${keys('⌃⌥G')})`}
                        onClick={() => useUi.getState().openChanges(sessionId)}
                    >
                        {labels.changes}
                    </button>
                ) : null}
            </span>
            {pr && prLabel ? (
                <a className={`git-pr git-pr--${pr.state}`} href={pr.url} target="_blank" rel="noreferrer noopener" title={prLabel.title}>
                    {prLabel.text}
                    {prLabel.mark ? <span className={`git-pr__checks git-pr__checks--${pr.checks}`}>{prLabel.mark}</span> : null}
                </a>
            ) : null}
        </>
    );
}

function SessionHeader({ session, project }: { session: Session; project: Project | undefined }) {
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const sidebarHidden = useUi((state) => state.sidebarHidden);
    const toggleSidebar = useUi((state) => state.toggleSidebar);
    const projectWorking = useUi((state) => {
        const sessionIds = new Set(state.app?.sessions
            .filter((entry) => entry.projectId === session.projectId && !entry.archived)
            .map((entry) => entry.id));
        return state.app?.panes.some((pane) => pane.status === 'working' && sessionIds.has(pane.sessionId)) ?? false;
    });
    const git = useUi((state) => state.app?.git[session.cwd]);
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

    const linkRequested = useUi((state) => state.linkEditSessionId === session.id);
    const editLink = (): void => {
        setLinkDraft(session.link ?? '');
        setEditingLink(true);
    };

    useEffect(() => {
        if (linkRequested) {
            useUi.getState().editSessionLink(null);
            editLink();
        }
    }, [linkRequested]);

    return (
        <header className={`session-header${projectWorking ? ' session-header--working' : ''}`} style={{ '--project-color': project?.color ?? '#7aa2f7' } as React.CSSProperties}>
            <button
                type="button"
                className="icon-button icon-button--bar"
                title={sidebarHidden ? `Show the sidebar (${keys('⌃⌥B')})` : `Hide the sidebar (${keys('⌃⌥B')})`}
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
                    className={`session-header__title${session.titleSource === 'pending' ? ' title--pending' : ''}`}
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
            {git ? <GitChips status={git} sessionId={session.id} /> : null}
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
                <MoreMenu label="Session actions" items={() => sessionMenu(session, { rename: () => setRenaming(true), editLink }, 'header')} />
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
    const host: PaneHost = { kind: 'session', id: session.id, layout: session.layout };

    const onSizes = (path: number[], sizes: number[]): void => {
        if (session.layout) {
            saveHostLayout(host, setSizesAt(session.layout, path, sizes));
        }
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
                    <PaneBox pane={maximized} host={host} />
                ) : session.layout ? (
                    <LayoutNode node={session.layout} path={[]} host={host} panes={panes} onSizes={onSizes} />
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
