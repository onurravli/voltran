import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NOTES_HOOK } from './adapters.ts';
import { NOTES_GUIDE } from './notes.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function setup(): { notes: string; changed: string; run: (mode: string, input?: string, env?: Record<string, string>) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-notes-hook-'));
    const folder = join(dir, 'pane-1');
    mkdirSync(folder);
    const guide = join(dir, 'GUIDE.md');
    writeFileSync(guide, NOTES_GUIDE);
    const notes = join(folder, 'notes.md');
    cleanups.push(() => {
        chmodSync(folder, 0o700);
        rmSync(dir, { recursive: true, force: true });
    });
    const run = (mode: string, input = '{}', env: Record<string, string> = { VOLTRAN_NOTES: notes }): string => {
        const result = spawnSync('sh', [NOTES_HOOK, mode, guide], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, input, encoding: 'utf8' });
        expect(result.status).toBe(0);
        return result.stdout;
    };
    return { notes, changed: `${folder}.changed`, run };
}

const toolCall = (path: string): string => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path, content: 'x' } });

describe('notes hook', () => {
    it('does nothing outside a Voltran pane', () => {
        const { run } = setup();
        expect(run('session-start', '{}', {})).toBe('');
        expect(run('pre-tool-use', toolCall('/x'), {})).toBe('');
    });

    it('gives Claude the guide and the notes when a session starts, resumes or compacts', () => {
        const { notes, changed, run } = setup();
        expect(run('session-start')).toBe(`${NOTES_GUIDE}\nNotes file: ${notes}\n\n(empty)\n`);
        writeFileSync(notes, '- ship the drawer\n');
        writeFileSync(changed, '');
        expect(run('session-start')).toBe(`${NOTES_GUIDE}\nNotes file: ${notes}\n\n- ship the drawer\n`);
        expect(existsSync(changed)).toBe(false);
    });

    it('does not print what a notes file planted as a link points at', () => {
        const { notes, run } = setup();
        const secret = `${notes}.secret`;
        writeFileSync(secret, 'outside the sandbox\n');
        symlinkSync(secret, notes);
        const output = run('session-start');
        expect(output).toContain('(not shown: the notes file or its folder is a link');
        expect(output).not.toContain('outside the sandbox');
    });

    it('stays under Claude\'s limit for hook output by cutting long notes', () => {
        const { notes, run } = setup();
        writeFileSync(notes, 'a'.repeat(9000));
        const output = run('session-start');
        expect(output).toContain(`${'a'.repeat(8000)}\n[Cut at 8000 of 9000 bytes. Read the file for the rest.]`);
        expect(output).not.toContain('a'.repeat(8001));
        expect(output.length).toBeLessThan(10_000);
    });

    it('repeats the notes on a prompt only after the user changed them', () => {
        const { notes, changed, run } = setup();
        writeFileSync(notes, 'v1\n');
        expect(run('prompt')).toBe('');
        writeFileSync(changed, '');
        expect(run('prompt')).toBe(`The user changed the pane notes since you last saw them.\n\n${NOTES_GUIDE}\nNotes file: ${notes}\n\nv1\n`);
        expect(existsSync(changed)).toBe(false);
        expect(run('prompt')).toBe('');
    });

    it('refuses an edit of the notes only while the user holds them', () => {
        const { notes, run } = setup();
        const folder = join(notes, '..');
        expect(run('pre-tool-use', toolCall(notes))).toBe('');
        chmodSync(folder, 0o500);
        expect(run('pre-tool-use', toolCall(join(folder, 'other.md')))).toBe('');
        const spaced = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: notes } }, null, 1);
        for (const input of [toolCall(notes), spaced]) {
            const output = JSON.parse(run('pre-tool-use', input)) as { hookSpecificOutput: Record<string, string> };
            expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
            expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/editing these notes/);
        }
    });
});
