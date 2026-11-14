import { createHash, randomBytes } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    renameSync,
    rmSync,
    watch,
    writeFileSync,
    type FSWatcher,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { MAX_NOTES_BYTES, type NotesAuthor, type NotesMeta, type PaneNotes } from '@voltran/shared';

const FILE = 'notes.md';
const GUIDE = 'GUIDE.md';
const LEASE_MS = 10_000;
const AGENT_EDIT_MS = 10_000;
const RELOAD_DELAY_MS = 100;
const READ_LIMIT = 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,64}$/;
export const CHANGED_MARKS = ['.project.changed', '.changed'];

export class NotesRefused extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export interface NotesChange extends PaneNotes {
    id: string;
    by: NotesAuthor;
    holder: string | null;
}

export interface NotesStoreOptions {
    dir: string;
    guide: string;
    onChange: (change: NotesChange) => void;
    onMeta: () => void;
}

interface Lock {
    by: NotesAuthor;
    holder: string | null;
    timer: ReturnType<typeof setTimeout>;
}

interface Note {
    content: string;
    version: string;
    updatedAt: number | null;
    updatedBy: NotesAuthor | null;
    lock: Lock | null;
    reloadTimer: ReturnType<typeof setTimeout> | null;
}

export const NOTES_GUIDE = `# Voltran pane notes

The file notes.md named below (its path is also in $VOLTRAN_NOTES) is a notebook this terminal pane
shares with the user, who sees it next to the terminal. It outlives restarts, resumed sessions and
compaction.

- Read it for context: the user may keep goals, decisions and constraints there.
- Keep it current as you work: record decisions, progress and next steps in a few lines. Edit it in
  place and keep what the user wrote unless they ask otherwise.
- Keep it short, well under 8 KB.
- If a write fails because the file or its folder is read-only, the user is editing it: try again
  later, and never change its permissions.
`;

export const PROJECT_NOTES_GUIDE = `# Voltran project notes

The file notes.md named below (its path is also in $VOLTRAN_PROJECT_NOTES) is a notebook the user
and every agent share across all sessions and worktrees of this project. It outlives restarts,
resumed sessions and compaction.

- Read it for context: the user may keep conventions, decisions and plans for the whole project there.
- Write there only what other sessions need too, such as a decision or a convention; keep the progress
  of your own task in the pane notes.
- Other agents and the user edit it too: edit it in place and keep what they wrote unless the user
  asks otherwise.
- Keep it short, well under 8 KB.
- If a write fails because the file or its folder is read-only, someone is editing it: try again
  later, and never change its permissions.
`;

export const notesGuidePath = (dir: string): string => join(dir, GUIDE);

const versionOf = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 16);

const kindOf = (path: string): 'file' | 'directory' | 'other' | null => {
    try {
        const stat = lstatSync(path);
        return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
};

// Agents can write in the notes folders, so anything there may be a link they planted. Files are
// replaced through a fresh temporary name that open refuses to follow, and only real files and
// folders get their modes changed.
function replaceFile(dir: string, name: string, content: string, mode: number): void {
    const temporary = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    try {
        writeFileSync(temporary, content, { mode, flag: 'wx' });
        renameSync(temporary, join(dir, name));
    } finally {
        rmSync(temporary, { force: true });
    }
}

function chmodFolder(path: string, mode: number): void {
    if (kindOf(path) === 'directory') {
        chmodSync(path, mode);
    }
}

// The note is only ever the plain file the daemon itself put there. Opening it without following a
// link and checking what the descriptor is leaves no gap to swap in a link, a pipe or a hard link to
// another file between the check and the use.
function openNote(path: string): number | null {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        return null;
    }
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.nlink === 1) {
        return fd;
    }
    closeSync(fd);
    return null;
}

function chmodNote(path: string, mode: number): void {
    const fd = openNote(path);
    if (fd === null) {
        return;
    }
    try {
        fchmodSync(fd, mode);
    } finally {
        closeSync(fd);
    }
}

function readNote(fd: number, size: number): string {
    const buffer = Buffer.alloc(Math.min(size, READ_LIMIT));
    let length = 0;
    while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, length);
        if (read === 0) {
            break;
        }
        length += read;
    }
    return buffer.subarray(0, length).toString('utf8');
}

// Each note (a pane's, or a project's in a second store) lives in a folder of its own, so a lock can make the folder read-only too: a
// read-only file alone does not stop a write that replaces it through a rename.
export class NotesStore {
    private readonly dir: string;
    private readonly options: NotesStoreOptions;
    private readonly notes = new Map<string, Note>();
    private watcher: FSWatcher | null = null;

    constructor(options: NotesStoreOptions) {
        this.dir = resolve(options.dir);
        this.options = options;
    }

    get guide(): string {
        return notesGuidePath(this.dir);
    }

    // A lock does not outlive the daemon that took it, and a deleted pane leaves no note behind.
    load(ids: Iterable<string>): void {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        replaceFile(this.dir, GUIDE, this.options.guide, 0o600);
        const known = new Set(ids);
        for (const name of readdirSync(this.dir)) {
            const mark = CHANGED_MARKS.find((suffix) => name.endsWith(suffix));
            const id = mark ? name.slice(0, -mark.length) : name;
            if (known.has(id)) {
                this.setWritable(id, true);
            } else if (ID.test(id)) {
                this.removeFiles(id);
            }
        }
    }

    watch(): void {
        this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
            const paneId = name?.split(sep)[0];
            const note = paneId ? this.notes.get(paneId) : undefined;
            if (!paneId || !note) {
                return;
            }
            if (note.reloadTimer) {
                clearTimeout(note.reloadTimer);
            }
            note.reloadTimer = setTimeout(() => {
                note.reloadTimer = null;
                try {
                    this.reload(paneId, note);
                } catch (error) {
                    console.error(`[voltran] could not read the notes of pane ${paneId}:`, error);
                }
            }, RELOAD_DELAY_MS);
        });
        this.watcher.on('error', () => {
            this.watcher?.close();
            this.watcher = null;
        });
    }

    close(): void {
        this.watcher?.close();
        this.watcher = null;
        for (const [paneId, note] of this.notes) {
            if (note.reloadTimer) {
                clearTimeout(note.reloadTimer);
                note.reloadTimer = null;
            }
            this.release(paneId, note, false);
        }
    }

    file(paneId: string): string {
        return join(this.folder(paneId), FILE);
    }

    isFile(paneId: string, path: unknown): boolean {
        return typeof path === 'string' && resolve(path) === join(this.dirOf(paneId), FILE);
    }

    meta(paneId: string): NotesMeta {
        const note = this.note(paneId);
        return {
            size: Buffer.byteLength(note.content),
            updatedAt: note.updatedAt,
            updatedBy: note.updatedBy,
            lock: note.lock?.by ?? null,
            holder: note.lock?.holder ?? null,
        };
    }

    read(paneId: string): PaneNotes {
        const note = this.note(paneId);
        return { content: note.content, version: note.version };
    }

    // What the notes hook shows Claude: read again now, since the watcher may not have caught up.
    current(paneId: string): string {
        const note = this.note(paneId);
        this.reload(paneId, note);
        return note.content;
    }

    // The folder is made read-only before the note is read again, so nothing can change it between
    // the check against the version the window shows and the window's first save.
    lock(paneId: string, holder: string, version: string | undefined): NotesMeta {
        const note = this.note(paneId);
        if (note.lock?.by === 'agent') {
            throw new NotesRefused(409, 'An agent is updating these notes. Try again in a moment.');
        }
        if (note.lock && note.lock.holder !== holder) {
            throw new NotesRefused(409, 'These notes are being edited in another window.');
        }
        this.setLock(paneId, note, 'user', holder);
        this.reload(paneId, note);
        if (version !== undefined && version !== note.version) {
            this.release(paneId, note, true);
            throw new NotesRefused(409, 'These notes changed while you were away; the latest version is shown.');
        }
        return this.meta(paneId);
    }

    unlock(paneId: string, holder: string): void {
        const note = this.notes.get(paneId);
        if (note?.lock?.by === 'user' && note.lock.holder === holder) {
            this.release(paneId, note, true);
        }
    }

    save(paneId: string, holder: string, version: string, content: string): PaneNotes {
        if (Buffer.byteLength(content) > MAX_NOTES_BYTES) {
            throw new NotesRefused(413, `Notes can be at most ${MAX_NOTES_BYTES / 1024} KB.`);
        }
        const note = this.note(paneId);
        if (note.lock?.by !== 'user' || note.lock.holder !== holder) {
            throw new NotesRefused(409, 'These notes are not locked for editing in this window.');
        }
        if (version !== note.version) {
            throw new NotesRefused(409, 'These notes changed; the latest version is shown.');
        }
        this.writeFile(paneId, content);
        note.content = content;
        note.version = versionOf(content);
        note.updatedAt = Date.now();
        note.updatedBy = 'user';
        this.setLock(paneId, note, 'user', holder);
        this.options.onChange({ id: paneId, content, version: note.version, by: 'user', holder });
        this.options.onMeta();
        return { content, version: note.version };
    }

    // The id of the note whose file this is, if it is one.
    idOf(path: unknown): string | null {
        if (typeof path !== 'string') {
            return null;
        }
        const file = resolve(path);
        const id = basename(dirname(file));
        return basename(file) === FILE && dirname(dirname(file)) === this.dir && ID.test(id) ? id : null;
    }

    // Marks that the user changed a note, for the notes hook to show it again on the next prompt.
    markChanged(paneId: string, mark: string): void {
        this.dirOf(paneId);
        replaceFile(this.dir, `${paneId}${mark}`, '', 0o600);
    }

    // The editor is the pane whose agent writes, which a change it makes reports as its holder.
    agentEditing(paneId: string, editor: string | null = null): void {
        const note = this.note(paneId);
        if (note.lock?.by !== 'user') {
            this.setLock(paneId, note, 'agent', editor);
        }
    }

    // Without an editor, any agent's lock ends; with one, only the lock that editor holds.
    agentDone(paneId: string, editor?: string): void {
        const note = this.notes.get(paneId);
        if (note?.lock?.by === 'agent' && (editor === undefined || note.lock.holder === editor)) {
            const editor = note.lock.holder;
            this.release(paneId, note, true);
            this.reload(paneId, note, editor);
        }
    }

    remove(paneId: string): void {
        const note = this.notes.get(paneId);
        if (note) {
            if (note.reloadTimer) {
                clearTimeout(note.reloadTimer);
            }
            if (note.lock) {
                clearTimeout(note.lock.timer);
            }
            this.notes.delete(paneId);
        }
        this.removeFiles(paneId);
    }

    private note(paneId: string): Note {
        let note = this.notes.get(paneId);
        if (!note) {
            const { content, updatedAt } = this.readFile(paneId);
            note = { content, version: versionOf(content), updatedAt, updatedBy: null, lock: null, reloadTimer: null };
            this.notes.set(paneId, note);
        }
        return note;
    }

    private reload(paneId: string, note: Note, editor: string | null = null): void {
        const { content, updatedAt } = this.readFile(paneId);
        const version = versionOf(content);
        if (version === note.version) {
            return;
        }
        note.content = content;
        note.version = version;
        note.updatedAt = updatedAt ?? Date.now();
        note.updatedBy = 'agent';
        const holder = editor ?? (note.lock?.by === 'agent' ? note.lock.holder : null);
        this.options.onChange({ id: paneId, content, version, by: 'agent', holder });
        this.options.onMeta();
    }

    private setLock(paneId: string, note: Note, by: NotesAuthor, holder: string | null): void {
        const previous = note.lock;
        if (previous) {
            clearTimeout(previous.timer);
        }
        const timer = setTimeout(() => this.release(paneId, note, true), by === 'user' ? LEASE_MS : AGENT_EDIT_MS);
        timer.unref();
        note.lock = { by, holder, timer };
        if (by === 'user' && previous?.by !== 'user') {
            this.setWritable(paneId, false);
        }
        if (previous?.by !== by || previous.holder !== holder) {
            this.options.onMeta();
        }
    }

    private release(paneId: string, note: Note, notify: boolean): void {
        const lock = note.lock;
        if (!lock) {
            return;
        }
        clearTimeout(lock.timer);
        note.lock = null;
        if (lock.by === 'user') {
            this.setWritable(paneId, true);
        }
        if (notify) {
            this.options.onMeta();
        }
    }

    // A link, a pipe or anything else that is not a plain file reads as empty notes, and an agent
    // that writes more than the daemon will read gets the start of it.
    private readFile(paneId: string): { content: string; updatedAt: number | null } {
        const empty = { content: '', updatedAt: null };
        const dir = this.dirOf(paneId);
        if (kindOf(dir) !== 'directory') {
            return empty;
        }
        const fd = openNote(join(dir, FILE));
        if (fd === null) {
            return empty;
        }
        try {
            const stat = fstatSync(fd);
            return { content: readNote(fd, stat.size), updatedAt: stat.mtimeMs };
        } finally {
            closeSync(fd);
        }
    }

    private writeFile(paneId: string, content: string): void {
        const dir = this.folder(paneId);
        chmodSync(dir, 0o700);
        try {
            replaceFile(dir, FILE, content, 0o400);
        } finally {
            chmodSync(dir, 0o500);
        }
    }

    private setWritable(paneId: string, writable: boolean): void {
        const dir = writable ? this.dirOf(paneId) : this.folder(paneId);
        const file = join(dir, FILE);
        if (writable) {
            chmodNote(file, 0o600);
            chmodFolder(dir, 0o700);
        } else {
            chmodNote(file, 0o400);
            chmodSync(dir, 0o500);
        }
    }

    private removeFiles(paneId: string): void {
        const dir = this.dirOf(paneId);
        chmodFolder(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
        for (const mark of CHANGED_MARKS) {
            rmSync(join(this.dir, `${paneId}${mark}`), { force: true });
        }
    }

    // The pane's folder, as a real folder: whatever else stands at its path is removed first.
    private folder(paneId: string): string {
        const dir = this.dirOf(paneId);
        const kind = kindOf(dir);
        if (kind !== 'directory') {
            if (kind !== null) {
                rmSync(dir, { force: true });
            }
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return dir;
    }

    private dirOf(paneId: string): string {
        if (!ID.test(paneId)) {
            throw new Error(`invalid pane id "${paneId}"`);
        }
        return join(this.dir, paneId);
    }
}
