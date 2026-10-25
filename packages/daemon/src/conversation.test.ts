import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeLine, readClaudeConversation } from './conversation.ts';
import { findClaudeTranscript, isClaudeTranscript } from './transcripts.ts';

const SESSION = '4b09873e-72c8-471c-bbb2-f748e22f70d8';

const cleanups: string[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        rmSync(cleanups.pop()!, { recursive: true, force: true });
    }
});

function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-conversation-'));
    cleanups.push(dir);
    return dir;
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { model: 'claude-test', role: 'assistant', content }, ...extra });

describe('parseClaudeLine', () => {
    it('turns prompts, messages, thinking, tool calls and results into entries', () => {
        expect(parseClaudeLine({ type: 'user', timestamp: '2026-10-10T00:00:00.000Z', message: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'What is this?' }] } }))
            .toEqual([{ kind: 'prompt', text: 'What is this?', images: 1, at: Date.parse('2026-10-10T00:00:00.000Z') }]);
        expect(parseClaudeLine(assistant([
            { type: 'thinking', thinking: '' },
            { type: 'thinking', thinking: 'Look first.' },
            { type: 'text', text: 'A **diagram**.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls\npwd', description: 'List files' } },
        ]))).toEqual([
            { kind: 'thinking', text: 'Look first.', at: null },
            { kind: 'text', text: 'A **diagram**.', model: 'claude-test', at: null },
            { kind: 'tool', id: 't1', name: 'Bash', summary: 'List files', detail: { kind: 'command', command: 'ls\npwd' }, at: null },
        ]);
        expect(parseClaudeLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } }))
            .toEqual([{ kind: 'result', toolUseId: 't1', text: 'denied', error: true, at: null }]);
    });

    it('keeps the inputs the view draws for edits, writes and plans, and the rest as JSON', () => {
        const tool = (name: string, input: Record<string, unknown>) => parseClaudeLine(assistant([{ type: 'tool_use', id: 'x', name, input }]))![0];
        expect(tool('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })).toMatchObject({ detail: { kind: 'edit', path: '/r/a.ts', changes: [{ before: 'a', after: 'b' }] } });
        expect(tool('MultiEdit', { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, null] })).toMatchObject({ detail: { kind: 'edit', changes: [{ before: 'a', after: 'b' }] } });
        expect(tool('Write', { file_path: '/r/b.ts', content: 'x' })).toMatchObject({ detail: { kind: 'write', path: '/r/b.ts', content: 'x' } });
        expect(tool('TodoWrite', { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'odd' }] }))
            .toMatchObject({ detail: { kind: 'todos', todos: [{ text: 'Read', state: 'completed' }, { text: 'Write', state: 'pending' }] } });
        expect(tool('WebSearch', { query: 'q' })).toMatchObject({ summary: 'q', detail: { kind: 'input', text: '{\n  "query": "q"\n}' } });
        expect(tool('Edit', {})).toMatchObject({ detail: null });
    });

    it('shows local commands as what the user typed and their output as a notice, without colour codes', () => {
        expect(parseClaudeLine({ type: 'user', message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } }))
            .toEqual([{ kind: 'prompt', text: '/model opus', images: 0, at: null }]);
        expect(parseClaudeLine({ type: 'user', message: { content: '<local-command-stdout>Set model to \u001b[1mopus\u001b[22m</local-command-stdout>' } }))
            .toEqual([{ kind: 'notice', text: 'Set model to opus', tone: 'info', at: null }]);
        expect(parseClaudeLine({ type: 'user', message: { content: '<bash-input>git status</bash-input>' } }))
            .toEqual([{ kind: 'prompt', text: '! git status', images: 0, at: null }]);
        expect(parseClaudeLine({ type: 'user', message: { content: '<bash-stdout></bash-stdout><bash-stderr>not a repo</bash-stderr>' } }))
            .toEqual([{ kind: 'notice', text: 'not a repo', tone: 'error', at: null }]);
        expect(parseClaudeLine({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }))
            .toEqual([{ kind: 'notice', text: 'Interrupted', tone: 'info', at: null }]);
    });

    it('skips what Claude adds for itself and marks compaction and failed requests', () => {
        expect(parseClaudeLine({ type: 'user', isMeta: true, message: { content: '<system-reminder>x</system-reminder>' } })).toEqual([]);
        expect(parseClaudeLine({ type: 'user', isCompactSummary: true, message: { content: 'Summary of the conversation' } })).toEqual([]);
        expect(parseClaudeLine({ type: 'attachment', attachment: {} })).toEqual([]);
        expect(parseClaudeLine({ type: 'system', subtype: 'compact_boundary' })).toEqual([{ kind: 'notice', text: 'Conversation compacted', tone: 'info', at: null }]);
        expect(parseClaudeLine(assistant([{ type: 'text', text: 'API Error: overloaded' }], { isApiErrorMessage: true })))
            .toEqual([{ kind: 'notice', text: 'API Error: overloaded', tone: 'error', at: null }]);
        expect(parseClaudeLine({ type: 'assistant', message: { model: '<synthetic>', content: 'No response requested.' } }))
            .toEqual([{ kind: 'text', text: 'No response requested.', model: null, at: null }]);
        expect(parseClaudeLine('nope')).toBeNull();
        expect(parseClaudeLine({ type: 'user' })).toBeNull();
    });
});

describe('readClaudeConversation', () => {
    it('reads whole lines from where the last read stopped', () => {
        const path = join(folder(), `${SESSION}.jsonl`);
        writeFileSync(path, line({ type: 'user', message: { content: 'hi' } }) + '{"type":"assistant","mess');
        const first = readClaudeConversation(path, SESSION, 0)!;
        expect(first).toMatchObject({ source: SESSION, entries: [{ kind: 'prompt', text: 'hi' }], more: false });
        expect(readClaudeConversation(path, SESSION, first.next)!.entries).toEqual([]);
        appendFileSync(path, 'age":{"content":"hello"}}\n');
        expect(readClaudeConversation(path, SESSION, first.next)!.entries).toEqual([{ kind: 'text', text: 'hello', model: null, at: null }]);
    });

    it('says when a long transcript has more to read', () => {
        const path = join(folder(), `${SESSION}.jsonl`);
        const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(100_000) }] } };
        writeFileSync(path, line(result).repeat(15));
        let chunk = readClaudeConversation(path, SESSION, 0)!;
        let entries = chunk.entries.length;
        expect(chunk.more).toBe(true);
        while (chunk.more) {
            chunk = readClaudeConversation(path, SESSION, chunk.next)!;
            entries += chunk.entries.length;
        }
        expect(entries).toBe(15);
    });

    it('refuses links and missing files', () => {
        const dir = folder();
        writeFileSync(join(dir, 'real.jsonl'), line({ type: 'user', message: { content: 'secret' } }));
        symlinkSync(join(dir, 'real.jsonl'), join(dir, `${SESSION}.jsonl`));
        expect(readClaudeConversation(join(dir, `${SESSION}.jsonl`), SESSION, 0)).toBeNull();
        expect(readClaudeConversation(join(dir, 'missing.jsonl'), SESSION, 0)).toBeNull();
    });
});

describe('finding a pane\'s transcript', () => {
    it('accepts only a path named after the session its hook reported', () => {
        expect(isClaudeTranscript(`/home/me/.claude/projects/p/${SESSION}.jsonl`, SESSION)).toBe(true);
        expect(isClaudeTranscript(`/home/me/.claude/projects/p/other.jsonl`, SESSION)).toBe(false);
        expect(isClaudeTranscript(`p/${SESSION}.jsonl`, SESSION)).toBe(false);
        expect(isClaudeTranscript(`/x/--help.jsonl`, '--help')).toBe(false);
    });

    it('looks the session up in every project folder of Claude\'s config', () => {
        const config = folder();
        mkdirSync(join(config, 'projects', '-repo-a'), { recursive: true });
        mkdirSync(join(config, 'projects', '-repo-b'), { recursive: true });
        writeFileSync(join(config, 'projects', '-repo-b', `${SESSION}.jsonl`), '');
        expect(findClaudeTranscript(config, SESSION)).toBe(join(config, 'projects', '-repo-b', `${SESSION}.jsonl`));
        expect(findClaudeTranscript(config, '11111111-2222-3333-4444-555555555555')).toBeNull();
        expect(findClaudeTranscript(config, '../escape')).toBeNull();
        expect(findClaudeTranscript(null, SESSION)).toBeNull();
    });
});
