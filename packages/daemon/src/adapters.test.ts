import { describe, expect, it } from 'vitest';
import type { Pane } from '@voltran/shared';
import { adapterFor, claudeArgsProblem, splitArgs } from './adapters.ts';

describe('splitArgs', () => {
    it('splits on whitespace and honours quotes and backslashes without expanding anything', () => {
        expect(splitArgs('')).toEqual([]);
        expect(splitArgs('  --plugin-dir   ./plugins/x  ')).toEqual(['--plugin-dir', './plugins/x']);
        expect(splitArgs(`--plugin-dir './a b' --name "x \\"y\\"" c\\ d ~/e $HOME ''`)).toEqual(['--plugin-dir', './a b', '--name', 'x "y"', 'c d', '~/e', '$HOME', '']);
        expect(splitArgs(`'a\\b' "c\\d"`)).toEqual(['a\\b', 'c\\d']);
    });

    it('refuses an unterminated quote', () => {
        expect(splitArgs(`--plugin-dir 'a b`)).toBeNull();
        expect(splitArgs('--name "x')).toBeNull();
    });
});

describe('claudeArgsProblem', () => {
    it('accepts ordinary arguments', () => {
        expect(claudeArgsProblem('--plugin-dir ./plugins/x --model opus')).toBeNull();
    });

    it('refuses the flags Voltran sets and arguments it cannot split', () => {
        expect(claudeArgsProblem('--resume abc')).toBe('--resume is set by Voltran');
        expect(claudeArgsProblem('-c')).toBe('-c is set by Voltran');
        expect(claudeArgsProblem('--settings=x.json')).toBe('--settings is set by Voltran');
        expect(claudeArgsProblem('--session-id abc')).toBe('--session-id is set by Voltran');
        expect(claudeArgsProblem(`--plugin-dir 'a`)).toBe('the Claude arguments have an unterminated quote');
    });
});

describe('claude adapter', () => {
    const pane = (overrides: Partial<Pane>): Pane => ({
        id: 'p',
        sessionId: 's',
        adapter: 'claude',
        title: 'Claude Code',
        command: null,
        cwd: '/tmp',
        agentSessionId: 'abc',
        agentResumable: true,
        ended: false,
        createdAt: 0,
        ...overrides,
    });
    const launch = (overrides: Partial<Pane>) => adapterFor('claude').launch({ pane: pane(overrides), shell: '/bin/zsh', claudeSettingsFile: '/s.json', subagentRunning: false });

    it('passes its arguments after the ones Voltran sets, on resume too', () => {
        expect(launch({ command: `--plugin-dir './a b'` }).args).toEqual(['--settings', '/s.json', '--resume', 'abc', '--plugin-dir', './a b']);
        expect(launch({}).args).toEqual(['--settings', '/s.json', '--resume', 'abc']);
    });
});
