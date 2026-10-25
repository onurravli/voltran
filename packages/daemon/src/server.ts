import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
    MAX_ATTACHMENT_BYTES,
    PREVIEW_FRAME_SOURCES,
    parseSettingsPatch,
    type Diagnostics,
    type EditSettingsBody,
    type PaneClientMessage,
    type ServerEvent,
} from '@voltran/shared';
import { voltranVersion, writeNewToken, type Config } from './config.ts';
import { HttpError, type Hub } from './hub.ts';
import { bearerToken, WS_PROTOCOL, type Guard } from './security.ts';
import { editorCommand, type SettingsFile } from './settings.ts';
import type { VersionWatch } from './version.ts';

const JSON_LIMIT = 1024 * 1024;
const HOOK_LIMIT = 4 * 1024 * 1024;
const WS_MAX_PAYLOAD = 1024 * 1024;
const SLOW_CLIENT_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.webmanifest': 'application/manifest+json',
};

// Cross-Origin-Resource-Policy keeps other sites from loading even the UI's files, which would tell
// them Voltran runs here.
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
};

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;

// The page holds a credential that can run commands, so it runs no script but its own files and the
// inline scripts index.html carries, by hash. xterm adds <style> elements, so styles may be inline.
export function contentSecurityPolicy(html: string): string {
    const hashes = [...html.matchAll(INLINE_SCRIPT)].map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
    return [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        `frame-src ${PREVIEW_FRAME_SOURCES.join(' ')}`,
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; ');
}

export interface ServerOptions {
    config: Config;
    hub: Hub;
    guard: Guard;
    settings: SettingsFile;
    previousWindows: number;
    version?: VersionWatch;
    env: NodeJS.ProcessEnv;
    openFile: (path: string) => void;
    onShutdown: () => void;
    onRestart: () => void;
    diagnose?: () => Promise<Diagnostics>;
}

const VERSION_POLL_MS = 2000;

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

interface Route {
    method: string;
    pattern: RegExp;
    handler: Handler;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
    res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
    return (await readBytes(req, limit)).toString('utf8');
}

function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                reject(new HttpError(413, 'request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolveBody(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function requestUrl(req: IncomingMessage): URL {
    try {
        return new URL(req.url ?? '/', 'http://localhost');
    } catch {
        throw new HttpError(400, 'malformed request URL');
    }
}

async function readJson<T>(req: IncomingMessage, limit = JSON_LIMIT): Promise<T> {
    const raw = await readBody(req, limit);
    if (!raw) {
        return {} as T;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new HttpError(400, 'request body is not valid JSON');
    }
}

export function openInEditor(path: string): void {
    const opener = process.platform === 'darwin' ? ['open', '-t', path] : process.platform === 'win32' ? null : ['xdg-open', path];
    if (!opener) {
        return;
    }
    const child = spawn(opener[0], opener.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
}

export function createVoltranServer(options: ServerOptions): Server {
    const { config, hub, guard, settings } = options;

    const routes: Route[] = [];
    const route = (method: string, path: string, handler: Handler): void => {
        const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
        routes.push({ method, pattern, handler });
    };

    route('GET', '/api/health', (_req, res) => sendJson(res, 200, { ok: true, pid: process.pid, version: voltranVersion() }));
    route('GET', '/api/diagnostics', async (_req, res) => {
        if (!options.diagnose) {
            throw new HttpError(404, 'diagnostics are not available');
        }
        sendJson(res, 200, await options.diagnose());
    });
    route('GET', '/api/state', (_req, res) => sendJson(res, 200, hub.state()));
    route('POST', '/api/login-code', (_req, res) => sendJson(res, 200, { code: guard.issueLoginCode() }));
    route('GET', '/api/windows', (_req, res) => sendJson(res, 200, { open: hub.openWindows(), previous: options.previousWindows }));
    route('POST', '/api/shutdown', (_req, res) => {
        sendJson(res, 202, { ok: true });
        setImmediate(options.onShutdown);
    });
    route('POST', '/api/restart', (_req, res) => {
        sendJson(res, 202, { ok: true });
        setImmediate(options.onRestart);
    });
    // A window renews its credential when it loads and every few hours, so only one left unused lapses.
    route('POST', '/api/session/renew', (req, res) => {
        if (!guard.isBrowserSession(bearerToken(req))) {
            throw new HttpError(400, 'only a browser credential is renewed');
        }
        sendJson(res, 200, { session: guard.issueBrowserSession() });
    });
    route('POST', '/api/signout', (_req, res) => {
        guard.rotate(writeNewToken(config));
        sendJson(res, 200, { ok: true });
        closeSockets();
    });

    route('GET', '/api/settings', (_req, res) => sendJson(res, 200, settings.state()));
    route('PATCH', '/api/settings', async (req, res) => {
        const { patch, problems } = parseSettingsPatch(await readJson(req));
        if (problems.length > 0) {
            throw new HttpError(400, problems.join('; '));
        }
        sendJson(res, 200, settings.update(patch));
    });
    route('POST', '/api/settings/open', (_req, res) => {
        settings.create();
        options.openFile(settings.path);
        sendJson(res, 202, { path: settings.path });
    });
    route('POST', '/api/settings/edit', async (req, res) => {
        const body = await readJson<EditSettingsBody | null>(req);
        const pane = hub.createPane(
            String(body?.sessionId),
            {
                adapter: 'command',
                title: 'settings.json',
                command: editorCommand(settings.state().settings.editor.command, settings.path, options.env),
                splitFrom: typeof body?.splitFrom === 'string' ? body.splitFrom : undefined,
                direction: 'horizontal',
            },
            { closeOnCleanExit: true },
        );
        settings.create();
        sendJson(res, 201, pane);
    });

    route('POST', '/api/projects', async (req, res) => sendJson(res, 201, hub.createProject(await readJson(req))));
    route('PATCH', '/api/projects/:id', async (req, res, [id]) => sendJson(res, 200, hub.updateProject(id, await readJson(req))));
    route('GET', '/api/projects/:id/git', async (_req, res, [id]) => sendJson(res, 200, await hub.projectGit(id)));
    route('DELETE', '/api/projects/:id', async (_req, res, [id]) => {
        await hub.deleteProject(id);
        sendJson(res, 200, { ok: true });
    });

    route('POST', '/api/sessions', async (req, res) => sendJson(res, 201, await hub.createSession(await readJson(req))));
    route('PATCH', '/api/sessions/:id', async (req, res, [id]) => sendJson(res, 200, hub.updateSession(id, await readJson(req))));
    route('DELETE', '/api/sessions/:id', async (req, res, [id]) => {
        const worktree = requestUrl(req).searchParams.get('worktree');
        if (worktree !== null && worktree !== 'keep' && worktree !== 'remove') {
            throw new HttpError(400, 'worktree must be "keep" or "remove"');
        }
        await hub.deleteSession(id, worktree);
        sendJson(res, 200, { ok: true });
    });
    route('GET', '/api/sessions/:id/changes', async (_req, res, [id]) => sendJson(res, 200, await hub.sessionChanges(id)));
    route('GET', '/api/sessions/:id/contents', async (req, res, [id]) =>
        sendJson(res, 200, await hub.sessionFileContents(id, requestUrl(req).searchParams.get('path') ?? '')),
    );
    route('POST', '/api/sessions/:id/reveal', (_req, res, [id]) => {
        hub.revealSession(id);
        sendJson(res, 200, { ok: true });
    });
    route('POST', '/api/sessions/:id/panes', async (req, res, [id]) => sendJson(res, 201, hub.createPane(id, await readJson(req))));

    route('POST', '/api/workspaces', async (req, res) => sendJson(res, 201, hub.createWorkspace(await readJson(req))));
    route('PATCH', '/api/workspaces/:id', async (req, res, [id]) => sendJson(res, 200, hub.updateWorkspace(id, await readJson(req))));
    route('DELETE', '/api/workspaces/:id', (_req, res, [id]) => {
        hub.deleteWorkspace(id);
        sendJson(res, 200, { ok: true });
    });

    route('PATCH', '/api/panes/:id', async (req, res, [id]) => sendJson(res, 200, hub.updatePane(id, await readJson(req))));
    route('POST', '/api/panes/:id/move', async (req, res, [id]) => sendJson(res, 200, hub.movePane(id, await readJson(req))));
    route('DELETE', '/api/panes/:id', (_req, res, [id]) => {
        hub.deletePane(id);
        sendJson(res, 200, { ok: true });
    });
    route('POST', '/api/panes/:id/restart', (_req, res, [id]) => {
        hub.restartPane(id);
        sendJson(res, 200, { ok: true });
    });
    route('POST', '/api/panes/:id/kill', (_req, res, [id]) => {
        hub.killPane(id);
        sendJson(res, 200, { ok: true });
    });
    route('POST', '/api/panes/:id/subagents/:agent/view', (_req, res, [id, agent]) => sendJson(res, 200, hub.viewSubagent(id, agent)));
    route('POST', '/api/panes/:id/seen', (_req, res, [id]) => {
        hub.seenPane(id);
        sendJson(res, 200, { ok: true });
    });
    route('GET', '/api/panes/:id/conversation', (req, res, [id]) => {
        const params = requestUrl(req).searchParams;
        sendJson(res, 200, hub.paneConversation(id, params.get('source'), Number(params.get('from') ?? 0)));
    });
    route('GET', '/api/panes/:id/commands', (_req, res, [id]) => sendJson(res, 200, hub.paneCommands(id)));
    route('POST', '/api/panes/:id/attachments', async (req, res, [id]) =>
        sendJson(res, 201, hub.attach(id, await readBytes(req, MAX_ATTACHMENT_BYTES))),
    );
    route('GET', '/api/panes/:id/notes', (_req, res, [id]) => sendJson(res, 200, hub.paneNotes(id)));
    route('PUT', '/api/panes/:id/notes', async (req, res, [id]) => sendJson(res, 200, hub.saveNotes(id, await readJson(req))));
    route('POST', '/api/panes/:id/notes/lock', async (req, res, [id]) => sendJson(res, 200, hub.lockNotes(id, await readJson(req))));
    route('POST', '/api/panes/:id/notes/unlock', async (req, res, [id]) => {
        hub.unlockNotes(id, await readJson(req));
        sendJson(res, 200, { ok: true });
    });

    const hookPattern = /^\/api\/hooks\/([^/]+)\/([A-Za-z]+)$/;
    const hookNotesPattern = /^\/api\/hooks\/([^/]+)\/notes$/;

    const handleHook = async (req: IncomingMessage, res: ServerResponse, paneId: string, event: string): Promise<void> => {
        const secret = bearerToken(req);
        if (!secret) {
            sendJson(res, 401, { error: 'missing hook secret' });
            return;
        }
        const payload = await readJson<unknown>(req, HOOK_LIMIT);
        const accepted = hub.hook(decodeURIComponent(paneId), event, secret, payload);
        sendJson(res, accepted ? 200 : 403, accepted ? { ok: true } : { error: 'hook refused' });
    };

    const handleHookNotes = (req: IncomingMessage, res: ServerResponse, paneId: string): void => {
        const secret = bearerToken(req);
        const notes = secret ? hub.hookNotes(decodeURIComponent(paneId), secret) : null;
        if (notes === null) {
            sendJson(res, secret ? 403 : 401, { error: secret ? 'hook refused' : 'missing hook secret' });
            return;
        }
        sendText(res, 200, notes);
    };

    const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
        const index = join(config.webDist, 'index.html');
        if (!existsSync(index)) {
            sendText(res, 503, 'Voltran UI is not built. Run `npm run build` in the voltran repo, or use `npm run dev:web`.');
            return;
        }
        const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
        const candidate = join(config.webDist, relative);
        const insideDist = candidate === config.webDist || candidate.startsWith(config.webDist + sep);
        const file = insideDist && relative && existsSync(candidate) && statSync(candidate).isFile() ? candidate : index;
        const type = MIME[extname(file)] ?? 'application/octet-stream';
        const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': type };
        if (file !== index && relative.startsWith('assets/')) {
            headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        }
        const body = readFileSync(file);
        if (file === index) {
            headers['Content-Security-Policy'] = contentSecurityPolicy(body.toString('utf8'));
        }
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
    };

    const server = createServer(async (req, res) => {
        try {
            const { pathname } = requestUrl(req);
            const hookMatch = req.method === 'POST' ? pathname.match(hookPattern) : null;
            const hookNotesMatch = req.method === 'GET' ? pathname.match(hookNotesPattern) : null;
            if (hookMatch || hookNotesMatch) {
                const verdict = guard.checkRequest(req, { allowAnonymous: true });
                if (!verdict.ok) {
                    sendJson(res, verdict.status, { error: verdict.reason });
                    return;
                }
                if (hookMatch) {
                    await handleHook(req, res, hookMatch[1], hookMatch[2]);
                } else {
                    handleHookNotes(req, res, hookNotesMatch![1]);
                }
                return;
            }

            // The UI's files hold nothing secret, so a window loads them before it is signed in; the
            // page at /auth?code=… then trades the one-time code for its own credential.
            if (!pathname.startsWith('/api/')) {
                const verdict = guard.checkRequest(req, { allowAnonymous: true });
                if (!verdict.ok) {
                    sendText(res, verdict.status, verdict.reason);
                    return;
                }
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    sendJson(res, 405, { error: 'method not allowed' });
                    return;
                }
                serveStatic(req, res, pathname);
                return;
            }

            if (pathname === '/api/session' && req.method === 'POST') {
                const verdict = guard.checkRequest(req, { allowAnonymous: true });
                if (!verdict.ok) {
                    sendJson(res, verdict.status, { error: verdict.reason });
                    return;
                }
                const body = await readJson<{ code?: unknown } | null>(req);
                if (!guard.redeemLoginCode(typeof body?.code === 'string' ? body.code : '')) {
                    sendJson(res, 401, { error: 'this sign-in link has expired or was used already' });
                    return;
                }
                sendJson(res, 200, { session: guard.issueBrowserSession() });
                return;
            }

            const verdict = guard.checkRequest(req);
            if (!verdict.ok) {
                sendJson(res, verdict.status, { error: verdict.reason });
                return;
            }
            for (const entry of routes) {
                if (entry.method !== req.method) {
                    continue;
                }
                const match = pathname.match(entry.pattern);
                if (match) {
                    await entry.handler(req, res, match.slice(1).map(decodeURIComponent));
                    return;
                }
            }
            sendJson(res, 404, { error: 'not found' });
        } catch (error) {
            if (res.headersSent) {
                res.end();
                return;
            }
            if (error instanceof HttpError) {
                sendJson(res, error.status, { error: error.message });
                return;
            }
            if (error instanceof URIError) {
                sendJson(res, 400, { error: 'malformed request URL' });
                return;
            }
            console.error('[voltran] request failed:', error);
            sendJson(res, 500, { error: 'internal error' });
        }
    });

    const closeSockets = attachWebSockets(server, hub, guard, settings, options.version);
    const version = options.version;
    if (version) {
        const poll = setInterval(() => {
            if (version.refresh()) {
                hub.publish({ type: 'version', ...version.current() });
            }
        }, VERSION_POLL_MS);
        poll.unref();
        server.on('close', () => clearInterval(poll));
    }
    return server;
}

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

// Returns what closes every open socket, for when the credentials they were opened with stop working.
function attachWebSockets(server: Server, hub: Hub, guard: Guard, settings: SettingsFile, version: VersionWatch | undefined): () => void {
    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: WS_MAX_PAYLOAD,
        handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    });
    const alive = new WeakMap<WebSocket, boolean>();

    const heartbeat = setInterval(() => {
        for (const client of wss.clients) {
            if (alive.get(client) === false) {
                client.terminate();
                continue;
            }
            alive.set(client, false);
            client.ping();
        }
    }, HEARTBEAT_MS);
    server.on('close', () => clearInterval(heartbeat));

    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const verdict = guard.checkRequest(req);
        if (!verdict.ok) {
            refuseUpgrade(socket, verdict.status, verdict.reason);
            return;
        }
        const pathname = requestUrl(req).pathname;
        const paneMatch = pathname.match(/^\/ws\/panes\/([^/]+)$/);
        const paneId = paneMatch ? decodeURIComponent(paneMatch[1]) : null;

        if (pathname !== '/ws/events' && paneId === null) {
            refuseUpgrade(socket, 404, 'Not Found');
            return;
        }
        if (paneId !== null && !hub.panes.has(paneId)) {
            refuseUpgrade(socket, 404, 'Not Found');
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            alive.set(ws, true);
            ws.on('pong', () => alive.set(ws, true));
            if (paneId !== null) {
                servePane(ws, hub, paneId);
            } else {
                serveEvents(ws, hub, settings, version);
            }
        });
    };

    // Nothing that arrives with an upgrade request may throw out of this listener: the daemon would
    // exit and take every pane with it.
    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => socket.destroy());
        try {
            upgrade(req, socket, head);
        } catch {
            refuseUpgrade(socket, 400, 'Bad Request');
        }
    });
    return () => {
        for (const client of wss.clients) {
            client.close(4401, 'signed out');
        }
    };
}

function serveEvents(ws: WebSocket, hub: Hub, settings: SettingsFile, version: VersionWatch | undefined): void {
    const send = (event: ServerEvent): void => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
        }
    };
    send({ type: 'settings', ...settings.state() });
    send({ type: 'state', state: hub.state() });
    if (version) {
        send({ type: 'version', ...version.current() });
    }
    const unsubscribe = hub.subscribe(send);
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
}

function parseClientMessage(data: RawData): PaneClientMessage | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(data.toString());
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === 'input' && typeof message.data === 'string') {
        return { type: 'input', data: message.data };
    }
    if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
        return { type: 'resize', cols: message.cols, rows: message.rows };
    }
    return null;
}

function servePane(ws: WebSocket, hub: Hub, paneId: string): void {
    const detach = hub.panes.attach(paneId, {
        sendText: (text) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(text);
            }
        },
        sendBinary: (data) => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            if (ws.bufferedAmount > SLOW_CLIENT_BYTES) {
                ws.close(4000, 'client too slow; reconnect for a fresh snapshot');
                return;
            }
            ws.send(data, { binary: true });
        },
        close: (code, reason) => ws.close(code, reason),
    });
    if (!detach) {
        ws.close(4404, 'pane not found');
        return;
    }

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            return;
        }
        const message = parseClientMessage(data);
        if (!message) {
            return;
        }
        if (message.type === 'input') {
            hub.panes.input(paneId, message.data);
        } else {
            hub.panes.resize(paneId, message.cols, message.rows);
        }
    });
    ws.on('close', detach);
    ws.on('error', detach);
}
