import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTranscriptLine, readSubagentMeta, readTranscript, subagentTranscriptPath } from './transcripts.ts';

const SESSION = '4b09873e-72c8-471c-bbb2-f748e22f70d8';

const cleanups: string[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        rmSync(cleanups.pop()!, { recursive: true, force: true });
    }
});

function project(): { dir: string; parent: string; subagents: string } {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-transcripts-'));
    cleanups.push(dir);
    const subagents = join(dir, SESSION, 'subagents');
    mkdirSync(subagents, { recursive: true });
    return { dir, parent: join(dir, `${SESSION}.jsonl`), subagents };
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const LINES = [
    { type: 'user', timestamp: '2026-10-10T00:00:00.000Z', message: { role: 'user', content: 'Research C++ polymorphism.' } },
    { type: 'attachment', attachment: { type: 'skill_listing' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder> Report back when done. </system-reminder>' } },
    { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'g++ --version\n', description: 'compiler' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Apple clang 17' }] }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Virtual functions dispatch at runtime.' }] } },
];

describe('subagentTranscriptPath', () => {
    it('follows Claude\'s layout next to the parent transcript', () => {
        expect(subagentTranscriptPath(`/home/me/.claude/projects/p/${SESSION}.jsonl`, SESSION, 'a6afb54c3c5df9e20'))
            .toBe(`/home/me/.claude/projects/p/${SESSION}/subagents/agent-a6afb54c3c5df9e20.jsonl`);
    });

    it('refuses anything that does not have that exact shape', () => {
        const parent = `/x/${SESSION}.jsonl`;
        expect(subagentTranscriptPath(parent, SESSION, '../../etc/passwd')).toBeNull();
        expect(subagentTranscriptPath(parent, SESSION, 'a/b')).toBeNull();
        expect(subagentTranscriptPath(parent, '../escape', 'a1')).toBeNull();
        expect(subagentTranscriptPath('/x/other.jsonl', SESSION, 'a1')).toBeNull();
        expect(subagentTranscriptPath(`relative/${SESSION}.jsonl`, SESSION, 'a1')).toBeNull();
        expect(subagentTranscriptPath(42, SESSION, 'a1')).toBeNull();
    });
});

describe('readTranscript', () => {
    it('returns the readable entries and skips what Voltran deliberately hides, including injected reminders', () => {
        const { parent, subagents } = project();
        const path = subagentTranscriptPath(parent, SESSION, 'a1')!;
        writeFileSync(join(subagents, 'agent-a1.jsonl'), LINES.map(line).join(''));

        const chunk = readTranscript(path, 0)!;
        expect(chunk.skipped).toBe(0);
        expect(chunk.entries).toEqual([
            { kind: 'prompt', text: 'Research C++ polymorphism.', at: Date.parse('2026-10-10T00:00:00.000Z') },
            { kind: 'tool', id: 'tu1', name: 'Bash', summary: 'g++ --version', at: null },
            { kind: 'result', toolUseId: 'tu1', text: 'Apple clang 17', error: false, at: null },
            { kind: 'text', text: 'Virtual functions dispatch at runtime.', at: null },
        ]);
    });

    it('reads only complete lines and continues from where it stopped', () => {
        const { parent, subagents } = project();
        const path = subagentTranscriptPath(parent, SESSION, 'a1')!;
        const file = join(subagents, 'agent-a1.jsonl');
        const first = line(LINES[0]);
        const last = line(LINES[5]);
        writeFileSync(file, first + last.slice(0, 20));

        const partial = readTranscript(path, 0)!;
        expect(partial.entries.map((entry) => entry.kind)).toEqual(['prompt']);
        expect(partial.next).toBe(Buffer.byteLength(first));

        appendFileSync(file, last.slice(20));
        const rest = readTranscript(path, partial.next)!;
        expect(rest.entries.map((entry) => entry.kind)).toEqual(['text']);
        expect(readTranscript(path, rest.next)!.entries).toEqual([]);
    });

    it('counts lines it does not understand instead of failing', () => {
        const { parent, subagents } = project();
        const path = subagentTranscriptPath(parent, SESSION, 'a1')!;
        writeFileSync(join(subagents, 'agent-a1.jsonl'), 'not json\n' + line({ no: 'type' }) + line({ type: 'assistant', message: { content: 7 } }) + line(LINES[5]));
        const chunk = readTranscript(path, 0)!;
        expect(chunk.skipped).toBe(3);
        expect(chunk.entries).toHaveLength(1);
    });

    it('truncates long tool results', () => {
        const { parent, subagents } = project();
        const path = subagentTranscriptPath(parent, SESSION, 'a1')!;
        writeFileSync(join(subagents, 'agent-a1.jsonl'), line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5000), is_error: true }] } }));
        const [entry] = readTranscript(path, 0)!.entries;
        expect(entry).toMatchObject({ kind: 'result', error: true });
        expect(entry.kind === 'result' && entry.text.length).toBe(2000);
    });

    it('refuses missing files and transcripts reached through symlinks', () => {
        const { dir, parent, subagents } = project();
        const outside = mkdtempSync(join(tmpdir(), 'voltran-outside-'));
        cleanups.push(outside);
        writeFileSync(join(outside, 'secret.jsonl'), line(LINES[5]));
        symlinkSync(join(outside, 'secret.jsonl'), join(subagents, 'agent-link.jsonl'));
        expect(readTranscript(subagentTranscriptPath(parent, SESSION, 'link')!, 0)).toBeNull();
        expect(readTranscript(subagentTranscriptPath(parent, SESSION, 'missing')!, 0)).toBeNull();

        const other = '0b09873e-72c8-471c-bbb2-f748e22f70d8';
        mkdirSync(join(outside, 'subagents'));
        writeFileSync(join(outside, 'subagents', 'agent-a1.jsonl'), line(LINES[5]));
        symlinkSync(outside, join(dir, other));
        expect(readTranscript(subagentTranscriptPath(join(dir, `${other}.jsonl`), other, 'a1')!, 0)).toBeNull();
    });

    it('finds the transcript of an agent a workflow started, once Claude writes it', () => {
        const { parent, subagents } = project();
        const path = subagentTranscriptPath(parent, SESSION, 'a7')!;
        expect(readTranscript(path, 0)).toBeNull();
        const run = join(subagents, 'workflows', 'wf_4f777aee-f5e');
        mkdirSync(run, { recursive: true });
        expect(readTranscript(path, 0)).toBeNull();
        writeFileSync(join(run, 'agent-a7.jsonl'), line(LINES[5]));
        expect(readTranscript(path, 0)?.entries).toEqual([{ kind: 'text', text: 'Virtual functions dispatch at runtime.', at: null }]);
    });

    it('refuses workflow transcripts reached through symlinks', () => {
        const outside = mkdtempSync(join(tmpdir(), 'voltran-outside-'));
        cleanups.push(outside);
        mkdirSync(join(outside, 'wf_run'));
        writeFileSync(join(outside, 'wf_run', 'agent-a1.jsonl'), line(LINES[5]));

        const linkedRun = project();
        mkdirSync(join(linkedRun.subagents, 'workflows'));
        symlinkSync(join(outside, 'wf_run'), join(linkedRun.subagents, 'workflows', 'wf_run'));
        expect(readTranscript(subagentTranscriptPath(linkedRun.parent, SESSION, 'a1')!, 0)).toBeNull();

        mkdirSync(join(linkedRun.subagents, 'workflows', 'wf_real'));
        symlinkSync(join(outside, 'wf_run', 'agent-a1.jsonl'), join(linkedRun.subagents, 'workflows', 'wf_real', 'agent-a2.jsonl'));
        expect(readTranscript(subagentTranscriptPath(linkedRun.parent, SESSION, 'a2')!, 0)).toBeNull();

        const linkedWorkflows = project();
        symlinkSync(outside, join(linkedWorkflows.subagents, 'workflows'));
        expect(readTranscript(subagentTranscriptPath(linkedWorkflows.parent, SESSION, 'a1')!, 0)).toBeNull();
    });
});

describe('readSubagentMeta', () => {
    it('reads the description and type Claude stores beside the transcript', () => {
        const { parent, subagents } = project();
        writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'map the repo', toolUseId: 't1' }));
        expect(readSubagentMeta(subagentTranscriptPath(parent, SESSION, 'a1')!)).toEqual({ description: 'map the repo', type: 'Explore' });
        expect(readSubagentMeta(subagentTranscriptPath(parent, SESSION, 'a2')!)).toBeNull();
    });

    it('reads it from the workflow run of an agent a workflow started', () => {
        const { parent, subagents } = project();
        const run = join(subagents, 'workflows', 'wf_4f777aee-f5e');
        mkdirSync(run, { recursive: true });
        writeFileSync(join(run, 'agent-a7.meta.json'), JSON.stringify({ agentType: 'developer', description: 'dev:OPT-244553', workflowPhase: 'Develop' }));
        expect(readSubagentMeta(subagentTranscriptPath(parent, SESSION, 'a7')!)).toEqual({ description: 'dev:OPT-244553', type: 'developer' });
    });
});

describe('parseTranscriptLine', () => {
    it('summarizes tool calls by their most telling input', () => {
        const tool = (name: string, input: Record<string, unknown>) =>
            parseTranscriptLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } })![0];
        expect(tool('Read', { file_path: '/repo/src/a.ts', limit: 20 })).toMatchObject({ summary: '/repo/src/a.ts' });
        expect(tool('WebSearch', { query: 'cpp vtable' })).toMatchObject({ summary: 'cpp vtable' });
        expect(tool('mcp__docs__search', { query: 'release notes', limit: 5 })).toMatchObject({ summary: 'release notes' });
        expect(tool('Bash', { command: 'x'.repeat(500) })).toMatchObject({ summary: expect.stringMatching(/^x{139}…$/) });
    });

    it('shows the report a subagent hands back as text rather than as a tool call', () => {
        const [entry] = parseTranscriptLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: '# Fact sheet\nAll checked.' } }] } })!;
        expect(entry).toEqual({ kind: 'text', text: '# Fact sheet\nAll checked.', at: null });
    });
});
