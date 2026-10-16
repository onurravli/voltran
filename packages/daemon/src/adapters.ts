import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterId, AdapterInfo, Pane, PaneKind, StatusSource } from '@voltran/shared';

export interface LaunchSpec {
    file: string;
    args: string[];
    env?: Record<string, string>;
}

export interface LaunchContext {
    pane: Pane;
    shell: string;
    claudeSettingsFile: string;
    subagentRunning: boolean;
    baseEnv: NodeJS.ProcessEnv;
}

const SUBAGENT_VIEWER = fileURLToPath(new URL('./subagent-view.ts', import.meta.url));
export const OPENCODE_PLUGIN = fileURLToPath(new URL('./opencode-plugin', import.meta.url));

interface AdapterDefinition {
    id: AdapterId;
    label: string;
    kind: PaneKind;
    statusSource: StatusSource;
    resumable: boolean;
    binary: string | null;
    launch(ctx: LaunchContext): LaunchSpec;
}

const DEFINITIONS: AdapterDefinition[] = [
    {
        id: 'claude',
        label: 'Claude Code',
        kind: 'agent',
        statusSource: 'hooks',
        resumable: true,
        binary: 'claude',
        launch: ({ pane, claudeSettingsFile }) => {
            const args = ['--settings', claudeSettingsFile];
            if (pane.agentSessionId && pane.agentResumable) {
                args.push('--resume', pane.agentSessionId);
            } else if (pane.agentSessionId) {
                args.push('--session-id', pane.agentSessionId);
            }
            args.push(...(splitArgs(pane.command ?? '') ?? []));
            return { file: 'claude', args };
        },
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        kind: 'agent',
        statusSource: 'hooks',
        resumable: true,
        binary: 'opencode',
        launch: ({ pane, baseEnv }) => {
            const args = splitArgs(pane.command ?? '') ?? [];
            const subcommand = args[0] === 'mini' ? args.splice(0, 1) : [];
            const session = pane.agentSessionId ? ['--session', pane.agentSessionId] : [];
            return {
                file: 'opencode',
                args: [...subcommand, '--standalone', ...session, ...args],
                env: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent(baseEnv.OPENCODE_CONFIG_CONTENT) },
            };
        },
    },
    {
        id: 'codex',
        label: 'Codex',
        kind: 'agent',
        statusSource: 'heuristic',
        resumable: false,
        binary: 'codex',
        launch: () => ({ file: 'codex', args: [] }),
    },
    {
        id: 'antigravity',
        label: 'Antigravity',
        kind: 'agent',
        statusSource: 'heuristic',
        resumable: false,
        binary: 'agy',
        launch: () => ({ file: 'agy', args: [] }),
    },
    {
        id: 'shell',
        label: 'Shell',
        kind: 'shell',
        statusSource: 'process',
        resumable: false,
        binary: null,
        launch: ({ shell }) => ({ file: shell, args: ['-l'] }),
    },
    {
        id: 'command',
        label: 'Command',
        kind: 'process',
        statusSource: 'process',
        resumable: false,
        binary: null,
        launch: ({ pane, shell }) => ({ file: shell, args: ['-l', '-c', pane.command ?? ''] }),
    },
    {
        id: 'subagent',
        label: 'Subagent',
        kind: 'process',
        statusSource: 'process',
        resumable: false,
        binary: null,
        launch: ({ pane, subagentRunning }) => ({
            file: process.execPath,
            args: [SUBAGENT_VIEWER, pane.command ?? '', subagentRunning ? '--follow' : '--once'],
        }),
    },
];

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

export function adapterFor(id: AdapterId): AdapterDefinition {
    const definition = BY_ID.get(id);
    if (!definition) {
        throw new Error(`Unknown adapter "${id}"`);
    }
    return definition;
}

export function isAdapterId(value: unknown): value is AdapterId {
    return typeof value === 'string' && BY_ID.has(value as AdapterId);
}

const CLAUDE_OWNED_FLAGS = ['--settings', '--session-id', '--resume', '-r', '--continue', '-c'];

export function splitArgs(text: string): string[] | null {
    const args: string[] = [];
    let word = '';
    let inWord = false;
    let quote: string | null = null;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quote === "'") {
            if (char === quote) {
                quote = null;
            } else {
                word += char;
            }
        } else if (quote === '"') {
            if (char === quote) {
                quote = null;
            } else if (char === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) {
                word += text[++index];
            } else {
                word += char;
            }
        } else if (char === "'" || char === '"') {
            quote = char;
            inWord = true;
        } else if (char === '\\' && index + 1 < text.length) {
            word += text[++index];
            inWord = true;
        } else if (/\s/.test(char)) {
            if (inWord) {
                args.push(word);
                word = '';
                inWord = false;
            }
        } else {
            word += char;
            inWord = true;
        }
    }
    if (quote) {
        return null;
    }
    if (inWord) {
        args.push(word);
    }
    return args;
}

export function claudeArgsProblem(text: string): string | null {
    const args = splitArgs(text);
    if (!args) {
        return 'the Claude arguments have an unterminated quote';
    }
    return ownedFlagProblem(args, CLAUDE_OWNED_FLAGS);
}

const OPENCODE_OWNED_FLAGS = ['--standalone', '--server', '--session', '-s', '--continue', '-c', '--fork'];

export function opencodeArgsProblem(text: string): string | null {
    const args = splitArgs(text);
    if (!args) {
        return 'the OpenCode arguments have an unterminated quote';
    }
    const first = args[0];
    if (first !== undefined && first !== 'mini' && !first.startsWith('-')) {
        return /^[.~/]|\//.test(first)
            ? `OpenCode starts in the session's folder; leave out ${first}`
            : `opencode ${first} does not open OpenCode's interface; run it as a command instead`;
    }
    return ownedFlagProblem(args, OPENCODE_OWNED_FLAGS);
}

function ownedFlagProblem(args: string[], flags: string[]): string | null {
    const owned = args.find((arg) => flags.some((flag) => arg === flag || (flag.startsWith('--') && arg.startsWith(`${flag}=`))));
    return owned ? `${owned.split('=')[0]} is set by Voltran` : null;
}

// OPENCODE_CONFIG_CONTENT adds to the user's own configuration files rather than replacing them, so
// the plugin reaches only the panes Voltran starts. A value the user already set is kept.
export function opencodeConfigContent(existing: string | undefined): string {
    let config: Record<string, unknown> = {};
    if (existing) {
        try {
            const parsed: unknown = JSON.parse(existing);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                config = parsed as Record<string, unknown>;
            }
        } catch {
            // not JSON: OpenCode would refuse it too
        }
    }
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    return JSON.stringify({ ...config, plugins: [...plugins, OPENCODE_PLUGIN] });
}

export function voltranSessionId(adapter: AdapterId): string | null {
    if (adapter === 'claude') {
        return randomUUID();
    }
    if (adapter === 'opencode') {
        return `ses_voltran${randomBytes(12).toString('hex')}`;
    }
    return null;
}

function findOnPath(binary: string, path: string): string | null {
    for (const dir of path.split(delimiter)) {
        if (!dir) {
            continue;
        }
        const candidate = join(dir, binary);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            continue;
        }
    }
    return null;
}

export function describeAdapters(path: string): AdapterInfo[] {
    return DEFINITIONS.map((definition) => ({
        id: definition.id,
        label: definition.label,
        kind: definition.kind,
        statusSource: definition.statusSource,
        resumable: definition.resumable,
        available: definition.binary === null || findOnPath(definition.binary, path) !== null,
    }));
}

export function resolveBinary(file: string, path: string): string {
    if (file.includes('/')) {
        return file;
    }
    return findOnPath(file, path) ?? file;
}

const START = '__VOLTRAN_PATH_START__';
const END = '__VOLTRAN_PATH_END__';

// A daemon started from launchd or a GUI gets a minimal PATH; agents installed through nvm,
// pyenv or ~/.local/bin are only on the PATH the user's interactive login shell builds.
export function resolveShellPath(shell: string, fallback: string, timeoutMs = 5000): Promise<string> {
    return new Promise((resolvePath) => {
        execFile(shell, ['-ilc', `printf '%s%s%s' '${START}' "$PATH" '${END}'`], { timeout: timeoutMs }, (error, stdout) => {
            if (error) {
                resolvePath(fallback);
                return;
            }
            const match = stdout.match(new RegExp(`${START}(.*)${END}`, 's'));
            resolvePath(match && match[1] ? match[1] : fallback);
        });
    });
}

const SESSION_SCOPED_ENV = [
    'CLAUDECODE',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_ENV_FILE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'OPENCODE',
    'OPENCODE_SESSION_ID',
    'OPENCODE_TERMINAL',
    'AGENT',
    'TERM_SESSION_ID',
    'TERM_PROGRAM_VERSION',
    'TERM_FEATURES',
    'LC_TERMINAL',
    'LC_TERMINAL_VERSION',
    'ITERM_SESSION_ID',
    'ITERM_PROFILE',
    'INIT_CWD',
    'VOLTRAN_PANE_ID',
    'VOLTRAN_HOOK_SECRET',
    'VOLTRAN_URL',
];

export function childEnv(base: NodeJS.ProcessEnv, path: string, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value === undefined || key.startsWith('npm_') || SESSION_SCOPED_ENV.includes(key)) {
            continue;
        }
        env[key] = value;
    }
    return {
        ...env,
        PATH: path,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Voltran',
        LANG: env.LANG || 'en_US.UTF-8',
        ...extra,
    };
}

export const CLAUDE_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'SessionEnd',
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

export function isClaudeHookEvent(value: string): value is ClaudeHookEvent {
    return (CLAUDE_HOOK_EVENTS as readonly string[]).includes(value);
}

// Sent by opencode-plugin/index.ts.
export const OPENCODE_EVENTS = [
    'Ready',
    'SessionCreated',
    'PromptSubmit',
    'TurnStart',
    'ToolStart',
    'ToolEnd',
    'Permission',
    'PermissionReplied',
    'Question',
    'QuestionAnswered',
    'TurnEnd',
] as const;

export type OpencodeEvent = (typeof OPENCODE_EVENTS)[number];

export function isOpencodeEvent(value: string): value is OpencodeEvent {
    return (OPENCODE_EVENTS as readonly string[]).includes(value);
}

// Hooks must never slow down or block the agent: short curl timeout, no output, always exit 0.
// The per-pane secret only authorizes status reports for that one pane.
export function claudeHookSettings(): object {
    const hooks: Record<string, unknown[]> = {};
    for (const event of CLAUDE_HOOK_EVENTS) {
        const command = `[ -n "$VOLTRAN_PANE_ID" ] && curl -s -m 2 -o /dev/null -X POST `
            + `-H "Authorization: Bearer $VOLTRAN_HOOK_SECRET" -H 'Content-Type: application/json' `
            + `--data-binary @- "$VOLTRAN_URL/api/hooks/$VOLTRAN_PANE_ID/${event}"; exit 0`;
        hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 5 }] }];
    }
    return { hooks };
}

export function writeClaudeSettings(file: string): void {
    writeFileSync(file, `${JSON.stringify(claudeHookSettings(), null, 2)}\n`, { mode: 0o600 });
}
