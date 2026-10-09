import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.ts';

export const COOKIE_NAME = 'voltran_session';
const LOGIN_CODE_TTL_MS = 60_000;

export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(req: IncomingMessage, name: string): string | null {
    const header = req.headers.cookie;
    if (!header) {
        return null;
    }
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            return decodeURIComponent(rest.join('='));
        }
    }
    return null;
}

export function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return null;
    }
    return header.slice('Bearer '.length).trim();
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
        if (bearer && safeEqual(bearer, this.token)) {
            return true;
        }
        const cookie = readCookie(req, COOKIE_NAME);
        return cookie !== null && safeEqual(cookie, this.token);
    }

    sessionCookie(): string {
        return `${COOKIE_NAME}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
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
