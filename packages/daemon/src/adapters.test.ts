import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pane } from '@voltran/shared';
import {
    adapterFor,
    childEnv,
    claudeArgsProblem,
    claudeHookSettings,
    CODEX_HOOK_EVENTS,
    codexHookArgs,
    NOTES_HOOK,
    OPENCODE_PLUGIN,
    opencodeArgsProblem,
    opencodeConfigContent,
    splitArgs,
    STATUS_LINE,
    voltranSessionId,
} from './adapters.ts';

describe('splitArgs', () => {
    it('splits on whitespace and honours quotes and backslashes without expanding anything', () => {
        expect(splitArgs('')).toEqual([]);
        expect(splitArgs('  --plugin-dir   ./plugins/x  ')).toEqual(['--plugin-dir', './plugins/x']);
        expect(splitArgs(`--plugin-dir './a b' --name "x \\"y\\"" c\\ d ~/e $HOME ''`)).toEqual([
            '--plugin-dir',
            './a b',
            '--name',
            'x "y"',
            'c d',
            '~/e',
            '$HOME',
            '',
        ]);
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
        agentSessionId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        agentResumable: true,
        ended: false,
        createdAt: 0,
        ...overrides,
    });
    const launch = (overrides: Partial<Pane>, baseEnv: NodeJS.ProcessEnv = {}) =>
        adapterFor('claude').launch({
            pane: pane(overrides),
            shell: '/bin/zsh',
            subagentRunning: false,
            baseEnv,
            notesFile: null,
            notesGuide: null,
        });
    const settings = expect.stringMatching(/^\{"hooks":/);

    it('passes its arguments after the ones Voltran sets, on resume too', () => {
        expect(launch({ command: `--plugin-dir './a b'` }).args).toEqual([
            '--settings',
            settings,
            '--resume',
            '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
            '--plugin-dir',
            './a b',
        ]);
        expect(launch({}).args).toEqual(['--settings', settings, '--resume', '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b']);
        expect(launch({ agentResumable: false }).args).toEqual([
            '--settings',
            settings,
            '--session-id',
            '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        ]);
    });

    it('never passes a stored session id that is not a Claude session id, so it cannot become a flag', () => {
        expect(launch({ agentSessionId: '--dangerously-skip-permissions' }).args).toEqual(['--settings', settings]);
        expect(launch({ agentSessionId: 'abc', agentResumable: false }).args).toEqual(['--settings', settings]);
    });

    it("hands the status line the user's own command, from their Claude folder", () => {
        const home = mkdtempSync(join(tmpdir(), 'voltran-claude-home-'));
        try {
            const cwd = join(home, 'project');
            mkdirSync(cwd);
            expect(launch({ cwd }, { HOME: home }).env).toBeUndefined();
            mkdirSync(join(home, '.claude'));
            writeFileSync(
                join(home, '.claude', 'settings.json'),
                JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/line.sh' } }),
            );
            expect(launch({ cwd }, { HOME: home }).env).toEqual({ VOLTRAN_STATUSLINE: 'bash ~/.claude/line.sh' });
            expect(launch({ cwd }, { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'elsewhere') }).env).toBeUndefined();
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('codex adapter', () => {
    it('adds the same hook command for every pane, one -c override per event', () => {
        const args = codexHookArgs();
        expect(args).toHaveLength(CODEX_HOOK_EVENTS.length * 2);
        CODEX_HOOK_EVENTS.forEach((event, index) => {
            expect(args[index * 2]).toBe('-c');
            const match = /^hooks\.(\w+)=\[\{hooks=\[\{type="command",command=("(?:[^"\\]|\\.)*")\}\]\}\]$/.exec(args[index * 2 + 1]);
            expect(match?.[1]).toBe(event);
            const command = JSON.parse(match?.[2] ?? '""') as string;
            expect(command).toContain(`"$VOLTRAN_URL/api/hooks/$VOLTRAN_PANE_ID/${event}"`);
            expect(command).toContain('-H @"$VOLTRAN_HOOK_HEADER"');
            expect(command).not.toContain('VOLTRAN_HOOK_SECRET');
            expect(command).not.toMatch(/[\r\n]/);
        });
        expect(codexHookArgs()).toEqual(args);
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
    const launch = (overrides: Partial<Pane>, baseEnv: NodeJS.ProcessEnv = {}, notesFile: string | null = null) =>
        adapterFor('opencode').launch({
            pane: pane(overrides),
            shell: '/bin/zsh',
            subagentRunning: false,
            baseEnv,
            notesFile,
            notesGuide: '/n/GUIDE.md',
        });

    it('runs its own server on the pane session, with the arguments after the ones Voltran sets', () => {
        expect(launch({}).args).toEqual(['--standalone', '--session', 'ses_abc']);
        expect(launch({ command: `--model 'a b'` }).args).toEqual(['--standalone', '--session', 'ses_abc', '--model', 'a b']);
        expect(launch({ command: 'mini --replay' }).args).toEqual(['mini', '--standalone', '--session', 'ses_abc', '--replay']);
    });

    it('adds the Voltran plugin to the configuration it passes', () => {
        expect(JSON.parse(launch({}).env?.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({ plugins: [OPENCODE_PLUGIN] });
    });

    it("gives OpenCode the notes guide and the pane's notes as instructions, after the user's own", () => {
        const config = JSON.parse(
            launch({}, { OPENCODE_CONFIG_CONTENT: '{"instructions":["mine.md"]}' }, '/n/p/notes.md').env?.OPENCODE_CONFIG_CONTENT ?? '',
        );
        expect(config).toEqual({ instructions: ['mine.md', '/n/GUIDE.md', '/n/p/notes.md'], plugins: [OPENCODE_PLUGIN] });
    });
});

describe('claudeHookSettings', () => {
    type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>; permissions?: { allow: string[] } };
    const notesOf = (pane: string) => ({ file: `/home/o'b/.voltran/notes/${pane}/notes.md`, guide: "/home/o'b/.voltran/notes/GUIDE.md" });
    const settings = claudeHookSettings(notesOf('pane-1')) as Settings;

    it('adds the notes hooks after the status reports, quoting their paths', () => {
        const hook = `'${NOTES_HOOK.replace(/'/g, `'\\''`)}'`;
        const guide = `'/home/o'\\''b/.voltran/notes/GUIDE.md'`;
        expect(settings.hooks.SessionStart.map((entry) => entry.hooks[0].command)).toEqual([
            expect.stringContaining('/api/hooks/$VOLTRAN_PANE_ID/SessionStart'),
            `sh ${hook} session-start ${guide}; exit 0`,
        ]);
        expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toBe(`sh ${hook} prompt ${guide}; exit 0`);
        expect(settings.hooks.PreToolUse[1]).toMatchObject({
            matcher: 'Edit|Write',
            hooks: [{ command: `sh ${hook} pre-tool-use ${guide}; exit 0` }],
        });
        expect(settings.hooks.Stop).toHaveLength(1);
    });

    it("runs Voltran's status line script, quoting its path", () => {
        expect((settings as unknown as { statusLine: object }).statusLine).toEqual({
            type: 'command',
            command: `sh '${STATUS_LINE.replace(/'/g, `'\\''`)}'`,
        });
    });

    it("lets Claude read and edit its own pane's notes without asking, and no other pane's", () => {
        expect(settings.permissions?.allow).toEqual([
            "Read(//home/o'b/.voltran/notes/pane-1/**)",
            "Edit(//home/o'b/.voltran/notes/pane-1/**)",
        ]);
        expect((claudeHookSettings(notesOf('pane-2')) as Settings).permissions?.allow).toEqual([
            "Read(//home/o'b/.voltran/notes/pane-2/**)",
            "Edit(//home/o'b/.voltran/notes/pane-2/**)",
        ]);
    });

    it('leaves out the notes hooks and permissions when the pane has no notes', () => {
        const bare = claudeHookSettings(null) as Settings;
        expect(bare.permissions).toBeUndefined();
        expect(bare.hooks.SessionStart).toHaveLength(1);
    });
});

describe('childEnv', () => {
    it('does not pass on the notes of the pane that started the daemon', () => {
        const env = childEnv({ VOLTRAN_NOTES: '/elsewhere/notes.md', VOLTRAN_STATUSLINE: 'x', HOME: '/h' }, '/bin');
        expect(env.VOLTRAN_NOTES).toBeUndefined();
        expect(env.VOLTRAN_STATUSLINE).toBeUndefined();
        expect(env.HOME).toBe('/h');
    });
});

describe('opencodeConfigContent', () => {
    it('keeps the configuration the user passed and their plugins', () => {
        expect(JSON.parse(opencodeConfigContent('{"model":"a/b","plugins":["x"]}'))).toEqual({
            model: 'a/b',
            plugins: ['x', OPENCODE_PLUGIN],
        });
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
