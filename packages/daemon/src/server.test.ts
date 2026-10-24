import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, MAX_WORKSPACE_PANES, paneIds, type AppState, type Layout, type NotesMeta, type PaneNotes, type PaneView, type ServerEvent, type Session, type SettingsState, type Workspace } from '@voltran/shared';
import { loadConfig } from './config.ts';
import { commandRunner } from './git.ts';
import { buildDaemon, type Daemon } from './main.ts';

// Stands in for the real CLI: runs the exact hook commands Voltran handed it through --settings,
// so the env plumbing and the per-pane secret are exercised end to end. With --notes-test it also
// starts a session and writes the pane's notes the way Claude's Write tool would; with --title-test it
// writes a transcript in which Claude has named the conversation and stops; with --usage-test it renders
// its status line with the account's usage limits.
const FAKE_CLAUDE = `#!/bin/sh
echo "fake claude $*"
settings=$2
hook() { node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.hooks[process.argv[2]][Number(process.argv[3])].hooks[0].command)' "$settings" "$1" "$2"; }
printf '{"session_id":"7e57c1a0-0000-4000-8000-000000000001","prompt":"hi from fake claude"}' | sh -c "$(hook UserPromptSubmit 0)"
case "$*" in *--notes-test*)
    sh -c "$(hook SessionStart 1)" < /dev/null
    call='{"session_id":"7e57c1a0-0000-4000-8000-000000000001","tool_name":"Write","tool_input":{"file_path":"'"$VOLTRAN_NOTES"'"}}'
    printf '%s' "$call" | sh -c "$(hook PreToolUse 0)"
    sleep 1
    printf 'agent progress\\n' > "$VOLTRAN_NOTES"
    printf '%s' "$call" | sh -c "$(hook PostToolUse 0)"
;; esac
case "$*" in *--title-test*)
    sid=11111111-2222-3333-4444-555555555555
    printf '{"type":"ai-title","aiTitle":"Fake conversation title","sessionId":"%s"}\\n' "$sid" > "$PWD/$sid.jsonl"
    printf '{"session_id":"%s","transcript_path":"%s"}' "$sid" "$PWD/$sid.jsonl" | sh -c "$(hook Stop 0)"
;; esac
case "$*" in *--usage-test*)
    line=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).statusLine.command)' "$settings")
    printf '{"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":4000000000}}}' | sh -c "$line"
;; esac
sleep 30
`;

// Loads the real Voltran plugin from the configuration Voltran passed and feeds it OpenCode events
// for the session it was told to open.
const FAKE_OPENCODE = `#!/bin/sh
echo "fake opencode $*"
exec node -e '
const { plugins } = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const session = process.argv[process.argv.indexOf("--session") + 1];
const events = [
    { type: "session.inbox.enqueued", data: { sessionID: session, item: { type: "user", payload: { text: "hi from fake opencode" } } } },
    { type: "permission.asked", data: { id: "per_1", sessionID: session, action: "shell", resources: ["ls"] } },
];
const subscribe = async function* () { yield* events; await new Promise(() => {}); };
import(plugins.at(-1) + "/index.ts").then((plugin) => plugin.default.setup({ event: { subscribe } }));
setTimeout(() => {}, 30000);
' -- "$@"
`;

// Runs the hook commands Voltran passed as -c overrides, the way Codex runs trusted hooks.
const FAKE_CODEX = `#!/bin/sh
echo "fake codex"
exec node -e '
const { execSync } = require("child_process");
const hooks = {};
for (const arg of process.argv) {
    const match = /^hooks\\.(\\w+)=.*command=("(?:[^"\\\\]|\\\\.)*")/.exec(arg);
    if (match) hooks[match[1]] = JSON.parse(match[2]);
}
const run = (event, payload) => execSync(hooks[event], { input: JSON.stringify(payload), shell: "/bin/sh" });
run("SessionStart", { session_id: "s1", hook_event_name: "SessionStart", source: "startup" });
run("UserPromptSubmit", { session_id: "s1", turn_id: "t1", prompt: "bump postgres" });
run("PermissionRequest", { session_id: "s1", turn_id: "t1", tool_name: "shell", tool_input: { description: "Run terraform plan" } });
setTimeout(() => run("Stop", { session_id: "s1", turn_id: "t1", last_assistant_message: "Plan is clean." }), 1500);
setTimeout(() => {}, 30000);
' -- "$@"
`;

let daemon: Daemon;
let base: string;
let home: string;
let port: number;
const opened: string[] = [];
const realGit = commandRunner(process.env);
const FAKE_PULL_REQUEST = JSON.stringify({
    number: 42,
    url: 'https://github.com/example/repo/pull/42',
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
});

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
    writeFileSync(join(fakeBin, 'opencode'), FAKE_OPENCODE);
    chmodSync(join(fakeBin, 'opencode'), 0o755);
    writeFileSync(join(fakeBin, 'codex'), FAKE_CODEX);
    chmodSync(join(fakeBin, 'codex'), 0o755);

    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = loadConfig({ VOLTRAN_HOME: join(home, 'data'), VOLTRAN_PORT: String(port) });
    daemon = buildDaemon(config, {
        shell: '/bin/sh',
        path: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        baseEnv: process.env,
        openFile: (path) => opened.push(path),
        gitRunner: (command, args, cwd) => (command === 'gh' ? Promise.resolve({ ok: true, stdout: FAKE_PULL_REQUEST }) : realGit(command, args, cwd)),
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
            const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${daemon.token}` } });
            socket.on('open', () => resolveOutcome('opened'));
            socket.on('error', (error) => resolveOutcome(error.message));
        });
        expect(outcome).toContain('403');
    });

    it('answers malformed URLs, escapes and cookies without going down', async () => {
        const raw = (method: string, path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolveStatus) => {
            httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
                response.resume();
                resolveStatus(response.statusCode ?? 0);
            }).end();
        });
        const upgrade = (path: string, headers: Record<string, string>): Promise<string> => new Promise((resolveOutcome) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
            socket.on('open', () => {
                socket.close();
                resolveOutcome('opened');
            });
            socket.on('error', (error) => resolveOutcome(error.message));
        });

        expect(await raw('GET', '//')).toBe(400);
        expect(await raw('GET', '/api/panes/%/notes', { Authorization: `Bearer ${daemon.token}` })).toBe(400);
        expect(await raw('POST', '/api/hooks/%/Stop', { Authorization: 'Bearer nope' })).toBe(400);
        expect(await upgrade('/ws/events', { Cookie: 'voltran_session=%' })).toContain('401');
        expect(await upgrade('/ws/panes/%', { Authorization: `Bearer ${daemon.token}` })).toContain('400');
        expect((await api('GET', '/api/health')).status).toBe(200);
    });

    it('keeps its home, database and token readable by the user alone', () => {
        const data = join(home, 'data');
        expect(statSync(data).mode & 0o777).toBe(0o700);
        expect(statSync(join(data, 'voltran.db')).mode & 0o777).toBe(0o600);
        expect(statSync(join(data, 'token')).mode & 0o777).toBe(0o600);
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

    it('signs a browser in with a one-time code, giving it a credential of its own and never a cookie', async () => {
        const page = await fetch(`${base}/auth?code=whatever`);
        expect(page.headers.get('set-cookie')).toBeNull();
        expect(page.status === 200 || page.status === 503).toBe(true);

        const { body } = await api<{ code: string }>('POST', '/api/login-code');
        const exchange = (code: string) => fetch(`${base}/api/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: base },
            body: JSON.stringify({ code }),
        });
        const first = await exchange(body.code);
        expect(first.status).toBe(200);
        expect(first.headers.get('set-cookie')).toBeNull();
        const { session } = await first.json() as { session: string };
        expect(session).not.toContain(daemon.token);

        expect((await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${session}` } })).status).toBe(200);
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, ['voltran', session], { headers: { Origin: base } });
        await new Promise((resolveMessage) => socket.once('message', resolveMessage));
        expect(socket.protocol).toBe('voltran');
        socket.close();

        expect((await exchange(body.code)).status).toBe(401);
        const { body: fresh } = await api<{ code: string }>('POST', '/api/login-code');
        const crossSite = await fetch(`${base}/api/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
            body: JSON.stringify({ code: fresh.code }),
        });
        expect(crossSite.status).toBe(403);
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

describe('workspaces', () => {
    const row = (...ids: string[]): Layout => ({ type: 'split', direction: 'horizontal', children: ids.map((paneId) => ({ type: 'pane', paneId })), sizes: ids.map(() => 100 / ids.length) });
    const workspaceOf = async (id: string): Promise<Workspace | undefined> => (await api<AppState>('GET', '/api/state')).body.workspaces.find((entry) => entry.id === id);

    it('shows panes of different projects side by side without taking them from their sessions', async () => {
        const { body: first } = await api<{ id: string }>('POST', '/api/projects', { path: mkdtempSync(join(home, 'workspace-a-')) });
        const { body: second } = await api<{ id: string }>('POST', '/api/projects', { path: mkdtempSync(join(home, 'workspace-b-')) });
        const { body: a } = await api<Session>('POST', '/api/sessions', { projectId: first.id, title: 'a', panes: [{ adapter: 'shell' }, { adapter: 'shell' }] });
        const { body: b } = await api<Session>('POST', '/api/sessions', { projectId: second.id, title: 'b', panes: [{ adapter: 'shell' }] });
        const [a1, a2] = paneIds(a.layout);
        const [b1] = paneIds(b.layout);

        const { status, body: created } = await api<Workspace>('POST', '/api/workspaces', { title: '  Review  ' });
        expect(status).toBe(201);
        expect(created).toMatchObject({ title: 'Review', layout: null });
        const { status: saved, body: updated } = await api<Workspace>('PATCH', `/api/workspaces/${created.id}`, { title: 'Release', layout: row(a1, b1, a2) });
        expect(saved).toBe(200);
        expect(updated).toMatchObject({ title: 'Release', layout: row(a1, b1, a2) });

        const { body: state } = await api<AppState>('GET', '/api/state');
        expect(state.workspaces.find((entry) => entry.id === created.id)?.layout).toEqual(row(a1, b1, a2));
        expect(paneIds(state.sessions.find((entry) => entry.id === a.id)?.layout ?? null)).toEqual([a1, a2]);
        expect(state.panes.find((pane) => pane.id === b1)?.sessionId).toBe(b.id);

        expect((await api('DELETE', `/api/workspaces/${created.id}`)).status).toBe(200);
        expect(await workspaceOf(created.id)).toBeUndefined();
        expect((await api<AppState>('GET', '/api/state')).body.panes.filter((pane) => [a1, a2, b1].includes(pane.id))).toHaveLength(3);
        for (const project of [first.id, second.id]) {
            await api('DELETE', `/api/projects/${project}`);
        }
    });

    it('refuses malformed layouts, unknown or repeated panes and too many panes', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: state.projects[0].id, title: 'limits', panes: [{ adapter: 'shell' }] });
        const [paneId] = paneIds(session.layout);
        const { body: workspace } = await api<Workspace>('POST', '/api/workspaces', { title: 'limits' });

        expect((await api('POST', '/api/workspaces', { title: '  ' })).status).toBe(400);
        expect((await api('PATCH', `/api/workspaces/${workspace.id}`, { layout: { type: 'split', children: [] } })).status).toBe(400);
        expect((await api('PATCH', `/api/workspaces/${workspace.id}`, { layout: row(paneId, paneId) })).status).toBe(400);
        expect((await api('PATCH', `/api/workspaces/${workspace.id}`, { layout: row(paneId, 'invented') })).status).toBe(409);
        const many = Array.from({ length: MAX_WORKSPACE_PANES + 1 }, (_, index) => `pane-${index}`);
        expect((await api('PATCH', `/api/workspaces/${workspace.id}`, { layout: row(...many) })).status).toBe(400);
        expect((await api('PATCH', '/api/workspaces/unknown', { title: 'x' })).status).toBe(404);
        expect((await fetch(`${base}/api/workspaces`, { method: 'POST', body: JSON.stringify({ title: 'x' }) })).status).toBe(401);
        expect((await workspaceOf(workspace.id))?.layout).toBeNull();

        await api('DELETE', `/api/workspaces/${workspace.id}`);
        await api('DELETE', `/api/sessions/${session.id}`);
    });

    it('splits a pane inside a workspace into its own session and the workspace at once', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: state.projects[0].id, title: 'split', panes: [{ adapter: 'shell' }] });
        const [source] = paneIds(session.layout);
        const { body: workspace } = await api<Workspace>('POST', '/api/workspaces', { title: 'split' });
        await api('PATCH', `/api/workspaces/${workspace.id}`, { layout: { type: 'pane', paneId: source } });

        const { status, body: pane } = await api<PaneView>('POST', `/api/sessions/${session.id}/panes`, { adapter: 'shell', splitFrom: source, direction: 'vertical', workspaceId: workspace.id });
        expect(status).toBe(201);
        expect(pane.sessionId).toBe(session.id);
        expect((await workspaceOf(workspace.id))?.layout).toEqual({ type: 'split', direction: 'vertical', children: [{ type: 'pane', paneId: source }, { type: 'pane', paneId: pane.id }], sizes: [50, 50] });
        expect(paneIds((await api<AppState>('GET', '/api/state')).body.sessions.find((entry) => entry.id === session.id)?.layout ?? null)).toEqual([source, pane.id]);

        const before = (await api<AppState>('GET', '/api/state')).body.panes.length;
        expect((await api('POST', `/api/sessions/${session.id}/panes`, { adapter: 'shell', workspaceId: 'unknown' })).status).toBe(404);
        expect((await api<AppState>('GET', '/api/state')).body.panes.length).toBe(before);

        await api('DELETE', `/api/workspaces/${workspace.id}`);
        await api('DELETE', `/api/sessions/${session.id}`);
    });

    it('drops a pane from every workspace when the pane, its session or its project goes away', async () => {
        const { body: project } = await api<{ id: string }>('POST', '/api/projects', { path: mkdtempSync(join(home, 'workspace-prune-')) });
        const { body: one } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'one', panes: [{ adapter: 'shell' }, { adapter: 'shell' }] });
        const { body: two } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'two', panes: [{ adapter: 'shell' }] });
        const { body: three } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'three', panes: [{ adapter: 'shell' }] });
        const [p1, p2] = paneIds(one.layout);
        const [p3] = paneIds(two.layout);
        const [p4] = paneIds(three.layout);
        const { body: left } = await api<Workspace>('POST', '/api/workspaces', { title: 'left' });
        const { body: right } = await api<Workspace>('POST', '/api/workspaces', { title: 'right' });
        await api('PATCH', `/api/workspaces/${left.id}`, { layout: row(p1, p2, p3, p4) });
        await api('PATCH', `/api/workspaces/${right.id}`, { layout: row(p3, p1) });

        await api('DELETE', `/api/panes/${p1}`);
        expect(paneIds((await workspaceOf(left.id))?.layout ?? null)).toEqual([p2, p3, p4]);
        expect((await workspaceOf(right.id))?.layout).toEqual({ type: 'pane', paneId: p3 });

        await api('DELETE', `/api/sessions/${two.id}`);
        expect(paneIds((await workspaceOf(left.id))?.layout ?? null)).toEqual([p2, p4]);
        expect((await workspaceOf(right.id))?.layout).toBeNull();

        await api('DELETE', `/api/projects/${project.id}`);
        expect((await workspaceOf(left.id))?.layout).toBeNull();

        await api('DELETE', `/api/workspaces/${left.id}`);
        await api('DELETE', `/api/workspaces/${right.id}`);
    });
});

describe('git status', () => {
    it('tells open windows the branch, changes and pull request of each session folder', async () => {
        const dir = mkdtempSync(join(home, 'git-project-'));
        const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
        execFileSync('git', ['init', '-b', 'feat/status'], { cwd: dir, stdio: 'ignore', env });
        execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'start'], { cwd: dir, stdio: 'ignore', env });
        writeFileSync(join(dir, 'notes.md'), 'draft\n');
        const { body: project } = await api<{ id: string }>('POST', '/api/projects', { path: dir });
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'git' });

        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        await new Promise((resolveOpen) => socket.on('open', resolveOpen));
        await until(async () => Boolean((await api<AppState>('GET', '/api/state')).body.git[session.cwd]));
        expect((await api<AppState>('GET', '/api/state')).body.git[session.cwd]).toEqual({
            branch: 'feat/status',
            commit: expect.stringMatching(/^[0-9a-f]{7}$/),
            upstream: null,
            ahead: 0,
            behind: 0,
            changed: 1,
            staged: 0,
            unstaged: 0,
            untracked: 1,
            conflicted: 0,
            pullRequest: { number: 42, url: 'https://github.com/example/repo/pull/42', state: 'open', checks: 'passing' },
        });

        socket.close();
        await api('DELETE', `/api/projects/${project.id}`);
    });

    it('starts a session in its own worktree and asks before deleting its changes', async () => {
        const dir = mkdtempSync(join(home, 'worktree-project-'));
        const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
        execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore', env });
        execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'start'], { cwd: dir, stdio: 'ignore', env });
        const { body: project } = await api<{ id: string }>('POST', '/api/projects', { name: 'Shop', path: dir });
        expect((await api('GET', `/api/projects/${project.id}/git`)).body).toEqual({ repository: true, branch: 'main', branches: ['main'] });

        const created = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'Cart', worktree: { branch: 'cart', base: 'main' } });
        expect(created.status).toBe(201);
        expect(created.body.worktree).toBe(join(home, 'data', 'worktrees', 'shop', 'cart'));
        expect(created.body.cwd).toBe(created.body.worktree);
        expect((await api('POST', '/api/sessions', { projectId: project.id, title: 'Again', worktree: { branch: 'cart' } })).status).toBe(409);

        writeFileSync(join(created.body.cwd, 'cart.ts'), 'export {};\n');
        expect((await api('DELETE', `/api/sessions/${created.body.id}?worktree=maybe`)).status).toBe(400);
        expect(await api('DELETE', `/api/sessions/${created.body.id}`)).toEqual({ status: 409, body: { error: 'its worktree has 1 uncommitted change' } });
        expect((await api('DELETE', `/api/sessions/${created.body.id}?worktree=remove`)).status).toBe(200);
        expect(existsSync(created.body.worktree!)).toBe(false);
        await api('DELETE', `/api/projects/${project.id}`);
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

        expect(await pane()).toMatchObject({ title: 'Claude Code', detail: 'hi from fake claude', agentSessionId: '7e57c1a0-0000-4000-8000-000000000001', agentResumable: true });
        expect(output).toMatch(/fake claude --settings \{"hooks":.*\} --session-id [0-9a-f-]{36} --plugin-dir \.\/a b/);

        const forged = await fetch(`${base}/api/hooks/${paneId}/Stop`, { method: 'POST', headers: { Authorization: `Bearer ${daemon.token}` }, body: '{}' });
        expect(forged.status).toBe(403);
        const header = join(home, 'data', 'hooks', paneId);
        expect(statSync(header).mode & 0o777).toBe(0o600);
        expect(output).not.toMatch(/[0-9a-f]{48}/);

        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
        expect(existsSync(header)).toBe(false);
        const scrollback = join(home, 'data', 'scrollback');
        expect(existsSync(scrollback) ? readdirSync(scrollback).filter((file) => file.startsWith(paneId)) : []).toEqual([]);
    });

    it('report the account\'s usage limits from Claude\'s status line and still show the user\'s own', async () => {
        const dir = mkdtempSync(join(home, 'usage-'));
        mkdirSync(join(dir, '.claude'));
        writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'printf "own status line"' } }));
        const { body: project } = await api<{ id: string }>('POST', '/api/projects', { path: dir });
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'usage', panes: [{ adapter: 'claude', command: '--usage-test' }] });
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

        await until(async () => (await api<AppState>('GET', '/api/state')).body.usage !== null);
        expect((await api<AppState>('GET', '/api/state')).body.usage).toEqual({ fiveHour: { usedPercent: 42, resetsAt: 4_000_000_000_000 }, sevenDay: null });
        await until(async () => output.includes('own status line'));

        const forged = await fetch(`${base}/api/hooks/${paneId}/StatusLine`, {
            method: 'POST',
            headers: { Authorization: 'Bearer not-the-secret' },
            body: '{"rate_limits":{"five_hour":{"used_percentage":99,"resets_at":4000000000}}}',
        });
        expect(forged.status).toBe(403);
        expect((await api<AppState>('GET', '/api/state')).body.usage?.fiveHour?.usedPercent).toBe(42);

        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
    });

    it('names a session started without a title from its agents, until the user renames it', async () => {
        const { body: project } = await api<{ id: string }>('POST', '/api/projects', { path: mkdtempSync(join(home, 'naming-')) });
        const refused = await api<{ error: string }>('POST', '/api/sessions', { projectId: project.id, panes: [{ adapter: 'shell' }] });
        expect(refused.status).toBe(400);

        const start = async (adapter: 'claude' | 'codex', command?: string): Promise<{ session: Session; socket: WebSocket }> => {
            const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: '  ', panes: [{ adapter, command }] });
            const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/panes/${paneIds(session.layout)[0]}`, { headers: { Authorization: `Bearer ${daemon.token}` } });
            await new Promise((resolveOpen) => socket.on('open', resolveOpen));
            socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
            return { session, socket };
        };
        const titleOf = async (id: string): Promise<Pick<Session, 'title' | 'titleSource'> | undefined> => {
            const session = (await api<AppState>('GET', '/api/state')).body.sessions.find((entry) => entry.id === id);
            return session && { title: session.title, titleSource: session.titleSource };
        };

        const claude = await start('claude', '--title-test');
        expect(claude.session).toMatchObject({ title: 'New session', titleSource: 'pending' });
        await until(async () => (await titleOf(claude.session.id))?.titleSource === 'agent');
        expect(await titleOf(claude.session.id)).toEqual({ title: 'Fake conversation title', titleSource: 'agent' });

        const codex = await start('codex');
        await until(async () => (await titleOf(codex.session.id))?.titleSource === 'prompt');
        expect(await titleOf(codex.session.id)).toEqual({ title: 'bump postgres', titleSource: 'prompt' });
        await api('PATCH', `/api/sessions/${codex.session.id}`, { title: 'Postgres upgrade' });
        expect(await titleOf(codex.session.id)).toEqual({ title: 'Postgres upgrade', titleSource: 'user' });

        for (const { session, socket } of [claude, codex]) {
            socket.close();
            await api('DELETE', `/api/sessions/${session.id}`);
        }
    });

    it('give Claude the pane notes and hold them while Claude edits them', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', {
            projectId: state.projects[0].id,
            title: 'notes hooks',
            panes: [{ adapter: 'claude', command: '--notes-test' }],
        });
        const [paneId] = paneIds(session.layout);
        const notesFile = join(home, 'data', 'notes', paneId, 'notes.md');

        let output = '';
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/panes/${paneId}`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                output += data.toString();
            }
        });
        await new Promise((resolveOpen) => socket.on('open', resolveOpen));
        socket.send(JSON.stringify({ type: 'resize', cols: 200, rows: 40 }));

        const meta = async (): Promise<NotesMeta | undefined> => (await api<AppState>('GET', '/api/state')).body.panes.find((pane) => pane.id === paneId)?.notes;
        await until(async () => (await meta())?.lock === 'agent');
        const { body: shown } = await api<PaneNotes>('GET', `/api/panes/${paneId}/notes`);
        expect((await api('POST', `/api/panes/${paneId}/notes/lock`, { holder: 'window-cccc', version: shown.version })).status).toBe(409);

        await until(async () => {
            const notes = await meta();
            return notes?.updatedBy === 'agent' && notes.lock === null;
        });
        expect((await meta())?.size).toBe(15);
        expect((await api<PaneNotes>('GET', `/api/panes/${paneId}/notes`)).body.content).toBe('agent progress\n');
        await until(() => output.replace(/\s+/g, ' ').includes(`Notes file: ${notesFile}`));
        expect(output).toContain('# Voltran pane notes');
        expect(output).not.toContain('Voltran did not answer');
        expect((await fetch(`${base}/api/hooks/${paneId}/notes`)).status).toBe(401);
        expect((await fetch(`${base}/api/hooks/${paneId}/notes`, { headers: { Authorization: `Bearer ${daemon.token}` } })).status).toBe(403);

        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
    });

    it('track Codex status through the hooks Voltran passes it, once they report', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: state.projects[0].id, title: 'codex', panes: [{ adapter: 'codex' }] });
        const paneId = session.layout?.type === 'pane' ? session.layout.paneId : '';
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/panes/${paneId}`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        await new Promise((resolveOpen) => socket.on('open', resolveOpen));
        socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

        const pane = async (): Promise<PaneView | undefined> => (await api<AppState>('GET', '/api/state')).body.panes.find((entry) => entry.id === paneId);
        await until(async () => (await pane())?.status === 'needs-input');
        expect(await pane()).toMatchObject({ status: 'needs-input', detail: 'Run terraform plan' });
        await until(async () => (await pane())?.status === 'done');
        expect(await pane()).toMatchObject({ status: 'done', detail: 'Plan is clean.' });

        const forged = await fetch(`${base}/api/hooks/${paneId}/Stop`, { method: 'POST', headers: { Authorization: `Bearer ${daemon.token}` }, body: '{}' });
        expect(forged.status).toBe(403);
        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
    });

    it('track OpenCode status through the plugin Voltran adds to its own server', async () => {
        const { body: state } = await api<AppState>('GET', '/api/state');
        const projectId = state.projects[0].id;
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'opencode', command: '--session ses_x' }] })).status).toBe(400);
        expect((await api('POST', '/api/sessions', { projectId, title: 'x', panes: [{ adapter: 'opencode', command: 'run hi' }] })).status).toBe(400);
        const { body: session } = await api<Session>('POST', '/api/sessions', {
            projectId,
            title: 'opencode',
            panes: [{ adapter: 'opencode', command: "--model 'a b'" }],
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
        await until(async () => (await pane())?.status === 'needs-input');

        const view = await pane();
        expect(view).toMatchObject({ title: 'OpenCode', detail: 'Allow shell: ls', agentResumable: true });
        expect(view?.agentSessionId).toMatch(/^ses_voltran[0-9a-f]{24}$/);
        expect(output).toContain(`fake opencode --standalone --session ${view?.agentSessionId} --model a b`);

        const forged = await fetch(`${base}/api/hooks/${paneId}/TurnEnd`, { method: 'POST', headers: { Authorization: `Bearer ${daemon.token}` }, body: '{}' });
        expect(forged.status).toBe(403);

        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
    });
});

describe('notes', () => {
    it('keeps a note per pane that only the window holding the lock can save, and tells every window', async () => {
        const { body: project } = await api<{ id: string }>('POST', '/api/projects', { path: mkdtempSync(join(home, 'notes-')) });
        const { body: session } = await api<Session>('POST', '/api/sessions', { projectId: project.id, title: 'notes', panes: [{ adapter: 'shell' }] });
        const [paneId] = paneIds(session.layout);
        const events: ServerEvent[] = [];
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { Authorization: `Bearer ${daemon.token}` } });
        socket.on('message', (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
        await new Promise((resolveOpen) => socket.on('open', resolveOpen));
        const meta = async (): Promise<NotesMeta | undefined> => (await api<AppState>('GET', '/api/state')).body.panes.find((pane) => pane.id === paneId)?.notes;

        const { body: empty } = await api<PaneNotes>('GET', `/api/panes/${paneId}/notes`);
        expect(empty.content).toBe('');
        expect((await api('PUT', `/api/panes/${paneId}/notes`, { content: 'x', version: empty.version, holder: 'window-aaaa' })).status).toBe(409);
        expect((await api('POST', `/api/panes/${paneId}/notes/lock`, { holder: '../x', version: empty.version })).status).toBe(400);

        const locked = await api<NotesMeta>('POST', `/api/panes/${paneId}/notes/lock`, { holder: 'window-aaaa', version: empty.version });
        expect(locked).toMatchObject({ status: 200, body: { lock: 'user', holder: 'window-aaaa' } });
        expect((await api('POST', `/api/panes/${paneId}/notes/lock`, { holder: 'window-bbbb', version: empty.version })).status).toBe(409);

        const saved = await api<PaneNotes>('PUT', `/api/panes/${paneId}/notes`, { content: '# Plan\n', version: empty.version, holder: 'window-aaaa' });
        expect(saved).toMatchObject({ status: 200, body: { content: '# Plan\n' } });
        await until(() => events.some((event) => event.type === 'notes' && event.paneId === paneId && event.content === '# Plan\n'));
        await until(async () => (await meta())?.size === 7);
        expect(await meta()).toMatchObject({ updatedBy: 'user', lock: 'user', holder: 'window-aaaa' });
        expect((await api('PUT', `/api/panes/${paneId}/notes`, { content: 'old', version: empty.version, holder: 'window-aaaa' })).status).toBe(409);

        await api('POST', `/api/panes/${paneId}/notes/unlock`, { holder: 'window-aaaa' });
        await until(async () => (await meta())?.lock === null);
        expect((await api<PaneNotes>('GET', `/api/panes/${paneId}/notes`)).body).toEqual(saved.body);
        expect((await api('GET', '/api/panes/missing/notes')).status).toBe(404);

        socket.close();
        await api('DELETE', `/api/sessions/${session.id}`);
        expect(existsSync(join(home, 'data', 'notes', paneId))).toBe(false);
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
