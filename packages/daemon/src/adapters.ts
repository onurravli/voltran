import { execFile } from 'node:child_process';
import { accessSync, constants, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterId, AdapterInfo, Pane, PaneKind, StatusSource } from '@voltran/shared';

export interface LaunchSpec {
    file: string;
    args: string[];
}

export interface LaunchContext {
    pane: Pane;
    shell: string;
    claudeSettingsFile: string;
    subagentRunning: boolean;
}

const SUBAGENT_VIEWER = fileURLToPath(new URL('./subagent-view.ts', import.meta.url));

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
            return { file: 'claude', args };
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
        id: 'gemini',
        label: 'Gemini CLI',
        kind: 'agent',
        statusSource: 'heuristic',
        resumable: false,
        binary: 'gemini',
        launch: () => ({ file: 'gemini', args: [] }),
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
