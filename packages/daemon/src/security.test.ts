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

    it('accepts the session cookie from the same origin', () => {
        const verdict = guard.checkRequest(request({ host: '127.0.0.1:4800', origin: 'http://127.0.0.1:4800', cookie: `other=1; voltran_session=${TOKEN}` }));
        expect(verdict).toEqual({ ok: true });
    });

    it('refuses a rebinding host even with a valid token', () => {
        expect(guard.checkRequest(request({ host: 'attacker.example:4800', authorization: `Bearer ${TOKEN}` }))).toMatchObject({ ok: false, status: 421 });
    });

    it('refuses cross-origin requests even with a valid cookie', () => {
        const verdict = guard.checkRequest(request({ host: '127.0.0.1:4800', origin: 'https://attacker.example', cookie: `voltran_session=${TOKEN}` }));
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
