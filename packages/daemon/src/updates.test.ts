import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CHECK_INTERVAL_MS,
    LATEST_URL,
    UpdateChecker,
    fetchLatest,
    isNewer,
    skipReason,
    type Fetch,
} from './updates.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-updates-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const answer =
    (body: unknown, ok = true): Fetch =>
    async () => ({ ok, json: async () => body });

describe('isNewer', () => {
    it('compares release numbers, with a pre-release before its release', () => {
        expect(isNewer('1.2.0', '1.1.9')).toBe(true);
        expect(isNewer('1.10.0', '1.9.0')).toBe(true);
        expect(isNewer('1.1.0', '1.1.0')).toBe(false);
        expect(isNewer('1.0.9', '1.1.0')).toBe(false);
        expect(isNewer('1.1.0', '1.1.0-beta.2')).toBe(true);
        expect(isNewer('1.1.0-beta.10', '1.1.0-beta.9')).toBe(true);
        expect(isNewer('1.1.0-beta.1', '1.1.0')).toBe(false);
        expect(isNewer('latest', '1.0.0')).toBe(false);
    });
});

describe('skipReason', () => {
    const base = { dev: false, env: {}, setting: true };

    it('checks only an installed copy the user has not turned it off for', () => {
        const installed = folder();
        expect(skipReason({ ...base, repoRoot: installed })).toBeNull();
        expect(skipReason({ ...base, repoRoot: installed, setting: false })).toMatch(/settings/);
        expect(skipReason({ ...base, repoRoot: installed, env: { VOLTRAN_NO_UPDATE_CHECK: '1' } })).toMatch(
            /VOLTRAN_NO_UPDATE_CHECK/,
        );
        expect(skipReason({ ...base, repoRoot: installed, dev: true })).toMatch(/development/);
        const checkout = folder();
        mkdirSync(join(checkout, '.git'));
        expect(skipReason({ ...base, repoRoot: checkout })).toMatch(/git checkout/);
    });
});

describe('fetchLatest', () => {
    it('asks the registry for the latest version, sending nothing of its own', async () => {
        const calls: { url: string; init: object }[] = [];
        const version = await fetchLatest(async (url, init) => {
            calls.push({ url, init });
            return { ok: true, json: async () => ({ version: '2.0.0', name: 'voltran' }) };
        });
        expect(version).toBe('2.0.0');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(LATEST_URL);
        expect(Object.keys(calls[0].init)).toEqual(['signal']);
    });

    it('reads every failure as no answer', async () => {
        expect(await fetchLatest(answer({ version: '2.0.0' }, false))).toBeNull();
        expect(await fetchLatest(answer({ version: '<script>' }))).toBeNull();
        expect(await fetchLatest(answer(null))).toBeNull();
        expect(
            await fetchLatest(async () => {
                throw new Error('offline');
            }),
        ).toBeNull();
    });
});

describe('UpdateChecker', () => {
    const setup = (fetchImpl: Fetch, skip: () => string | null = () => null) => {
        const cacheFile = join(folder(), 'update.json');
        let now = 1_000_000;
        const onChange = vi.fn();
        const fetchSpy = vi.fn(fetchImpl);
        const make = () =>
            new UpdateChecker({ cacheFile, current: '1.1.0', skip, onChange, fetch: fetchSpy, now: () => now });
        return { cacheFile, onChange, fetchSpy, make, advance: (ms: number) => (now += ms) };
    };

    it('tells about a newer version once a day and remembers the answer across restarts', async () => {
        const { cacheFile, onChange, fetchSpy, make, advance } = setup(answer({ version: '1.2.0' }));
        const checker = make();
        expect(checker.notice()).toBeNull();
        await checker.checkIfDue();
        expect(checker.notice()).toEqual({ current: '1.1.0', latest: '1.2.0' });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(statSync(cacheFile).mode & 0o777).toBe(0o600);

        const restarted = make();
        expect(restarted.notice()).toEqual({ current: '1.1.0', latest: '1.2.0' });
        await restarted.checkIfDue();
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        advance(CHECK_INTERVAL_MS);
        await restarted.checkIfDue();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('stays quiet when up to date, offline or turned off, and does not ask again before a day', async () => {
        const current = setup(answer({ version: '1.1.0' }));
        const upToDate = current.make();
        await upToDate.checkIfDue();
        expect(upToDate.notice()).toBeNull();
        expect(current.onChange).not.toHaveBeenCalled();

        const offline = setup(async () => {
            throw new Error('offline');
        });
        const failing = offline.make();
        await failing.checkIfDue();
        await failing.checkIfDue();
        expect(failing.notice()).toBeNull();
        expect(offline.fetchSpy).toHaveBeenCalledTimes(1);

        const off = setup(answer({ version: '9.0.0' }), () => 'turned off in settings (updates.check)');
        const disabled = off.make();
        await disabled.checkIfDue();
        expect(off.fetchSpy).not.toHaveBeenCalled();
        expect(disabled.notice()).toBeNull();
    });

    it('keeps the last known version when a later check fails, and reads a broken cache as none', async () => {
        const { cacheFile, make, advance, fetchSpy } = setup(answer({ version: '1.3.0' }));
        await make().checkIfDue();
        fetchSpy.mockImplementation(async () => {
            throw new Error('offline');
        });
        advance(CHECK_INTERVAL_MS);
        const later = make();
        await later.checkIfDue();
        expect(later.notice()?.latest).toBe('1.3.0');
        expect(JSON.parse(readFileSync(cacheFile, 'utf8')).latest).toBe('1.3.0');
        writeFileSync(cacheFile, '{nope');
        expect(make().notice()).toBeNull();
    });
});
