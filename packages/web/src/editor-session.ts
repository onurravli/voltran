import type * as MonacoApi from 'monaco-editor/editor/editor.api.js';
import {
    DEFAULT_SETTINGS,
    type ChangeState,
    type DirListing,
    type EditorFile,
    type SavedFile,
    type Settings,
} from '@voltran/shared';
import { ApiError, api } from './api.ts';
import {
    anyUnsaved,
    isInside,
    isSettingsTab,
    joinPath,
    memoryKey,
    cleanOnSave,
    minimalEdit,
    movedPath,
    nameOf,
    parentOf,
    parseMemory,
    sameListing,
    setUnsaved,
    gitMarks,
    type EditorMemory,
} from './editor.ts';
import { reportError, useUi } from './store.ts';

type Monaco = typeof import('./monaco.ts').monaco;
type TextModel = MonacoApi.editor.ITextModel;
type ViewState = MonacoApi.editor.ICodeEditorViewState;

export type TabState = 'loading' | 'ready' | 'binary' | 'tooLarge' | 'error';

export interface EditorTab {
    path: string;
    state: TabState;
    error: string | null;
    dirty: boolean;
    conflict: 'changed' | 'deleted' | null;
}

export type Listing = DirListing | { error: string };

export interface EditorSnapshot {
    tabs: EditorTab[];
    active: string | null;
    expanded: string[];
    listings: Record<string, Listing>;
    git: Record<string, ChangeState>;
    treeWidth: number;
    treeHidden: boolean;
}

interface Doc {
    model: TextModel;
    version: string | null;
    savedAlt: number;
    view: ViewState | null;
    listener: MonacoApi.IDisposable;
}

const FILE_POLL_MS = 2000;
const TREE_POLL_MS = 4000;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// What one editor pane holds: its tabs, the Monaco model of every open file and its tree. It outlives
// the pane's component, which unmounts whenever another session is shown, so unsaved text and undo
// history stay until the pane itself is closed.
export class EditorSession {
    readonly paneId: string;
    private sessionId: string;
    private monaco: Monaco | null = null;
    private readonly docs = new Map<string, Doc>();
    private readonly loading = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private snapshot: EditorSnapshot;
    private attached = 0;
    private fileTimer: ReturnType<typeof setInterval> | null = null;
    private treeTimer: ReturnType<typeof setInterval> | null = null;
    private polling = false;
    private treeRequest = 0;
    private gitRequest = 0;
    private gitBusy = false;
    private disposed = false;
    private preferences: Settings['editor'] = DEFAULT_SETTINGS.editor;
    private readonly autoSaves = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(paneId: string, sessionId: string) {
        this.paneId = paneId;
        this.sessionId = sessionId;
        let stored: string | null = null;
        try {
            stored = localStorage.getItem(memoryKey(paneId));
        } catch {
            stored = null;
        }
        const memory = parseMemory(stored);
        this.snapshot = {
            tabs: memory.tabs.map((path) => ({ path, state: 'loading', error: null, dirty: false, conflict: null })),
            active: memory.active,
            expanded: memory.expanded,
            listings: {},
            git: {},
            treeWidth: memory.treeWidth,
            treeHidden: memory.treeHidden,
        };
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): EditorSnapshot => this.snapshot;

    private update(patch: Partial<EditorSnapshot>): void {
        if (this.disposed) {
            return;
        }
        this.snapshot = { ...this.snapshot, ...patch };
        const memory: EditorMemory = {
            tabs: this.snapshot.tabs.map((tab) => tab.path),
            active: this.snapshot.active,
            expanded: this.snapshot.expanded,
            treeWidth: this.snapshot.treeWidth,
            treeHidden: this.snapshot.treeHidden,
        };
        try {
            localStorage.setItem(memoryKey(this.paneId), JSON.stringify(memory));
        } catch {
            // Only the tabs of the next visit are lost.
        }
        setUnsaved(this.paneId, this.snapshot.tabs.filter((tab) => tab.dirty).length);
        for (const listener of this.listeners) {
            listener();
        }
    }

    private patchTab(path: string, patch: Partial<EditorTab>): void {
        const tabs = this.snapshot.tabs;
        const index = tabs.findIndex((tab) => tab.path === path);
        if (index < 0) {
            return;
        }
        const next = { ...tabs[index], ...patch };
        if ((Object.keys(patch) as (keyof EditorTab)[]).every((key) => tabs[index][key] === next[key])) {
            return;
        }
        this.update({ tabs: tabs.map((tab, at) => (at === index ? next : tab)) });
    }

    tab(path: string | null): EditorTab | null {
        return path === null ? null : (this.snapshot.tabs.find((tab) => tab.path === path) ?? null);
    }

    // The component calls this while it is mounted: polling runs only while someone looks.
    attach(monaco: Monaco): () => void {
        this.monaco = monaco;
        this.attached++;
        if (this.attached === 1) {
            this.fileTimer = setInterval(() => void this.pollActive(), FILE_POLL_MS);
            this.treeTimer = setInterval(() => {
                if (!document.hidden) {
                    this.refreshTree();
                }
            }, TREE_POLL_MS);
        }
        this.refreshTree();
        if (this.snapshot.active) {
            this.ensureLoaded(this.snapshot.active);
        }
        return () => {
            this.attached--;
            if (this.attached === 0) {
                this.stopTimers();
            }
        };
    }

    private applyText(model: TextModel, text: string): void {
        const edit = minimalEdit(model.getValue(), text);
        if (edit) {
            const range = (this.monaco as Monaco).Range.fromPositions(
                model.getPositionAt(edit.start),
                model.getPositionAt(edit.end),
            );
            model.pushEditOperations([], [{ range, text: edit.text }], () => null);
        }
    }

    private stopTimers(): void {
        if (this.fileTimer) {
            clearInterval(this.fileTimer);
        }
        if (this.treeTimer) {
            clearInterval(this.treeTimer);
        }
        this.fileTimer = null;
        this.treeTimer = null;
    }

    // A pane moved to another session works in that session's folder from then on.
    setSession(sessionId: string): void {
        if (sessionId === this.sessionId) {
            return;
        }
        this.sessionId = sessionId;
        this.update({ listings: {}, git: {} });
        this.refreshTree();
        void this.pollActive();
    }

    // The settings that act on the files rather than on the view: indentation, saving and auto save.
    setPreferences(preferences: Settings['editor']): void {
        const before = this.preferences;
        this.preferences = preferences;
        if (
            before.tabSize !== preferences.tabSize ||
            before.insertSpaces !== preferences.insertSpaces ||
            before.detectIndentation !== preferences.detectIndentation
        ) {
            for (const doc of this.docs.values()) {
                this.indent(doc.model);
            }
        }
        if (preferences.autoSave !== 'afterDelay') {
            this.cancelAutoSaves();
        }
    }

    // With detection on, a file indented its own way keeps that; the settings fill in the rest.
    private indent(model: TextModel): void {
        const { tabSize, insertSpaces, detectIndentation } = this.preferences;
        if (detectIndentation) {
            model.detectIndentation(insertSpaces, tabSize);
        } else {
            model.updateOptions({ tabSize, indentSize: tabSize, insertSpaces });
        }
    }

    private scheduleAutoSave(path: string): void {
        const { autoSave, autoSaveDelay } = this.preferences;
        clearTimeout(this.autoSaves.get(path));
        if (autoSave !== 'afterDelay') {
            return;
        }
        this.autoSaves.set(
            path,
            setTimeout(() => {
                this.autoSaves.delete(path);
                const tab = this.tab(path);
                if (tab?.dirty && !tab.conflict) {
                    void this.save(path, false, 'auto');
                }
            }, autoSaveDelay),
        );
    }

    private cancelAutoSaves(): void {
        for (const timer of this.autoSaves.values()) {
            clearTimeout(timer);
        }
        this.autoSaves.clear();
    }

    // Auto save on focus change: the editor lost focus, or another tab takes its place.
    focusLeft(path: string | null = this.snapshot.active): void {
        const tab = this.tab(path);
        if (this.preferences.autoSave === 'onFocusChange' && tab?.dirty && !tab.conflict) {
            void this.save(path);
        }
    }

    model(path: string | null): TextModel | null {
        return path === null ? null : (this.docs.get(path)?.model ?? null);
    }

    viewState(path: string): ViewState | null {
        return this.docs.get(path)?.view ?? null;
    }

    keepViewState(path: string, view: ViewState | null): void {
        const doc = this.docs.get(path);
        if (doc) {
            doc.view = view;
        }
    }

    private uri(path: string): MonacoApi.Uri {
        return (this.monaco as Monaco).Uri.from({
            scheme: 'voltran-file',
            authority: this.paneId,
            path: isSettingsTab(path) ? path : `/${path}`,
        });
    }

    private readFile(path: string, known: string | null): Promise<EditorFile> {
        return isSettingsTab(path) ? api.readSettingsFile(known) : api.readFile(this.sessionId, path, known);
    }

    private writeFile(path: string, text: string, base: string | null, force: boolean): Promise<SavedFile> {
        return isSettingsTab(path)
            ? api.writeSettingsFile(text, base, force)
            : api.writeFile(this.sessionId, path, text, base, force);
    }

    private addDoc(path: string, text: string, version: string | null, dirty = false): Doc {
        const monaco = this.monaco as Monaco;
        monaco.editor.getModel(this.uri(path))?.dispose();
        const model = monaco.editor.createModel(text, undefined, this.uri(path));
        this.indent(model);
        const doc: Doc = {
            model,
            version,
            savedAlt: dirty ? -1 : model.getAlternativeVersionId(),
            view: null,
            listener: model.onDidChangeContent(() => {
                const dirty = model.getAlternativeVersionId() !== doc.savedAlt;
                this.patchTab(path, { dirty });
                if (dirty) {
                    this.scheduleAutoSave(path);
                }
            }),
        };
        this.docs.set(path, doc);
        return doc;
    }

    private dropDoc(path: string): void {
        const doc = this.docs.get(path);
        clearTimeout(this.autoSaves.get(path));
        this.autoSaves.delete(path);
        if (doc) {
            doc.listener.dispose();
            doc.model.dispose();
            this.docs.delete(path);
        }
    }

    open(path: string): void {
        if (!this.tab(path)) {
            this.update({
                tabs: [...this.snapshot.tabs, { path, state: 'loading', error: null, dirty: false, conflict: null }],
            });
        }
        this.activate(path);
    }

    activate(path: string): void {
        if (this.snapshot.active !== path) {
            this.focusLeft();
            this.update({ active: path });
        }
        this.ensureLoaded(path);
        void this.pollActive();
    }

    private ensureLoaded(path: string): void {
        if (!this.monaco || this.docs.has(path) || this.loading.has(path)) {
            return;
        }
        const tab = this.tab(path);
        if (!tab || (tab.state !== 'loading' && tab.state !== 'error')) {
            return;
        }
        this.loading.add(path);
        this.patchTab(path, { state: 'loading', error: null });
        this.readFile(path, null)
            .then((file) => this.loaded(path, file))
            .catch((error) => this.patchTab(path, { state: 'error', error: message(error) }))
            .finally(() => this.loading.delete(path));
    }

    private loaded(path: string, file: EditorFile): void {
        if (!this.tab(path) || this.disposed) {
            return;
        }
        if (file.text === null) {
            this.patchTab(path, { state: file.binary ? 'binary' : 'tooLarge' });
            return;
        }
        this.addDoc(path, file.text, file.version);
        this.patchTab(path, { state: 'ready', error: null, dirty: false, conflict: null });
    }

    // Applies the file as it is on disk as one undoable edit, so a change an agent made can be undone
    // like any other and the cursor stays where it was.
    private applyDisk(doc: Doc, text: string, version: string): void {
        const model = doc.model;
        model.pushStackElement();
        this.applyText(model, text);
        model.pushStackElement();
        doc.version = version;
        doc.savedAlt = model.getAlternativeVersionId();
    }

    // The active file is read again every few seconds, sending the version it has so an unchanged file
    // costs no text. An agent's edit replaces a file without unsaved changes, and marks one with them.
    private async pollActive(): Promise<void> {
        const path = this.snapshot.active;
        const doc = path ? this.docs.get(path) : undefined;
        if (!path || !doc || this.polling || document.hidden) {
            return;
        }
        this.polling = true;
        const asked = doc.version;
        try {
            const file = await this.readFile(path, asked);
            if (this.docs.get(path) !== doc || doc.version !== asked) {
                return;
            }
            const tab = this.tab(path);
            if (file.unchanged) {
                if (tab?.conflict === 'deleted') {
                    this.patchTab(path, { conflict: null });
                }
                return;
            }
            if (file.text === null) {
                return;
            }
            if (tab?.dirty) {
                this.patchTab(path, { conflict: 'changed' });
            } else {
                this.applyDisk(doc, file.text, file.version);
                this.patchTab(path, { conflict: null, dirty: false });
            }
        } catch (error) {
            if (error instanceof ApiError && error.status === 404 && this.docs.get(path) === doc) {
                this.patchTab(path, { conflict: 'deleted' });
            }
        } finally {
            this.polling = false;
        }
    }

    // An auto save after a delay leaves the line ends alone, so the spaces just typed are not trimmed
    // away under the cursor; every other save cleans the text as the settings say first.
    async save(
        path: string | null = this.snapshot.active,
        force = false,
        reason: 'user' | 'auto' = 'user',
    ): Promise<boolean> {
        const doc = path ? this.docs.get(path) : undefined;
        const tab = this.tab(path);
        if (!path || !doc || !tab) {
            return false;
        }
        clearTimeout(this.autoSaves.get(path));
        this.autoSaves.delete(path);
        if (reason === 'user') {
            this.applyText(doc.model, cleanOnSave(doc.model.getValue(), this.preferences));
        }
        const text = doc.model.getValue();
        const alt = doc.model.getAlternativeVersionId();
        try {
            const saved = await this.writeFile(path, text, doc.version, force || tab.conflict === 'deleted');
            if (this.docs.get(path) !== doc) {
                return true;
            }
            doc.version = saved.version;
            doc.savedAlt = alt;
            this.patchTab(path, { dirty: doc.model.getAlternativeVersionId() !== alt, conflict: null });
            this.refreshTree();
            return true;
        } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
                this.patchTab(path, { conflict: /deleted/.test(error.message) ? 'deleted' : 'changed' });
                if (this.snapshot.active !== path) {
                    useUi.getState().showToast(`${nameOf(path)} changed on disk; it was not saved`, 'error');
                }
                return false;
            }
            reportError(error);
            return false;
        }
    }

    async saveAll(): Promise<void> {
        for (const tab of this.snapshot.tabs) {
            if (tab.dirty && tab.conflict !== 'changed') {
                await this.save(tab.path);
            }
        }
    }

    // Throws away what the user typed and shows the file as it is on disk.
    async reload(path: string): Promise<void> {
        const doc = this.docs.get(path);
        if (!doc) {
            return;
        }
        try {
            const file = await this.readFile(path, null);
            if (file.text === null) {
                this.dropDoc(path);
                this.patchTab(path, { state: file.binary ? 'binary' : 'tooLarge', dirty: false, conflict: null });
                return;
            }
            this.applyDisk(doc, file.text, file.version);
            this.patchTab(path, { dirty: false, conflict: null });
        } catch (error) {
            reportError(error);
        }
    }

    close(path: string, force = false): void {
        const tab = this.tab(path);
        if (!tab) {
            return;
        }
        if (tab.dirty && !force) {
            useUi.getState().openDialog({
                kind: 'confirm',
                title: `Close ${nameOf(path)} without saving?`,
                body: 'Its changes are lost.',
                action: 'Close without saving',
                onConfirm: () => this.close(path, true),
                alternative: {
                    action: 'Save and close',
                    onConfirm: async () => {
                        if (await this.save(path)) {
                            this.close(path, true);
                        }
                    },
                },
            });
            return;
        }
        this.dropDoc(path);
        const tabs = this.snapshot.tabs;
        const index = tabs.findIndex((entry) => entry.path === path);
        const rest = tabs.filter((entry) => entry.path !== path);
        const active =
            this.snapshot.active === path
                ? (rest[Math.min(index, rest.length - 1)]?.path ?? null)
                : this.snapshot.active;
        this.update({ tabs: rest, active });
        if (active) {
            this.ensureLoaded(active);
        }
    }

    closeWhere(keep: (tab: EditorTab) => boolean): void {
        for (const tab of this.snapshot.tabs) {
            if (!keep(tab) && !tab.dirty) {
                this.close(tab.path);
            }
        }
    }

    step(delta: number): void {
        const { tabs, active } = this.snapshot;
        if (tabs.length === 0) {
            return;
        }
        const index = tabs.findIndex((tab) => tab.path === active);
        this.activate(tabs[(index + delta + tabs.length) % tabs.length].path);
    }

    setTreeWidth(width: number): void {
        this.update({ treeWidth: width });
    }

    toggleTree(): void {
        this.update({ treeHidden: !this.snapshot.treeHidden });
    }

    toggleDir(path: string, open?: boolean): void {
        const expanded = this.snapshot.expanded;
        const isOpen = expanded.includes(path);
        if (open ?? !isOpen) {
            if (!isOpen) {
                this.update({ expanded: [...expanded, path] });
                this.refreshTree();
            }
        } else if (isOpen) {
            this.update({ expanded: expanded.filter((entry) => !isInside(entry, path)) });
        }
    }

    // Opens every folder above a file, so the tree shows it.
    reveal(path: string): void {
        if (isSettingsTab(path)) {
            return;
        }
        const missing: string[] = [];
        for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) {
            if (!this.snapshot.expanded.includes(dir)) {
                missing.push(dir);
            }
        }
        if (missing.length > 0) {
            this.update({ expanded: [...this.snapshot.expanded, ...missing] });
            this.refreshTree();
        }
    }

    collapseAll(): void {
        this.update({ expanded: [] });
    }

    // The repository's status, as the changes view reads it; a folder outside git shows none.
    private refreshGit(): void {
        if (this.gitBusy) {
            return;
        }
        this.gitBusy = true;
        const request = ++this.gitRequest;
        api.changes(this.sessionId)
            .then((changes) => gitMarks(changes.prefix, changes.files))
            .catch(() => ({}))
            .then((git) => {
                if (request === this.gitRequest && !sameListing(git, this.snapshot.git)) {
                    this.update({ git });
                }
            })
            .finally(() => {
                this.gitBusy = false;
            });
    }

    refreshTree(): void {
        if (this.disposed) {
            return;
        }
        this.refreshGit();
        const request = ++this.treeRequest;
        const paths = ['', ...this.snapshot.expanded].slice(0, 200);
        api.fileTree(this.sessionId, paths)
            .then((tree) => {
                if (request !== this.treeRequest) {
                    return;
                }
                const gone = this.snapshot.expanded.filter((dir) => {
                    const listing = tree.dirs[dir];
                    return listing !== undefined && 'error' in listing;
                });
                if (gone.length > 0) {
                    this.update({ expanded: this.snapshot.expanded.filter((dir) => !gone.includes(dir)) });
                }
                if (!sameListing(tree.dirs, this.snapshot.listings)) {
                    this.update({ listings: tree.dirs });
                }
            })
            .catch((error) => {
                if (request === this.treeRequest) {
                    this.update({ listings: { '': { error: message(error) } } });
                }
            });
    }

    async create(parent: string, name: string, kind: 'file' | 'dir'): Promise<void> {
        const path = joinPath(parent, name.trim());
        await api.fileAction(this.sessionId, { action: 'create', path, kind });
        if (parent) {
            this.toggleDir(parent, true);
        }
        this.reveal(path);
        if (kind === 'file') {
            this.open(path);
        } else {
            this.toggleDir(path, true);
        }
        this.refreshTree();
    }

    // Open files move along, keeping their text, unsaved changes included.
    async rename(from: string, to: string): Promise<void> {
        if (from === to) {
            return;
        }
        await api.fileAction(this.sessionId, { action: 'rename', from, to });
        const tabs = this.snapshot.tabs.map((tab) => {
            const moved = movedPath(tab.path, from, to);
            if (moved === null) {
                return tab;
            }
            const doc = this.docs.get(tab.path);
            if (doc) {
                const text = doc.model.getValue();
                const dirty = tab.dirty;
                const version = doc.version;
                this.dropDoc(tab.path);
                this.addDoc(moved, text, version, dirty);
            }
            return { ...tab, path: moved };
        });
        const active =
            this.snapshot.active === null ? null : (movedPath(this.snapshot.active, from, to) ?? this.snapshot.active);
        const expanded = this.snapshot.expanded.map((dir) => movedPath(dir, from, to) ?? dir);
        this.update({ tabs, active, expanded });
        this.reveal(to);
        this.refreshTree();
    }

    remove(path: string, folder: boolean): void {
        const { openDialog } = useUi.getState();
        const name = nameOf(path);
        openDialog({
            kind: 'confirm',
            title: `Move ${name} to the Trash?`,
            body: folder ? 'The folder and everything in it go to the Trash.' : 'You can put it back from the Trash.',
            action: 'Move to Trash',
            onConfirm: async () => {
                const result = await api.fileAction(this.sessionId, { action: 'trash', path });
                if (result.trashed) {
                    this.removed(path);
                    return;
                }
                setTimeout(() =>
                    openDialog({
                        kind: 'confirm',
                        title: `Delete ${name} for good?`,
                        body: 'Voltran could not move it to the Trash, which happens on another disk or a system without one. Deleting it cannot be undone.',
                        action: 'Delete',
                        onConfirm: async () => {
                            await api.fileAction(this.sessionId, { action: 'delete', path });
                            this.removed(path);
                        },
                    }),
                );
            },
        });
    }

    private removed(path: string): void {
        for (const tab of this.snapshot.tabs) {
            if (isInside(tab.path, path)) {
                this.close(tab.path, true);
            }
        }
        this.update({ expanded: this.snapshot.expanded.filter((dir) => !isInside(dir, path)) });
        this.refreshTree();
    }

    dispose(): void {
        this.stopTimers();
        for (const path of [...this.docs.keys()]) {
            this.dropDoc(path);
        }
        this.disposed = true;
        this.listeners.clear();
        setUnsaved(this.paneId, 0);
        try {
            localStorage.removeItem(memoryKey(this.paneId));
        } catch {
            // Nothing to clean up then.
        }
    }
}

const sessions = new Map<string, EditorSession>();

window.addEventListener('beforeunload', (event) => {
    if (anyUnsaved()) {
        event.preventDefault();
    }
});

export function editorFor(paneId: string, sessionId: string): EditorSession {
    let session = sessions.get(paneId);
    if (!session) {
        session = new EditorSession(paneId, sessionId);
        sessions.set(paneId, session);
    }
    return session;
}

export function peekEditor(paneId: string): EditorSession | undefined {
    return sessions.get(paneId);
}

export function disposeEditorsExcept(liveIds: Set<string>): void {
    for (const [paneId, session] of sessions) {
        if (!liveIds.has(paneId)) {
            session.dispose();
            sessions.delete(paneId);
        }
    }
}
