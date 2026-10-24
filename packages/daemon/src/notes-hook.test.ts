import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const SECRET = 'pane-secret';

// Stands in for the daemon, which reads the notes for the hook; this one reads the file as it is.
async function setup(): Promise<{ notes: string; changed: string; run: (mode: string, input?: string, env?: Record<string, string>) => Promise<string> }> {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-notes-hook-'));
    const folder = join(dir, 'pane-1');
    mkdirSync(folder);
    const guide = join(dir, 'GUIDE.md');
    writeFileSync(guide, NOTES_GUIDE);
    const notes = join(folder, 'notes.md');
    const header = join(dir, 'header');
    writeFileSync(header, `Authorization: Bearer ${SECRET}\n`);
    const server = createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/api/hooks/pane-1/notes' || req.headers.authorization !== `Bearer ${SECRET}`) {
            res.writeHead(403).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(existsSync(notes) ? readFileSync(notes) : '');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(() => {
        server.close();
        chmodSync(folder, 0o700);
        rmSync(dir, { recursive: true, force: true });
    });
    const paneEnv = { VOLTRAN_NOTES: notes, VOLTRAN_PANE_ID: 'pane-1', VOLTRAN_HOOK_HEADER: header, VOLTRAN_URL: url };
    const run = (mode: string, input = '{}', env: Record<string, string> = paneEnv): Promise<string> => new Promise((resolveRun, reject) => {
        const child = spawn('sh', [NOTES_HOOK, mode, guide], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            expect(code).toBe(0);
            resolveRun(stdout);
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(input);
    });
    return { notes, changed: `${folder}.changed`, run };
}

const toolCall = (path: string): string => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path, content: 'x' } });

describe('notes hook', () => {
    it('does nothing outside a Voltran pane', async () => {
        const { run } = await setup();
        expect(await run('session-start', '{}', {})).toBe('');
        expect(await run('pre-tool-use', toolCall('/x'), {})).toBe('');
    });

    it('gives Claude the guide and the notes when a session starts, resumes or compacts', async () => {
        const { notes, changed, run } = await setup();
        expect(await run('session-start')).toBe(`${NOTES_GUIDE}\nNotes file: ${notes}\n\n(empty)\n`);
        writeFileSync(notes, '- ship the drawer\n');
        writeFileSync(changed, '');
        expect(await run('session-start')).toBe(`${NOTES_GUIDE}\nNotes file: ${notes}\n\n- ship the drawer\n`);
        expect(existsSync(changed)).toBe(false);
    });

    it('takes the notes from Voltran, never from the file, and says so when Voltran does not answer', async () => {
        const { notes, run } = await setup();
        writeFileSync(notes, 'in the file\n');
        const output = await run('session-start', '{}', { VOLTRAN_NOTES: notes, VOLTRAN_PANE_ID: 'pane-1', VOLTRAN_HOOK_HEADER: '/nonexistent', VOLTRAN_URL: 'http://127.0.0.1:9' });
        expect(output).toContain('(not shown: Voltran did not answer. Read the file instead.)');
        expect(output).not.toContain('in the file');
    });

    it('stays under Claude\'s limit for hook output by cutting long notes', async () => {
        const { notes, run } = await setup();
        writeFileSync(notes, 'a'.repeat(9000));
        const output = await run('session-start');
        expect(output).toContain(`${'a'.repeat(8000)}\n[Cut at 8000 of 9000 bytes. Read the file for the rest.]`);
        expect(output).not.toContain('a'.repeat(8001));
        expect(output.length).toBeLessThan(10_000);
    });

    it('repeats the notes on a prompt only after the user changed them', async () => {
        const { notes, changed, run } = await setup();
        writeFileSync(notes, 'v1\n');
        expect(await run('prompt')).toBe('');
        writeFileSync(changed, '');
        expect(await run('prompt')).toBe(`The user changed the pane notes since you last saw them.\n\n${NOTES_GUIDE}\nNotes file: ${notes}\n\nv1\n`);
        expect(existsSync(changed)).toBe(false);
        expect(await run('prompt')).toBe('');
    });

    it('refuses an edit of the notes only while the user holds them', async () => {
        const { notes, run } = await setup();
        const folder = join(notes, '..');
        expect(await run('pre-tool-use', toolCall(notes))).toBe('');
        chmodSync(folder, 0o500);
        expect(await run('pre-tool-use', toolCall(join(folder, 'other.md')))).toBe('');
        const spaced = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: notes } }, null, 1);
        for (const input of [toolCall(notes), spaced]) {
            const output = JSON.parse(await run('pre-tool-use', input)) as { hookSpecificOutput: Record<string, string> };
            expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
            expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/editing these notes/);
        }
    });
});
