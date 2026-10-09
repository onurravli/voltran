import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Layout, PaneView, Project, Session } from '@voltran/shared';
import { STATUS_LABEL, paneIds } from '@voltran/shared';
import { api } from '../api.ts';
import { peekTerminal, terminalFor, type LinkState } from '../terminals.ts';
import { panesOf, reportError, useUi } from '../store.ts';
import {
    ArchiveIcon,
    CloseIcon,
    LinkIcon,
    MaximizeIcon,
    PlusIcon,
    RestartIcon,
    RestoreIcon,
    SplitDownIcon,
    SplitRightIcon,
    StopIcon,
    TrashIcon,
} from './Icons.tsx';
import { StatusLamp } from './StatusLamp.tsx';

function InlineEdit({ value, onSave, className, label }: { value: string; onSave: (next: string) => Promise<unknown>; className: string; label: string }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);

    useEffect(() => {
        if (!editing) {
            setDraft(value);
        }
    }, [value, editing]);

    const commit = (): void => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== value) {
            onSave(next).catch(reportError);
        }
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            commit();
        } else if (event.key === 'Escape') {
            setEditing(false);
        }
    };

    if (editing) {
        return (
            <input
                className={`${className} inline-edit`}
                aria-label={label}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
            />
        );
    }
    return (
        <span className={className} title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
            {value}
        </span>
    );
}

function paneSummary(pane: PaneView, kind: 'agent' | 'shell' | 'process' | undefined): string {
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

function PaneBox({ pane, session }: { pane: PaneView; session: Session }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const focused = useUi((state) => state.focusedPaneId === pane.id);
    const maximized = useUi((state) => state.maximizedPaneId === pane.id);
    const toggleMaximize = useUi((state) => state.toggleMaximize);
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const openDialog = useUi((state) => state.openDialog);
    const adapter = useUi((state) => state.app?.adapters.find((entry) => entry.id === pane.adapter));
    const [link, setLink] = useState<LinkState>('connecting');

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

    const close = (): void => {
        openDialog({
            kind: 'confirm',
            title: `Close ${pane.title}?`,
            body: 'The process in this pane stops and its scrollback is deleted.',
            action: 'Close pane',
            onConfirm: () => api.deletePane(pane.id),
        });
    };

    const running = pane.pid !== null;
    const failed = pane.status === 'exited' && pane.exitCode !== null && pane.exitCode !== 0;

    return (
        <div className={`pane${focused ? ' is-focused' : ''} pane--${pane.status}`} onMouseDown={() => useUi.getState().focusPane(pane.id)}>
            <div className="pane__header">
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
                    <button type="button" className="icon-button" title="Close pane (⌃⌥W)" onClick={close}>
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
                {link === 'reconnecting' && !session.archived ? <div className="pane__chip">Reconnecting…</div> : null}
                {link === 'gone' ? <div className="pane__chip">This pane was removed</div> : null}
                {pane.status === 'exited' && !session.archived ? (
                    <div className={`pane__exit${failed ? ' is-failed' : ''}`}>
                        <span>{pane.exitCode === null ? (pane.detail ?? 'The process did not start.') : `Exited with code ${pane.exitCode}.`}</span>
                        <button type="button" className="button button--small" onClick={() => api.restartPane(pane.id).catch(reportError)}>
                            {adapter?.resumable ? 'Restart and resume' : 'Restart'}
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
    const [editingLink, setEditingLink] = useState(false);
    const [linkDraft, setLinkDraft] = useState(session.link ?? '');

    const saveLink = (): void => {
        setEditingLink(false);
        const next = linkDraft.trim();
        if (next !== (session.link ?? '')) {
            api.updateSession(session.id, { link: next || null }).catch(reportError);
        }
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

    return (
        <header className="session-header" style={{ '--project-color': project?.color ?? '#7aa2f7' } as React.CSSProperties}>
            <div className="session-header__main">
                <InlineEdit
                    className="session-header__title"
                    label="Session name"
                    value={session.title}
                    onSave={(title) => api.updateSession(session.id, { title })}
                />
                <div className="session-header__meta">
                    <span className="session-header__project">{project?.name}</span>
                    <code className="session-header__path" title={session.cwd}>{session.cwd}</code>
                    {editingLink ? (
                        <input
                            className="session-header__link-input"
                            aria-label="Session link"
                            placeholder="https://…"
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
                        <a className="session-header__link" href={session.link} target="_blank" rel="noreferrer noopener" onDoubleClick={(event) => { event.preventDefault(); setLinkDraft(session.link ?? ''); setEditingLink(true); }} title="Double-click to edit">
                            <LinkIcon size={13} /> {new URL(session.link).hostname}{new URL(session.link).pathname.replace(/\/$/, '')}
                        </a>
                    ) : (
                        <button type="button" className="text-button" onClick={() => { setLinkDraft(''); setEditingLink(true); }}>
                            <LinkIcon size={13} /> Add link
                        </button>
                    )}
                </div>
            </div>
            <div className="session-header__actions">
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
                <button
                    type="button"
                    className="icon-button"
                    title={session.archived ? 'Restore session' : 'Archive session (stops its processes)'}
                    onClick={() => api.updateSession(session.id, { archived: !session.archived }).catch(reportError)}
                >
                    <ArchiveIcon size={15} />
                </button>
                <button type="button" className="icon-button" title="Delete session" onClick={remove}>
                    <TrashIcon size={15} />
                </button>
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
