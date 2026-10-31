import {
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { DEFAULT_SETTINGS, type ChangeState, type PaneView } from '@voltran/shared';
import { api } from '../api.ts';
import {
    MAX_TREE_WIDTH,
    MIN_TREE_WIDTH,
    editorCommand,
    editorOptions,
    isSettingsTab,
    editorKeys,
    joinPath,
    nameOf,
    nameProblem,
    parentOf,
    rankFiles,
    type EditorCommand,
    type FileMatch,
} from '../editor.ts';
import { editorFor, type EditorSession, type EditorSnapshot, type EditorTab } from '../editor-session.ts';
import { editorTheme } from '../editor-theme.ts';
import { fontStack } from '../fonts.ts';
import { shortPath } from '../labels.ts';
import { IS_MAC } from '../shortcuts.ts';
import { activeThemeId, reportError, useUi } from '../store.ts';
import { themeById } from '../themes.ts';
import { ContextMenuArea, type MenuItem } from './Controls.tsx';
import { loadMonaco } from './DiffEditor.tsx';
import {
    ChevronIcon,
    CloseIcon,
    CollapseIcon,
    NewFileIcon,
    NewFolderIcon,
    RestartIcon,
    SearchIcon,
    SidebarIcon,
} from './Icons.tsx';

type Monaco = typeof import('../monaco.ts').monaco;
type CodeEditor = ReturnType<Monaco['editor']['create']>;

const GIT_MARKS: Record<ChangeState, { mark: string; label: string; folder: string }> = {
    modified: { mark: 'M', label: 'Modified', folder: 'changes' },
    added: { mark: 'A', label: 'Added', folder: 'new files' },
    deleted: { mark: 'D', label: 'Deleted', folder: 'changes' },
    renamed: { mark: 'R', label: 'Renamed', folder: 'changes' },
    untracked: { mark: 'U', label: 'Untracked', folder: 'new files' },
    conflicted: { mark: '!', label: 'In conflict', folder: 'a conflict' },
};

type Editing =
    | { mode: 'create'; parent: string; kind: 'file' | 'dir' }
    | { mode: 'rename'; path: string; folder: boolean }
    | null;

function copy(text: string, what: string): void {
    navigator.clipboard
        .writeText(text)
        .then(() => useUi.getState().showToast(`Copied the ${what}`))
        .catch(reportError);
}

function tabLabels(tabs: EditorTab[]): Map<string, string> {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
        counts.set(nameOf(tab.path), (counts.get(nameOf(tab.path)) ?? 0) + 1);
    }
    return new Map(
        tabs.map((tab) => {
            const name = nameOf(tab.path);
            const folder = parentOf(tab.path);
            return [tab.path, (counts.get(name) ?? 0) > 1 && folder ? `${name} · ${nameOf(folder)}` : name];
        }),
    );
}

export function EditorView({ pane, focusToken }: { pane: PaneView; focusToken: number | null }) {
    const session = useMemo(() => editorFor(pane.id, pane.sessionId), [pane.id, pane.sessionId]);
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const cwd = useUi((state) => state.app?.sessions.find((entry) => entry.id === pane.sessionId)?.cwd ?? '');
    const git = useUi((state) => state.app?.git[cwd]);
    const gitKey = git ? `${git.commit}:${git.changed}:${git.staged}:${git.unstaged}:${git.untracked}` : null;
    const themeId = useUi(activeThemeId);
    const font = useUi((state) => state.terminalFont);
    const settings = useUi((state) => state.settingsFile?.settings.editor ?? DEFAULT_SETTINGS.editor);
    const options = useMemo(() => editorOptions(settings, font), [settings, font]);
    const focused = useUi((state) => state.focusedPaneId === pane.id);
    const [monaco, setMonaco] = useState<Monaco | null>(null);
    const [failed, setFailed] = useState(false);
    const [editor, setEditor] = useState<CodeEditor | null>(null);
    const [quickOpen, setQuickOpen] = useState(false);
    const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
    const [dragWidth, setDragWidth] = useState<number | null>(null);
    const root = useRef<HTMLElement>(null);
    const host = useRef<HTMLDivElement>(null);
    const shown = useRef<string | null>(null);

    useEffect(() => session.setSession(pane.sessionId), [session, pane.sessionId]);

    useEffect(() => {
        let current = true;
        loadMonaco()
            .then((loaded) => current && setMonaco(loaded))
            .catch(() => current && setFailed(true));
        return () => {
            current = false;
        };
    }, []);

    useEffect(() => (monaco ? session.attach(monaco) : undefined), [monaco, session]);

    useEffect(() => {
        if (gitKey !== null) {
            session.refreshTree();
        }
    }, [gitKey, session]);

    useEffect(() => {
        if (!monaco) {
            return;
        }
        monaco.editor.defineTheme('voltran', editorTheme(themeById(themeId)));
        monaco.editor.setTheme('voltran');
    }, [monaco, themeId]);

    useEffect(() => {
        if (!monaco || !host.current) {
            return;
        }
        const created = monaco.editor.create(host.current, {
            model: null,
            theme: 'voltran',
            automaticLayout: true,
            lineNumbersMinChars: 4,
            fixedOverflowWidgets: true,
            wordBasedSuggestions: 'currentDocument',
            scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        });
        const offBlur = created.onDidBlurEditorText(() => session.focusLeft());
        const offCursor = created.onDidChangeCursorPosition((event) =>
            setCursor({ line: event.position.lineNumber, column: event.position.column }),
        );
        setEditor(created);
        return () => {
            offCursor.dispose();
            offBlur.dispose();
            if (shown.current) {
                session.keepViewState(shown.current, created.saveViewState());
            }
            shown.current = null;
            created.setModel(null);
            created.dispose();
            setEditor(null);
        };
    }, [monaco, session]);

    useEffect(() => {
        editor?.updateOptions({ ...options, fontFamily: fontStack(options.fontFamily) });
    }, [editor, options]);

    useEffect(() => session.setPreferences(settings), [session, settings]);

    const activeTab = session.tab(snapshot.active);
    const settingsTab = snapshot.active !== null && isSettingsTab(snapshot.active);
    const settingsPath = useUi((state) => state.settingsFile?.path ?? 'settings.json');
    const activeModel = activeTab?.state === 'ready' ? session.model(snapshot.active) : null;

    useEffect(() => {
        if (!editor || editor.getModel() === activeModel) {
            return;
        }
        if (shown.current) {
            session.keepViewState(shown.current, editor.saveViewState());
        }
        editor.setModel(activeModel);
        shown.current = activeModel ? snapshot.active : null;
        const view = snapshot.active ? session.viewState(snapshot.active) : null;
        if (activeModel && view) {
            editor.restoreViewState(view);
        }
        if (activeModel) {
            const position = editor.getPosition();
            setCursor(position ? { line: position.lineNumber, column: position.column } : null);
            if (root.current?.contains(document.activeElement)) {
                editor.focus();
            }
        }
    }, [editor, activeModel, snapshot.active, session]);

    useEffect(() => {
        if (!focused || root.current?.contains(document.activeElement)) {
            return;
        }
        if (editor?.getModel()) {
            editor.focus();
        } else {
            root.current?.focus();
        }
    }, [focused, focusToken, editor]);

    const open = (path: string): void => {
        session.open(path);
        session.reveal(path);
    };

    const run = (command: EditorCommand): void => {
        switch (command) {
            case 'save':
                void session.save();
                break;
            case 'saveAll':
                void session.saveAll();
                break;
            case 'quickOpen':
                setQuickOpen(true);
                break;
            case 'toggleTree':
                session.toggleTree();
                break;
            case 'closeTab':
                if (snapshot.active) {
                    session.close(snapshot.active);
                }
                break;
            case 'nextTab':
                session.step(1);
                break;
            case 'previousTab':
                session.step(-1);
                break;
        }
    };

    const onKeyDownCapture = (event: ReactKeyboardEvent): void => {
        const command = editorCommand(event, IS_MAC);
        if (command) {
            event.preventDefault();
            event.stopPropagation();
            run(command);
        }
    };

    const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
        event.preventDefault();
        const start = event.clientX;
        const width = snapshot.treeWidth;
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const clamp = (x: number): number => Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, width + x - start));
        const move = (next: PointerEvent): void => setDragWidth(clamp(next.clientX));
        const end = (last: PointerEvent): void => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
            setDragWidth(null);
            session.setTreeWidth(clamp(last.clientX));
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    };

    const language = activeModel
        ? monaco?.languages.getLanguages().find((entry) => entry.id === activeModel.getLanguageId())
        : undefined;

    return (
        <section
            ref={root}
            className="editor"
            aria-label="Editor"
            tabIndex={-1}
            onKeyDownCapture={onKeyDownCapture}
            style={{ '--tree-width': `${dragWidth ?? snapshot.treeWidth}px` } as React.CSSProperties}
        >
            {snapshot.treeHidden ? null : (
                <>
                    <FileTree session={session} snapshot={snapshot} cwd={cwd} onOpen={open} />
                    <div
                        className="editor__divider"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label="Resize the file tree"
                        onPointerDown={startResize}
                    />
                </>
            )}
            <div className="editor__main">
                <div className="editor__bar">
                    <button
                        type="button"
                        className="icon-button editor__tree-toggle"
                        aria-pressed={!snapshot.treeHidden}
                        aria-label={snapshot.treeHidden ? 'Show the files' : 'Hide the files'}
                        title={`${snapshot.treeHidden ? 'Show' : 'Hide'} the files (${IS_MAC ? '⌘B' : 'Ctrl+B'})`}
                        onClick={() => session.toggleTree()}
                    >
                        <SidebarIcon size={14} />
                    </button>
                    <Tabs session={session} snapshot={snapshot} />
                </div>
                {activeTab?.conflict ? <ConflictBar session={session} tab={activeTab} /> : null}
                <div className="editor__surface">
                    <div className="editor__monaco" ref={host} />
                    {failed ? (
                        <div className="editor__empty">The editor could not load. Reload the window to try again.</div>
                    ) : !activeTab ? (
                        <EmptyEditor onQuickOpen={() => setQuickOpen(true)} />
                    ) : activeTab.state === 'ready' && activeModel ? null : (
                        <div className="editor__empty">
                            {activeTab.state === 'binary'
                                ? 'A binary file, or not UTF-8 text; it is not shown here.'
                                : activeTab.state === 'tooLarge'
                                  ? 'Too large to edit here.'
                                  : activeTab.state === 'error'
                                    ? activeTab.error
                                    : 'Opening…'}
                        </div>
                    )}
                </div>
                <div className="editor__status">
                    <span
                        className="editor__path"
                        title={snapshot.active ? (settingsTab ? settingsPath : joinPath(cwd, snapshot.active)) : cwd}
                    >
                        {settingsTab ? shortPath(settingsPath) : (snapshot.active ?? shortPath(cwd))}
                    </span>
                    {activeModel && cursor ? (
                        <span>
                            Ln {cursor.line}, Col {cursor.column}
                        </span>
                    ) : null}
                    {language ? <span>{language.aliases?.[0] ?? language.id}</span> : null}
                </div>
            </div>
            {quickOpen ? (
                <QuickOpen
                    sessionId={pane.sessionId}
                    onOpen={(path) => {
                        setQuickOpen(false);
                        open(path);
                    }}
                    onClose={() => {
                        setQuickOpen(false);
                        editor?.focus();
                    }}
                />
            ) : null}
        </section>
    );
}

function EmptyEditor({ onQuickOpen }: { onQuickOpen: () => void }) {
    return (
        <div className="editor__empty editor__welcome">
            <p>No file is open. Pick one in the tree, or find one by name.</p>
            <button type="button" className="button" onClick={onQuickOpen}>
                <SearchIcon size={13} /> Open a file…
            </button>
            <dl className="editor__keys">
                {editorKeys(IS_MAC).map((entry) => (
                    <div key={entry.label}>
                        <dt>
                            <kbd>{entry.keys}</kbd>
                        </dt>
                        <dd>{entry.label}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function ConflictBar({ session, tab }: { session: EditorSession; tab: EditorTab }) {
    const name = nameOf(tab.path);
    if (tab.conflict === 'deleted') {
        return (
            <div className="editor__conflict" role="alert">
                <span>{name} was deleted on disk.</span>
                <button type="button" className="button" onClick={() => void session.save(tab.path, true)}>
                    Save to recreate it
                </button>
                <button type="button" className="button button--ghost" onClick={() => session.close(tab.path, true)}>
                    Close
                </button>
            </div>
        );
    }
    return (
        <div className="editor__conflict" role="alert">
            <span>{name} changed on disk while you had unsaved changes.</span>
            <button type="button" className="button" onClick={() => void session.reload(tab.path)}>
                Use the disk version
            </button>
            <button type="button" className="button button--ghost" onClick={() => void session.save(tab.path, true)}>
                Overwrite with mine
            </button>
        </div>
    );
}

function Tabs({ session, snapshot }: { session: EditorSession; snapshot: EditorSnapshot }) {
    const target = useRef<string | null>(null);
    const strip = useRef<HTMLDivElement>(null);
    const labels = tabLabels(snapshot.tabs);
    const settingsPath = useUi((state) => state.settingsFile?.path ?? 'settings.json');

    useEffect(() => {
        const active = strip.current?.querySelector('[aria-selected="true"]');
        active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [snapshot.active]);

    const items = (): MenuItem[] => {
        const path = target.current;
        if (!path) {
            return [];
        }
        return [
            { label: 'Close', onSelect: () => session.close(path) },
            { label: 'Close others', onSelect: () => session.closeWhere((tab) => tab.path === path) },
            { label: 'Close saved', onSelect: () => session.closeWhere((tab) => tab.dirty) },
            ...(isSettingsTab(path)
                ? [{ label: 'Copy path', separated: true, onSelect: () => copy(settingsPath, 'path') }]
                : [
                      { label: 'Reveal in the tree', separated: true, onSelect: () => session.reveal(path) },
                      { label: 'Copy relative path', onSelect: () => copy(path, 'relative path') },
                  ]),
        ];
    };

    if (snapshot.tabs.length === 0) {
        return <div className="editor__tabs" />;
    }
    return (
        <ContextMenuArea label="Tab" items={items}>
            <div
                ref={strip}
                className="editor__tabs"
                role="tablist"
                aria-label="Open files"
                onContextMenuCapture={(event) => {
                    target.current =
                        (event.target as Element).closest<HTMLElement>('[data-path]')?.dataset.path ?? null;
                }}
            >
                {snapshot.tabs.map((tab) => {
                    const selected = tab.path === snapshot.active;
                    return (
                        <div
                            key={tab.path}
                            data-path={tab.path}
                            className={`editor__tab${selected ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}${tab.conflict ? ' is-conflict' : ''}`}
                            role="tab"
                            aria-selected={selected}
                            tabIndex={selected ? 0 : -1}
                            title={isSettingsTab(tab.path) ? `Voltran settings: ${settingsPath}` : tab.path}
                            onClick={() => session.activate(tab.path)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    session.activate(tab.path);
                                }
                            }}
                            onAuxClick={(event) => {
                                if (event.button === 1) {
                                    event.preventDefault();
                                    session.close(tab.path);
                                }
                            }}
                        >
                            <span className="editor__tab-name">{labels.get(tab.path)}</span>
                            <button
                                type="button"
                                className="editor__tab-close"
                                tabIndex={-1}
                                aria-label={
                                    tab.dirty ? `Close ${tab.path}, which has unsaved changes` : `Close ${tab.path}`
                                }
                                title={`Close (${IS_MAC ? '⌃W' : 'Alt+W'})`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    session.close(tab.path);
                                }}
                            >
                                <CloseIcon size={11} />
                            </button>
                        </div>
                    );
                })}
            </div>
        </ContextMenuArea>
    );
}

function TreeInput({
    depth,
    initial,
    folder,
    onSubmit,
    onCancel,
}: {
    depth: number;
    initial: string;
    folder: boolean;
    onSubmit: (name: string) => Promise<void>;
    onCancel: () => void;
}) {
    const [value, setValue] = useState(initial);
    const [problem, setProblem] = useState<string | null>(null);
    const done = useRef(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const field = input.current;
        if (!field) {
            return;
        }
        field.focus();
        const dot = folder ? -1 : initial.lastIndexOf('.');
        field.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, [initial, folder]);

    const submit = (): void => {
        if (done.current) {
            return;
        }
        if (!value.trim() || value.trim() === initial) {
            done.current = true;
            onCancel();
            return;
        }
        const invalid = nameProblem(value);
        if (invalid) {
            setProblem(invalid);
            return;
        }
        done.current = true;
        onSubmit(value.trim()).catch((error) => {
            done.current = false;
            setProblem(error instanceof Error ? error.message : String(error));
            input.current?.focus();
        });
    };

    return (
        <div className="tree__row tree__row--input" style={{ '--depth': depth } as React.CSSProperties}>
            <span className="tree__twisty" />
            <input
                ref={input}
                className={`tree__input${problem ? ' is-invalid' : ''}`}
                value={value}
                spellCheck={false}
                aria-label={folder ? 'Folder name' : 'File name'}
                aria-invalid={problem !== null}
                title={problem ?? undefined}
                onChange={(event) => {
                    setValue(event.target.value);
                    setProblem(null);
                }}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        submit();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        done.current = true;
                        onCancel();
                    }
                }}
                onBlur={() => {
                    if (!problem) {
                        submit();
                    } else {
                        done.current = true;
                        onCancel();
                    }
                }}
            />
            {problem ? <span className="tree__problem">{problem}</span> : null}
        </div>
    );
}

function FileTree({
    session,
    snapshot,
    cwd,
    onOpen,
}: {
    session: EditorSession;
    snapshot: EditorSnapshot;
    cwd: string;
    onOpen: (path: string) => void;
}) {
    const [editing, setEditing] = useState<Editing>(null);
    const target = useRef<{ path: string; folder: boolean } | null>(null);
    const nav = useRef<HTMLElement>(null);
    const dirty = new Set(snapshot.tabs.filter((tab) => tab.dirty).map((tab) => tab.path));
    const expanded = new Set(snapshot.expanded);

    const startCreate = (parent: string, kind: 'file' | 'dir'): void => {
        if (parent) {
            session.toggleDir(parent, true);
        }
        setEditing({ mode: 'create', parent, kind });
    };

    const items = (): MenuItem[] => {
        const entry = target.current;
        const folder = entry ? (entry.folder ? entry.path : parentOf(entry.path)) : '';
        const create: MenuItem[] = [
            { label: 'New file…', onSelect: () => startCreate(folder, 'file') },
            { label: 'New folder…', onSelect: () => startCreate(folder, 'dir') },
        ];
        if (!entry) {
            return [...create, { label: 'Refresh', separated: true, onSelect: () => session.refreshTree() }];
        }
        return [
            ...(entry.folder ? [] : [{ label: 'Open', onSelect: () => onOpen(entry.path) }]),
            ...create.map((item, index) => (index === 0 && !entry.folder ? { ...item, separated: true } : item)),
            {
                label: 'Rename…',
                separated: true,
                onSelect: () => setEditing({ mode: 'rename', path: entry.path, folder: entry.folder }),
            },
            {
                label: entry.folder ? 'Move folder to Trash…' : 'Move to Trash…',
                danger: true,
                onSelect: () => session.remove(entry.path, entry.folder),
            },
            { label: 'Copy path', separated: true, onSelect: () => copy(joinPath(cwd, entry.path), 'path') },
            { label: 'Copy relative path', onSelect: () => copy(entry.path, 'relative path') },
        ];
    };

    const rows = (): HTMLElement[] => [...(nav.current?.querySelectorAll<HTMLElement>('.tree__row[data-path]') ?? [])];

    const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
        const row = (event.target as Element).closest<HTMLElement>('.tree__row[data-path]');
        if (!row || event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        const path = row.dataset.path ?? '';
        const folder = row.dataset.kind === 'dir';
        const all = rows();
        const index = all.indexOf(row);
        const focusAt = (at: number): void => all[Math.max(0, Math.min(all.length - 1, at))]?.focus();
        if (event.key === 'ArrowDown') {
            focusAt(index + 1);
        } else if (event.key === 'ArrowUp') {
            focusAt(index - 1);
        } else if (event.key === 'ArrowRight' && folder) {
            if (expanded.has(path)) {
                focusAt(index + 1);
            } else {
                session.toggleDir(path, true);
            }
        } else if (event.key === 'ArrowLeft') {
            if (folder && expanded.has(path)) {
                session.toggleDir(path, false);
            } else {
                all.find((candidate) => candidate.dataset.path === parentOf(path) && parentOf(path) !== '')?.focus();
            }
        } else if (event.key === 'F2') {
            setEditing({ mode: 'rename', path, folder });
        } else if (event.key === 'Delete' || (event.key === 'Backspace' && IS_MAC)) {
            session.remove(path, folder);
        } else {
            return;
        }
        event.preventDefault();
    };

    const renderDir = (dir: string, depth: number): React.ReactNode[] => {
        const listing = snapshot.listings[dir];
        const out: React.ReactNode[] = [];
        if (editing?.mode === 'create' && editing.parent === dir) {
            out.push(
                <TreeInput
                    key={`create:${dir}`}
                    depth={depth}
                    initial=""
                    folder={editing.kind === 'dir'}
                    onSubmit={async (name) => {
                        await session.create(dir, name, editing.kind);
                        setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                />,
            );
        }
        if (!listing) {
            out.push(
                <div key={`loading:${dir}`} className="tree__note" style={{ '--depth': depth } as React.CSSProperties}>
                    Loading…
                </div>,
            );
            return out;
        }
        if ('error' in listing) {
            out.push(
                <div
                    key={`error:${dir}`}
                    className="tree__note tree__note--error"
                    style={{ '--depth': depth } as React.CSSProperties}
                >
                    {listing.error}
                </div>,
            );
            return out;
        }
        if (dir === '' && listing.entries.length === 0 && !editing) {
            out.push(
                <div key="empty" className="tree__note" style={{ '--depth': depth } as React.CSSProperties}>
                    This folder is empty.
                </div>,
            );
        }
        for (const entry of listing.entries) {
            const path = joinPath(dir, entry.name);
            const folder = entry.kind === 'dir';
            const open = folder && expanded.has(path);
            const change = snapshot.git[path];
            if (editing?.mode === 'rename' && editing.path === path) {
                out.push(
                    <TreeInput
                        key={`rename:${path}`}
                        depth={depth}
                        initial={entry.name}
                        folder={folder}
                        onSubmit={async (name) => {
                            await session.rename(path, joinPath(dir, name));
                            setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                    />,
                );
            } else {
                out.push(
                    <button
                        key={path}
                        type="button"
                        data-path={path}
                        data-kind={entry.kind}
                        className={`tree__row${path === snapshot.active ? ' is-active' : ''}${entry.ignored ? ' is-ignored' : ''}${entry.link ? ' is-link' : ''}${dirty.has(path) ? ' is-dirty' : ''}${change ? ` git--${change}` : ''}`}
                        style={{ '--depth': depth } as React.CSSProperties}
                        title={`${path}${entry.link ? ' (a link)' : ''}${change ? `\n${folder ? `Holds ${GIT_MARKS[change].folder}` : GIT_MARKS[change].label}` : ''}`}
                        aria-expanded={folder ? open : undefined}
                        onClick={() =>
                            folder ? session.toggleDir(path) : entry.kind === 'file' ? onOpen(path) : undefined
                        }
                    >
                        <span className="tree__twisty">
                            {folder ? <ChevronIcon size={12} className={open ? 'is-open' : undefined} /> : null}
                        </span>
                        <span className="tree__name">{entry.name}</span>
                        {change ? <span className="tree__git">{folder ? '●' : GIT_MARKS[change].mark}</span> : null}
                    </button>,
                );
            }
            if (open) {
                out.push(...renderDir(path, depth + 1));
            }
        }
        if (listing.truncated) {
            out.push(
                <div key={`more:${dir}`} className="tree__note" style={{ '--depth': depth } as React.CSSProperties}>
                    Only the first {listing.entries.length} entries are shown.
                </div>,
            );
        }
        return out;
    };

    return (
        <div className="editor__tree">
            <div className="tree__head">
                <button
                    type="button"
                    className="icon-button"
                    title="New file"
                    aria-label="New file"
                    onClick={() => startCreate('', 'file')}
                >
                    <NewFileIcon size={14} />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    title="New folder"
                    aria-label="New folder"
                    onClick={() => startCreate('', 'dir')}
                >
                    <NewFolderIcon size={14} />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    title="Refresh"
                    aria-label="Refresh"
                    onClick={() => session.refreshTree()}
                >
                    <RestartIcon size={13} />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    title="Collapse folders"
                    aria-label="Collapse folders"
                    onClick={() => session.collapseAll()}
                >
                    <CollapseIcon size={14} />
                </button>
            </div>
            <ContextMenuArea label="File" items={items}>
                <nav
                    ref={nav}
                    className="tree"
                    aria-label="Files"
                    onKeyDown={onKeyDown}
                    onContextMenuCapture={(event) => {
                        const row = (event.target as Element).closest<HTMLElement>('.tree__row[data-path]');
                        target.current = row
                            ? { path: row.dataset.path ?? '', folder: row.dataset.kind === 'dir' }
                            : null;
                    }}
                >
                    {renderDir('', 0)}
                </nav>
            </ContextMenuArea>
        </div>
    );
}

function Highlighted({ match }: { match: FileMatch }) {
    const marks = new Set(match.positions);
    const nameStart = match.path.lastIndexOf('/') + 1;
    const part = (from: number, to: number) =>
        [...match.path.slice(from, to)].map((char, index) =>
            marks.has(from + index) ? <mark key={index}>{char}</mark> : char,
        );
    return (
        <>
            <span className="quick-open__name">{part(nameStart, match.path.length)}</span>
            {nameStart > 0 ? <span className="quick-open__folder">{part(0, nameStart - 1)}</span> : null}
        </>
    );
}

function QuickOpen({
    sessionId,
    onOpen,
    onClose,
}: {
    sessionId: string;
    onOpen: (path: string) => void;
    onClose: () => void;
}) {
    const [files, setFiles] = useState<string[] | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let current = true;
        api.allFiles(sessionId)
            .then((result) => {
                if (current) {
                    setFiles(result.files);
                    setTruncated(result.truncated);
                }
            })
            .catch((reason) => current && setError(reason instanceof Error ? reason.message : String(reason)));
        return () => {
            current = false;
        };
    }, [sessionId]);

    const matches = useMemo(() => (files ? rankFiles(query, files) : []), [files, query]);

    useEffect(() => setSelected(0), [query]);

    useEffect(() => {
        list.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    }, [selected]);

    const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'ArrowDown') {
            setSelected((index) => Math.min(matches.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
            setSelected((index) => Math.max(0, index - 1));
        } else if (event.key === 'Enter') {
            const match = matches[selected];
            if (match) {
                onOpen(match.path);
            }
        } else if (event.key === 'Escape') {
            onClose();
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    };

    return (
        <div
            className="quick-open"
            role="dialog"
            aria-label="Open a file"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="quick-open__box">
                <input
                    className="field__input field__input--mono quick-open__input"
                    autoFocus
                    value={query}
                    placeholder="Find a file by name"
                    spellCheck={false}
                    aria-label="File name"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={(event) => {
                        if (!event.currentTarget.closest('.quick-open')?.contains(event.relatedTarget as Node | null)) {
                            onClose();
                        }
                    }}
                />
                <div className="quick-open__list" ref={list} role="listbox" aria-label="Files">
                    {error ? (
                        <div className="quick-open__note">{error}</div>
                    ) : files === null ? (
                        <div className="quick-open__note">Listing the files…</div>
                    ) : matches.length === 0 ? (
                        <div className="quick-open__note">No file matches.</div>
                    ) : (
                        matches.map((match, index) => (
                            <button
                                key={match.path}
                                type="button"
                                role="option"
                                aria-selected={index === selected}
                                tabIndex={-1}
                                className={`quick-open__item${index === selected ? ' is-selected' : ''}`}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseMove={() => setSelected(index)}
                                onClick={() => onOpen(match.path)}
                            >
                                <Highlighted match={match} />
                            </button>
                        ))
                    )}
                    {truncated ? (
                        <div className="quick-open__note">Only the first {files?.length} files are searched.</div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
