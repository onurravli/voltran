import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { SlashCommand } from '@voltran/shared';

const HEAD_BYTES = 64 * 1024;
const MAX_FILES = 1000;
const MAX_DESCRIPTION = 200;

// Claude Code has no way to list its commands for another program, so this is the menu it showed
// (v2.1.310) less what comes from files. `t` marks a command that answers in a picker or panel.
const BUILTIN: [name: string, description: string, terminal?: 't'][] = [
    ['add-dir', 'Add a new working directory'],
    ['advisor', 'Let Claude consult a stronger model at key moments', 't'],
    ['artifacts', 'Browse your published and shared artifacts', 't'],
    ['auto-mode-setup', 'Teach auto mode about your environment, plus optional rule tweaks'],
    ['autocompact', 'Set how full the context gets before auto-summarizing', 't'],
    ['autofix-pr', 'Monitor and autofix any issues with the current PR'],
    ['background', 'Send this session to the background and free the terminal', 't'],
    ['branch', 'Create a branch of the current conversation at this point'],
    ['btw', 'Ask a quick side question without interrupting the main conversation', 't'],
    ['bug', 'Report a bug or share your conversation', 't'],
    ['cd', 'Move this session to a new working directory'],
    ['chrome', 'Open Claude in Chrome settings', 't'],
    ['clear', 'Start a new session with empty context'],
    ['color', 'Set the prompt bar color for this session', 't'],
    ['compact', 'Free up context by summarizing the conversation so far'],
    ['config', 'Open settings', 't'],
    ['context', 'Visualize current context usage as a colored grid', 't'],
    ['copy', "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)", 't'],
    ['desktop', 'Continue the current session in Claude Desktop', 't'],
    ['diff', 'Toggle the diff panel showing uncommitted changes', 't'],
    ['effort', 'Set effort level for model usage', 't'],
    ['exit', 'Exit the CLI'],
    ['export', 'Export the current conversation to a file or clipboard', 't'],
    ['fast', 'Toggle fast mode'],
    ['feedback', 'Send feedback to Anthropic or report a bug', 't'],
    ['focus', 'Toggle focus view: just your prompt, summary, and response', 't'],
    ['fork', 'Copy this conversation into a new background session and keep working here'],
    ['goal', 'Set a goal Claude checks before stopping'],
    ['help', 'Show help and available commands', 't'],
    ['hooks', 'View hook configurations for tool events', 't'],
    ['ide', 'Manage IDE integrations and show status', 't'],
    ['import', 'Import config from another AI coding agent', 't'],
    ['install-github-app', 'Set up Claude GitHub Actions for a repository', 't'],
    ['install-slack-app', 'Install the Claude Slack app', 't'],
    ['keybindings', 'Open your keyboard shortcuts file', 't'],
    ['list-agents', 'List subagents, teammates, and other Claude sessions you can message', 't'],
    ['login', 'Sign in with your Anthropic account', 't'],
    ['logout', 'Sign out from your Anthropic account', 't'],
    ['mcp', 'Manage MCP servers', 't'],
    ['memory', 'Edit CLAUDE.md files and memory settings', 't'],
    ['mobile', 'Show QR code to download the Claude mobile app', 't'],
    ['model', 'Set the AI model for Claude Code', 't'],
    ['output-style', 'List output styles or switch to one', 't'],
    ['passes', 'Share a free week of Claude Code with friends and earn usage credits', 't'],
    ['permissions', 'Manage allow and deny tool permission rules', 't'],
    ['plan', 'Enable plan mode or view the current session plan'],
    ['plugin', 'Manage Claude Code plugins', 't'],
    ['powerup', 'Discover Claude Code features through quick interactive lessons', 't'],
    ['privacy-settings', 'View and update your privacy settings', 't'],
    ['radio', 'Listen to Claude FM lo-fi radio', 't'],
    ['rate-limit-options', 'Manage usage limits and upgrade options', 't'],
    ['recap', 'Generate a one-line session recap now'],
    ['release-notes', 'View release notes', 't'],
    ['reload-plugins', 'Activate pending plugin changes in the current session'],
    ['reload-skills', 'Pick up skills added or changed on disk during this session'],
    ['remote-control', 'Control this session from your phone or claude.ai/code', 't'],
    ['remote-env', 'Choose the default environment for cloud agents', 't'],
    ['rename', 'Rename the current conversation'],
    ['resume', 'Resume a previous conversation', 't'],
    ['rewind', 'Restore the code and/or conversation to a previous point', 't'],
    ['sandbox', 'Configure the sandbox', 't'],
    ['scroll-speed', 'Adjust mouse wheel scroll speed', 't'],
    ['skill-doctor', 'Show which loaded skills are unused and costing context', 't'],
    ['skills', 'List available skills', 't'],
    ['status', 'Show Claude Code status including version, model, account, API connectivity, and tool statuses', 't'],
    ['stickers', 'Order Claude Code stickers', 't'],
    ['subtask', 'Send a subagent off with your full context; its result comes back here'],
    ['tasks', 'View and manage everything running in the background', 't'],
    ['teleport', 'Send this session to the cloud, or resume one from claude.ai', 't'],
    ['terminal-setup', 'Install Shift+Enter key binding for newlines', 't'],
    ['theme', 'Change the theme', 't'],
    ['tui', 'Set the terminal UI renderer (default | fullscreen)', 't'],
    ['ultrareview', 'Start a cloud agent that finds and verifies bugs in your branch', 't'],
    ['upgrade', 'Upgrade to Max for higher rate limits and more Opus', 't'],
    ['usage', 'Show session cost, plan usage, and activity stats', 't'],
    ['usage-credits', 'Configure usage credits or request them from your admin when you hit a limit', 't'],
    ['voice', 'Toggle voice mode', 't'],
    ['web-setup', 'Set up cloud sessions with your GitHub account', 't'],
    ['workflows', 'Browse running and completed workflows', 't'],
    ['artifact-capabilities', 'Runtime capabilities for published Artifacts'],
    ['artifact-diagramming', 'Diagramming guidance for Artifacts'],
    ['batch', 'Plan a large change; background agents each open a PR'],
    ['claude-api', 'Build and debug apps that use the Claude API'],
    ['claude-in-chrome', 'Let Claude browse and interact with pages in your Chrome'],
    ['code-review', 'Review the current diff or a PR for bugs and cleanups'],
    ['dataviz', 'Chart and dashboard design guidance'],
    ['debug', 'Turn on debug logging and investigate problems'],
    ['deep-research', 'Deep research harness: web searches, verified claims, a cited report'],
    ['design', 'Make a new Design artifact from a brief'],
    ['design-login', 'Authorize design-system access for /design-sync with your claude.ai account', 't'],
    ['design-sync', 'Push your design system components to claude.ai/design'],
    ['doctor', 'Health-check your setup and fix issues'],
    ['fewer-permission-prompts', 'Pre-approve safe read-only commands based on your usage'],
    ['init', 'Initialize a new CLAUDE.md file with codebase documentation'],
    ['insights', 'Generate a report analyzing your Claude Code sessions'],
    ['loop', 'Repeat a prompt or command on an interval (e.g. /loop 5m /foo)'],
    ['plugin-authoring', 'Write a mod: a live pane, view or behaviour change in Claude Code'],
    ['run', 'Launch this project’s app to see your change working'],
    ['run-skill-generator', 'Create a skill that knows how to run this project’s app'],
    ['schedule', 'Create and manage routines: cloud agents on a schedule'],
    ['security-review', 'Complete a security review of the pending changes on the current branch'],
    ['simplify', 'Clean up the changed code without changing behavior'],
    ['slides', 'Make a new Slides deck artifact from a brief'],
    ['statusline', "Set up Claude Code's status line UI"],
    ['team-onboarding', 'Help teammates ramp on Claude Code with a guide from your usage'],
    ['update-config', 'Change settings: hooks, permissions, environment variables'],
    ['verify', 'Verify that a code change actually does what it is supposed to, end to end'],
    ['workflow-authoring', 'Load the reference for writing Workflow tool scripts'],
];

// A synced skill that has a built-in command's name keeps it under this namespace, as in Claude's menu.
const BUILTIN_NAMES = new Set(BUILTIN.map(([name]) => name));

function readHead(path: string): string {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch {
        return '';
    }
    try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString('utf8');
    } catch {
        return '';
    } finally {
        closeSync(fd);
    }
}

function unquote(value: string): string {
    const trimmed = value.trim();
    return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

// Only the two keys the menu shows, from the YAML frontmatter Claude Code reads; a command without a
// description shows its first line of text instead.
export function frontmatter(text: string): { name: string | null; description: string } {
    const match = /^---\r?\n([\s\S]*?)(?:\r?\n---|$)/.exec(text);
    const fields = new Map<string, string>();
    if (match) {
        const lines = match[1].split(/\r?\n/);
        lines.forEach((line, index) => {
            const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
            if (!field) {
                return;
            }
            let value = field[2];
            if (/^[|>][-+]?$/.test(value.trim())) {
                const block: string[] = [];
                for (const next of lines.slice(index + 1)) {
                    if (!/^\s+\S/.test(next)) {
                        break;
                    }
                    block.push(next.trim());
                }
                value = block.join(' ');
            }
            fields.set(field[1], unquote(value));
        });
    }
    const body = match ? text.slice(match[0].length) : text;
    const firstLine =
        body
            .split(/\r?\n/)
            .map((line) => line.replace(/^#+\s*/, '').trim())
            .find(Boolean) ?? '';
    const description = (fields.get('description') || firstLine).replace(/\s+/g, ' ').trim();
    return {
        name: fields.get('name') || null,
        description:
            description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    };
}

function statKind(path: string): 'file' | 'directory' | null {
    try {
        const stat = statSync(path);
        return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
    } catch {
        return null;
    }
}

function isDirectory(path: string): boolean {
    return statKind(path) === 'directory';
}

function walk(dir: string, depth: number, visit: (path: string) => void, budget: { files: number }): void {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names.sort()) {
        if (budget.files <= 0 || name.startsWith('.')) {
            continue;
        }
        const path = join(dir, name);
        if (isDirectory(path)) {
            if (depth > 0) {
                walk(path, depth - 1, visit, budget);
            }
        } else {
            budget.files -= 1;
            visit(path);
        }
    }
}

// commands/a/b.md is /a:b; a skill is the folder that holds SKILL.md, named by its frontmatter.
function commandsIn(
    root: string,
    source: SlashCommand['source'],
    prefix: string,
    budget: { files: number },
): SlashCommand[] {
    const found: SlashCommand[] = [];
    walk(
        join(root, 'commands'),
        3,
        (path) => {
            if (!path.endsWith('.md') || basename(path).startsWith('_')) {
                return;
            }
            const name = relative(join(root, 'commands'), path).slice(0, -3).split(sep).join(':');
            found.push({
                name: `${prefix}${name}`,
                description: frontmatter(readHead(path)).description,
                source,
                terminal: false,
            });
        },
        budget,
    );
    for (const path of skillFiles(join(root, 'skills'), budget)) {
        const head = frontmatter(readHead(path));
        const name = head.name ?? basename(dirname(path));
        const synced = path.startsWith(join(root, 'skills', 'synced') + sep);
        const namespace = synced && BUILTIN_NAMES.has(name) ? 'anthropic-skills:' : prefix;
        found.push({ name: `${namespace}${name}`, description: head.description, source, terminal: false });
    }
    return found;
}

// Claude reads skills/<name>/SKILL.md, and the skills claude.ai syncs under skills/synced/<id>/<name>.
function skillFiles(dir: string, budget: { files: number }): string[] {
    const children = (folder: string): string[] => {
        try {
            return readdirSync(folder)
                .filter((name) => !name.startsWith('.'))
                .sort()
                .map((name) => join(folder, name))
                .filter(isDirectory);
        } catch {
            return [];
        }
    };
    const folders = [...children(dir), ...children(join(dir, 'synced')).flatMap(children)];
    const files: string[] = [];
    for (const folder of folders) {
        const path = join(folder, 'SKILL.md');
        if (budget.files > 0 && statKind(path) === 'file') {
            budget.files -= 1;
            files.push(path);
        }
    }
    return files;
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function enabledPlugins(files: string[]): Set<string> {
    const enabled = new Set<string>();
    for (const file of files) {
        const plugins = (readJson(file) as { enabledPlugins?: unknown } | null)?.enabledPlugins;
        if (plugins && typeof plugins === 'object') {
            for (const [id, on] of Object.entries(plugins)) {
                if (on === true) {
                    enabled.add(id);
                } else {
                    enabled.delete(id);
                }
            }
        }
    }
    return enabled;
}

function pluginRoots(configDir: string, folders: string[]): { name: string; root: string }[] {
    const settings = [
        join(configDir, 'settings.json'),
        ...folders
            .flatMap((folder) => [
                join(folder, '.claude', 'settings.json'),
                join(folder, '.claude', 'settings.local.json'),
            ])
            .reverse(),
    ];
    const enabled = enabledPlugins(settings);
    const installed =
        (readJson(join(configDir, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, unknown> } | null)
            ?.plugins ?? {};
    const roots: { name: string; root: string }[] = [];
    for (const [id, installs] of Object.entries(installed)) {
        if (!enabled.has(id) || !Array.isArray(installs)) {
            continue;
        }
        const install = installs.find((entry: { scope?: unknown; projectPath?: unknown }) =>
            entry?.scope !== 'project' && entry?.scope !== 'local' ? true : folders.includes(String(entry.projectPath)),
        ) as { installPath?: unknown } | undefined;
        if (typeof install?.installPath === 'string') {
            roots.push({ name: id.split('@')[0], root: install.installPath });
        }
    }
    return roots;
}

// The folders from where Claude starts up to the home folder, nearest first, whose .claude folders
// add project commands.
function projectFolders(cwd: string, home: string | undefined): string[] {
    const folders: string[] = [];
    for (let current = cwd; ; current = dirname(current)) {
        if (current === home) {
            break;
        }
        folders.push(current);
        if (dirname(current) === current) {
            break;
        }
    }
    return folders;
}

// A project's command wins over a user's of the same name and a user's over a built-in, and the menu
// lists the built-ins first.
export function claudeCommands(cwd: string, configDir: string | null, home = process.env.HOME): SlashCommand[] {
    const budget = { files: MAX_FILES };
    const folders = projectFolders(cwd, home);
    const listed = [
        ...folders.flatMap((folder) => commandsIn(join(folder, '.claude'), 'project', '', budget)),
        ...(configDir ? commandsIn(configDir, 'user', '', budget) : []),
        ...(configDir
            ? pluginRoots(configDir, folders).flatMap(({ name, root }) =>
                  commandsIn(root, 'plugin', `${name}:`, budget),
              )
            : []),
        ...BUILTIN.map(
            ([name, description, terminal]): SlashCommand => ({
                name,
                description,
                source: 'builtin',
                terminal: terminal === 't',
            }),
        ),
    ];
    const seen = new Set<string>();
    const unique = listed.filter(
        (command) => /^[\w:.-]+$/.test(command.name) && !seen.has(command.name) && seen.add(command.name),
    );
    return [
        ...unique.filter((command) => command.source === 'builtin'),
        ...unique.filter((command) => command.source !== 'builtin'),
    ];
}
