import { describe, expect, it } from 'vitest';
import type { Pane } from '@voltran/shared';
import { adapterFor, claudeArgsProblem, OPENCODE_PLUGIN, opencodeArgsProblem, opencodeConfigContent, splitArgs, voltranSessionId } from './adapters.ts';

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
    const launch = (overrides: Partial<Pane>) => adapterFor('claude').launch({ pane: pane(overrides), shell: '/bin/zsh', claudeSettingsFile: '/s.json', subagentRunning: false, baseEnv: {} });

    it('passes its arguments after the ones Voltran sets, on resume too', () => {
        expect(launch({ command: `--plugin-dir './a b'` }).args).toEqual(['--settings', '/s.json', '--resume', 'abc', '--plugin-dir', './a b']);
        expect(launch({}).args).toEqual(['--settings', '/s.json', '--resume', 'abc']);
    });
});

describe('opencodeArgsProblem', () => {
    it('accepts ordinary arguments and the mini interface', () => {
        expect(opencodeArgsProblem('--model anthropic/claude-sonnet-4-5 --agent plan')).toBeNull();
        expect(opencodeArgsProblem('mini --model x')).toBeNull();
    });

    it('refuses the flags Voltran sets and subcommands without an interface', () => {
        expect(opencodeArgsProblem('--session ses_1')).toBe('--session is set by Voltran');
        expect(opencodeArgsProblem('-s ses_1')).toBe('-s is set by Voltran');
        expect(opencodeArgsProblem('--server=http://x')).toBe('--server is set by Voltran');
        expect(opencodeArgsProblem('mini --standalone')).toBe('--standalone is set by Voltran');
        expect(opencodeArgsProblem('run hello')).toBe("opencode run does not open OpenCode's interface; run it as a command instead");
        expect(opencodeArgsProblem('.')).toBe("OpenCode starts in the session's folder; leave out .");
        expect(opencodeArgsProblem('../other --model x')).toBe("OpenCode starts in the session's folder; leave out ../other");
        expect(opencodeArgsProblem(`--model 'a`)).toBe('the OpenCode arguments have an unterminated quote');
    });
});

describe('opencode adapter', () => {
    const pane = (overrides: Partial<Pane>): Pane => ({
        id: 'p',
        sessionId: 's',
        adapter: 'opencode',
        title: 'OpenCode',
        command: null,
        cwd: '/tmp',
        agentSessionId: 'ses_abc',
        agentResumable: false,
        ended: false,
        createdAt: 0,
        ...overrides,
    });
    const launch = (overrides: Partial<Pane>, baseEnv: NodeJS.ProcessEnv = {}) =>
        adapterFor('opencode').launch({ pane: pane(overrides), shell: '/bin/zsh', claudeSettingsFile: '/s.json', subagentRunning: false, baseEnv });

    it('runs its own server on the pane session, with the arguments after the ones Voltran sets', () => {
        expect(launch({}).args).toEqual(['--standalone', '--session', 'ses_abc']);
        expect(launch({ command: `--model 'a b'` }).args).toEqual(['--standalone', '--session', 'ses_abc', '--model', 'a b']);
        expect(launch({ command: 'mini --replay' }).args).toEqual(['mini', '--standalone', '--session', 'ses_abc', '--replay']);
    });

    it('adds the Voltran plugin to the configuration it passes', () => {
        expect(JSON.parse(launch({}).env?.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({ plugins: [OPENCODE_PLUGIN] });
    });
});

describe('opencodeConfigContent', () => {
    it('keeps the configuration the user passed and their plugins', () => {
        expect(JSON.parse(opencodeConfigContent('{"model":"a/b","plugins":["x"]}'))).toEqual({ model: 'a/b', plugins: ['x', OPENCODE_PLUGIN] });
    });

    it('ignores a value that is not a JSON object', () => {
        expect(JSON.parse(opencodeConfigContent('nope'))).toEqual({ plugins: [OPENCODE_PLUGIN] });
        expect(JSON.parse(opencodeConfigContent('[1]'))).toEqual({ plugins: [OPENCODE_PLUGIN] });
    });
});

describe('voltranSessionId', () => {
    it('gives each agent a session id in the form it accepts', () => {
        expect(voltranSessionId('claude')).toMatch(/^[0-9a-f-]{36}$/);
        expect(voltranSessionId('opencode')).toMatch(/^ses_voltran[0-9a-f]{24}$/);
        expect(voltranSessionId('shell')).toBeNull();
    });
});
