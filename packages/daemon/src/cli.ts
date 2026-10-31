import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    bugReportUrl,
    formatDiagnostics,
    type AppState,
    type CreateSessionBody,
    type PaneSpec,
    type Project,
} from '@voltran/shared';
import { resolveShellPath } from './adapters.ts';
import {
    DEV_WEB_PORT,
    REPO_ROOT,
    ensureHome,
    loadConfig,
    privateFile,
    readOrCreateToken,
    voltranVersion,
    writeNewToken,
    type Config,
} from './config.ts';
import { diagnose, type DaemonInfo } from './doctor.ts';
import { SYSTEMD_UNIT_FILE, SYSTEMD_UNIT_NAME, findChrome, systemdUnit } from './linux.ts';
import { CHROME, LAUNCH_AGENT_FILE, LAUNCH_AGENT_LABEL, installedChromeApp, launchAgentPlist } from './macos.ts';
import { withoutControls } from './status.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = join(HERE, `main${extname(import.meta.url)}`);
const CLI_ENTRY = join(REPO_ROOT, 'bin', 'voltran.mjs');

const LOGO = String.raw`__     __    _ _
\ \   / /__ | | |_ _ __ __ _ _ __
 \ \ / / _ \| | __| '__/ _${'`'} | '_ \
  \ V / (_) | | |_| | | (_| | | | |
   \_/ \___/|_|\__|_|  \__,_|_| |_|`;

const HELP = `${LOGO}

Local multi-agent session and terminal orchestrator

Usage:
  voltran up [--browser] [--no-open] [--new]   start the daemon if needed and open the UI
  voltran add [path] [--name <name>]   register a folder as a project (default: current dir)
  voltran new [path] [--pane <agent> [args]]… [--title <title>] [--worktree <branch>[:<base>]]
                                       open a session in a folder, registering it as a project if needed
  voltran status                       show daemon and attention summary
  voltran down                         stop the daemon (agents resume on next open)
  voltran restart                      restart the daemon to load new code; takes up's options
  voltran autostart [on|off]           start the daemon when you log in
  voltran signout                      sign out every window and replace the token
  voltran doctor [--report]            check the installation; --report opens a bug report with the result
  voltran version                      print the installed version

On macOS, once Voltran is installed as an app (⌘K → Install Voltran as an app), up opens that app.

Options:
  --browser   open in the default browser instead of a Chrome app window
  --no-open   do not open any window
  --new       open a window even if Voltran is already open in one

new:
  --pane      a pane, in order: claude, codex, opencode, antigravity or shell, followed by
              arguments for it, command and a command to run, preview and a local page
              (localhost:5173), changes for the git changes of the folder, or editor for
              its files. Repeat it for more panes; without it the session starts with one
              Claude Code pane.
              voltran new . --pane "claude --model opus" --pane "command npm run dev"
  --title     the session's title; agents name an untitled session from its first prompt
  --worktree  work in a new git worktree on this branch, from <base> or the current HEAD

Environment:
  VOLTRAN_PORT  (default 4747)   VOLTRAN_HOME  (default ~/.voltran)`;

interface Client {
    config: Config;
    request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

function client(): Client {
    const config = loadConfig();
    ensureHome(config);
    const token = readOrCreateToken(config);
    return {
        config,
        async request<T>(method: string, path: string, body?: unknown): Promise<T> {
            const response = await fetch(`${config.url}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await response.text();
            const parsed = text ? JSON.parse(text) : {};
            if (!response.ok) {
                throw new Error(parsed.error ?? `HTTP ${response.status}`);
            }
            return parsed as T;
        },
    };
}

async function runningPid(api: Client): Promise<number | null> {
    try {
        return (await api.request<{ pid: number }>('GET', '/api/health')).pid;
    } catch {
        return null;
    }
}

async function isRunning(api: Client): Promise<boolean> {
    return (await runningPid(api)) !== null;
}

async function waitUntilRunning(api: Client, timeoutMs: number, previousPid: number | null = null): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pid = await runningPid(api);
        if (pid !== null && pid !== previousPid) {
            return true;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    return false;
}

function ensureUiBuilt(config: Config): void {
    if (config.dev || existsSync(join(config.webDist, 'index.html'))) {
        return;
    }
    console.log('Building the Voltran UI (first run)…');
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

export function startDaemonProcess(config: Config): void {
    const log = openSync(privateFile(config.logFile), 'a');
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
        cwd: config.home,
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
    });
    child.unref();
}

function openWindow(base: string, path: string, preferBrowser: boolean): void {
    const url = `${base}${path}`;
    if (process.platform === 'linux') {
        openLinuxWindow(url, preferBrowser);
        return;
    }
    if (process.platform !== 'darwin') {
        console.log(`Open ${url}`);
        return;
    }
    const app = preferBrowser ? null : installedChromeApp(base);
    if (app) {
        const launch = [
            `--profile-directory=${app.profileDirectory}`,
            `--app-id=${app.id}`,
            `--app-launch-url-for-shortcuts-menu-item=${url}`,
        ];
        spawn('open', ['-na', CHROME, '--args', ...launch], { stdio: 'ignore', detached: true }).unref();
        return;
    }
    if (!preferBrowser && existsSync(CHROME)) {
        spawn('open', ['-na', CHROME, '--args', `--app=${url}`], { stdio: 'ignore', detached: true }).unref();
        return;
    }
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

function openLinuxWindow(url: string, preferBrowser: boolean): void {
    const chrome = preferBrowser ? null : findChrome();
    const [file, args] = chrome ? [chrome, [`--app=${url}`]] : ['xdg-open', [url]];
    const child = spawn(file, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open ${url}`));
    child.unref();
}

async function openWindows(api: Client): Promise<{ open: number; previous: number }> {
    try {
        return await api.request<{ open: number; previous: number }>('GET', '/api/windows');
    } catch {
        return { open: 0, previous: 0 };
    }
}

// Windows left open across `voltran down` reconnect on their own, with a backoff of up to ~6s.
async function waitForWindows(api: Client, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { open } = await openWindows(api);
        if (open > 0) {
            return open;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    return 0;
}

async function startIfNeeded(api: Client): Promise<boolean> {
    ensureUiBuilt(api.config);
    if (await isRunning(api)) {
        console.log(`Voltran is running on ${api.config.url}`);
        return false;
    }
    startDaemonProcess(api.config);
    if (!(await waitUntilRunning(api, 15_000))) {
        console.error(`Voltran did not start. See ${api.config.logFile}`);
        process.exit(1);
    }
    console.log(`Voltran started on ${api.config.url}`);
    return true;
}

async function up(args: string[]): Promise<void> {
    const api = client();
    const started = await startIfNeeded(api);
    await openUi(api, args, started);
}

// With a session, a window that is already open switches to it; a new window opens on it.
async function openUi(api: Client, args: string[], started: boolean, sessionId?: string): Promise<void> {
    if (args.includes('--no-open')) {
        return;
    }
    if (!args.includes('--new')) {
        let { open, previous } = await openWindows(api);
        if (open === 0 && started && previous > 0) {
            console.log(`Waiting for the open Voltran ${previous === 1 ? 'window' : 'windows'} to reconnect…`);
            open = await waitForWindows(api, 8000);
        }
        if (open > 0 && sessionId) {
            await api.request('POST', `/api/sessions/${sessionId}/reveal`);
            return;
        }
        if (open > 0) {
            console.log(
                `Voltran is already open in ${open === 1 ? 'a window' : `${open} windows`}. Use \`voltran up --new\` to open another.`,
            );
            return;
        }
    }
    const { code } = await api.request<{ code: string }>('POST', '/api/login-code');
    const base = api.config.dev ? `http://localhost:${DEV_WEB_PORT}` : api.config.url;
    openWindow(base, `/auth?code=${code}${sessionId ? `&session=${sessionId}` : ''}`, args.includes('--browser'));
}

async function down(): Promise<void> {
    const api = client();
    if (!(await isRunning(api))) {
        console.log('Voltran is not running.');
        return;
    }
    await api.request('POST', '/api/shutdown');
    console.log('Voltran stopped. Agent sessions resume when you open them again.');
}

// The daemon starts its own successor, so a restart run from a pane inside Voltran completes even
// though that pane, and this process with it, is stopped along the way.
async function restart(args: string[]): Promise<void> {
    const api = client();
    const previousPid = await runningPid(api);
    if (previousPid === null) {
        return up(args);
    }
    ensureUiBuilt(api.config);
    await api.request('POST', '/api/restart');
    if (!(await waitUntilRunning(api, 20_000, previousPid))) {
        console.error(`Voltran did not restart. See ${api.config.logFile}`);
        process.exit(1);
    }
    console.log(`Voltran restarted on ${api.config.url}`);
    await openUi(api, args, true);
}

function launchctl(args: string[]): boolean {
    try {
        execFileSync('launchctl', args, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function systemctl(args: string[]): boolean {
    try {
        execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// launchd and systemd start services with a bare environment, so the service names node by its full
// path and passes on the shell and Voltran's own settings; the daemon builds its PATH from that shell.
// Homebrew keeps Node and Voltran in versioned Cellar folders that an upgrade deletes, while its opt
// links and the bin link the CLI was started through stay where they are.
export function autostartProgram(
    execPath = process.execPath,
    invoked = process.argv[1],
    cliEntry = CLI_ENTRY,
): string[] {
    const optNode = execPath.replace(/\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/, '/opt/$1/bin/node');
    const node = optNode !== execPath && existsSync(optNode) && realpathSync(optNode) === execPath ? optNode : execPath;
    const cli = invoked && realpathSync(invoked) === realpathSync(cliEntry) ? invoked : cliEntry;
    return [node, cli, 'up', '--no-open'];
}

function autostartEnv(): Record<string, string> {
    const env: Record<string, string> = { SHELL: process.env.SHELL || '/bin/zsh' };
    for (const name of ['VOLTRAN_HOME', 'VOLTRAN_PORT']) {
        if (process.env[name]) {
            env[name] = process.env[name]!;
        }
    }
    return env;
}

function autostart(args: string[]): void {
    if (process.platform === 'linux') {
        autostartLinux(args);
        return;
    }
    if (process.platform !== 'darwin') {
        console.log('voltran autostart is only available on macOS and Linux.');
        return;
    }
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const [choice] = args;
    if (choice === 'on') {
        const config = loadConfig();
        ensureHome(config);
        const env = autostartEnv();
        const program = autostartProgram();
        mkdirSync(dirname(LAUNCH_AGENT_FILE), { recursive: true });
        writeFileSync(LAUNCH_AGENT_FILE, launchAgentPlist({ program, env, log: config.logFile }));
        launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]);
        if (!launchctl(['bootstrap', domain, LAUNCH_AGENT_FILE])) {
            console.error(`launchctl could not load ${LAUNCH_AGENT_FILE}`);
            process.exit(1);
        }
        console.log(`Voltran now starts when you log in (${LAUNCH_AGENT_FILE}).`);
        console.log(`It runs ${program[0]}; run \`voltran autostart on\` again after switching Node versions.`);
    } else if (choice === 'off') {
        launchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]);
        rmSync(LAUNCH_AGENT_FILE, { force: true });
        console.log('Voltran no longer starts when you log in. The daemon keeps running until `voltran down`.');
    } else {
        console.log(
            existsSync(LAUNCH_AGENT_FILE)
                ? 'Voltran starts when you log in. Turn it off with `voltran autostart off`.'
                : 'Voltran does not start when you log in. Turn it on with `voltran autostart on`.',
        );
    }
}

function autostartLinux(args: string[]): void {
    const [choice] = args;
    if (choice === 'on') {
        const config = loadConfig();
        ensureHome(config);
        const program = autostartProgram();
        mkdirSync(dirname(SYSTEMD_UNIT_FILE), { recursive: true });
        writeFileSync(SYSTEMD_UNIT_FILE, systemdUnit({ program, env: autostartEnv(), log: config.logFile }));
        if (!systemctl(['daemon-reload']) || !systemctl(['enable', '--now', SYSTEMD_UNIT_NAME])) {
            console.error(
                `systemctl --user could not enable ${SYSTEMD_UNIT_FILE}. Autostart needs a systemd user session.`,
            );
            process.exit(1);
        }
        console.log(`Voltran now starts when you log in (${SYSTEMD_UNIT_FILE}).`);
        console.log(`It runs ${program[0]}; run \`voltran autostart on\` again after switching Node versions.`);
    } else if (choice === 'off') {
        systemctl(['disable', '--now', SYSTEMD_UNIT_NAME]);
        rmSync(SYSTEMD_UNIT_FILE, { force: true });
        systemctl(['daemon-reload']);
        console.log('Voltran no longer starts when you log in. The daemon keeps running until `voltran down`.');
    } else {
        console.log(
            existsSync(SYSTEMD_UNIT_FILE)
                ? 'Voltran starts when you log in. Turn it off with `voltran autostart off`.'
                : 'Voltran does not start when you log in. Turn it on with `voltran autostart on`.',
        );
    }
}

async function status(): Promise<void> {
    const api = client();
    if (!(await isRunning(api))) {
        console.log('Voltran is not running. Start it with `voltran up`.');
        return;
    }
    const state = await api.request<AppState>('GET', '/api/state');
    const pid = existsSync(api.config.pidFile) ? readFileSync(api.config.pidFile, 'utf8').trim() : '?';
    const attention = state.panes.filter((pane) => pane.status === 'needs-input' || pane.status === 'done');
    console.log(`Voltran running on ${api.config.url} (pid ${pid})`);
    const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const open = state.sessions.filter((session) => !session.archived).length;
    console.log(
        `${count(state.projects.length, 'project')}, ${count(open, 'session')}, ${count(state.panes.length, 'pane')}`,
    );
    for (const pane of attention) {
        const session = state.sessions.find((entry) => entry.id === pane.sessionId);
        const line = `${session?.title ?? '?'} · ${pane.title}${pane.detail ? ` — ${pane.detail}` : ''}`;
        console.log(`  ${pane.status === 'needs-input' ? '●' : '○'} ${withoutControls(line)}`);
    }
}

async function add(args: string[]): Promise<void> {
    const api = client();
    if (!(await isRunning(api))) {
        console.log('Voltran is not running. Start it with `voltran up`.');
        process.exit(1);
    }
    const nameIndex = args.indexOf('--name');
    const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
    const positional = args.filter((arg, index) => !arg.startsWith('--') && index !== nameIndex + 1);
    const path = resolve(positional[0] ?? process.cwd());
    const project = await api.request<{ name: string; path: string }>('POST', '/api/projects', { path, name });
    console.log(`Added project ${project.name} → ${project.path}`);
}

export interface NewSessionArgs {
    path: string;
    title?: string;
    panes: PaneSpec[];
    worktree?: { branch: string; base?: string };
    windowArgs: string[];
}

const PANE_ADAPTERS = new Set([
    'claude',
    'codex',
    'opencode',
    'antigravity',
    'shell',
    'command',
    'preview',
    'changes',
    'editor',
]);

// A pane is its adapter's name and the rest of the words as they were typed: arguments for an agent,
// or the command line of a `command` pane.
export function parseNewArgs(args: string[], cwd = process.cwd()): NewSessionArgs {
    const result: NewSessionArgs = { path: cwd, panes: [], windowArgs: [] };
    const positional: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const [flag, inline] =
            arg.startsWith('--') && arg.includes('=')
                ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
                : [arg, undefined];
        const value = (): string => {
            const next = inline ?? args[++index];
            if (next === undefined || next === '') {
                throw new Error(`${flag} needs a value`);
            }
            return next;
        };
        if (flag === '--pane') {
            const spec = value().trim();
            const [adapter] = spec.split(/\s+/, 1);
            const rest = spec.slice(adapter.length).trim();
            if (!PANE_ADAPTERS.has(adapter)) {
                throw new Error(
                    `unknown pane "${adapter}"; use claude, codex, opencode, antigravity, shell, command, preview, changes or editor`,
                );
            }
            if (adapter === 'command' && !rest) {
                throw new Error('a command pane needs the command to run, such as --pane "command npm run dev"');
            }
            if (adapter === 'preview' && !rest) {
                throw new Error('a preview pane needs the page to show, such as --pane "preview localhost:5173"');
            }
            if (adapter === 'shell' && rest) {
                throw new Error('a shell pane takes no arguments; use --pane "command …" to run a command');
            }
            if ((adapter === 'changes' || adapter === 'editor') && rest) {
                throw new Error(`a ${adapter} pane takes no arguments`);
            }
            result.panes.push(rest ? ({ adapter, command: rest } as PaneSpec) : ({ adapter } as PaneSpec));
        } else if (flag === '--title') {
            result.title = value();
        } else if (flag === '--worktree') {
            const [branch, base] = value().split(':', 2);
            result.worktree = base ? { branch, base } : { branch };
        } else if (flag === '--no-open' || flag === '--browser' || flag === '--new') {
            result.windowArgs.push(flag);
        } else if (arg.startsWith('-')) {
            throw new Error(`unknown option ${arg}`);
        } else {
            positional.push(arg);
        }
    }
    if (positional.length > 1) {
        throw new Error(`one folder at most, got ${positional.join(' ')}`);
    }
    if (positional[0]) {
        result.path = resolve(cwd, positional[0].replace(/^~(?=$|\/)/, homedir()));
    }
    if (result.panes.length === 0) {
        result.panes.push({ adapter: 'claude' });
    }
    return result;
}

async function newSession(args: string[]): Promise<void> {
    let parsed: NewSessionArgs;
    try {
        parsed = parseNewArgs(args);
    } catch (error) {
        console.error(`voltran new: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    const api = client();
    const started = await startIfNeeded(api);
    try {
        const state = await api.request<AppState>('GET', '/api/state');
        let project = state.projects.find((entry) => entry.path === parsed.path);
        if (!project) {
            project = await api.request<Project>('POST', '/api/projects', { path: parsed.path });
            console.log(`Added project ${project.name} → ${project.path}`);
        }
        const body: CreateSessionBody = {
            projectId: project.id,
            title: parsed.title,
            panes: parsed.panes,
            worktree: parsed.worktree,
        };
        const session = await api.request<{ id: string; title: string; cwd: string }>('POST', '/api/sessions', body);
        console.log(`Opened ${parsed.title ? `"${withoutControls(session.title)}"` : 'a session'} in ${session.cwd}`);
        console.log(session.id);
        await openUi(api, parsed.windowArgs, started, session.id);
    } catch (error) {
        console.error(`voltran new: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

// A new token signs out every window and every copy of a browser credential, wherever it went.
async function signout(): Promise<void> {
    const api = client();
    if (await isRunning(api)) {
        await api.request('POST', '/api/signout');
    } else {
        writeNewToken(api.config);
    }
    console.log('Signed out every window. `voltran up` signs this computer in again.');
}

// Reads the token without creating it, so a check on a broken install changes nothing.
async function daemonInfo(config: Config): Promise<DaemonInfo | null> {
    try {
        const token = readFileSync(config.tokenFile, 'utf8').trim();
        const response = await fetch(`${config.url}/api/health`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(2000),
        });
        const health = (await response.json()) as { pid: number; version: string };
        return response.ok ? { pid: health.pid, version: health.version } : null;
    } catch {
        return null;
    }
}

async function doctor(args: string[]): Promise<void> {
    const config = loadConfig();
    const shell = process.env.SHELL || '/bin/zsh';
    const path = await resolveShellPath(shell, process.env.PATH ?? '/usr/bin:/bin');
    const report = await diagnose({ config, shell, path, daemon: await daemonInfo(config) });
    console.log(formatDiagnostics(report));
    if (args.includes('--report')) {
        openWindow(bugReportUrl(report), '', true);
        console.log('\nOpened a bug report with these results in your browser.');
    } else {
        console.log('\nTo report a problem with these results attached, run `voltran doctor --report`.');
    }
    if (report.checks.some((check) => check.status === 'fail')) {
        process.exitCode = 1;
    }
}

export async function runCli(argv: string[]): Promise<void> {
    const [command = 'help', ...args] = argv;
    switch (command) {
        case 'up':
        case 'open':
            return up(args);
        case 'down':
        case 'stop':
            return down();
        case 'restart':
            return restart(args);
        case 'status':
            return status();
        case 'add':
            return add(args);
        case 'new':
            return newSession(args);
        case 'autostart':
            return autostart(args);
        case 'signout':
            return signout();
        case 'doctor':
            return doctor(args);
        case 'version':
        case '--version':
        case '-v':
            console.log(voltranVersion());
            return;
        default:
            console.log(HELP);
    }
}
