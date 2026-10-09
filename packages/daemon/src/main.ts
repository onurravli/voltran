import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describeAdapters, resolveShellPath, writeClaudeSettings } from './adapters.ts';
import { ensureHome, loadConfig, readOrCreateToken, type Config } from './config.ts';
import { Hub } from './hub.ts';
import { Guard } from './security.ts';
import { createVoltranServer } from './server.ts';
import { Store } from './store.ts';

export interface DaemonOptions {
    shell: string;
    path: string;
    baseEnv: NodeJS.ProcessEnv;
    onShutdown?: () => void;
}

export interface Daemon {
    config: Config;
    token: string;
    hub: Hub;
    server: Server;
    shutdown: () => void;
}

export function buildDaemon(config: Config, options: DaemonOptions): Daemon {
    ensureHome(config);
    const token = readOrCreateToken(config);
    writeClaudeSettings(config.claudeSettingsFile);

    const store = new Store(config.dbFile);
    const hub = new Hub({
        store,
        adapters: describeAdapters(options.path),
        scrollbackDir: config.scrollbackDir,
        claudeSettingsFile: config.claudeSettingsFile,
        url: config.url,
        shell: options.shell,
        path: options.path,
        baseEnv: options.baseEnv,
    });
    const guard = new Guard(config, token);

    let stopped = false;
    const shutdown = (): void => {
        if (stopped) {
            return;
        }
        stopped = true;
        hub.shutdown();
        store.close();
        rmSync(config.pidFile, { force: true });
        server.close();
        server.closeAllConnections();
        options.onShutdown?.();
    };

    const server = createVoltranServer({ config, hub, guard, onShutdown: shutdown });
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
        onShutdown: () => {
            console.log('[voltran] stopped');
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
