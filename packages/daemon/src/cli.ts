import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppState } from '@voltran/shared';
import { ensureHome, loadConfig, readOrCreateToken, type Config } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DAEMON_ENTRY = join(HERE, 'main.ts');
const CHROME = '/Applications/Google Chrome.app';

const HELP = `voltran — local multi-agent session and terminal orchestrator

Usage:
  voltran up [--browser] [--no-open]   start the daemon if needed and open the UI
  voltran add [path] [--name <name>]   register a folder as a project (default: current dir)
  voltran status                       show daemon and attention summary
  voltran down                         stop the daemon (agents resume on next open)

Options:
  --browser   open in the default browser instead of a Chrome app window
  --no-open   do not open any window

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

async function isRunning(api: Client): Promise<boolean> {
    try {
        await api.request('GET', '/api/health');
        return true;
    } catch {
        return false;
    }
}

async function waitUntilRunning(api: Client, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isRunning(api)) {
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

function startDaemonProcess(config: Config): void {
    const log = openSync(config.logFile, 'a');
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
        cwd: config.home,
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
    });
    child.unref();
}

function openWindow(url: string, preferBrowser: boolean): void {
    if (process.platform !== 'darwin') {
        console.log(`Open ${url}`);
        return;
    }
    if (!preferBrowser && existsSync(CHROME)) {
        spawn('open', ['-na', CHROME, '--args', `--app=${url}`], { stdio: 'ignore', detached: true }).unref();
        return;
    }
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function up(args: string[]): Promise<void> {
    const api = client();
    ensureUiBuilt(api.config);

    if (await isRunning(api)) {
        console.log(`Voltran is running on ${api.config.url}`);
    } else {
        startDaemonProcess(api.config);
        if (!(await waitUntilRunning(api, 15_000))) {
            console.error(`Voltran did not start. See ${api.config.logFile}`);
            process.exit(1);
        }
        console.log(`Voltran started on ${api.config.url}`);
    }

    if (args.includes('--no-open')) {
        return;
    }
    const { code } = await api.request<{ code: string }>('POST', '/api/login-code');
    const base = api.config.dev ? 'http://localhost:5173' : api.config.url;
    openWindow(`${base}/auth?code=${code}`, args.includes('--browser'));
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
    console.log(`${count(state.projects.length, 'project')}, ${count(open, 'session')}, ${count(state.panes.length, 'pane')}`);
    for (const pane of attention) {
        const session = state.sessions.find((entry) => entry.id === pane.sessionId);
        console.log(`  ${pane.status === 'needs-input' ? '●' : '○'} ${session?.title ?? '?'} · ${pane.title}${pane.detail ? ` — ${pane.detail}` : ''}`);
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

export async function runCli(argv: string[]): Promise<void> {
    const [command = 'help', ...args] = argv;
    switch (command) {
        case 'up':
        case 'open':
            return up(args);
        case 'down':
        case 'stop':
            return down();
        case 'status':
            return status();
        case 'add':
            return add(args);
        default:
            console.log(HELP);
    }
}
