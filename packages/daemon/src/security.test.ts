import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { Guard, safeEqual } from './security.ts';

const TOKEN = 'a'.repeat(64);
const config = loadConfig({ VOLTRAN_HOME: '/tmp/voltran-guard-test', VOLTRAN_PORT: '4800' });
const guard = new Guard(config, TOKEN);

const request = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage);

describe('Guard.checkRequest', () => {
    it('accepts the bearer token on the daemon host', () => {
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800', authorization: `Bearer ${TOKEN}` }))).toEqual({ ok: true });
        expect(guard.checkRequest(request({ host: 'localhost:4800', authorization: `Bearer ${TOKEN}` }))).toEqual({ ok: true });
    });

    it('accepts a browser credential it signed, as a header or as a WebSocket subprotocol', () => {
        const session = guard.issueBrowserSession();
        const origin = 'http://127.0.0.1:4800';
        expect(session).not.toContain(TOKEN);
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800', origin, authorization: `Bearer ${session}` }))).toEqual({ ok: true });
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800', origin, 'sec-websocket-protocol': `voltran, ${session}` }))).toEqual({ ok: true });
        expect(guard.issueBrowserSession()).not.toBe(session);
    });

    it('refuses a forged or foreign browser credential, and ignores cookies', () => {
        const session = guard.issueBrowserSession();
        const [id, mac] = session.split('.');
        const other = new Guard(config, 'b'.repeat(64)).issueBrowserSession();
        for (const credential of [`${id}.${mac.replace(/^./, (c) => (c === '0' ? '1' : '0'))}`, `${'0'.repeat(32)}.${mac}`, other, id, `${session}x`]) {
            expect(guard.checkRequest(request({ host: '127.0.0.1:4800', authorization: `Bearer ${credential}` }))).toMatchObject({ ok: false, status: 401 });
            expect(guard.checkRequest(request({ host: '127.0.0.1:4800', 'sec-websocket-protocol': `voltran, ${credential}` }))).toMatchObject({ ok: false, status: 401 });
        }
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800', cookie: `voltran_session=${TOKEN}` }))).toMatchObject({ ok: false, status: 401 });
    });

    it('refuses a rebinding host even with a valid token', () => {
        expect(guard.checkRequest(request({ host: 'attacker.example:4800', authorization: `Bearer ${TOKEN}` }))).toMatchObject({ ok: false, status: 421 });
    });

    it('refuses cross-origin requests even with a valid credential', () => {
        const verdict = guard.checkRequest(request({ host: '127.0.0.1:4800', origin: 'https://attacker.example', authorization: `Bearer ${guard.issueBrowserSession()}` }));
        expect(verdict).toMatchObject({ ok: false, status: 403 });
    });

    it('refuses missing or wrong credentials', () => {
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800' }))).toMatchObject({ ok: false, status: 401 });
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800', authorization: 'Bearer nope' }))).toMatchObject({ ok: false, status: 401 });
    });

    it('lets anonymous routes through only after the host and origin checks', () => {
        expect(guard.checkRequest(request({ host: '127.0.0.1:4800' }), { allowAnonymous: true })).toEqual({ ok: true });
        expect(guard.checkRequest(request({ host: 'evil:4800' }), { allowAnonymous: true })).toMatchObject({ ok: false });
    });

    it('allows the Vite dev origin only in dev mode', () => {
        const devGuard = new Guard(loadConfig({ VOLTRAN_HOME: '/tmp/x', VOLTRAN_PORT: '4800', VOLTRAN_DEV: '1' }), TOKEN);
        const devRequest = request({ host: 'localhost:5173', origin: 'http://localhost:5173', authorization: `Bearer ${TOKEN}` });
        expect(devGuard.checkRequest(devRequest)).toEqual({ ok: true });
        expect(guard.checkRequest(devRequest)).toMatchObject({ ok: false });
    });
});

describe('login codes', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('are single use', () => {
        const code = guard.issueLoginCode();
        expect(guard.redeemLoginCode(code)).toBe(true);
        expect(guard.redeemLoginCode(code)).toBe(false);
    });

    it('expire after a minute', () => {
        vi.useFakeTimers();
        const code = guard.issueLoginCode();
        vi.advanceTimersByTime(61_000);
        expect(guard.redeemLoginCode(code)).toBe(false);
    });

    it('reject unknown codes', () => {
        expect(guard.redeemLoginCode('made-up')).toBe(false);
    });
});

describe('safeEqual', () => {
    it('compares strings of any length without throwing', () => {
        expect(safeEqual('abc', 'abc')).toBe(true);
        expect(safeEqual('abc', 'abcd')).toBe(false);
        expect(safeEqual('é', 'e')).toBe(false);
    });
});
