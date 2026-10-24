import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionChangesReader, parseChangedFiles, parsePatch } from './changes.ts';
import { commandRunner } from './git.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function repository(): { root: string; git: (...args: string[]) => string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-changes-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    return { root, git };
}

const reader = (): SessionChangesReader => new SessionChangesReader(commandRunner(process.env));

describe('parseChangedFiles', () => {
    it('reads changed, renamed, conflicted and untracked entries', () => {
        const output = [
            '1 .M N... 100644 100644 100644 aaa bbb src/main.ts',
            '1 A. N... 000000 100644 100644 000 ccc new file.ts',
            '2 R. N... 100644 100644 100644 ddd ddd R100 lib/after.ts',
            'lib/before.ts',
            'u UU N... 100644 100644 100644 100644 e f g conflict.ts',
            '? notes.md',
            '',
        ].join('\0');
        expect(parseChangedFiles(output)).toEqual([
            { path: 'conflict.ts', oldPath: null, state: 'conflicted', staged: false, unstaged: true },
            { path: 'lib/after.ts', oldPath: 'lib/before.ts', state: 'renamed', staged: true, unstaged: false },
            { path: 'new file.ts', oldPath: null, state: 'added', staged: true, unstaged: false },
            { path: 'notes.md', oldPath: null, state: 'untracked', staged: false, unstaged: true },
            { path: 'src/main.ts', oldPath: null, state: 'modified', staged: false, unstaged: true },
        ]);
    });
});

describe('parsePatch', () => {
    it('numbers old and new lines through each hunk', () => {
        const hunks = parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@ fn\n keep\n-old\n+new\n\\ No newline at end of file\n');
        expect(hunks).toEqual([{
            header: '@@ -2,3 +2,3 @@ fn',
            lines: [
                { kind: 'context', text: 'keep', old: 2, new: 2 },
                { kind: 'del', text: 'old', old: 3, new: null },
                { kind: 'add', text: 'new', old: null, new: 3 },
                { kind: 'note', text: 'No newline at end of file', old: null, new: null },
            ],
        }]);
    });
});

describe('SessionChangesReader', () => {
    it('lists the changes of the whole repository and shows each one', async () => {
        const { root, git } = repository();
        writeFileSync(join(root, 'kept.txt'), 'one\ntwo\nthree\n');
        writeFileSync(join(root, 'gone.txt'), 'bye\n');
        writeFileSync(join(root, 'moved.txt'), 'a\nb\nc\nd\ne\n');
        git('add', '.');
        git('commit', '-q', '-m', 'first');
        writeFileSync(join(root, 'kept.txt'), 'one\n2\nthree\n');
        unlinkSync(join(root, 'gone.txt'));
        git('mv', 'moved.txt', 'renamed.txt');
        writeFileSync(join(root, 'fresh.txt'), 'hello\nworld');
        writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
        symlinkSync('/etc/hosts', join(root, 'link'));
        execFileSync('mkdir', ['-p', join(root, 'sub')]);

        const changes = await reader().list(join(root, 'sub'));
        expect(changes.root).toBe(root);
        expect(changes.files.map((file) => `${file.state} ${file.path}`)).toEqual([
            'untracked blob.bin', 'untracked fresh.txt', 'deleted gone.txt', 'modified kept.txt', 'untracked link', 'renamed renamed.txt',
        ]);

        const kept = await reader().diff(root, 'kept.txt');
        expect(kept).toMatchObject({ added: 1, removed: 1, binary: false, tooLarge: false });
        expect(kept.hunks[0].lines.filter((line) => line.kind !== 'context')).toEqual([
            { kind: 'del', text: 'two', old: 2, new: null },
            { kind: 'add', text: '2', old: null, new: 2 },
        ]);
        expect((await reader().diff(root, 'gone.txt')).removed).toBe(1);
        expect(await reader().diff(root, 'renamed.txt')).toMatchObject({ added: 0, removed: 0, hunks: [] });
        const fresh = await reader().diff(root, 'fresh.txt');
        expect(fresh.added).toBe(2);
        expect(fresh.hunks[0].lines.map((line) => line.text)).toEqual(['hello', 'world', 'No newline at end of file']);
        expect((await reader().diff(root, 'blob.bin')).binary).toBe(true);
        expect((await reader().diff(root, 'link')).hunks[0].lines[0].text).toBe('/etc/hosts');
    });

    it('reads only files that have changes', async () => {
        const { root, git } = repository();
        writeFileSync(join(root, 'a.txt'), 'a\n');
        git('add', '.');
        git('commit', '-q', '-m', 'first');
        await expect(reader().diff(root, 'a.txt')).rejects.toThrow('has no changes');
        await expect(reader().diff(root, '../../etc/passwd')).rejects.toThrow('has no changes');
    });

    it('shows a repository with no commits against the empty tree', async () => {
        const { root, git } = repository();
        writeFileSync(join(root, 'first.txt'), 'x\n');
        git('add', '.');
        expect(await reader().diff(root, 'first.txt')).toMatchObject({ added: 1, removed: 0 });
    });

    it('runs no command the repository configures', async () => {
        const { root, git } = repository();
        const marker = (name: string): string => join(root, `${name}-ran`);
        writeFileSync(join(root, '.gitattributes'), '*.txt diff=evil filter=evil\n');
        writeFileSync(join(root, 'a.txt'), 'a\n');
        git('add', '.');
        git('commit', '-q', '-m', 'first');
        git('config', 'diff.external', `touch ${marker('external')}`);
        git('config', 'diff.evil.command', `touch ${marker('driver')}`);
        git('config', 'diff.evil.textconv', `sh -c 'touch ${marker('textconv')}; cat "$1"' --`);
        git('config', 'filter.evil.clean', `sh -c 'touch ${marker('clean')}; cat'`);
        git('config', 'core.fsmonitor', `touch ${marker('fsmonitor')}`);
        writeFileSync(join(root, 'a.txt'), 'b\n');

        const changes = await reader().list(root);
        expect(changes.files.map((file) => file.path)).toEqual(['a.txt']);
        const diff = await reader().diff(root, 'a.txt');
        expect(diff.hunks[0].lines.map((line) => `${line.kind} ${line.text}`)).toEqual(['del a', 'add b']);
        for (const name of ['external', 'driver', 'textconv', 'clean', 'fsmonitor']) {
            expect(existsSync(marker(name)), name).toBe(false);
        }
    });

    it('refuses a folder outside any repository', async () => {
        const folder = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-changes-')));
        cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
        await expect(reader().list(folder)).rejects.toThrow('is not in a git repository');
    });
});
