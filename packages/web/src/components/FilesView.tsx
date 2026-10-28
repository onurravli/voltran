import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditableFile, FolderListing } from '@voltran/shared';
import { api } from '../api.ts';
import { parentPath, shownFolders, treeRows, type TreeRow } from '../files.ts';
import { IS_MAC } from '../shortcuts.ts';
import { reportError, useUi } from '../store.ts';
import { CodeEditor, type EditorHandle } from './CodeEditor.tsx';

const SAVE_KEY = IS_MAC ? '⌘S' : 'Ctrl+S';
const TREE_POLL_MS = 5000;
const FILE_POLL_MS = 3000;

interface OpenFile {
    file: EditableFile;
    revision: number;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function rowTitle(row: TreeRow): string {
    return row.kind === 'link'
        ? `${row.path}\nA link; Voltran does not follow links`
        : row.kind === 'other'
          ? `${row.path}\nNot a file`
          : row.path;
}

export function FilesView({ sessionId, focusToken = null }: { sessionId: string; focusToken?: number | null }) {
    const session = useUi((state) => state.app?.sessions.find((entry) => entry.id === sessionId));
    const status = useUi((state) => (session ? state.app?.git[session.cwd] : undefined));
    const [listings, setListings] = useState<Record<string, FolderListing>>({});
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [treeError, setTreeError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [open, setOpen] = useState<OpenFile | null>(null);
    const [openError, setOpenError] = useState<string | null>(null);
    const [disk, setDisk] = useState<EditableFile | null>(null);
    const [missing, setMissing] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [revision, setRevision] = useState(0);
    const root = useRef<HTMLElement>(null);
    const tree = useRef<HTMLElement>(null);
    const editor = useRef<EditorHandle | null>(null);
    const latest = useRef({ open, dirty });
    latest.current = { open, dirty };
    const statusKey = status ? `${status.commit}:${status.changed}:${status.staged}:${status.unstaged}:${status.untracked}` : null;

    useEffect(() => {
        if (focusToken !== null && !root.current?.contains(document.activeElement)) {
            tree.current?.focus();
        }
    }, [focusToken]);

    useEffect(() => {
        const timer = setInterval(() => {
            if (!document.hidden) {
                setRevision((value) => value + 1);
            }
        }, TREE_POLL_MS);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!dirty) {
            return;
        }
        const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);

    const readFolder = useCallback(
        (path: string): Promise<void> =>
            api.folder(sessionId, path).then(
                (listing) => {
                    setListings((current) => ({ ...current, [path]: listing }));
                    if (path === '') {
                        setTreeError(null);
                    }
                },
                (reason) => {
                    if (path === '') {
                        setTreeError(message(reason));
                    } else {
                        setExpanded((current) => new Set([...current].filter((entry) => entry !== path)));
                    }
                },
            ),
        [sessionId],
    );

    useEffect(() => {
        for (const folder of shownFolders(expanded)) {
            void readFolder(folder);
        }
    }, [readFolder, statusKey, revision]);

    const rows = useMemo(() => treeRows(listings, expanded), [listings, expanded]);

    const load = useCallback(
        (path: string): void => {
            setSelected(path);
            setOpenError(null);
            api.file(sessionId, path)
                .then((file) => {
                    setOpen((current) => ({ file, revision: (current?.revision ?? 0) + 1 }));
                    setDisk(null);
                    setMissing(false);
                })
                .catch((reason) => {
                    setOpen(null);
                    setOpenError(message(reason));
                });
        },
        [sessionId],
    );

    const save = useCallback(
        (overwrite = false): Promise<void> => {
            const current = latest.current.open;
            const snapshot = editor.current?.snapshot();
            if (!current || !snapshot || current.file.version === null) {
                return Promise.resolve();
            }
            const version = overwrite && disk?.version ? disk.version : current.file.version;
            setSaving(true);
            return api
                .saveFile(sessionId, { path: current.file.path, text: snapshot.text, version })
                .then((file) => {
                    setOpen((shown) =>
                        shown && shown.file.path === file.path ? { ...shown, file: { ...file, text: shown.file.text } } : shown,
                    );
                    editor.current?.markSaved(snapshot.id);
                    setDisk(null);
                    setMissing(false);
                })
                .catch((reason) => {
                    api.file(sessionId, current.file.path)
                        .then((file) => file.version !== current.file.version && setDisk(file))
                        .catch(() => setMissing(true));
                    throw reason;
                })
                .finally(() => setSaving(false));
        },
        [sessionId, disk],
    );

    // An agent may change the open file: the editor follows it while nothing is unsaved, and asks
    // what to keep otherwise.
    useEffect(() => {
        const path = open?.file.path;
        if (!path) {
            return;
        }
        let current = true;
        const check = (): void => {
            if (document.hidden) {
                return;
            }
            api.file(sessionId, path)
                .then((file) => {
                    const shown = latest.current.open;
                    if (!current || !shown || shown.file.path !== path) {
                        return;
                    }
                    setMissing(false);
                    if (file.version === shown.file.version) {
                        setDisk(null);
                    } else if (latest.current.dirty) {
                        setDisk(file);
                    } else {
                        setOpen({ file, revision: shown.revision + 1 });
                        setDisk(null);
                    }
                })
                .catch(() => current && setMissing(true));
        };
        const timer = setInterval(check, FILE_POLL_MS);
        return () => {
            current = false;
            clearInterval(timer);
        };
    }, [sessionId, open?.file.path]);

    const choose = (row: TreeRow): void => {
        setSelected(row.path);
        if (row.kind === 'folder') {
            const next = new Set(expanded);
            if (next.has(row.path)) {
                next.delete(row.path);
            } else {
                next.add(row.path);
                void readFolder(row.path);
            }
            setExpanded(next);
            return;
        }
        if (row.kind !== 'file' || row.path === open?.file.path) {
            return;
        }
        if (!dirty || !open) {
            load(row.path);
            return;
        }
        useUi.getState().openDialog({
            kind: 'confirm',
            title: `Save the changes to ${open.file.path}?`,
            body: 'They are lost unless you save them before opening another file.',
            action: 'Discard changes',
            onConfirm: () => load(row.path),
            alternative: { action: 'Save', onConfirm: () => save().then(() => load(row.path)) },
        });
    };

    const onTreeKey = (event: React.KeyboardEvent): void => {
        if (event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }
        const index = rows.findIndex((row) => row.path === selected);
        const row = rows[index];
        const focus = (target: TreeRow | undefined): void => {
            if (target) {
                event.preventDefault();
                setSelected(target.path);
                tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target.path)}"]`)?.focus();
            }
        };
        if (event.key === 'ArrowDown') {
            focus(rows[index + 1] ?? rows[0]);
        } else if (event.key === 'ArrowUp') {
            focus(index < 0 ? rows[0] : rows[index - 1]);
        } else if (event.key === 'ArrowRight' && row?.kind === 'folder' && !row.expanded) {
            event.preventDefault();
            choose(row);
        } else if (event.key === 'ArrowLeft' && row) {
            if (row.expanded) {
                event.preventDefault();
                choose(row);
            } else {
                focus(rows.find((entry) => entry.path === parentPath(row.path)));
            }
        }
    };

    const onKeyDown = (event: React.KeyboardEvent): void => {
        if ((IS_MAC ? event.metaKey : event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (!(event.target as Element).closest('.monaco-editor')) {
                save().catch(reportError);
            }
        }
    };

    const file = open?.file ?? null;
    const editable = file !== null && file.text !== null && !file.readOnly;

    return (
        <section ref={root} className="changes changes--pane files" aria-label="Files" tabIndex={-1} onKeyDown={onKeyDown}>
            <div className="changes__body">
                <nav ref={tree} className="changes__files files__tree" aria-label="File tree" tabIndex={-1} onKeyDown={onTreeKey}>
                    {treeError ? <div className="changes__empty">{treeError}</div> : null}
                    {listings['']?.entries.length === 0 ? <div className="changes__empty">This folder is empty.</div> : null}
                    {rows.map((row) => (
                        <button
                            key={row.path}
                            type="button"
                            data-path={row.path}
                            className={`changes__file files__row files__row--${row.kind}${row.path === open?.file.path ? ' is-selected' : ''}${row.path === selected ? ' is-cursor' : ''}`}
                            style={{ paddingLeft: `calc(8px + ${row.depth} * 14px)` }}
                            title={rowTitle(row)}
                            aria-expanded={row.kind === 'folder' ? row.expanded : undefined}
                            onClick={() => choose(row)}
                        >
                            <span className="files__twisty" aria-hidden="true">
                                {row.kind === 'folder' ? (row.expanded ? '▾' : '▸') : ''}
                            </span>
                            <span className="changes__name">{row.name}</span>
                        </button>
                    ))}
                    {Object.values(listings).some((listing) => listing.truncated) ? (
                        <div className="changes__more">Some folders have more entries than are listed.</div>
                    ) : null}
                </nav>
                <div className="changes__diff">
                    {file ? (
                        <div className="changes__file-head">
                            <span className="changes__path">{file.path}</span>
                            <span className="changes__stage">
                                {missing
                                    ? 'No longer on disk'
                                    : file.readOnly
                                      ? 'Read only: the file has another hard link'
                                      : dirty
                                        ? 'Unsaved changes'
                                        : 'Saved'}
                            </span>
                            {editable ? (
                                <button
                                    type="button"
                                    className="button button--small files__save"
                                    disabled={!dirty || saving}
                                    title={`Save (${SAVE_KEY})`}
                                    onClick={() => save().catch(reportError)}
                                >
                                    Save
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    {disk ? (
                        <div className="files__conflict" role="alert">
                            <span>The file changed on disk while you were editing it.</span>
                            <button
                                type="button"
                                className="button button--small button--ghost"
                                onClick={() => {
                                    setOpen((shown) => shown && { file: disk, revision: shown.revision + 1 });
                                    setDisk(null);
                                }}
                            >
                                Take the disk version
                            </button>
                            <button type="button" className="button button--small" onClick={() => save(true).catch(reportError)}>
                                Keep mine and save
                            </button>
                        </div>
                    ) : null}
                    {openError ? (
                        <div className="changes__empty">{openError}</div>
                    ) : !file ? (
                        <div className="changes__empty">Choose a file to open it.</div>
                    ) : file.binary ? (
                        <div className="changes__empty">A binary file, or not UTF-8; it is not shown.</div>
                    ) : file.tooLarge ? (
                        <div className="changes__empty">Too large to edit here.</div>
                    ) : (
                        <CodeEditor
                            path={file.path}
                            text={file.text ?? ''}
                            revision={open?.revision ?? 0}
                            readOnly={!editable}
                            handle={editor}
                            onDirty={setDirty}
                            onSave={() => save().catch(reportError)}
                        />
                    )}
                </div>
            </div>
        </section>
    );
}
