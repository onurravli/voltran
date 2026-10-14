import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, type AppState, type PaneView, type ServerEvent, type Session, type SettingsState } from '@voltran/shared';
import { loadConfig } from './config.ts';
import { buildDaemon, type Daemon } from './main.ts';

// Stands in for the real CLI: runs the exact UserPromptSubmit hook command Voltran handed it
// through --settings, so the env plumbing and the per-pane secret are exercised end to end.
const FAKE_CLAUDE = `#!/bin/sh
echo "fake claude $*"
cmd=$(node -e 'const s=require(process.argv[1]); process.stdout.write(s.hooks.UserPromptSubmit[0].hooks[0].command)' "$2")
printf '{"session_id":"fake-session-1","prompt":"hi from fake claude"}' | sh -c "$cmd"
sleep 30
`;

let daemon: Daemon;
let base: string;
let home: string;
let port: number;
const opened: string[] = [];

const freePort = (): Promise<number> => new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => resolvePort(free));
    });
});

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error('condition not met in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'voltran-server-'));
    const fakeBin = join(home, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'claude'), FAKE_CLAUDE);
    chmodSync(join(fakeBin, 'claude'), 0o755);

    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = loadConfig({ VOLTRAN_HOME: join(home, 'data'), VOLTRAN_PORT: String(port) });
    daemon = buildDaemon(config, {
        shell: '/bin/sh',
        path: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        baseEnv: process.env,
        openFile: (path) => opened.push(path),
    });
    await new Promise<void>((resolveListen) => daemon.server.listen(port, '127.0.0.1', resolveListen));
});

afterAll(async () => {
    await daemon.shutdown();
    rmSync(home, { recursive: true, force: true });
});

describe('access control', () => {
    it('refuses requests without credentials', async () => {
        const response = await fetch(`${base}/api/state`);
        expect(response.status).toBe(401);
    });

    it('refuses cross-origin requests that carry valid credentials', async () => {
        const { status } = await api('GET', '/api/state', undefined, { Origin: 'https://attacker.example' });
        expect(status).toBe(403);
    });

    it('refuses a DNS-rebinding Host header', async () => {
        const status = await new Promise<number>((resolveStatus) => {
            httpRequest({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: `attacker.example:${port}`, Authorization: `Bearer ${daemon.token}` } }, (response) => {
                response.resume();
                resolveStatus(response.statusCode ?? 0);
            }).end();
        });
        expect(status).toBe(421);
    });

    it('refuses WebSocket upgrades from another origin', async () => {
        const outcome = await new Promise<string>((resolveOutcome) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { Origin: 'https://attacker.example', Cookie: `voltran_session=${daemon.token}` } });
            socket.on('open', () => resolveOutcome('opened'));
            socket.on('error', (error) => resolveOutcome(error.message));
        });
        expect(outcome).toContain('403');
    });

    it('counts the open windows for the CLI, for signed-in callers only', async () => {
        expect((await fetch(`${base}/api/windows`)).status).toBe(401);
        const before = (await api<{ open: number; previous: number }>('GET', '/api/windows')).body;
        expect(before.previous).toBe(0);
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        await new Promise((resolveMessage) => socket.once('message', resolveMessage));
        expect((await api<{ open: number }>('GET', '/api/windows')).body.open).toBe(before.open + 1);
        socket.close();
        await until(async () => (await api<{ open: number }>('GET', '/api/windows')).body.open === before.open);
    });

    it('signs a browser in with a one-time code', async () => {
        const { body } = await api<{ code: string }>('POST', '/api/login-code');
        const first = await fetch(`${base}/auth?code=${body.code}`, { redirect: 'manual' });
        expect(first.status).toBe(302);
        const cookie = first.headers.get('set-cookie') ?? '';
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Strict');

        const session = cookie.split(';')[0];
        const state = await fetch(`${base}/api/state`, { headers: { Cookie: session } });
        expect(state.status).toBe(200);

        const replay = await fetch(`${base}/auth?code=${body.code}`, { redirect: 'manual' });
        expect(replay.status).toBe(401);
    });
});

describe('validation', () => {
    it('only accepts existing absolute directories as projects, once', async () => {
        expect((await api('POST', '/api/projects', { path: 'relative/path' })).status).toBe(400);
        expect((await api('POST', '/api/projects', { path: '/does/not/exist' })).status).toBe(400);
        const dir = mkdtempSync(join(home, 'project-'));
        expect((await api('POST', '/api/projects', { path: dir })).status).toBe(201);
        expect((await api('POST', '/api/projects', { path: dir })).status).toBe(409);
    });

    it('rejects unsafe links, unknown adapters and empty commands', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const projectId = state.projects[0].id;
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', link: 'javascript:alert(1)' })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'rm -rf' }] })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'command', command: '  ' }] })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'claude', command: '--resume abc' }] })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'claude', command: '--settings=x.json' }] })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'claude', command: "--plugin-dir 'a b" }] })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: '   ' })).status).toBe(400);
    });

    it('rejects a layout that drops or invents panes', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: state.projects[0].id, title: 'layout', panes: [{ adapter: 'shell' }, { adapter: 'shell' }] });
        const { status } = await api('PATCH', `/api/sessions/${session.id}`, { layout: { type: 'pane', paneId: 'invented' } });
        expect(status).toBe(409);
        await api('DELETE', `/api/sessions/${session.id}`);
    });

    it('opens subagent panes only for signed-in clients and only for agents a pane reported', async () => {
        expect((await fetch(`${base}/api/panes/any/subagents/any/view`, { method: 'POST' })).status).toBe(401);
        expect((await api('POST', '/api/panes/unknown/subagents/a1/view')).status).toBe(404);

        const { body: state } = await api<AppState>('GET', '/api/state');
        const projectId = state.projects[0].id;
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId, title: 'subagents', panes: [{ adapter: 'shell' }] });
        const paneId = session.layout?.type === 'pane' ? session.layout.paneId : '';
        expect((await api('POST', `/api/panes/${paneId}/subagents/never-started/view`)).status).toBe(404);
        expect((await api('POST', `/api/sessions/${session.id}/panes`, { adapter: 'subagent', command: '/etc/passwd' })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'subagent', command: '/etc/passwd' }] })).status).toBe(400);
        await api('DELETE', `/api/sessions/${session.id}`);
    });
});

describe('moving panes', () => {
    it('moves a running pane to another session of the same project without restarting it', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const projectId = state.projects[0].id;
        const { body: from } = await api<Session>('POST', '/api/sessions', { projectId, title: 'from', panes: [{ adapter: 'shell' }, { adapter: 'shell' }] });
        const { body: to } = await api<Session>('POST', '/api/sessions', { projectId, title: 'to', panes: [{ adapter: 'shell' }] });
        const [moving, staying] = from.layout?.type === 'split' ? from.layout.children.map((child) => (child.type === 'pane' ? child.paneId : '')) : [];
        const pane = async (id: string): Promise<PaneView | undefined> => (await api<AppState>('GET', '/api/state')).body.panes.find((entry) => entry.id === id);

        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/panes/${moving}`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        await new Promise((resolveOpen) => socket.on('open', resolveOpen));
        socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
        await until(async () => (await pane(moving))?.pid !== null);
        const pid = (await pane(moving))?.pid;

        const { status, body: moved } = await api<PaneView>('POST', `/api/panes/${moving}/move`, { sessionId: to.id });
        expect(status).toBe(200);
        expect(moved.sessionId).toBe(to.id);
        const { body: after } = await api<AppState>('GET', '/api/state');
        expect(after.sessions.find((entry) => entry.id === from.id)?.layout).toEqual({ type: 'pane', paneId: staying });
        const target = after.sessions.find((entry) => entry.id === to.id)?.layout;
        expect(target?.type === 'split' && target.children.map((child) => (child.type === 'pane' ? child.paneId : ''))).toContain(moving);
        expect((await pane(moving))?.pid).toBe(pid);

        expect((await api('POST', `/api/panes/${moving}/move`, { sessionId: to.id })).status).toBe(200);
        socket.close();
        await api('DELETE', `/api/sessions/${from.id}`);
        await api('DELETE', `/api/sessions/${to.id}`);
    });

    it('refuses other projects, archived sessions and unknown ids', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const projectId = state.projects[0].id;
        const { body: source } = await api<Session>('POST', '/api/sessions', { projectId, title: 'source', panes: [{ adapter: 'shell' }] });
        const paneId = source.layout?.type === 'pane' ? source.layout.paneId : '';
        const { body: other } = await api<{ id: string }>('POST', '/api/projects', { path: mkdtempSync(join(home, 'other-project-')) });
        const { body: elsewhere } = await api<Session>('POST', '/api/sessions', { projectId: other.id, title: 'elsewhere' });
        const { body: archived } = await api<Session>('POST', '/api/sessions', { projectId, title: 'archived' });
        await api('PATCH', `/api/sessions/${archived.id}`, { archived: true });

        expect((await api('POST', `/api/panes/${paneId}/move`, { sessionId: elsewhere.id })).status).toBe(400);
        expect((await api('POST', `/api/panes/${paneId}/move`, { sessionId: archived.id })).status).toBe(409);
        expect((await api('POST', `/api/panes/${paneId}/move`, { sessionId: 'unknown' })).status).toBe(404);
        expect((await api('POST', '/api/panes/unknown/move', { sessionId: source.id })).status).toBe(404);
        expect((await api('POST', `/api/panes/${paneId}/move`, {})).status).toBe(400);
        expect((await fetch(`${base}/api/panes/${paneId}/move`, { method: 'POST', body: JSON.stringify({ sessionId: source.id }) })).status).toBe(401);

        for (const id of [source.id, elsewhere.id, archived.id]) {
            await api('DELETE', `/api/sessions/${id}`);
        }
    });
});

describe('agent panes', () => {
    it('track Claude status through hooks that carry a per-pane secret', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', {
            projectId: state.projects[0].id,
            title: 'hooks',
            panes: [{ adapter: 'claude', command: "--plugin-dir './a b'" }],
        });
        const paneId = session.layout?.type === 'pane' ? session.layout.paneId : '';

        let output = '';
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/panes/${paneId}`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                output += data.toString();
            }
        });
        await new Promise((resolveOpen) => socket.on('open', resolveOpen));
        socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

        const pane = async (): Promise<PaneView | undefined> => (await api<AppState>('GET', '/api/state')).body.panes.find((entry) => entry.id === paneId);
        await until(async () => (await pane())?.status === 'working');

        expect(await pane()).toMatchObject({ title: 'Claude Code', detail: 'hi from fake claude', agentSessionId: 'fake-session-1', agentResumable: true });
        expect(output).toMatch(/fake claude --settings \S+claude-settings\.json --session-id [0-9a-f-]{36} --plugin-dir \.\/a b/);

        const forged = await fetch(`${base}/api/hooks/${paneId}/Stop`, { method: 'POST', headers: { Authorization: `Bearer ${daemon.token}` }, body: '{}' });
        expect(forged.status).toBe(403);

        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
        const scrollback = join(home, 'data', 'scrollback');
        expect(existsSync(scrollback) ? readdirSync(scrollback).filter((file) => file.startsWith(paneId)) : []).toEqual([]);
    });
});

describe('settings', () => {
    it('saves a change into settings.json and tells every window', async () => {
        const { body: initial } = await api<SettingsState>('GET', '/api/settings');
        expect(initial).toMatchObject({ settings: DEFAULT_SETTINGS, problems: [], exists: false });

        const events: ServerEvent[] = [];
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        socket.on('message', (data) => events.push(JSON.parse(data.toString())));
        await until(() => events.some((event) => event.type === 'state'));
        expect(events[0]).toMatchObject({ type: 'settings', exists: false });

        const { status, body } = await api<SettingsState>('PATCH', '/api/settings', { terminal: { fontSize: 16 }, sidebar: { position: 'right' } });
        expect(status).toBe(200);
        expect(body).toMatchObject({ exists: true, problems: [], settings: { terminal: { fontSize: 16 }, sidebar: { position: 'right' } } });
        expect(readFileSync(body.path, 'utf8')).toContain('"fontSize": 16');
        await until(() => events.filter((event) => event.type === 'settings').length === 2);
        expect(events.filter((event) => event.type === 'settings')[1]).toMatchObject({ settings: { terminal: { fontSize: 16 } } });
        socket.close();
    });

    it('refuses invalid values and unknown settings without writing them', async () => {
        const before = (await api<SettingsState>('GET', '/api/settings')).body;
        const invalid = await api<{ error: string }>('PATCH', '/api/settings', { terminal: { fontSize: 'big' } });
        expect(invalid).toEqual({ status: 400, body: { error: '"terminal.fontSize" must be a whole number from 9 to 28' } });
        expect((await api('PATCH', '/api/settings', { colour: 'red' })).status).toBe(400);
        expect((await api('PATCH', '/api/settings', [])).status).toBe(400);
        expect((await fetch(`${base}/api/settings`, { method: 'PATCH', body: '{}' })).status).toBe(401);
        expect((await api<SettingsState>('GET', '/api/settings')).body).toEqual(before);
    });

    it('opens the file in an editor, creating it first', async () => {
        const { status, body } = await api<{ path: string }>('POST', '/api/settings/open');
        expect(status).toBe(202);
        expect(opened).toEqual([body.path]);
        expect(existsSync(body.path)).toBe(true);
    });

    it('edits the file in a pane next to the focused one, which closes itself when the editor exits cleanly', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: state.projects[0].id, title: 'edit settings', panes: [{ adapter: 'shell' }] });
        const shellId = session.layout?.type === 'pane' ? session.layout.paneId : '';
        const layout = async (): Promise<Session['layout'] | undefined> => (await api<AppState>('GET', '/api/state')).body.sessions.find((entry) => entry.id === session.id)?.layout;
        const open = async (editor: string): Promise<{ pane: PaneView; output: () => string; close: () => void }> => {
            await api('PATCH', '/api/settings', { editor: { command: editor } });
            const { status, body: pane } = await api<PaneView>('POST', '/api/settings/edit', { sessionId: session.id, splitFrom: shellId });
            expect(status).toBe(201);
            let output = '';
            const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/panes/${pane.id}`, { headers: { Authorization: `Bearer ${daemon.token}` } });
            socket.on('message', (data, isBinary) => {
                if (isBinary) {
                    output += data.toString();
                }
            });
            await new Promise((resolveOpen) => socket.on('open', resolveOpen));
            socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
            return { pane, output: () => output, close: () => socket.close() };
        };

        const clean = await open('cat');
        expect(clean.pane).toMatchObject({ adapter: 'command', title: 'settings.json' });
        expect(await layout()).toEqual({ type: 'split', direction: 'horizontal', children: [{ type: 'pane', paneId: shellId }, { type: 'pane', paneId: clean.pane.id }], sizes: expect.any(Array) });
        await until(() => clean.output().includes('"command": "cat"'));
        await until(async () => (await api<AppState>('GET', '/api/state')).body.panes.every((pane) => pane.id !== clean.pane.id));
        expect(await layout()).toEqual({ type: 'pane', paneId: shellId });
        clean.close();

        const failed = await open('false');
        await until(async () => (await api<AppState>('GET', '/api/state')).body.panes.find((pane) => pane.id === failed.pane.id)?.status === 'exited');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await api<AppState>('GET', '/api/state')).body.panes.find((pane) => pane.id === failed.pane.id)).toMatchObject({ exitCode: 1 });
        failed.close();

        expect((await api('POST', '/api/settings/edit', { sessionId: 'unknown' })).status).toBe(404);
        expect((await fetch(`${base}/api/settings/edit`, { method: 'POST', body: JSON.stringify({ sessionId: session.id }) })).status).toBe(401);
        await api('PATCH', '/api/settings', { editor: { command: '' } });
        await api('DELETE', `/api/sessions/${session.id}`);
    });
});

describe('restart', () => {
    it('shuts the daemon down and asks for a successor', async () => {
        const restartPort = await freePort();
        const config = loadConfig({ VOLTRAN_HOME: join(home, 'restart'), VOLTRAN_PORT: String(restartPort) });
        let shutdownForRestart: boolean | null = null;
        const restarting = buildDaemon(config, {
            shell: '/bin/sh',
            path: '/usr/bin:/bin',
            baseEnv: process.env,
            onShutdown: (restart) => {
                shutdownForRestart = restart;
            },
        });
        await new Promise<void>((resolveListen) => restarting.server.listen(restartPort, '127.0.0.1', resolveListen));

        const response = await fetch(`http://127.0.0.1:${restartPort}/api/restart`, { method: 'POST', headers: { Authorization: `Bearer ${restarting.token}` } });
        expect(response.status).toBe(202);
        await until(() => shutdownForRestart !== null);
        expect(shutdownForRestart).toBe(true);
        expect(restarting.server.listening).toBe(false);
    });
});
