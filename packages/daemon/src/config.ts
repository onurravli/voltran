import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
    home: string;
    port: number;
    url: string;
    dbFile: string;
    tokenFile: string;
    pidFile: string;
    logFile: string;
    scrollbackDir: string;
    notesDir: string;
    worktreesDir: string;
    settingsFile: string;
    windowsFile: string;
    webDist: string;
    dev: boolean;
    allowedHosts: Set<string>;
    allowedOrigins: Set<string>;
}

const DEFAULT_PORT = 4747;
const DEV_WEB_PORT = 5173;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const home = resolve(env.VOLTRAN_HOME || join(homedir(), '.voltran'));
    const port = Number(env.VOLTRAN_PORT || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`VOLTRAN_PORT must be a TCP port, got "${env.VOLTRAN_PORT}"`);
    }
    const dev = env.VOLTRAN_DEV === '1';

    const hostPorts = dev ? [port, DEV_WEB_PORT] : [port];
    const allowedHosts = new Set(hostPorts.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
    const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

    const here = dirname(fileURLToPath(import.meta.url));

    return {
        home,
        port,
        url: `http://127.0.0.1:${port}`,
        dbFile: join(home, 'voltran.db'),
        tokenFile: join(home, 'token'),
        pidFile: join(home, 'daemon.pid'),
        logFile: join(home, 'daemon.log'),
        scrollbackDir: join(home, 'scrollback'),
        notesDir: join(home, 'notes'),
        worktreesDir: join(home, 'worktrees'),
        settingsFile: join(home, 'settings.json'),
        windowsFile: join(home, 'windows'),
        webDist: resolve(here, '../../web/dist'),
        dev,
        allowedHosts,
        allowedOrigins,
    };
}

// Everything Voltran keeps is readable by the user alone. A home that already exists keeps the mode
// it was made with, so it is set again on every start, and one another user owns, such as a folder
// in /tmp someone else made first, is refused.
export function ensureHome(config: Config): void {
    mkdirSync(config.home, { recursive: true, mode: 0o700 });
    const owner = statSync(config.home).uid;
    if (process.getuid && owner !== process.getuid()) {
        throw new Error(`${config.home} belongs to another user; Voltran will not keep its data there`);
    }
    chmodSync(config.home, 0o700);
    for (const dir of [config.scrollbackDir, config.notesDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
    }
}

export function privateFile(path: string): string {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    return path;
}

export function readOrCreateToken(config: Config): string {
    if (existsSync(config.tokenFile)) {
        const token = readFileSync(config.tokenFile, 'utf8').trim();
        if (token.length >= 32) {
            chmodSync(config.tokenFile, 0o600);
            return token;
        }
    }
    const token = randomBytes(32).toString('hex');
    writeFileSync(config.tokenFile, `${token}\n`, { mode: 0o600 });
    return token;
}
