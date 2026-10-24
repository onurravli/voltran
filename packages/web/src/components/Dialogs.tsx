import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { branchFromTitle, commandPane, type AdapterId, type AdapterInfo, type PaneSpec, type ProjectGit } from '@voltran/shared';
import { api } from '../api.ts';
import { FIND_KEYS, SHORTCUTS } from '../shortcuts.ts';
import { reportError, useUi, type Dialog } from '../store.ts';
import { CommandPalette } from './CommandPalette.tsx';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        const first = ref.current?.querySelector<HTMLElement>('input, select, button');
        first?.focus();
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            previous?.focus?.();
        };
    }, [onClose]);

    return (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
                <h2 className="modal__title">{title}</h2>
                {children}
            </div>
        </div>
    );
}

function ProjectDialog({ onClose }: { onClose: () => void }) {
    const [path, setPath] = useState('');
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const project = await api.createProject({ path: path.trim(), name: name.trim() || undefined });
            useUi.getState().openDialog({ kind: 'session', projectId: project.id });
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Add a project" onClose={onClose}>
            <form className="form" onSubmit={submit}>
                <label className="field">
                    <span className="field__label">Folder</span>
                    <input
                        className="field__input field__input--mono"
                        value={path}
                        onChange={(event) => setPath(event.target.value)}
                        placeholder="~/Developer/my-repo"
                        spellCheck={false}
                        required
                    />
                    <span className="field__hint">Any folder or repository. Sessions start their panes here.</span>
                </label>
                <label className="field">
                    <span className="field__label">Name <span className="field__optional">optional</span></span>
                    <input className="field__input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to the folder name" />
                </label>
                {error ? <p className="form__error" role="alert">{error}</p> : null}
                <p className="form__aside">From a terminal, <code>voltran add</code> registers the current folder.</p>
                <div className="form__actions">
                    <button type="button" className="button button--ghost" onClick={onClose}>Cancel</button>
                    <button type="submit" className="button button--primary" disabled={busy || !path.trim()}>Add project</button>
                </div>
            </form>
        </Modal>
    );
}

function SessionDialog({ projectId, worktree: wantsWorktree, onClose }: { projectId?: string; worktree?: boolean; onClose: () => void }) {
    const app = useUi((state) => state.app);
    const projects = app?.projects ?? [];
    const adapters = (app?.adapters ?? []).filter((adapter) => adapter.id !== 'command' && adapter.id !== 'subagent');
    const currentProjectId = useUi((state) => state.app?.sessions.find((session) => session.id === state.selectedSessionId)?.projectId);
    const [project, setProject] = useState(projectId ?? currentProjectId ?? projects[0]?.id ?? '');
    const [title, setTitle] = useState('');
    const [link, setLink] = useState('');
    const [picks, setPicks] = useState<AdapterId[]>([]);
    const [command, setCommand] = useState('');
    const [git, setGit] = useState<ProjectGit | null>(null);
    const [worktree, setWorktree] = useState(false);
    const [branch, setBranch] = useState<string | null>(null);
    const [base, setBase] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const branchName = branch ?? branchFromTitle(title);

    useEffect(() => {
        let current = true;
        setGit(null);
        if (!project) {
            return undefined;
        }
        api.projectGit(project)
            .then((info) => {
                if (current) {
                    setGit(info);
                    setWorktree(info.repository && (wantsWorktree ?? useUi.getState().worktreeProjects[project] === true));
                    setBase(info.branch ?? info.branches[0] ?? '');
                }
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [project]);

    const toggle = (id: AdapterId): void => {
        setPicks((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
    };

    const commandAdapter = command.trim() ? commandPane(command).adapter : null;
    const namesItself = adapters.some((adapter) => adapter.reportsHooks && (picks.includes(adapter.id) || adapter.id === commandAdapter));

    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        const panes: PaneSpec[] = picks.map((adapter) => ({ adapter }));
        if (command.trim()) {
            panes.push(commandPane(command));
        }
        setBusy(true);
        setError(null);
        try {
            const own = git?.repository === true && worktree;
            const session = await api.createSession({
                projectId: project,
                title: title.trim() || undefined,
                link: link.trim() || null,
                panes,
                ...(own ? { worktree: { branch: branchName.trim(), ...(base ? { base } : {}) } } : {}),
            });
            if (git?.repository) {
                useUi.getState().setWorktreeChoice(project, worktree);
            }
            useUi.getState().selectSession(session.id);
            onClose();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    if (projects.length === 0) {
        return <ProjectDialog onClose={onClose} />;
    }

    return (
        <Modal title="Start a session" onClose={onClose}>
            <form className="form" onSubmit={submit}>
                <label className="field">
                    <span className="field__label">
                        What are you working on?{namesItself ? <> <span className="field__optional">optional</span></> : null}
                    </span>
                    <input
                        className="field__input"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={namesItself ? 'Leave it empty and the agent names it from your first prompt' : 'Fix login redirect, PROJ-123, flaky test hunt…'}
                        required={!namesItself}
                    />
                </label>
                <div className="field-row">
                    <label className="field">
                        <span className="field__label">Project</span>
                        <select className="field__input" value={project} onChange={(event) => setProject(event.target.value)}>
                            {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                        </select>
                    </label>
                    <label className="field">
                        <span className="field__label">Link <span className="field__optional">optional</span></span>
                        <input className="field__input" value={link} onChange={(event) => setLink(event.target.value)} placeholder="Ticket or PR URL" type="url" />
                    </label>
                </div>
                {git?.repository ? (
                    <div className="worktree-fields">
                        <label className="check">
                            <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />
                            <span>
                                Work in its own worktree
                                <span className="check__note">A new folder and branch, so agents in other sessions never touch its files</span>
                            </span>
                        </label>
                        {worktree ? (
                            <div className="field-row field-row--even">
                                <label className="field">
                                    <span className="field__label">Branch</span>
                                    <input
                                        className="field__input field__input--mono"
                                        value={branchName}
                                        onChange={(event) => setBranch(event.target.value)}
                                        placeholder="fix-login-redirect"
                                        spellCheck={false}
                                        required
                                    />
                                </label>
                                <label className="field">
                                    <span className="field__label">From</span>
                                    <select className="field__input field__input--mono" value={base} onChange={(event) => setBase(event.target.value)}>
                                        {git.branches.length === 0 ? <option value="">HEAD</option> : null}
                                        {git.branches.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                                    </select>
                                </label>
                            </div>
                        ) : null}
                    </div>
                ) : null}
                <fieldset className="field">
                    <legend className="field__label">Open with</legend>
                    <div className="chips">
                        {adapters.map((adapter) => (
                            <AdapterChip key={adapter.id} adapter={adapter} selected={picks.includes(adapter.id)} onToggle={() => toggle(adapter.id)} />
                        ))}
                    </div>
                </fieldset>
                <label className="field">
                    <span className="field__label">Run a command <span className="field__optional">optional</span></span>
                    <input
                        className="field__input field__input--mono"
                        value={command}
                        onChange={(event) => setCommand(event.target.value)}
                        placeholder="npm run dev"
                        spellCheck={false}
                    />
                </label>
                {error ? <p className="form__error" role="alert">{error}</p> : null}
                <div className="form__actions">
                    <button type="button" className="button button--ghost" onClick={onClose}>Cancel</button>
                    <button type="submit" className="button button--primary" disabled={busy || (!title.trim() && !namesItself) || !project || (picks.length === 0 && !command.trim()) || (git?.repository === true && worktree && !branchName.trim())}>
                        {busy && git?.repository && worktree ? 'Creating the worktree…' : 'Start session'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

function AdapterChip({ adapter, selected, onToggle }: { adapter: AdapterInfo; selected: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            className={`chip${selected ? ' is-selected' : ''}`}
            aria-pressed={selected}
            disabled={!adapter.available}
            title={adapter.available ? undefined : `${adapter.label} is not installed on this machine`}
            onClick={onToggle}
        >
            {adapter.label}
            {!adapter.available ? <span className="chip__note">not installed</span> : null}
        </button>
    );
}

function ConfirmDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: 'confirm' }>; onClose: () => void }) {
    const [busy, setBusy] = useState(false);
    const confirm = async (action: () => void | Promise<void>): Promise<void> => {
        setBusy(true);
        try {
            await action();
            onClose();
        } catch (failure) {
            reportError(failure);
            setBusy(false);
        }
    };
    return (
        <Modal title={dialog.title} onClose={onClose}>
            <p className="modal__body">{dialog.body}</p>
            <div className="form__actions">
                <button type="button" className="button button--ghost" onClick={onClose}>Cancel</button>
                {dialog.alternative ? (
                    <button type="button" className="button" onClick={() => confirm(dialog.alternative!.onConfirm)} disabled={busy}>{dialog.alternative.action}</button>
                ) : null}
                <button type="button" className="button button--danger" onClick={() => confirm(dialog.onConfirm)} disabled={busy}>{dialog.action}</button>
            </div>
        </Modal>
    );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
    return (
        <Modal title="Keyboard shortcuts" onClose={onClose}>
            <dl className="shortcuts">
                {[...SHORTCUTS, ...FIND_KEYS].map((shortcut) => (
                    <div key={shortcut.keys} className="shortcuts__row">
                        <dt><kbd>{shortcut.keys}</kbd></dt>
                        <dd>{shortcut.label}</dd>
                    </div>
                ))}
            </dl>
            <p className="form__aside">They work while a terminal has focus, too.</p>
        </Modal>
    );
}

export function Dialogs() {
    const dialog = useUi((state) => state.dialog);
    const openDialog = useUi((state) => state.openDialog);
    const close = (): void => openDialog(null);

    if (!dialog) {
        return null;
    }
    switch (dialog.kind) {
        case 'project':
            return <ProjectDialog onClose={close} />;
        case 'session':
            return <SessionDialog projectId={dialog.projectId} worktree={dialog.worktree} onClose={close} />;
        case 'confirm':
            return <ConfirmDialog dialog={dialog} onClose={close} />;
        case 'shortcuts':
            return <ShortcutsDialog onClose={close} />;
        case 'palette':
            return <CommandPalette onClose={close} />;
    }
}

const NO_ADAPTERS: AdapterInfo[] = [];

export function PaneMenu() {
    const target = useUi((state) => state.paneMenu);
    const adapters = useUi((state) => state.app?.adapters ?? NO_ADAPTERS);
    const openPaneMenu = useUi((state) => state.openPaneMenu);
    const [command, setCommand] = useState('');
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!target) {
            return;
        }
        setCommand('');
        const onPointer = (event: MouseEvent): void => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                openPaneMenu(null);
            }
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                openPaneMenu(null);
            }
        };
        window.addEventListener('mousedown', onPointer);
        window.addEventListener('keydown', onKey);
        ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
        return () => {
            window.removeEventListener('mousedown', onPointer);
            window.removeEventListener('keydown', onKey);
        };
    }, [target, openPaneMenu]);

    if (!target) {
        return null;
    }

    const create = (spec: PaneSpec): void => {
        openPaneMenu(null);
        api.createPane(target.sessionId, { ...spec, splitFrom: target.splitFrom, direction: target.direction, workspaceId: target.workspaceId })
            .then((pane) => useUi.getState().focusPane(pane.id))
            .catch(reportError);
    };

    const width = 248;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, target.anchor.x - width));
    const top = Math.min(window.innerHeight - 280, target.anchor.y);

    return (
        <div className="menu" ref={ref} style={{ left, top, width }} role="menu">
            {adapters.filter((adapter) => adapter.id !== 'command' && adapter.id !== 'subagent').map((adapter) => (
                <button
                    key={adapter.id}
                    type="button"
                    role="menuitem"
                    className="menu__item"
                    disabled={!adapter.available}
                    onClick={() => create({ adapter: adapter.id })}
                >
                    <span>{adapter.label}</span>
                    <span className="menu__note">{adapter.available ? (adapter.kind === 'agent' ? 'agent' : '') : 'not installed'}</span>
                </button>
            ))}
            <form
                className="menu__command"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (command.trim()) {
                        create(commandPane(command));
                    }
                }}
            >
                <input
                    className="field__input field__input--mono"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="Run a command…"
                    spellCheck={false}
                    aria-label="Command to run"
                />
            </form>
        </div>
    );
}

export function ToastView() {
    const toast = useUi((state) => state.toast);
    if (!toast) {
        return null;
    }
    return (
        <div className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
            {toast.tone === 'error' ? <span className="lamp lamp--sm toast__lamp" /> : null}
            <span>{toast.message}</span>
        </div>
    );
}
