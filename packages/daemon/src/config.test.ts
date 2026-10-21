import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHome, loadConfig, privateFile } from './config.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-config-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

describe('ensureHome', () => {
    it('makes the home and its folders readable by the user alone, even when they already exist', () => {
        const home = join(scratch(), 'home');
        const config = loadConfig({ VOLTRAN_HOME: home, VOLTRAN_PORT: '4800' });
        mkdirSync(config.notesDir, { recursive: true, mode: 0o755 });
        chmodSync(home, 0o755);
        ensureHome(config);
        expect([home, config.scrollbackDir, config.notesDir].map(modeOf)).toEqual([0o700, 0o700, 0o700]);
    });
});

describe('privateFile', () => {
    it('creates a missing file and tightens an existing one to 0600 without touching its contents', () => {
        const dir = scratch();
        const created = privateFile(join(dir, 'new.log'));
        expect(existsSync(created)).toBe(true);
        expect(modeOf(created)).toBe(0o600);
        const existing = join(dir, 'old.log');
        writeFileSync(existing, 'kept\n', { mode: 0o644 });
        privateFile(existing);
        expect(modeOf(existing)).toBe(0o600);
        expect(statSync(existing).size).toBe(5);
    });
});
