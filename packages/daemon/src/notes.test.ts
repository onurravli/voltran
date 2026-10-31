import { randomUUID } from 'node:crypto';
import {
    appendFileSync,
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_NOTES_BYTES } from '@voltran/shared';
import { NotesRefused, NotesStore, type NotesChange } from './notes.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

const HOLDER = 'window-one';

function setup(): { dir: string; store: NotesStore; changes: NotesChange[]; metas: () => number } {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-notes-'));
    const changes: NotesChange[] = [];
    let metas = 0;
    const store = new NotesStore({ dir, onChange: (change) => changes.push(change), onMeta: () => metas++ });
    cleanups.push(() => {
        store.close();
        chmodAll(dir);
        rmSync(dir, { recursive: true, force: true });
    });
    return { dir, store, changes, metas: () => metas };
}

function chmodAll(dir: string): void {
    if (!existsSync(dir)) {
        return;
    }
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            chmodAll(path);
        }
    }
}

function refusal(action: () => unknown): NotesRefused {
    try {
        action();
    } catch (error) {
        if (error instanceof NotesRefused) {
            return error;
        }
        throw error;
    }
    throw new Error('expected the store to refuse');
}

function writes(path: string): boolean {
    try {
        appendFileSync(path, 'agent\n');
        return true;
    } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
        return false;
    }
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('condition not met in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const asRoot = process.getuid?.() === 0;

describe('NotesStore', () => {
    it('starts empty and gives each pane a folder of its own', () => {
        const { dir, store } = setup();
        const paneId = randomUUID();
        expect(store.read(paneId).content).toBe('');
        expect(store.meta(paneId)).toEqual({ size: 0, updatedAt: null, updatedBy: null, lock: null, holder: null });
        const file = store.file(paneId);
        expect(file).toBe(join(dir, paneId, 'notes.md'));
        expect(statSync(join(dir, paneId)).isDirectory()).toBe(true);
        expect(store.isFile(paneId, file)).toBe(true);
        expect(store.isFile(paneId, join(dir, randomUUID(), 'notes.md'))).toBe(false);
        expect(() => store.file('../escape')).toThrow();
    });

    it('saves only under the lock and against the version the window shows', () => {
        const { dir, store, changes } = setup();
        const paneId = randomUUID();
        const { version } = store.read(paneId);
        expect(refusal(() => store.save(paneId, HOLDER, version, 'early')).status).toBe(409);

        store.lock(paneId, HOLDER, version);
        const saved = store.save(paneId, HOLDER, version, '# Plan\n');
        expect(readFileSync(join(dir, paneId, 'notes.md'), 'utf8')).toBe('# Plan\n');
        expect(saved.version).not.toBe(version);
        expect(changes.at(-1)).toMatchObject({ paneId, content: '# Plan\n', by: 'user', holder: HOLDER });
        expect(existsSync(join(dir, `${paneId}.changed`))).toBe(true);
        expect(store.meta(paneId)).toMatchObject({ size: 7, updatedBy: 'user', lock: 'user', holder: HOLDER });

        expect(refusal(() => store.save(paneId, HOLDER, version, 'stale')).status).toBe(409);
        expect(refusal(() => store.save(paneId, 'window-two', saved.version, 'other')).status).toBe(409);
        expect(refusal(() => store.save(paneId, HOLDER, saved.version, 'x'.repeat(MAX_NOTES_BYTES + 1))).status).toBe(
            413,
        );
        expect(store.read(paneId).content).toBe('# Plan\n');
    });

    it.skipIf(asRoot)('keeps every writer out while the user holds the lock', () => {
        const { dir, store } = setup();
        const paneId = randomUUID();
        const file = store.file(paneId);
        writeFileSync(file, 'start\n');
        store.lock(paneId, HOLDER, store.read(paneId).version);

        expect(statSync(join(dir, paneId)).mode & 0o777).toBe(0o500);
        expect(statSync(file).mode & 0o777).toBe(0o400);
        expect(writes(file)).toBe(false);
        expect(() => writeFileSync(join(dir, paneId, 'replacement.md'), 'agent\n')).toThrow();

        store.unlock(paneId, HOLDER);
        expect(statSync(join(dir, paneId)).mode & 0o777).toBe(0o700);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(writes(file)).toBe(true);
        const temporary = join(dir, paneId, 'replacement.md');
        writeFileSync(temporary, 'replaced\n');
        renameSync(temporary, file);
        expect(readFileSync(file, 'utf8')).toBe('replaced\n');
    });

    it('never follows a link planted where it writes or reads, and never changes the mode of what a link points at', () => {
        const { dir, store } = setup();
        const outside = mkdtempSync(join(tmpdir(), 'voltran-outside-'));
        cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
        const precious = (name: string): string => {
            const path = join(outside, name);
            writeFileSync(path, 'precious\n', { mode: 0o644 });
            return path;
        };
        const paneId = randomUUID();
        const notes = precious('notes');
        const changed = precious('changed');
        const guide = precious('guide');
        symlinkSync(notes, store.file(paneId));
        symlinkSync(changed, join(dir, `${paneId}.changed`));
        symlinkSync(guide, join(dir, 'GUIDE.md'));

        store.load([paneId]);
        expect(store.read(paneId).content).toBe('');
        store.lock(paneId, HOLDER, store.read(paneId).version);
        store.save(paneId, HOLDER, store.read(paneId).version, 'mine\n');
        store.unlock(paneId, HOLDER);

        for (const path of [notes, changed, guide]) {
            expect(readFileSync(path, 'utf8')).toBe('precious\n');
            expect(statSync(path).mode & 0o777).toBe(0o644);
        }
        expect(lstatSync(store.file(paneId)).isFile()).toBe(true);
        expect(readFileSync(store.file(paneId), 'utf8')).toBe('mine\n');
        expect(lstatSync(join(dir, `${paneId}.changed`)).isFile()).toBe(true);

        const linked = randomUUID();
        symlinkSync(outside, join(dir, linked));
        store.lock(linked, HOLDER, store.read(linked).version);
        store.save(linked, HOLDER, store.read(linked).version, 'elsewhere?\n');
        store.unlock(linked, HOLDER);
        expect(lstatSync(join(dir, linked)).isDirectory()).toBe(true);
        expect(existsSync(join(outside, 'notes.md'))).toBe(false);
        expect(statSync(outside).mode & 0o777).toBe(0o700);
    });

    it('treats a hard link planted as the notes like any other file that is not its own', () => {
        const { store } = setup();
        const outside = mkdtempSync(join(tmpdir(), 'voltran-outside-'));
        cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
        const precious = join(outside, 'precious');
        writeFileSync(precious, 'precious\n', { mode: 0o644 });
        const paneId = randomUUID();
        store.load([paneId]);
        linkSync(precious, store.file(paneId));

        expect(store.current(paneId)).toBe('');
        store.lock(paneId, HOLDER, store.read(paneId).version);
        expect(statSync(precious).mode & 0o777).toBe(0o644);
        store.unlock(paneId, HOLDER);
        expect(statSync(precious).mode & 0o777).toBe(0o644);
        expect(readFileSync(precious, 'utf8')).toBe('precious\n');
    });

    it("reads no more of an agent's notes than it would ever show", () => {
        const { store } = setup();
        const paneId = randomUUID();
        store.read(paneId);
        writeFileSync(store.file(paneId), 'a'.repeat(2 * 1024 * 1024));
        expect(store.current(paneId).length).toBe(1024 * 1024);
    });

    // An error the watcher's reload threw would end the daemon, and every pane with it.
    it.skipIf(process.getuid?.() === 0)(
        'reads notes an agent made unreadable as empty instead of failing',
        async () => {
            const { store } = setup();
            const paneId = randomUUID();
            const file = store.file(paneId);
            writeFileSync(file, 'readable\n');
            expect(store.read(paneId).content).toBe('readable\n');
            store.watch();
            chmodSync(file, 0o200);
            appendFileSync(file, 'more\n');
            await new Promise((resolveWait) => setTimeout(resolveWait, 500));
            expect(store.current(paneId)).toBe('');
        },
    );

    it('refuses the lock to a stale window, another window and a running agent edit', () => {
        const { store } = setup();
        const paneId = randomUUID();
        writeFileSync(store.file(paneId), 'first\n');
        const shown = store.read(paneId).version;
        writeFileSync(store.file(paneId), 'agent wrote this\n');

        expect(refusal(() => store.lock(paneId, HOLDER, shown)).status).toBe(409);
        expect(store.meta(paneId).lock).toBeNull();
        expect(store.read(paneId).content).toBe('agent wrote this\n');

        store.lock(paneId, HOLDER, store.read(paneId).version);
        expect(refusal(() => store.lock(paneId, 'window-two', store.read(paneId).version)).message).toMatch(
            /another window/,
        );
        store.unlock(paneId, 'window-two');
        expect(store.meta(paneId).lock).toBe('user');
        store.unlock(paneId, HOLDER);

        store.agentEditing(paneId);
        expect(store.meta(paneId).lock).toBe('agent');
        expect(refusal(() => store.lock(paneId, HOLDER, store.read(paneId).version)).message).toMatch(/agent/);
    });

    it('renews the lease for the same window and lets it lapse when the window goes quiet', () => {
        vi.useFakeTimers();
        const { dir, store } = setup();
        const paneId = randomUUID();
        store.file(paneId);
        store.lock(paneId, HOLDER, store.read(paneId).version);
        vi.advanceTimersByTime(8000);
        store.lock(paneId, HOLDER, undefined);
        vi.advanceTimersByTime(8000);
        expect(store.meta(paneId).lock).toBe('user');
        vi.advanceTimersByTime(2500);
        expect(store.meta(paneId).lock).toBeNull();
        expect(statSync(join(dir, paneId)).mode & 0o777).toBe(0o700);
    });

    it('does not let an agent edit take the lock from the user', () => {
        const { store } = setup();
        const paneId = randomUUID();
        store.lock(paneId, HOLDER, store.read(paneId).version);
        store.agentEditing(paneId);
        expect(store.meta(paneId)).toMatchObject({ lock: 'user', holder: HOLDER });
    });

    it("reports a write it did not make as the agent's once the agent is done", () => {
        const { store, changes } = setup();
        const paneId = randomUUID();
        const file = store.file(paneId);
        store.agentEditing(paneId);
        writeFileSync(file, 'progress: step 2\n');
        store.agentDone(paneId);
        expect(store.meta(paneId)).toMatchObject({ lock: null, updatedBy: 'agent' });
        expect(changes.at(-1)).toMatchObject({ paneId, content: 'progress: step 2\n', by: 'agent', holder: null });
    });

    // FSEvents drops what happens before its stream is running, so the write is repeated until the
    // watcher is up rather than assuming it is ready the moment watch() returns.
    it('notices a write from any process through the watcher', async () => {
        const { store, changes } = setup();
        const paneId = randomUUID();
        const file = store.file(paneId);
        store.read(paneId);
        store.watch();
        for (let attempt = 1; attempt <= 5 && changes.length === 0; attempt++) {
            writeFileSync(file, `written by codex ${attempt}\n`);
            await until(() => changes.length > 0, 600).catch(() => undefined);
        }
        expect(changes.at(-1)).toMatchObject({ paneId, by: 'agent' });
        expect(store.read(paneId).content).toBe(changes.at(-1)?.content);
    });

    it('unlocks the notes of known panes and deletes the rest when it starts', () => {
        const { dir, store } = setup();
        const kept = randomUUID();
        const gone = randomUUID();
        for (const paneId of [kept, gone]) {
            mkdirSync(join(dir, paneId));
            writeFileSync(join(dir, paneId, 'notes.md'), `${paneId}\n`, { mode: 0o400 });
            chmodSync(join(dir, paneId), 0o500);
            writeFileSync(join(dir, `${paneId}.changed`), '');
        }
        store.load([kept]);
        expect(statSync(join(dir, kept)).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, kept, 'notes.md')).mode & 0o777).toBe(0o600);
        expect(existsSync(join(dir, `${kept}.changed`))).toBe(true);
        expect(existsSync(join(dir, gone))).toBe(false);
        expect(existsSync(join(dir, `${gone}.changed`))).toBe(false);
    });

    it("deletes a pane's note even while it is locked", () => {
        const { dir, store } = setup();
        const paneId = randomUUID();
        store.lock(paneId, HOLDER, store.read(paneId).version);
        store.save(paneId, HOLDER, store.read(paneId).version, 'bye\n');
        store.remove(paneId);
        expect(existsSync(join(dir, paneId))).toBe(false);
        expect(existsSync(join(dir, `${paneId}.changed`))).toBe(false);
        expect(store.read(paneId).content).toBe('');
    });

    it('unlocks every note when it closes', () => {
        const { dir, store } = setup();
        const paneId = randomUUID();
        store.lock(paneId, HOLDER, store.read(paneId).version);
        store.close();
        expect(statSync(join(dir, paneId)).mode & 0o777).toBe(0o700);
    });
});
