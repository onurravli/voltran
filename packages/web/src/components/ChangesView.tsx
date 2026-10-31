import { useEffect, useRef, useState } from 'react';
import { paneIds, type ChangedFile, type ChangeState, type FileContents, type SessionChanges } from '@voltran/shared';
import { api } from '../api.ts';
import { shortPath } from '../labels.ts';
import { reportError, selectedWorkspace, useUi } from '../store.ts';
import { DiffEditor, type DiffStat } from './DiffEditor.tsx';
import { CloseIcon, SplitRightIcon } from './Icons.tsx';

const STATE_MARKS: Record<ChangeState, { mark: string; label: string }> = {
    modified: { mark: 'M', label: 'Modified' },
    added: { mark: 'A', label: 'Added' },
    deleted: { mark: 'D', label: 'Deleted' },
    renamed: { mark: 'R', label: 'Renamed' },
    untracked: { mark: 'U', label: 'Untracked' },
    conflicted: { mark: '!', label: 'In conflict' },
};

function stageLabel(file: ChangedFile): string {
    if (file.state === 'untracked') {
        return 'not added to git yet';
    }
    return file.staged && file.unstaged ? 'partly staged' : file.staged ? 'staged' : 'not staged';
}

function splitPath(path: string): { name: string; folder: string } {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? { name: path, folder: '' } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function openAsPane(sessionId: string): void {
    const ui = useUi.getState();
    const session = ui.app?.sessions.find((entry) => entry.id === sessionId);
    const workspace = selectedWorkspace(ui);
    const shown = workspace ? paneIds(workspace.layout) : session ? paneIds(session.layout) : [];
    const splitFrom = ui.focusedPaneId && shown.includes(ui.focusedPaneId) ? ui.focusedPaneId : undefined;
    api.createPane(sessionId, { adapter: 'changes', splitFrom, direction: 'horizontal', workspaceId: workspace?.id })
        .then((pane) => {
            ui.openChanges(null);
            ui.focusPane(pane.id);
        })
        .catch(reportError);
}

export function ChangesView({
    sessionId,
    pane = false,
    focusToken = null,
}: {
    sessionId: string;
    pane?: boolean;
    focusToken?: number | null;
}) {
    const session = useUi((state) => state.app?.sessions.find((entry) => entry.id === sessionId));
    const status = useUi((state) => (session ? state.app?.git[session.cwd] : undefined));
    const openChanges = useUi((state) => state.openChanges);
    const [changes, setChanges] = useState<SessionChanges | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [contents, setContents] = useState<FileContents | null>(null);
    const [stat, setStat] = useState<DiffStat | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [contentsError, setContentsError] = useState<string | null>(null);
    const root = useRef<HTMLElement>(null);
    const statusKey = status
        ? `${status.commit}:${status.changed}:${status.staged}:${status.unstaged}:${status.untracked}`
        : null;
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        if (!pane || (focusToken !== null && !root.current?.contains(document.activeElement))) {
            root.current?.focus();
        }
    }, [pane, focusToken]);

    // The status poll notices an agent's edits; the list is read again then, and on a timer while
    // open, since an edit to an already changed file leaves the counts as they were.
    useEffect(() => {
        const timer = setInterval(() => {
            if (!document.hidden) {
                setRevision((value) => value + 1);
            }
        }, 5000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        let current = true;
        api.changes(sessionId)
            .then((next) => {
                if (!current) {
                    return;
                }
                setChanges(next);
                setError(null);
                setSelected((path) =>
                    path && next.files.some((file) => file.path === path) ? path : (next.files[0]?.path ?? null),
                );
            })
            .catch((reason) => current && setError(message(reason)));
        return () => {
            current = false;
        };
    }, [sessionId, statusKey, revision]);

    useEffect(() => {
        if (!selected) {
            setContents(null);
            return;
        }
        let current = true;
        api.contents(sessionId, selected)
            .then((next) => {
                if (current) {
                    setContents(next);
                    setContentsError(null);
                }
            })
            .catch((reason) => current && setContentsError(message(reason)));
        return () => {
            current = false;
        };
    }, [sessionId, selected, changes]);

    useEffect(() => setStat(null), [selected]);

    const files = changes?.files ?? [];
    const step = (delta: number): void => {
        if (files.length === 0) {
            return;
        }
        const index = files.findIndex((file) => file.path === selected);
        setSelected(files[Math.min(files.length - 1, Math.max(0, index + delta))].path);
    };

    const onKeyDown = (event: React.KeyboardEvent): void => {
        if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) {
            return;
        }
        if (event.key === 'Escape' && !pane) {
            event.preventDefault();
            openChanges(null);
        } else if ((event.target as Element).closest('.monaco-editor')) {
            return;
        } else if (event.key === 'ArrowDown' || event.key === 'j') {
            event.preventDefault();
            step(1);
        } else if (event.key === 'ArrowUp' || event.key === 'k') {
            event.preventDefault();
            step(-1);
        }
    };

    const file = files.find((entry) => entry.path === selected) ?? null;
    const shown = contents && contents.path === selected ? contents : null;
    const count = changes
        ? `${files.length}${changes.truncated ? '+' : ''} ${files.length === 1 ? 'file' : 'files'}`
        : '';

    return (
        <section
            ref={root}
            className={`changes${pane ? ' changes--pane' : ''}`}
            role={pane ? 'region' : 'dialog'}
            aria-label="Changes"
            tabIndex={-1}
            onKeyDown={onKeyDown}
        >
            {pane ? null : (
                <header className="changes__bar">
                    <span className="changes__title">Changes</span>
                    {changes ? (
                        <span className="changes__root" title={changes.root}>
                            {shortPath(changes.root)}
                        </span>
                    ) : null}
                    <span className="changes__count">{count}</span>
                    <span className="changes__hint">↑↓ files · Esc closes</span>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Open in a pane"
                        title="Open in a pane"
                        onClick={() => openAsPane(sessionId)}
                    >
                        <SplitRightIcon size={14} />
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Close"
                        title="Close (Esc)"
                        onClick={() => openChanges(null)}
                    >
                        <CloseIcon size={14} />
                    </button>
                </header>
            )}
            {error ? (
                <div className="changes__empty">{error}</div>
            ) : changes && files.length === 0 ? (
                <div className="changes__empty">No changes since the last commit.</div>
            ) : (
                <div className="changes__body">
                    <nav className="changes__files" aria-label="Changed files">
                        {files.map((entry) => {
                            const { name, folder } = splitPath(entry.path);
                            const mark = STATE_MARKS[entry.state];
                            return (
                                <button
                                    key={entry.path}
                                    type="button"
                                    className={`changes__file${entry.path === selected ? ' is-selected' : ''}`}
                                    title={`${entry.oldPath ? `${entry.oldPath} → ` : ''}${entry.path}\n${mark.label}, ${stageLabel(entry)}`}
                                    onClick={() => setSelected(entry.path)}
                                >
                                    <span className={`changes__mark changes__mark--${entry.state}`}>{mark.mark}</span>
                                    <span className="changes__name">{name}</span>
                                    <span className="changes__folder">{folder}</span>
                                </button>
                            );
                        })}
                        {changes?.truncated ? (
                            <div className="changes__more">Only the first {files.length} files are listed.</div>
                        ) : null}
                    </nav>
                    <div className="changes__diff">
                        {file ? (
                            <div className="changes__file-head">
                                <span className="changes__path">
                                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                                </span>
                                <span className="changes__stage">
                                    {STATE_MARKS[file.state].label}, {stageLabel(file)}
                                </span>
                                {shown && stat ? (
                                    <span className="changes__stat">
                                        <span className="changes__added">+{stat.added}</span>{' '}
                                        <span className="changes__removed">−{stat.removed}</span>
                                    </span>
                                ) : null}
                            </div>
                        ) : null}
                        {contentsError ? (
                            <div className="changes__empty">{contentsError}</div>
                        ) : shown ? (
                            <DiffBody contents={shown} onStat={setStat} />
                        ) : null}
                    </div>
                </div>
            )}
        </section>
    );
}

function DiffBody({ contents, onStat }: { contents: FileContents; onStat: (stat: DiffStat | null) => void }) {
    if (contents.binary) {
        return <div className="changes__empty">A binary file; its contents are not shown.</div>;
    }
    if (contents.tooLarge) {
        return <div className="changes__empty">Too large to show here.</div>;
    }
    if (contents.original === contents.modified) {
        return <div className="changes__empty">No changes to the contents.</div>;
    }
    return <DiffEditor contents={contents} onStat={onStat} />;
}
