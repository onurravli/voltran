import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Usage } from '@voltran/shared';
import { STATUS_LINE } from './adapters.ts';
import { mergeUsage, userStatusLine } from './statusline.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()!();
    }
});

const limits = (fiveHour: unknown, sevenDay?: unknown): Record<string, unknown> => ({
    rate_limits: { five_hour: fiveHour, seven_day: sevenDay },
});

describe('mergeUsage', () => {
    const current: Usage = {
        fiveHour: { usedPercent: 40, resetsAt: 2_000_000_000_000 },
        sevenDay: { usedPercent: 10, resetsAt: 2_000_500_000_000 },
    };

    it('reads both windows, with the reset in milliseconds', () => {
        expect(
            mergeUsage(
                null,
                limits(
                    { used_percentage: 38.5, resets_at: 2_000_000_000 },
                    { used_percentage: 61, resets_at: 2_000_500_000 },
                ),
            ),
        ).toEqual({
            fiveHour: { usedPercent: 38.5, resetsAt: 2_000_000_000_000 },
            sevenDay: { usedPercent: 61, resetsAt: 2_000_500_000_000 },
        });
    });

    it('keeps what it had when the input has no limits or none it can read', () => {
        expect(mergeUsage(null, {})).toBeNull();
        expect(mergeUsage(current, { model: { id: 'x' } })).toBe(current);
        expect(mergeUsage(null, limits({ used_percentage: '38' }, { resets_at: 2_000_500_000 }))).toBeNull();
        expect(mergeUsage(current, limits({ used_percentage: Number.NaN, resets_at: 2_000_000_000 }))).toBe(current);
    });

    it('keeps a window the input leaves out', () => {
        expect(mergeUsage(current, limits({ used_percentage: 45, resets_at: 2_000_000_000 }))).toEqual({
            ...current,
            fiveHour: { usedPercent: 45, resetsAt: 2_000_000_000_000 },
        });
    });

    it('ignores an older view of a window from a quieter pane', () => {
        expect(mergeUsage(current, limits({ used_percentage: 30, resets_at: 2_000_000_000 }))).toBe(current);
        expect(mergeUsage(current, limits({ used_percentage: 90, resets_at: 1_999_999_000 }))).toBe(current);
        expect(mergeUsage(current, limits({ used_percentage: 40, resets_at: 2_000_000_000 }))).toBe(current);
    });

    it('takes a later window even when less of it is used', () => {
        expect(mergeUsage(current, limits({ used_percentage: 2, resets_at: 2_000_018_000 }))?.fiveHour).toEqual({
            usedPercent: 2,
            resetsAt: 2_000_018_000_000,
        });
    });

    it('keeps the percentage between 0 and 100 and drops a reset it cannot read', () => {
        expect(mergeUsage(null, limits({ used_percentage: 130, resets_at: 'soon' }))?.fiveHour).toEqual({
            usedPercent: 100,
            resetsAt: null,
        });
        expect(mergeUsage(null, limits({ used_percentage: -1 }))?.fiveHour).toEqual({ usedPercent: 0, resetsAt: null });
    });
});

describe('userStatusLine', () => {
    function folders(): {
        root: string;
        sub: string;
        config: string;
        write: (dir: string, file: string, settings: unknown) => void;
    } {
        const base = mkdtempSync(join(tmpdir(), 'voltran-statusline-'));
        cleanups.push(() => rmSync(base, { recursive: true, force: true }));
        const root = join(base, 'repo');
        const sub = join(root, 'packages', 'app');
        const config = join(base, 'config');
        mkdirSync(join(root, '.git'), { recursive: true });
        mkdirSync(sub, { recursive: true });
        mkdirSync(config);
        const write = (dir: string, file: string, settings: unknown): void => {
            const folder = dir === config ? config : join(dir, '.claude');
            mkdirSync(folder, { recursive: true });
            writeFileSync(join(folder, file), typeof settings === 'string' ? settings : JSON.stringify(settings));
        };
        return { root, sub, config, write };
    }
    const line = (command: string): object => ({ statusLine: { type: 'command', command } });

    it('finds nothing when no settings set a status line', () => {
        const { sub, config } = folders();
        expect(userStatusLine(sub, config)).toBeNull();
        expect(userStatusLine(sub, null)).toBeNull();
    });

    it("follows Claude's order: local at the repository root, local here, project here, then the user's", () => {
        const { root, sub, config, write } = folders();
        write(config, 'settings.json', line('user'));
        expect(userStatusLine(sub, config)).toBe('user');
        write(root, 'settings.json', line('root project'));
        expect(userStatusLine(sub, config)).toBe('user');
        write(sub, 'settings.json', line('project'));
        expect(userStatusLine(sub, config)).toBe('project');
        write(sub, 'settings.local.json', line('local'));
        expect(userStatusLine(sub, config)).toBe('local');
        write(root, 'settings.local.json', line('root local'));
        expect(userStatusLine(sub, config)).toBe('root local');
    });

    it('skips settings it cannot read and a status line without a command', () => {
        const { sub, config, write } = folders();
        write(config, 'settings.json', line('user'));
        write(sub, 'settings.local.json', '{ broken');
        write(sub, 'settings.json', { statusLine: { type: 'command', command: '  ' } });
        expect(userStatusLine(sub, config)).toBe('user');
    });
});

describe('status line script', () => {
    const run = (input: string, env: Record<string, string>): { status: number | null; stdout: string } =>
        spawnSync('sh', [STATUS_LINE], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
            input,
            encoding: 'utf8',
        });

    async function daemon(): Promise<{ url: string; requests: { path: string; auth: string; body: string }[] }> {
        const requests: { path: string; auth: string; body: string }[] = [];
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                requests.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', body });
                res.end('{}');
            });
        });
        await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
        cleanups.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
        return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
    }

    async function until(condition: () => boolean): Promise<void> {
        for (let tries = 0; !condition(); tries += 1) {
            if (tries > 100) {
                throw new Error('condition not met in time');
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
    }

    it("prints the user's own status line from the same input", () => {
        expect(run('{"model":{}}', { VOLTRAN_STATUSLINE: 'cat; printf " mine"' })).toEqual(
            expect.objectContaining({ status: 0, stdout: '{"model":{}} mine' }),
        );
        expect(run('{}', { VOLTRAN_STATUSLINE: 'exit 3' }).status).toBe(3);
        expect(run('{}', {})).toEqual(expect.objectContaining({ status: 0, stdout: '' }));
    });

    it("reports input that carries the usage limits to the pane's hook route", async () => {
        const { url, requests } = await daemon();
        const header = join(mkdtempSync(join(tmpdir(), 'voltran-header-')), 'pane-1');
        cleanups.push(() => rmSync(dirname(header), { recursive: true, force: true }));
        writeFileSync(header, 'Authorization: Bearer s3cret\n', { mode: 0o600 });
        const env = { VOLTRAN_PANE_ID: 'pane-1', VOLTRAN_HOOK_HEADER: header, VOLTRAN_URL: url };
        const input = JSON.stringify(limits({ used_percentage: 10, resets_at: 2_000_000_000 }));
        expect(run('{"model":{}}', env).status).toBe(0);
        expect(run(input, env).status).toBe(0);
        await until(() => requests.length > 0);
        expect(requests).toEqual([{ path: '/api/hooks/pane-1/StatusLine', auth: 'Bearer s3cret', body: input }]);
    });
});
