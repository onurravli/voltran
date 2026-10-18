import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findChrome, systemdUnit } from './linux.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-linux-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function executable(dir: string, name: string): string {
    const file = join(dir, name);
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    return file;
}

describe('Linux integration', () => {
    it('prefers Google Chrome over Chromium and finds neither on an empty PATH', () => {
        const first = tempDir();
        const second = tempDir();
        executable(first, 'chromium');
        const chrome = executable(second, 'google-chrome');
        writeFileSync(join(first, 'google-chrome-stable'), 'not executable');

        expect(findChrome([first, second].join(delimiter))).toBe(chrome);
        expect(findChrome(first)).toBe(join(first, 'chromium'));
        expect(findChrome('')).toBeNull();
    });

    it('writes a user unit that runs the given program with its environment and leaves the daemon running', () => {
        const text = systemdUnit({
            program: ['/home/me/.nvm/node', '/home/me/R&D "voltran" 100% $5/bin/voltran.mjs', 'up', '--no-open'],
            env: { SHELL: '/bin/bash', VOLTRAN_HOME: '/home/me/$voltran' },
            log: '/home/me/.voltran/daemon.log',
        });
        const lines = text.split('\n');
        expect(lines).toContain('Type=oneshot');
        expect(lines).toContain('RemainAfterExit=yes');
        expect(lines).toContain('KillMode=process');
        expect(lines).toContain('ExecStart="/home/me/.nvm/node" "/home/me/R&D \\"voltran\\" 100%% $$5/bin/voltran.mjs" "up" "--no-open"');
        expect(lines).toContain('Environment="SHELL=/bin/bash"');
        expect(lines).toContain('Environment="VOLTRAN_HOME=/home/me/$voltran"');
        expect(lines).toContain('StandardOutput=append:/home/me/.voltran/daemon.log');
        expect(lines).toContain('WantedBy=default.target');
        expect(text.endsWith('\n')).toBe(true);
    });
});
