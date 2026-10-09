import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { PaneClientMessage, ServerEvent } from '@voltran/shared';
import type { Config } from './config.ts';
import { HttpError, type Hub } from './hub.ts';
import { bearerToken, type Guard } from './security.ts';

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

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
};

export interface ServerOptions {
    config: Config;
    hub: Hub;
    guard: Guard;
    onShutdown: () => void;
}

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

function readBody(req: IncomingMessage, limit: number): Promise<string> {
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
        req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
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

const UNAUTHENTICATED_PAGE = `<!doctype html><meta charset="utf-8"><title>Voltran</title>
<body style="font:15px system-ui;background:#0d0f14;color:#c8cdd8;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:600;letter-spacing:.2em">VOLTRAN</h1>
<p>This browser is not signed in. Run <code style="background:#1a1e27;padding:2px 6px;border-radius:4px">voltran up</code> in a terminal to open it.</p></div>`;

export function createVoltranServer(options: ServerOptions): Server {
    const { config, hub, guard } = options;

    const routes: Route[] = [];
    const route = (method: string, path: string, handler: Handler): void => {
        const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
        routes.push({ method, pattern, handler });
    };

    route('GET', '/api/health', (_req, res) => sendJson(res, 200, { ok: true, pid: process.pid, version: '0.1.0' }));
    route('GET', '/api/state', (_req, res) => sendJson(res, 200, hub.state()));
    route('POST', '/api/login-code', (_req, res) => sendJson(res, 200, { code: guard.issueLoginCode() }));
    route('POST', '/api/shutdown', (_req, res) => {
        sendJson(res, 202, { ok: true });
        setImmediate(options.onShutdown);
    });

    route('POST', '/api/projects', async (req, res) => sendJson(res, 201, hub.createProject(await readJson(req))));
    route('PATCH', '/api/projects/:id', async (req, res, [id]) => sendJson(res, 200, hub.updateProject(id, await readJson(req))));
    route('DELETE', '/api/projects/:id', (_req, res, [id]) => {
        hub.deleteProject(id);
        sendJson(res, 200, { ok: true });
    });

    route('POST', '/api/sessions', async (req, res) => sendJson(res, 201, hub.createSession(await readJson(req))));
    route('PATCH', '/api/sessions/:id', async (req, res, [id]) => sendJson(res, 200, hub.updateSession(id, await readJson(req))));
    route('DELETE', '/api/sessions/:id', (_req, res, [id]) => {
        hub.deleteSession(id);
        sendJson(res, 200, { ok: true });
    });
    route('POST', '/api/sessions/:id/panes', async (req, res, [id]) => sendJson(res, 201, hub.createPane(id, await readJson(req))));

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

    const hookPattern = /^\/api\/hooks\/([^/]+)\/([A-Za-z]+)$/;

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
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    };

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;

        try {
            const hookMatch = req.method === 'POST' ? pathname.match(hookPattern) : null;
            if (hookMatch) {
                const verdict = guard.checkRequest(req, { allowAnonymous: true });
                if (!verdict.ok) {
                    sendJson(res, verdict.status, { error: verdict.reason });
                    return;
                }
                await handleHook(req, res, hookMatch[1], hookMatch[2]);
                return;
            }

            if (pathname === '/auth') {
                const verdict = guard.checkRequest(req, { allowAnonymous: true });
                if (!verdict.ok) {
                    sendText(res, verdict.status, verdict.reason);
                    return;
                }
                const code = url.searchParams.get('code') ?? '';
                if (!guard.redeemLoginCode(code)) {
                    sendText(res, 401, UNAUTHENTICATED_PAGE, 'text/html; charset=utf-8');
                    return;
                }
                res.writeHead(302, { ...SECURITY_HEADERS, 'Set-Cookie': guard.sessionCookie(), Location: '/' });
                res.end();
                return;
            }

            const verdict = guard.checkRequest(req);
            if (!verdict.ok) {
                if (verdict.status === 401 && !pathname.startsWith('/api/')) {
                    sendText(res, 401, UNAUTHENTICATED_PAGE, 'text/html; charset=utf-8');
                } else {
                    sendJson(res, verdict.status, { error: verdict.reason });
                }
                return;
            }

            if (pathname.startsWith('/api/')) {
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
                return;
            }

            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { error: 'method not allowed' });
                return;
            }
            serveStatic(req, res, pathname);
        } catch (error) {
            if (res.headersSent) {
                res.end();
                return;
            }
            if (error instanceof HttpError) {
                sendJson(res, error.status, { error: error.message });
                return;
            }
            console.error('[voltran] request failed:', error);
            sendJson(res, 500, { error: 'internal error' });
        }
    });

    attachWebSockets(server, hub, guard);
    return server;
}

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

function attachWebSockets(server: Server, hub: Hub, guard: Guard): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
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

    server.on('upgrade', (req, socket, head) => {
        const verdict = guard.checkRequest(req);
        if (!verdict.ok) {
            refuseUpgrade(socket, verdict.status, verdict.reason);
            return;
        }
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const paneMatch = pathname.match(/^\/ws\/panes\/([^/]+)$/);

        if (pathname !== '/ws/events' && !paneMatch) {
            refuseUpgrade(socket, 404, 'Not Found');
            return;
        }
        if (paneMatch && !hub.panes.has(decodeURIComponent(paneMatch[1]))) {
            refuseUpgrade(socket, 404, 'Not Found');
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            alive.set(ws, true);
            ws.on('pong', () => alive.set(ws, true));
            if (paneMatch) {
                servePane(ws, hub, decodeURIComponent(paneMatch[1]));
            } else {
                serveEvents(ws, hub);
            }
        });
    });
}

function serveEvents(ws: WebSocket, hub: Hub): void {
    const send = (event: ServerEvent): void => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
        }
    };
    send({ type: 'state', state: hub.state() });
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
