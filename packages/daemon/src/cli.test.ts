import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autostartProgram } from './cli.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function homebrew(): string {
    const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-cli-')));
    cleanups.push(() => rmSync(prefix, { recursive: true, force: true }));
    for (const dir of ['Cellar/node/26.1.0/bin', 'Cellar/voltran/1.0.0/libexec/bin', 'opt', 'bin']) {
        mkdirSync(join(prefix, dir), { recursive: true });
    }
    writeFileSync(join(prefix, 'Cellar/node/26.1.0/bin/node'), '');
    writeFileSync(join(prefix, 'Cellar/voltran/1.0.0/libexec/bin/voltran.mjs'), '');
    symlinkSync('../Cellar/node/26.1.0', join(prefix, 'opt/node'));
    symlinkSync('../Cellar/voltran/1.0.0/libexec/bin/voltran.mjs', join(prefix, 'bin/voltran'));
    return prefix;
}

describe('autostartProgram', () => {
    it('runs Homebrew\'s Node and Voltran through links that outlive an upgrade', () => {
        const prefix = homebrew();
        expect(autostartProgram(
            join(prefix, 'Cellar/node/26.1.0/bin/node'),
            join(prefix, 'bin/voltran'),
            join(prefix, 'Cellar/voltran/1.0.0/libexec/bin/voltran.mjs'),
        )).toEqual([join(prefix, 'opt/node/bin/node'), join(prefix, 'bin/voltran'), 'up', '--no-open']);
    });

    it('keeps the real paths when there is no such link', () => {
        const prefix = homebrew();
        rmSync(join(prefix, 'opt/node'));
        const node = join(prefix, 'Cellar/node/26.1.0/bin/node');
        const cli = join(prefix, 'Cellar/voltran/1.0.0/libexec/bin/voltran.mjs');
        expect(autostartProgram(node, node, cli)).toEqual([node, cli, 'up', '--no-open']);
    });
});
