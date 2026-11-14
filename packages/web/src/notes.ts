import type { NotesLockBody, NotesMeta, NotesScope, PaneNotes, SaveNotesBody } from '@voltran/shared';
import { api } from './api.ts';

export interface NotesApi {
    read(id: string): Promise<PaneNotes>;
    lock(id: string, body: NotesLockBody): Promise<NotesMeta>;
    unlock(id: string, body: NotesLockBody): Promise<void>;
    save(id: string, body: SaveNotesBody, keepalive?: boolean): Promise<PaneNotes>;
}

export interface NotesSnapshot {
    loaded: boolean;
    text: string;
    dirty: boolean;
    holding: boolean;
    saving: boolean;
    conflict: string | null;
}

export const SAVE_DELAY_MS = 600;
export const RELEASE_DELAY_MS = 3000;
export const RENEW_EVERY_MS = 4000;

export const NOTES_HOLDER = `window-${globalThis.crypto.randomUUID()}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The lock is taken on the first keystroke and given back a few seconds after the last one, so an
// agent waits only while the user is actually typing. The draft is never replaced by a change from
// elsewhere: when a save is refused, it stays until the user keeps it or loads the other version.
export class NotesEditor {
    readonly id: string;
    private readonly api: NotesApi;
    private readonly holder: string;
    private content = '';
    private version = '';
    private draft: string | null = null;
    private loaded = false;
    private loading: Promise<void> | null = null;
    private holding = false;
    private acquiring: Promise<boolean> | null = null;
    private saving: Promise<void> | null = null;
    private conflict: string | null = null;
    private renewedAt = 0;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private releaseTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly listeners = new Set<() => void>();
    private snapshot: NotesSnapshot;

    constructor(id: string, notesApi: NotesApi, holder: string) {
        this.id = id;
        this.api = notesApi;
        this.holder = holder;
        this.snapshot = this.compute();
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): NotesSnapshot => this.snapshot;

    load(): Promise<void> {
        if (this.loaded) {
            return Promise.resolve();
        }
        this.loading ??= this.api.read(this.id).then(
            (latest) => this.applyRemote(latest, null),
            (error) => {
                this.loading = null;
                this.conflict = message(error);
                this.notify();
            },
        );
        return this.loading;
    }

    input(text: string): void {
        this.draft = text;
        this.clearTimer('release');
        this.notify();
        if (this.conflict) {
            return;
        }
        if (!this.holding) {
            void this.acquire();
            return;
        }
        this.renewIfDue();
        this.scheduleSave();
    }

    applyRemote(latest: PaneNotes, holder: string | null): void {
        if (holder === this.holder) {
            return;
        }
        this.content = latest.content;
        this.version = latest.version;
        this.loaded = true;
        if (this.draft === latest.content) {
            this.draft = null;
        }
        this.notify();
    }

    keepMine(): void {
        this.conflict = null;
        this.notify();
        void this.acquire();
    }

    takeTheirs(): void {
        this.conflict = null;
        this.draft = null;
        this.notify();
        this.release();
    }

    async flush(): Promise<void> {
        if (this.acquiring) {
            await this.acquiring;
        }
        this.clearTimer('save');
        if (this.draft !== null && this.holding && !this.conflict) {
            await this.save();
        } else if (this.saving) {
            await this.saving;
        }
        this.release();
    }

    // A closing page only finishes requests it started before it went away, so this starts the save
    // at once and leaves the lock to expire.
    flushOnExit(): void {
        this.clearTimer('save');
        if (this.draft !== null && this.holding && !this.conflict) {
            void this.saveNow(true);
        }
    }

    private acquire(): Promise<boolean> {
        this.acquiring ??= this.api
            .lock(this.id, { holder: this.holder, version: this.version })
            .then(
                () => {
                    this.holding = true;
                    this.renewedAt = Date.now();
                    this.scheduleSave();
                    return true;
                },
                (error) => {
                    this.refused(error);
                    return false;
                },
            )
            .finally(() => {
                this.acquiring = null;
                this.notify();
            });
        return this.acquiring;
    }

    private renewIfDue(): void {
        if (Date.now() - this.renewedAt < RENEW_EVERY_MS) {
            return;
        }
        this.renewedAt = Date.now();
        this.api.lock(this.id, { holder: this.holder }).catch((error) => this.refused(error));
    }

    private scheduleSave(): void {
        this.clearTimer('save');
        this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
    }

    private save(): Promise<void> {
        this.clearTimer('save');
        const run = (this.saving ?? Promise.resolve()).then(() => this.saveNow(false));
        this.saving = run;
        void run.then(() => {
            if (this.saving !== run) {
                return;
            }
            this.saving = null;
            if (this.draft !== null && this.holding && !this.conflict) {
                this.scheduleSave();
            } else {
                this.scheduleRelease();
            }
            this.notify();
        });
        this.notify();
        return run;
    }

    private async saveNow(keepalive: boolean): Promise<void> {
        if (this.draft === null || !this.holding || this.conflict) {
            return;
        }
        const text = this.draft;
        try {
            const saved = await this.api.save(
                this.id,
                { content: text, version: this.version, holder: this.holder },
                keepalive,
            );
            this.content = saved.content;
            this.version = saved.version;
            this.renewedAt = Date.now();
            if (this.draft === text) {
                this.draft = null;
            }
        } catch (error) {
            this.refused(error);
        }
    }

    private scheduleRelease(): void {
        this.clearTimer('release');
        if (this.holding && this.draft === null) {
            this.releaseTimer = setTimeout(() => this.release(), RELEASE_DELAY_MS);
        }
    }

    private release(): void {
        this.clearTimer('release');
        if (!this.holding || this.saving || (this.draft !== null && !this.conflict)) {
            return;
        }
        this.holding = false;
        this.notify();
        this.api.unlock(this.id, { holder: this.holder }).catch(() => undefined);
    }

    private refused(error: unknown): void {
        this.holding = false;
        this.clearTimer('save');
        if (this.draft !== null) {
            this.conflict = message(error);
        }
        this.notify();
        this.api.read(this.id).then(
            (latest) => this.applyRemote(latest, null),
            () => undefined,
        );
    }

    private clearTimer(which: 'save' | 'release'): void {
        const timer = which === 'save' ? this.saveTimer : this.releaseTimer;
        if (timer) {
            clearTimeout(timer);
        }
        if (which === 'save') {
            this.saveTimer = null;
        } else {
            this.releaseTimer = null;
        }
    }

    private compute(): NotesSnapshot {
        return {
            loaded: this.loaded,
            text: this.draft ?? this.content,
            dirty: this.draft !== null,
            holding: this.holding,
            saving: this.saving !== null,
            conflict: this.conflict,
        };
    }

    private notify(): void {
        this.snapshot = this.compute();
        this.listeners.forEach((listener) => listener());
    }
}

const scopedApi = (scope: NotesScope): NotesApi => ({
    read: (id) => api.readNotes(scope, id),
    lock: (id, body) => api.lockNotes(scope, id, body),
    unlock: (id, body) => api.unlockNotes(scope, id, body),
    save: (id, body, keepalive) => api.saveNotes(scope, id, body, keepalive),
});

const apis: Record<NotesScope, NotesApi> = { pane: scopedApi('pane'), project: scopedApi('project') };

// A project's notes have one editor per window, which every pane of the project shows.
const editors: Record<NotesScope, Map<string, NotesEditor>> = { pane: new Map(), project: new Map() };

export function notesFor(scope: NotesScope, id: string): NotesEditor {
    let editor = editors[scope].get(id);
    if (!editor) {
        editor = new NotesEditor(id, apis[scope], NOTES_HOLDER);
        editors[scope].set(id, editor);
    }
    return editor;
}

export function applyNotesEvent(scope: NotesScope, id: string, latest: PaneNotes, holder: string | null): void {
    editors[scope].get(id)?.applyRemote(latest, holder);
}

export function disposeNotesExcept(scope: NotesScope, liveIds: Set<string>): void {
    for (const id of editors[scope].keys()) {
        if (!liveIds.has(id)) {
            editors[scope].delete(id);
        }
    }
}

export function flushNotesOnExit(): void {
    for (const scope of ['pane', 'project'] as const) {
        editors[scope].forEach((editor) => editor.flushOnExit());
    }
}

const openedAt = Date.now();
const seenAt = new Map<string, number>();

export function markNotesSeen(scope: NotesScope, id: string): void {
    seenAt.set(`${scope}:${id}`, Date.now());
}

export function notesFresh(scope: NotesScope, id: string, meta: NotesMeta): boolean {
    return meta.updatedBy === 'agent' && (meta.updatedAt ?? 0) > (seenAt.get(`${scope}:${id}`) ?? openedAt);
}

export function blockedBy(meta: NotesMeta, holding: boolean): 'agent' | 'window' | null {
    if (holding) {
        return null;
    }
    if (meta.lock === 'agent') {
        return 'agent';
    }
    return meta.lock === 'user' && meta.holder !== NOTES_HOLDER ? 'window' : null;
}
