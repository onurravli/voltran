import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pane, Session, TitleSource } from '@voltran/shared';
import { SessionNamer, titleFromPrompt } from './naming.ts';
import { readAiTitle } from './transcripts.ts';

const CONVERSATION = '11111111-2222-3333-4444-555555555555';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function transcript(lines: object[], name = `${CONVERSATION}.jsonl`): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-naming-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, name);
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    return file;
}

const session = (titleSource: TitleSource): Session => ({
    id: 's1',
    projectId: 'p1',
    title: 'New session',
    titleSource,
    link: null,
    cwd: '/tmp',
    worktree: null,
    layout: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
});

const pane = (adapter: Pane['adapter']): Pane => ({
    id: 'pane1',
    sessionId: 's1',
    adapter,
    title: adapter,
    command: null,
    cwd: '/tmp',
    agentSessionId: null,
    agentResumable: false,
    ended: false,
    createdAt: 0,
});

describe('titleFromPrompt', () => {
    it.each([
        ['fix the login redirect', 'fix the login redirect'],
        ['\n\n  fix   the\tlogin redirect  \nand then the tests', 'fix the login redirect'],
        ['make the sidebar remember which projects are collapsed after a reload, please', 'make the sidebar remember which projects are collapsed after…'],
        ['fix \u001b[2Jthe\u009b login', 'fix [2Jthe login'],
        ['/review', null],
        ['   ', null],
        [42, null],
    ])('names %j as %j', (prompt, expected) => {
        expect(titleFromPrompt(prompt)).toBe(expected);
    });
});

describe('readAiTitle', () => {
    it('reads the title Claude Code gave the conversation', () => {
        const file = transcript([{ type: 'user', message: { content: 'hi' } }, { type: 'ai-title', aiTitle: '  Login  redirect fix ', sessionId: CONVERSATION }]);
        expect(readAiTitle(file, CONVERSATION)).toBe('Login redirect fix');
        const escaped = transcript([{ type: 'ai-title', aiTitle: 'Login\u001b]0;x\u0007 fix', sessionId: CONVERSATION }]);
        expect(readAiTitle(escaped, CONVERSATION)).toBe('Login]0;x fix');
    });

    it('refuses a path that does not name the reported conversation, a link or a relative path', () => {
        const file = transcript([{ type: 'ai-title', aiTitle: 'Title' }]);
        expect(readAiTitle(file, '99999999-2222-3333-4444-555555555555')).toBeNull();
        expect(readAiTitle(file, 'not-a-uuid')).toBeNull();
        expect(readAiTitle(`${CONVERSATION}.jsonl`, CONVERSATION)).toBeNull();
        const other = transcript([{ type: 'ai-title', aiTitle: 'Elsewhere' }], 'other.jsonl');
        const link = join(mkdtempSync(join(tmpdir(), 'voltran-naming-')), `${CONVERSATION}.jsonl`);
        cleanups.push(() => rmSync(join(link, '..'), { recursive: true, force: true }));
        symlinkSync(other, link);
        expect(readAiTitle(link, CONVERSATION)).toBeNull();
    });

    it('returns nothing before Claude has named the conversation', () => {
        expect(readAiTitle(transcript([{ type: 'user', message: { content: 'hi' } }]), CONVERSATION)).toBeNull();
        expect(readAiTitle('/nonexistent/' + `${CONVERSATION}.jsonl`, CONVERSATION)).toBeNull();
    });
});

describe('SessionNamer', () => {
    it('names a pending session from the first prompt of any agent', () => {
        const namer = new SessionNamer();
        expect(namer.name(session('pending'), pane('codex'), 'UserPromptSubmit', { prompt: 'bump postgres' })).toEqual({ title: 'bump postgres', titleSource: 'prompt' });
        expect(namer.name(session('pending'), pane('opencode'), 'PromptSubmit', { prompt: 'add dark mode' })).toEqual({ title: 'add dark mode', titleSource: 'prompt' });
        expect(namer.name(session('prompt'), pane('codex'), 'UserPromptSubmit', { prompt: 'second prompt' })).toBeNull();
        expect(namer.name(session('pending'), pane('codex'), 'Stop', { prompt: 'not a prompt event' })).toBeNull();
    });

    it("prefers Claude's own title, then stops looking", () => {
        const namer = new SessionNamer();
        const file = transcript([{ type: 'ai-title', aiTitle: 'Login redirect fix' }]);
        const payload = { prompt: 'fix it', transcript_path: file, session_id: CONVERSATION };
        expect(namer.name(session('pending'), pane('claude'), 'UserPromptSubmit', payload, 0)).toEqual({ title: 'Login redirect fix', titleSource: 'agent' });
        expect(namer.name(session('agent'), pane('claude'), 'Stop', payload, 5000)).toBeNull();
    });

    it('keeps the prompt title until the transcript has one, looking at most every two seconds', () => {
        const namer = new SessionNamer();
        const empty = transcript([{ type: 'user', message: { content: 'fix it' } }]);
        const payload = { prompt: 'fix it', transcript_path: empty, session_id: CONVERSATION };
        expect(namer.name(session('pending'), pane('claude'), 'UserPromptSubmit', payload, 0)).toEqual({ title: 'fix it', titleSource: 'prompt' });
        writeFileSync(empty, JSON.stringify({ type: 'ai-title', aiTitle: 'Named' }) + '\n', { flag: 'a' });
        expect(namer.name(session('prompt'), pane('claude'), 'PreToolUse', payload, 1000)).toBeNull();
        expect(namer.name(session('prompt'), pane('claude'), 'Stop', payload, 2500)).toEqual({ title: 'Named', titleSource: 'agent' });
    });

    it('never renames a session the user titled', () => {
        const file = transcript([{ type: 'ai-title', aiTitle: 'Named' }]);
        expect(new SessionNamer().name(session('user'), pane('claude'), 'UserPromptSubmit', { prompt: 'x', transcript_path: file, session_id: CONVERSATION })).toBeNull();
    });
});
