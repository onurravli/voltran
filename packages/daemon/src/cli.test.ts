import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autostartProgram, parseNewArgs } from './cli.ts';

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
    it("runs Homebrew's Node and Voltran through links that outlive an upgrade", () => {
        const prefix = homebrew();
        expect(
            autostartProgram(
                join(prefix, 'Cellar/node/26.1.0/bin/node'),
                join(prefix, 'bin/voltran'),
                join(prefix, 'Cellar/voltran/1.0.0/libexec/bin/voltran.mjs'),
            ),
        ).toEqual([join(prefix, 'opt/node/bin/node'), join(prefix, 'bin/voltran'), 'up', '--no-open']);
    });

    it('keeps the real paths when there is no such link', () => {
        const prefix = homebrew();
        rmSync(join(prefix, 'opt/node'));
        const node = join(prefix, 'Cellar/node/26.1.0/bin/node');
        const cli = join(prefix, 'Cellar/voltran/1.0.0/libexec/bin/voltran.mjs');
        expect(autostartProgram(node, node, cli)).toEqual([node, cli, 'up', '--no-open']);
    });
});

describe('parseNewArgs', () => {
    it('starts one Claude Code pane in the current folder by default', () => {
        expect(parseNewArgs([], '/work/app')).toEqual({
            path: '/work/app',
            panes: [{ adapter: 'claude' }],
            windowArgs: [],
        });
    });

    it('keeps panes in order with their arguments as typed', () => {
        const parsed = parseNewArgs(
            [
                '../api',
                '--pane',
                'claude --model opus',
                '--pane=shell',
                '--pane',
                'command npm run dev -- --port 3000',
                '--title',
                'Refactor auth',
                '--no-open',
            ],
            '/work/app',
        );
        expect(parsed).toEqual({
            path: '/work/api',
            title: 'Refactor auth',
            panes: [
                { adapter: 'claude', command: '--model opus' },
                { adapter: 'shell' },
                { adapter: 'command', command: 'npm run dev -- --port 3000' },
            ],
            windowArgs: ['--no-open'],
        });
    });

    it('opens a changes pane next to an agent', () => {
        expect(parseNewArgs(['--pane', 'claude', '--pane', 'changes'], '/w').panes).toEqual([
            { adapter: 'claude' },
            { adapter: 'changes' },
        ]);
    });

    it('reads a worktree branch and an optional base', () => {
        expect(parseNewArgs(['--worktree', 'feat/pipeline'], '/w').worktree).toEqual({ branch: 'feat/pipeline' });
        expect(parseNewArgs(['--worktree=feat/pipeline:main'], '/w').worktree).toEqual({
            branch: 'feat/pipeline',
            base: 'main',
        });
    });

    it('rejects what it cannot run', () => {
        expect(() => parseNewArgs(['--pane', 'vim'])).toThrow('unknown pane "vim"');
        expect(() => parseNewArgs(['--pane', 'command'])).toThrow('needs the command');
        expect(() => parseNewArgs(['--pane', 'shell ls'])).toThrow('takes no arguments');
        expect(() => parseNewArgs(['--pane', 'changes src'])).toThrow('takes no arguments');
        expect(() => parseNewArgs(['--title'])).toThrow('--title needs a value');
        expect(() => parseNewArgs(['--claude'])).toThrow('unknown option --claude');
        expect(() => parseNewArgs(['a', 'b'])).toThrow('one folder at most');
    });
});
