import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { daemonCheck, homeCheck, redactHome, updatesCheck, versionAtLeast } from './doctor.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function scratchConfig() {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-doctor-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return loadConfig({ VOLTRAN_HOME: join(dir, 'home'), VOLTRAN_PORT: '4801' });
}

describe('versionAtLeast', () => {
    it('compares release versions part by part', () => {
        expect(versionAtLeast('22.18.0', '22.18.0')).toBe(true);
        expect(versionAtLeast('v24.1.0', '22.18.0')).toBe(true);
        expect(versionAtLeast('22.9.0', '22.18.0')).toBe(false);
        expect(versionAtLeast('21.99.0', '22.18.0')).toBe(false);
    });
});

describe('homeCheck', () => {
    it('accepts a home that does not exist yet without creating it', () => {
        const config = scratchConfig();
        expect(homeCheck(config).status).toBe('ok');
        expect(homeCheck(config).detail).toContain('not created yet');
    });

    it('warns about a home or a token others can read', () => {
        const config = scratchConfig();
        mkdirSync(config.home, { mode: 0o700 });
        expect(homeCheck(config).status).toBe('ok');
        chmodSync(config.home, 0o755);
        writeFileSync(config.tokenFile, 'x'.repeat(64), { mode: 0o644 });
        const result = homeCheck(config);
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('mode 755');
        expect(result.detail).toContain('token is readable by others');
    });

    it('fails for a home another user owns', () => {
        const config = scratchConfig();
        mkdirSync(config.home, { mode: 0o700 });
        expect(homeCheck(config, 12345).status).toBe('fail');
    });
});

describe('daemonCheck', () => {
    it('says whether the daemon runs, and asks for a restart when it runs other code', () => {
        const config = scratchConfig();
        expect(daemonCheck(config, null, '1.0.0').status).toBe('off');
        expect(daemonCheck(config, { pid: 42, version: '1.0.0' }, '1.0.0')).toEqual({
            name: 'Daemon',
            status: 'ok',
            detail: 'running on port 4801 (pid 42)',
        });
        const stale = daemonCheck(config, { pid: 42, version: '0.1.0' }, '1.0.0');
        expect(stale.status).toBe('warn');
        expect(stale.detail).toContain('voltran restart');
    });
});

describe('redactHome', () => {
    it('writes the home folder as ~', () => {
        expect(redactHome('/Users/me/.voltran and /Users/me: done', '/Users/me')).toBe('~/.voltran and ~: done');
        expect(redactHome('/Users/meg/code', '/Users/me')).toBe('/Users/meg/code');
        expect(redactHome('/Users/meg/code', '/')).toBe('/Users/meg/code');
    });
});

describe('updatesCheck', () => {
    const installed = (): { config: ReturnType<typeof loadConfig>; root: string } => {
        const root = mkdtempSync(join(tmpdir(), 'voltran-doctor-updates-'));
        mkdirSync(join(root, 'home'));
        return { config: loadConfig({ VOLTRAN_HOME: join(root, 'home') }), root };
    };
    const registry = (version: string | null) => async () =>
        version === null ? Promise.reject(new Error('offline')) : { ok: true, json: async () => ({ version }) };

    it('says whether a newer version is out, or that the registry did not answer', async () => {
        const { config, root } = installed();
        expect(await updatesCheck(config, '1.0.0', {}, registry('1.1.0'), root)).toEqual({
            name: 'Updates',
            status: 'warn',
            detail: '1.1.0 is available; run `npm i -g voltran`',
        });
        expect(await updatesCheck(config, '1.1.0', {}, registry('1.1.0'), root)).toMatchObject({ status: 'ok' });
        expect(await updatesCheck(config, '1.1.0', {}, registry(null), root)).toMatchObject({
            status: 'off',
            detail: 'offline: registry.npmjs.org did not answer',
        });
        rmSync(root, { recursive: true, force: true });
    });

    it('asks nothing when the check is off', async () => {
        const { config, root } = installed();
        let asked = false;
        const fetchImpl = async () => {
            asked = true;
            return { ok: true, json: async () => ({ version: '9.0.0' }) };
        };
        writeFileSync(config.settingsFile, '{ "updates": { "check": false } }\n');
        expect(await updatesCheck(config, '1.0.0', {}, fetchImpl, root)).toMatchObject({
            status: 'off',
            detail: /settings/,
        });
        writeFileSync(config.settingsFile, '{}\n');
        expect(await updatesCheck(config, '1.0.0', { VOLTRAN_NO_UPDATE_CHECK: '1' }, fetchImpl, root)).toMatchObject({
            status: 'off',
        });
        mkdirSync(join(root, '.git'));
        expect(await updatesCheck(config, '1.0.0', {}, fetchImpl, root)).toMatchObject({
            detail: 'not checked in a git checkout',
        });
        expect(asked).toBe(false);
        rmSync(root, { recursive: true, force: true });
    });
});
