import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotesMeta, PaneNotes } from '@voltran/shared';
import { NotesEditor, RELEASE_DELAY_MS, RENEW_EVERY_MS, SAVE_DELAY_MS, type NotesApi } from './notes.ts';

const META: NotesMeta = { size: 0, updatedAt: null, updatedBy: null, lock: 'user', holder: 'window-me' };

function fakeApi(initial: PaneNotes = { content: 'start\n', version: 'v0' }) {
    const calls: string[] = [];
    const state = { server: { ...initial }, lockError: null as Error | null, saveError: null as Error | null, saves: 0 };
    const notesApi: NotesApi = {
        read: async () => {
            calls.push('read');
            return { ...state.server };
        },
        lock: async (_paneId, body) => {
            calls.push(`lock ${body.version ?? '-'}`);
            if (state.lockError) {
                throw state.lockError;
            }
            return META;
        },
        unlock: async () => {
            calls.push('unlock');
        },
        save: async (_paneId, body, keepalive) => {
            calls.push(`save ${JSON.stringify(body.content)} @${body.version}${keepalive ? ' keepalive' : ''}`);
            if (state.saveError) {
                throw state.saveError;
            }
            state.server = { content: body.content, version: `v${++state.saves}` };
            return { ...state.server };
        },
    };
    return { notesApi, calls, state };
}

async function opened(initial?: PaneNotes) {
    const fake = fakeApi(initial);
    const editor = new NotesEditor('pane-1', fake.notesApi, 'window-me');
    await editor.load();
    fake.calls.length = 0;
    return { editor, ...fake };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('NotesEditor', () => {
    it('takes the lock on the first keystroke, saves after a pause and gives the lock back later', async () => {
        const { editor, calls } = await opened();
        expect(editor.getSnapshot()).toMatchObject({ loaded: true, text: 'start\n', dirty: false, holding: false });

        editor.input('start\nmore');
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(['lock v0']);
        expect(editor.getSnapshot()).toMatchObject({ text: 'start\nmore', dirty: true, holding: true });

        await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
        expect(calls).toEqual(['lock v0', 'save "start\\nmore" @v0']);
        expect(editor.getSnapshot()).toMatchObject({ text: 'start\nmore', dirty: false, holding: true });

        await vi.advanceTimersByTimeAsync(RELEASE_DELAY_MS);
        expect(calls.at(-1)).toBe('unlock');
        expect(editor.getSnapshot().holding).toBe(false);

        editor.input('again');
        await vi.advanceTimersByTimeAsync(0);
        expect(calls.at(-1)).toBe('lock v1');
    });

    it('renews the lock while the user keeps typing without a pause', async () => {
        const { editor, calls } = await opened();
        editor.input('a');
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 20; index++) {
            await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS / 2);
            editor.input(`a${'b'.repeat(index)}`);
        }
        const renewals = calls.filter((call) => call === 'lock -').length;
        expect(renewals).toBe(Math.floor((20 * SAVE_DELAY_MS) / 2 / RENEW_EVERY_MS));
        expect(calls.some((call) => call.startsWith('save'))).toBe(false);
    });

    it('shows changes made elsewhere but never replaces what the user is typing', async () => {
        const { editor } = await opened();
        editor.applyRemote({ content: 'agent wrote\n', version: 'v9' }, null);
        expect(editor.getSnapshot()).toMatchObject({ text: 'agent wrote\n', dirty: false });

        editor.input('mine');
        editor.applyRemote({ content: 'agent again\n', version: 'v10' }, null);
        expect(editor.getSnapshot()).toMatchObject({ text: 'mine', dirty: true });

        editor.applyRemote({ content: 'echo of my own save', version: 'v11' }, 'window-me');
        expect(editor.getSnapshot().text).toBe('mine');
    });

    it('keeps the draft when the lock is refused, until the user keeps it or loads the other version', async () => {
        const { editor, calls, state } = await opened();
        state.lockError = new Error('An agent is updating these notes. Try again in a moment.');
        state.server = { content: 'agent version\n', version: 'v5' };

        editor.input('my draft');
        await vi.advanceTimersByTimeAsync(0);
        expect(editor.getSnapshot()).toMatchObject({ text: 'my draft', dirty: true, holding: false, conflict: state.lockError.message });
        expect(calls).toEqual(['lock v0', 'read']);

        state.lockError = null;
        editor.keepMine();
        await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
        expect(calls.slice(2)).toEqual(['lock v5', 'save "my draft" @v5']);
        expect(editor.getSnapshot()).toMatchObject({ text: 'my draft', dirty: false, conflict: null });
    });

    it('loads the other version when the user chooses it', async () => {
        const { editor, state } = await opened();
        state.lockError = new Error('These notes are being edited in another window.');
        state.server = { content: 'other window\n', version: 'v7' };
        editor.input('my draft');
        await vi.advanceTimersByTimeAsync(0);
        editor.takeTheirs();
        expect(editor.getSnapshot()).toMatchObject({ text: 'other window\n', dirty: false, conflict: null });
    });

    it('keeps the draft when a save is refused', async () => {
        const { editor, state } = await opened();
        editor.input('draft');
        await vi.advanceTimersByTimeAsync(0);
        state.saveError = new Error('These notes are not locked for editing in this window.');
        await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
        expect(editor.getSnapshot()).toMatchObject({ text: 'draft', dirty: true, holding: false, conflict: state.saveError.message });
    });

    it('saves at once and gives the lock back when the user leaves the notes', async () => {
        const { editor, calls } = await opened();
        editor.input('quick');
        await editor.flush();
        expect(calls).toEqual(['lock v0', 'save "quick" @v0', 'unlock']);
        expect(editor.getSnapshot()).toMatchObject({ dirty: false, holding: false });
    });

    it('starts the save before the page goes away', async () => {
        const { editor, calls } = await opened();
        editor.input('last words');
        await vi.advanceTimersByTimeAsync(0);
        editor.flushOnExit();
        expect(calls.at(-1)).toBe('save "last words" @v0 keepalive');
    });
});
