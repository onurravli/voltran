import { describe, expect, it } from 'vitest';
import { createRenderState, renderEntries } from './subagent-render.ts';

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');

describe('renderEntries', () => {
    it('lays a conversation out like Claude Code', () => {
        const state = createRenderState();
        const output = plain(renderEntries([
            { kind: 'prompt', text: 'Find the Jokers.\nKeep it short.', at: null },
            { kind: 'tool', id: 't1', name: 'WebSearch', summary: 'Impractical Jokers cast', at: null },
            { kind: 'result', toolUseId: 't1', text: 'one\ntwo\nthree\nfour\nfive', error: false, at: null },
            { kind: 'text', text: '# Fact sheet\nThe **four** Jokers:\n```\nJoe Murr Q Sal\n```\nDone.', at: null },
        ], state));
        expect(output).toBe([
            '> Find the Jokers.',
            '  Keep it short.',
            '',
            '● WebSearch(Impractical Jokers cast)',
            '  ⎿  one',
            '     two',
            '     three',
            '     … +2 lines',
            '',
            '● Fact sheet',
            '  The four Jokers:',
            '  Joe Murr Q Sal',
            '  Done.',
            '',
        ].join('\n'));
    });

    it('names the tool when its result arrives after another call', () => {
        const state = createRenderState();
        renderEntries([
            { kind: 'tool', id: 'a', name: 'Read', summary: 'a.ts', at: null },
            { kind: 'tool', id: 'b', name: 'Grep', summary: 'TODO', at: null },
        ], state);
        expect(plain(renderEntries([{ kind: 'result', toolUseId: 'a', text: 'contents', error: false, at: null }], state))).toBe('  ⎿  (Read) contents\n');
        expect(plain(renderEntries([{ kind: 'result', toolUseId: 'b', text: '', error: false, at: null }], state))).toBe('  ⎿  (no output)\n');
    });

    it('shows failed tool results in red', () => {
        const state = createRenderState();
        renderEntries([{ kind: 'tool', id: 'x', name: 'Bash', summary: 'rm', at: null }], state);
        const output = renderEntries([{ kind: 'result', toolUseId: 'x', text: 'permission denied', error: true, at: null }], state);
        expect(output).toContain('\x1b[31mpermission denied');
    });

    it('hides results of calls it does not show, such as the report hand-back', () => {
        const output = renderEntries([
            { kind: 'text', text: 'The report.', at: null },
            { kind: 'result', toolUseId: 'handback', text: '{"success":true}', error: false, at: null },
        ], createRenderState());
        expect(plain(output)).toBe('\n● The report.\n');
    });

    it('cuts very long result lines', () => {
        const state = createRenderState();
        renderEntries([{ kind: 'tool', id: 's', name: 'WebSearch', summary: 'q', at: null }], state);
        const [line] = plain(renderEntries([{ kind: 'result', toolUseId: 's', text: 'x'.repeat(1000), error: false, at: null }], state)).split('\n');
        expect(line).toBe(`  ⎿  ${'x'.repeat(159)}…`);
    });

    it('renders italics and links without their markdown syntax', () => {
        const output = renderEntries([{ kind: 'text', text: '*Issued today* by **me**, see [Wikipedia](https://en.wikipedia.org/wiki/Reuben_sandwich). 2 * 3 * 4 stays.', at: null }], createRenderState());
        expect(output).toContain('\x1b[3mIssued today\x1b[0m');
        expect(plain(output)).toBe('\n● Issued today by me, see Wikipedia (https://en.wikipedia.org/wiki/Reuben_sandwich). 2 * 3 * 4 stays.\n');
    });
});
