import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { arch, homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CheckStatus, DiagnosticCheck, Diagnostics } from '@voltran/shared';
import { findOnPath } from './adapters.ts';
import { REPO_ROOT, voltranVersion, type Config } from './config.ts';
import { SYSTEMD_UNIT_FILE, findChrome } from './linux.ts';
import { CHROME, LAUNCH_AGENT_FILE, installedChromeApp } from './macos.ts';
import { withoutControls } from './status.ts';

export const MIN_NODE = '22.18.0';

const AGENTS = [
    { name: 'Claude Code', binary: 'claude' },
    { name: 'Codex', binary: 'codex' },
    { name: 'OpenCode', binary: 'opencode' },
    { name: 'Antigravity', binary: 'agy' },
];

export interface DaemonInfo {
    pid: number;
    version: string;
}

export interface DiagnoseOptions {
    config: Config;
    shell: string;
    path: string;
    daemon: DaemonInfo | null;
}

function check(name: string, status: CheckStatus, detail: string): DiagnosticCheck {
    return { name, status, detail };
}

function run(file: string, args: string[], path: string, timeoutMs = 4000): Promise<string | null> {
    return new Promise((done) => {
        execFile(file, args, { timeout: timeoutMs, env: { ...process.env, PATH: path } }, (error, stdout) => {
            done(error ? null : stdout.trim());
        });
    });
}

function firstLine(text: string): string {
    return withoutControls(text.split('\n')[0] ?? '')
        .trim()
        .slice(0, 80);
}

export function versionAtLeast(version: string, minimum: string): boolean {
    const parts = (text: string): number[] =>
        text
            .replace(/^v/, '')
            .split('.')
            .map((part) => Number.parseInt(part, 10) || 0);
    const [have, need] = [parts(version), parts(minimum)];
    for (let index = 0; index < need.length; index++) {
        if ((have[index] ?? 0) !== need[index]) {
            return (have[index] ?? 0) > need[index];
        }
    }
    return true;
}

async function platformName(): Promise<string> {
    if (process.platform === 'darwin') {
        const version = await run('sw_vers', ['-productVersion'], '/usr/bin:/bin');
        return `macOS ${version ?? 'unknown'} (${arch()})`;
    }
    if (process.platform === 'linux') {
        let name = 'Linux';
        try {
            name = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? name;
        } catch {
            // Not every distribution has /etc/os-release.
        }
        let wsl = false;
        try {
            wsl = /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
        } catch {
            wsl = false;
        }
        return `${name}${wsl ? ' on WSL2' : ''} (${arch()})`;
    }
    return `${process.platform} (${arch()})`;
}

// node-pty is a native module, so a broken install fails here, on import or on spawn.
async function terminalsCheck(): Promise<DiagnosticCheck> {
    try {
        const pty = await import('node-pty');
        const exited = await new Promise<boolean>((done) => {
            const child = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 20, rows: 5, cwd: homedir(), env: { PATH: '/usr/bin:/bin' } });
            const timer = setTimeout(() => {
                child.kill();
                done(false);
            }, 3000);
            child.onExit(() => {
                clearTimeout(timer);
                done(true);
            });
        });
        return exited
            ? check('Terminals', 'ok', 'node-pty starts processes')
            : check('Terminals', 'fail', 'a test process started but never exited');
    } catch (error) {
        return check(
            'Terminals',
            'fail',
            `node-pty cannot start a process: ${firstLine(error instanceof Error ? error.message : String(error))}`,
        );
    }
}

export function homeCheck(config: Config, uid = process.getuid?.()): DiagnosticCheck {
    if (!existsSync(config.home)) {
        return check('Data folder', 'ok', `${config.home} (not created yet)`);
    }
    const stat = statSync(config.home);
    if (uid !== undefined && stat.uid !== uid) {
        return check('Data folder', 'fail', `${config.home} belongs to another user`);
    }
    const problems: string[] = [];
    if ((stat.mode & 0o777) !== 0o700) {
        problems.push(`mode ${(stat.mode & 0o777).toString(8)} instead of 700`);
    }
    if (existsSync(config.tokenFile) && (statSync(config.tokenFile).mode & 0o077) !== 0) {
        problems.push('the token is readable by others');
    }
    return problems.length > 0
        ? check('Data folder', 'warn', `${config.home}: ${problems.join(', ')}; the daemon fixes this when it starts`)
        : check('Data folder', 'ok', config.home);
}

export function daemonCheck(config: Config, daemon: DaemonInfo | null, version: string): DiagnosticCheck {
    if (!daemon) {
        return check('Daemon', 'off', `not running on port ${config.port}`);
    }
    if (daemon.version !== version) {
        return check(
            'Daemon',
            'warn',
            `running ${daemon.version} (pid ${daemon.pid}) while this copy is ${version}; run \`voltran restart\``,
        );
    }
    return check('Daemon', 'ok', `running on port ${config.port} (pid ${daemon.pid})`);
}

async function voltranCheck(version: string, path: string): Promise<DiagnosticCheck> {
    const commit = existsSync(join(REPO_ROOT, '.git')) ? await run('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], path) : null;
    return check('Voltran', 'ok', commit ? `${version} (${commit})` : version);
}

async function agentCheck(name: string, binary: string, path: string): Promise<DiagnosticCheck> {
    const file = findOnPath(binary, path);
    if (!file) {
        return check(name, 'off', 'not installed');
    }
    const version = await run(file, ['--version'], path);
    return check(name, 'ok', version ? firstLine(version) : `${binary} found, but \`${binary} --version\` failed`);
}

async function toolCheck(name: string, binary: string, missing: string, path: string): Promise<DiagnosticCheck> {
    const version = findOnPath(binary, path) ? await run(binary, ['--version'], path) : null;
    return version ? check(name, 'ok', firstLine(version)) : check(name, binary === 'git' ? 'warn' : 'off', missing);
}

function browserCheck(config: Config): DiagnosticCheck {
    if (process.platform === 'darwin') {
        if (installedChromeApp(config.url)) {
            return check('Window', 'ok', 'opens the installed Chrome app');
        }
        return existsSync(CHROME)
            ? check('Window', 'ok', 'opens a Chrome app window')
            : check('Window', 'off', 'Chrome not found; opens in the default browser');
    }
    const chrome = findChrome();
    return chrome
        ? check('Window', 'ok', `opens an app window with ${basename(chrome)}`)
        : check('Window', 'off', 'Chrome not found; opens in the default browser');
}

// Only a count: the endpoints are secrets, and the pairing address would put the LAN in a public issue.
async function phonesCheck(config: Config, path: string): Promise<DiagnosticCheck> {
    let count = 0;
    try {
        const devices = JSON.parse(readFileSync(join(config.pushDir, 'devices.json'), 'utf8')) as unknown;
        count = Array.isArray(devices) ? devices.length : 0;
    } catch {
        count = 0;
    }
    const openssl = process.platform === 'darwin' ? await run('openssl', ['version'], path) : null;
    const pairing =
        process.platform !== 'darwin' ? 'pairing needs macOS' : openssl ? 'pairing ready' : 'openssl not found, so a phone cannot pair';
    const paired = count === 0 ? 'none paired' : count === 1 ? '1 paired' : `${count} paired`;
    return check(
        'Phone notifications',
        process.platform === 'darwin' && !openssl ? 'warn' : count > 0 ? 'ok' : 'off',
        `${paired}; ${pairing}`,
    );
}

function autostartCheck(): DiagnosticCheck {
    const file = process.platform === 'darwin' ? LAUNCH_AGENT_FILE : process.platform === 'linux' ? SYSTEMD_UNIT_FILE : null;
    return file && existsSync(file) ? check('Autostart', 'ok', 'on') : check('Autostart', 'off', 'off');
}

// What a bug report needs, and nothing a user would not want in a public issue: no token, no file
// contents, no pane output, and the home folder written as ~.
export async function diagnose(options: DiagnoseOptions): Promise<Diagnostics> {
    const { config, shell, path, daemon } = options;
    const version = voltranVersion();
    const node = process.versions.node;
    const platform = await platformName();
    const checks = await Promise.all([
        voltranCheck(version, path),
        check(
            'Node.js',
            versionAtLeast(node, MIN_NODE) ? 'ok' : 'fail',
            versionAtLeast(node, MIN_NODE) ? node : `${node}; Voltran needs ${MIN_NODE} or newer`,
        ),
        check('System', 'ok', platform),
        terminalsCheck(),
        check(
            'UI',
            existsSync(join(config.webDist, 'index.html')) ? 'ok' : 'warn',
            existsSync(join(config.webDist, 'index.html')) ? 'built' : 'not built yet; `voltran up` builds it',
        ),
        homeCheck(config),
        daemonCheck(config, daemon, version),
        check('Shell', 'ok', shell),
        ...AGENTS.map((agent) => agentCheck(agent.name, agent.binary, path)),
        toolCheck('git', 'git', 'not found; sessions show no branch or changes', path),
        toolCheck('GitHub CLI', 'gh', 'not found; sessions show no pull requests', path),
        browserCheck(config),
        autostartCheck(),
        phonesCheck(config, path),
    ]);
    return { version, platform, node, checks: checks.map((entry) => ({ ...entry, detail: redactHome(entry.detail) })) };
}

export function redactHome(text: string, home = homedir()): string {
    if (home.length <= 1) {
        return text;
    }
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`${escaped}(?![\\w.-])`, 'g'), '~');
}
