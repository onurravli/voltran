import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describeAdapters, resolveShellPath, writeClaudeSettings } from './adapters.ts';
import { startDaemonProcess } from './cli.ts';
import { ensureHome, loadConfig, readOrCreateToken, type Config } from './config.ts';
import { Hub } from './hub.ts';
import { Guard } from './security.ts';
import type { GitRunner } from './git.ts';
import { createVoltranServer, openInEditor } from './server.ts';
import { SettingsFile } from './settings.ts';
import { Store } from './store.ts';
import { VersionWatch } from './version.ts';

export interface DaemonOptions {
    shell: string;
    path: string;
    baseEnv: NodeJS.ProcessEnv;
    onShutdown?: (restart: boolean) => void;
    openFile?: (path: string) => void;
    gitRunner?: GitRunner;
}

export interface Daemon {
    config: Config;
    token: string;
    hub: Hub;
    server: Server;
    shutdown: () => Promise<void>;
}

function readPreviousWindows(file: string): number {
    try {
        const count = Number(readFileSync(file, 'utf8'));
        rmSync(file, { force: true });
        return Number.isSafeInteger(count) && count > 0 ? count : 0;
    } catch {
        return 0;
    }
}

export function buildDaemon(config: Config, options: DaemonOptions): Daemon {
    ensureHome(config);
    const token = readOrCreateToken(config);
    writeClaudeSettings(config.claudeSettingsFile, config.notesDir);

    const store = new Store(config.dbFile);
    const hub = new Hub({
        store,
        adapters: describeAdapters(options.path),
        scrollbackDir: config.scrollbackDir,
        notesDir: config.notesDir,
        worktreesDir: config.worktreesDir,
        claudeSettingsFile: config.claudeSettingsFile,
        url: config.url,
        shell: options.shell,
        path: options.path,
        baseEnv: options.baseEnv,
        gitRunner: options.gitRunner,
        pullRequests: () => settings.state().settings.git.pullRequests,
    });
    const guard = new Guard(config, token);
    const settings = new SettingsFile(config.settingsFile, (state) => hub.publish({ type: 'settings', ...state }));
    settings.watch();

    // Remembers how many windows were open so the next `voltran up` can wait for them to reconnect
    // instead of opening another one.
    const previousWindows = readPreviousWindows(config.windowsFile);

    let stopped = false;
    let restarting = false;
    const shutdown = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        stopped = true;
        try {
            writeFileSync(config.windowsFile, String(hub.openWindows()), { mode: 0o600 });
        } catch {
            // only a hint for the next start
        }
        settings.close();
        try {
            await hub.shutdown();
        } finally {
            store.close();
            rmSync(config.pidFile, { force: true });
            server.close();
            server.closeAllConnections();
            options.onShutdown?.(restarting);
        }
    };
    const restart = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        restarting = true;
        await shutdown();
    };

    const version = new VersionWatch(fileURLToPath(new URL('../..', import.meta.url)), config.webDist);
    const server = createVoltranServer({
        config,
        hub,
        guard,
        settings,
        previousWindows,
        version,
        env: options.baseEnv,
        openFile: options.openFile ?? openInEditor,
        onShutdown: shutdown,
        onRestart: restart,
    });
    return { config, token, hub, server, shutdown };
}

export async function startDaemon(): Promise<void> {
    const config = loadConfig();
    const shell = process.env.SHELL || '/bin/zsh';
    const path = await resolveShellPath(shell, process.env.PATH ?? '/usr/bin:/bin');

    const daemon = buildDaemon(config, {
        shell,
        path,
        baseEnv: process.env,
        onShutdown: (restart) => {
            if (restart) {
                startDaemonProcess(config);
            }
            console.log(restart ? '[voltran] restarting' : '[voltran] stopped');
            setTimeout(() => process.exit(0), 200).unref();
        },
    });

    daemon.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`[voltran] port ${config.port} is already in use. Is Voltran already running? Try \`voltran status\`.`);
        } else {
            console.error('[voltran] server error:', error);
        }
        process.exit(1);
    });

    daemon.server.listen(config.port, '127.0.0.1', () => {
        writeFileSync(config.pidFile, `${process.pid}\n`);
        console.log(`[voltran] daemon listening on ${config.url} (pid ${process.pid}${config.dev ? ', dev' : ''})`);
    });

    process.on('SIGINT', daemon.shutdown);
    process.on('SIGTERM', daemon.shutdown);
    process.on('SIGHUP', daemon.shutdown);
}

const invokedDirectly = process.argv[1] !== undefined
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    startDaemon().catch((error: unknown) => {
        console.error('[voltran] failed to start:', error);
        process.exit(1);
    });
}
