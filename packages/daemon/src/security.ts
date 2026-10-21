import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.ts';

export const WS_PROTOCOL = 'voltran';
const LOGIN_CODE_TTL_MS = 60_000;
const BROWSER_SESSION = /^([0-9a-f]{32})\.([0-9a-f]{64})$/;

export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return null;
    }
    return header.slice('Bearer '.length).trim();
}

// A browser cannot set headers on a WebSocket upgrade, so it offers its credential as a subprotocol
// next to WS_PROTOCOL, the one the server picks.
export function offeredProtocols(req: IncomingMessage): string[] {
    const header = req.headers['sec-websocket-protocol'];
    return typeof header === 'string' ? header.split(',').map((protocol) => protocol.trim()).filter(Boolean) : [];
}

export type GuardResult = { ok: true } | { ok: false; status: number; reason: string };

// A localhost server that can spawn processes is reachable from any web page the user visits:
// the Host check stops DNS rebinding, the Origin check stops cross-site requests and WebSocket
// hijacking, and the token stops every other local client.
export class Guard {
    private readonly config: Config;
    private readonly token: string;
    private loginCodes = new Map<string, number>();

    constructor(config: Config, token: string) {
        this.config = config;
        this.token = token;
    }

    checkRequest(req: IncomingMessage, options: { allowAnonymous?: boolean } = {}): GuardResult {
        const host = req.headers.host ?? '';
        if (!this.config.allowedHosts.has(host)) {
            return { ok: false, status: 421, reason: 'unexpected Host header' };
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !this.config.allowedOrigins.has(origin)) {
            return { ok: false, status: 403, reason: 'cross-origin request refused' };
        }
        if (options.allowAnonymous) {
            return { ok: true };
        }
        return this.isAuthenticated(req) ? { ok: true } : { ok: false, status: 401, reason: 'not authenticated' };
    }

    isAuthenticated(req: IncomingMessage): boolean {
        const bearer = bearerToken(req);
        if (bearer && (safeEqual(bearer, this.token) || this.isBrowserSession(bearer))) {
            return true;
        }
        return offeredProtocols(req).some((protocol) => this.isBrowserSession(protocol));
    }

    // A signed-in browser holds a credential of its own, never the token, and keeps it in the page's
    // storage, which no other port on this host can read; a cookie would go to every port. It is
    // signed with the token, so it survives a restart and a new token signs every browser out.
    issueBrowserSession(): string {
        const id = randomBytes(16).toString('hex');
        return `${id}.${this.sign(id)}`;
    }

    private isBrowserSession(value: string): boolean {
        const match = BROWSER_SESSION.exec(value);
        return match !== null && safeEqual(match[2], this.sign(match[1]));
    }

    private sign(id: string): string {
        return createHmac('sha256', this.token).update(`browser-session:${id}`).digest('hex');
    }

    issueLoginCode(): string {
        this.pruneLoginCodes();
        const code = randomBytes(24).toString('hex');
        this.loginCodes.set(code, Date.now() + LOGIN_CODE_TTL_MS);
        return code;
    }

    redeemLoginCode(code: string): boolean {
        this.pruneLoginCodes();
        const expires = this.loginCodes.get(code);
        if (expires === undefined) {
            return false;
        }
        this.loginCodes.delete(code);
        return expires > Date.now();
    }

    private pruneLoginCodes(): void {
        const now = Date.now();
        for (const [code, expires] of this.loginCodes) {
            if (expires <= now) {
                this.loginCodes.delete(code);
            }
        }
    }
}
