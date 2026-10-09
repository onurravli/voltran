import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    claudeSettingsFile: string;
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
        claudeSettingsFile: join(home, 'claude-settings.json'),
        webDist: resolve(here, '../../web/dist'),
        dev,
        allowedHosts,
        allowedOrigins,
    };
}

export function ensureHome(config: Config): void {
    mkdirSync(config.home, { recursive: true, mode: 0o700 });
    mkdirSync(config.scrollbackDir, { recursive: true, mode: 0o700 });
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
