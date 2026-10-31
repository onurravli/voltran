import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesError, MAX_EDIT_BYTES, ProjectFiles, relativePath, systemTrash, type Trash } from './files.ts';
import { commandRunner } from './git.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function folder(prefix = 'voltran-files-'): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function repository(): string {
    const root = folder();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    return root;
}

function files(trash: Trash = () => false): ProjectFiles {
    return new ProjectFiles({ run: commandRunner(process.env), trash });
}

function status(action: () => unknown): number | null {
    try {
        action();
    } catch (error) {
        return error instanceof FilesError ? error.status : -1;
    }
    return null;
}

describe('relativePath', () => {
    it('takes only plain paths inside the folder', () => {
        expect(relativePath('src/main.ts')).toBe('src/main.ts');
        expect(relativePath('', true)).toBe('');
        for (const bad of ['', '/etc/passwd', '../up', 'a/../../b', 'a//b', './a', 'a/', 'a\0b', 42]) {
            expect(() => relativePath(bad)).toThrow(FilesError);
        }
    });
});

describe('ProjectFiles', () => {
    it('lists folders first, hides .git and marks what git ignores', async () => {
        const root = repository();
        writeFileSync(join(root, '.gitignore'), 'dist/\n*.log\n');
        mkdirSync(join(root, 'src'));
        mkdirSync(join(root, 'dist'));
        writeFileSync(join(root, 'b.txt'), '');
        writeFileSync(join(root, 'A.md'), '');
        writeFileSync(join(root, 'debug.log'), '');
        writeFileSync(join(root, 'src', 'main.ts'), '');
        symlinkSync('src', join(root, 'linked'));

        const tree = await files().tree(root, ['', 'src']);
        const top = tree.dirs[''];
        if (!('entries' in top)) {
            throw new Error(top.error);
        }
        expect(top.entries.map((entry) => entry.name)).toEqual([
            'dist',
            'linked',
            'src',
            '.gitignore',
            'A.md',
            'b.txt',
            'debug.log',
        ]);
        expect(top.entries.find((entry) => entry.name === 'dist')).toMatchObject({ kind: 'dir', ignored: true });
        expect(top.entries.find((entry) => entry.name === 'debug.log')).toMatchObject({ kind: 'file', ignored: true });
        expect(top.entries.find((entry) => entry.name === 'linked')).toMatchObject({
            kind: 'dir',
            link: true,
            ignored: false,
        });
        expect(tree.dirs.src).toEqual({
            entries: [{ name: 'main.ts', kind: 'file', link: false, ignored: false }],
            truncated: false,
        });
    });

    it('lists a folder outside git without marking anything ignored', async () => {
        const root = folder();
        writeFileSync(join(root, 'notes.txt'), 'x');
        const tree = await files().tree(root, ['']);
        expect(tree.dirs['']).toEqual({
            entries: [{ name: 'notes.txt', kind: 'file', link: false, ignored: false }],
            truncated: false,
        });
    });

    it('refuses a folder a link takes outside, and reports it per folder', async () => {
        const root = folder();
        const outside = folder('voltran-outside-');
        writeFileSync(join(outside, 'secret'), 'no');
        symlinkSync(outside, join(root, 'away'));
        const tree = await files().tree(root, ['away', '../x']);
        expect(tree.dirs.away).toEqual({ error: 'away leads outside the folder' });
        expect(tree.dirs['../x']).toHaveProperty('error');
        expect(status(() => files().read(root, 'away/secret', null))).toBe(403);
        expect(status(() => files().write(root, 'away/secret', 'yes', null, true))).toBe(403);
        expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('no');
    });

    it('lists the files git knows and the untracked ones it does not ignore', async () => {
        const root = repository();
        writeFileSync(join(root, '.gitignore'), 'dist/\n');
        mkdirSync(join(root, 'dist'));
        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'dist', 'out.js'), '');
        writeFileSync(join(root, 'src', 'main.ts'), '');
        execFileSync('git', ['add', '.'], { cwd: root });
        writeFileSync(join(root, 'new.ts'), '');
        expect((await files().list(root)).files.sort()).toEqual(['.gitignore', 'new.ts', 'src/main.ts']);
    });

    it('walks a folder outside git, skipping node_modules', async () => {
        const root = folder();
        mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
        mkdirSync(join(root, 'lib'));
        writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '');
        writeFileSync(join(root, 'lib', 'a.js'), '');
        expect(await files().list(root)).toEqual({ files: ['lib/a.js'], truncated: false });
    });

    it('reads text with a version, and answers unchanged for a known version', () => {
        const root = folder();
        writeFileSync(join(root, 'a.ts'), '\uFEFFconst a = 1;\r\n');
        const first = files().read(root, 'a.ts', null);
        expect(first).toMatchObject({
            path: 'a.ts',
            text: '\uFEFFconst a = 1;\r\n',
            binary: false,
            tooLarge: false,
            unchanged: false,
        });
        expect(files().read(root, 'a.ts', first.version)).toMatchObject({
            text: null,
            unchanged: true,
            version: first.version,
        });
    });

    it('treats NUL bytes and invalid UTF-8 as binary, and big files as too large', () => {
        const root = folder();
        writeFileSync(join(root, 'nul.bin'), Buffer.from([0x61, 0, 0x62]));
        writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        writeFileSync(join(root, 'big.txt'), Buffer.alloc(MAX_EDIT_BYTES + 1, 0x61));
        expect(files().read(root, 'nul.bin', null)).toMatchObject({ binary: true, text: null });
        expect(files().read(root, 'latin1.txt', null)).toMatchObject({ binary: true, text: null });
        expect(files().read(root, 'big.txt', null)).toMatchObject({ tooLarge: true, text: null });
        mkdirSync(join(root, 'dir'));
        expect(status(() => files().read(root, 'dir', null))).toBe(409);
        expect(status(() => files().read(root, 'missing', null))).toBe(404);
    });

    it('saves in place over the version it was read at, keeping the mode', () => {
        const root = folder();
        const path = join(root, 'run.sh');
        writeFileSync(path, 'echo one\n');
        chmodSync(path, 0o755);
        const { version } = files().read(root, 'run.sh', null);
        const saved = files().write(root, 'run.sh', 'echo two\n', version, false);
        expect(readFileSync(path, 'utf8')).toBe('echo two\n');
        expect(statSync(path).mode & 0o777).toBe(0o755);
        expect(saved.version).toBe(files().read(root, 'run.sh', null).version);
        expect(saved.version).not.toBe(version);
    });

    it('refuses to overwrite a file that changed on disk unless forced', () => {
        const root = folder();
        const path = join(root, 'a.ts');
        writeFileSync(path, 'one');
        const { version } = files().read(root, 'a.ts', null);
        writeFileSync(path, 'agent');
        expect(status(() => files().write(root, 'a.ts', 'mine', version, false))).toBe(409);
        expect(readFileSync(path, 'utf8')).toBe('agent');
        files().write(root, 'a.ts', 'mine', version, true);
        expect(readFileSync(path, 'utf8')).toBe('mine');
    });

    it('writes through a link inside the folder to its target', () => {
        const root = folder();
        writeFileSync(join(root, 'real.ts'), 'a');
        symlinkSync('real.ts', join(root, 'alias.ts'));
        const { version } = files().read(root, 'alias.ts', null);
        files().write(root, 'alias.ts', 'b', version, false);
        expect(readFileSync(join(root, 'real.ts'), 'utf8')).toBe('b');
    });

    it('recreates a file deleted on disk only when forced', () => {
        const root = folder();
        writeFileSync(join(root, 'gone.ts'), 'a');
        const { version } = files().read(root, 'gone.ts', null);
        rmSync(join(root, 'gone.ts'));
        expect(status(() => files().write(root, 'gone.ts', 'b', version, false))).toBe(409);
        files().write(root, 'gone.ts', 'b', version, true);
        expect(readFileSync(join(root, 'gone.ts'), 'utf8')).toBe('b');
    });

    it('creates files and folders, with the folders on the way', () => {
        const root = folder();
        files().act(root, { action: 'create', path: 'src/deep/new.ts', kind: 'file' });
        files().act(root, { action: 'create', path: 'empty', kind: 'dir' });
        expect(readFileSync(join(root, 'src', 'deep', 'new.ts'), 'utf8')).toBe('');
        expect(statSync(join(root, 'empty')).isDirectory()).toBe(true);
        expect(status(() => files().act(root, { action: 'create', path: 'empty', kind: 'file' }))).toBe(409);
        expect(status(() => files().act(root, { action: 'create', path: 'x', kind: 'link' }))).toBe(400);
    });

    it('renames, refusing to replace anything or to move a folder into itself', () => {
        const root = folder();
        mkdirSync(join(root, 'dir'));
        writeFileSync(join(root, 'a.ts'), 'a');
        writeFileSync(join(root, 'b.ts'), 'b');
        files().act(root, { action: 'rename', from: 'a.ts', to: 'dir/moved.ts' });
        expect(readFileSync(join(root, 'dir', 'moved.ts'), 'utf8')).toBe('a');
        expect(status(() => files().act(root, { action: 'rename', from: 'b.ts', to: 'dir/moved.ts' }))).toBe(409);
        expect(status(() => files().act(root, { action: 'rename', from: 'dir', to: 'dir/inner' }))).toBe(409);
        expect(status(() => files().act(root, { action: 'rename', from: 'missing', to: 'c.ts' }))).toBe(404);
        files().act(root, { action: 'rename', from: 'b.ts', to: 'B.ts' });
        expect(existsSync(join(root, 'B.ts'))).toBe(true);
    });

    it('moves an entry to the trash, and deletes it only when asked to', () => {
        const root = folder();
        const trashed: string[] = [];
        mkdirSync(join(root, 'dir'));
        writeFileSync(join(root, 'dir', 'a.ts'), 'a');
        writeFileSync(join(root, 'b.ts'), 'b');
        expect(
            files((path) => {
                trashed.push(path);
                return false;
            }).act(root, { action: 'trash', path: 'dir' }),
        ).toEqual({ trashed: false });
        expect(trashed).toEqual([join(root, 'dir')]);
        expect(existsSync(join(root, 'dir'))).toBe(true);
        files().act(root, { action: 'delete', path: 'dir' });
        expect(existsSync(join(root, 'dir'))).toBe(false);
        expect(status(() => files().act(root, { action: 'delete', path: '' }))).toBe(400);
    });

    it('deletes a link, not what it points to', () => {
        const root = folder();
        const outside = folder('voltran-outside-');
        writeFileSync(join(outside, 'keep'), 'k');
        symlinkSync(outside, join(root, 'away'));
        files().act(root, { action: 'delete', path: 'away' });
        expect(existsSync(join(root, 'away'))).toBe(false);
        expect(existsSync(join(outside, 'keep'))).toBe(true);
    });
});

describe('systemTrash', () => {
    it('moves to ~/.Trash on macOS, keeping both of two entries with one name', () => {
        const home = folder('voltran-home-');
        mkdirSync(join(home, '.Trash'));
        const root = folder();
        const trash = systemTrash({ HOME: home }, 'darwin');
        writeFileSync(join(root, 'a.ts'), 'one');
        expect(trash(join(root, 'a.ts'))).toBe(true);
        writeFileSync(join(root, 'a.ts'), 'two');
        expect(trash(join(root, 'a.ts'))).toBe(true);
        expect(existsSync(join(root, 'a.ts'))).toBe(false);
        expect(readFileSync(join(home, '.Trash', 'a.ts'), 'utf8')).toBe('one');
    });

    it('writes the freedesktop.org trash info on Linux', () => {
        const data = folder('voltran-data-');
        const root = folder();
        writeFileSync(join(root, 'a b.ts'), 'x');
        expect(systemTrash({ HOME: '/nowhere', XDG_DATA_HOME: data }, 'linux')(join(root, 'a b.ts'))).toBe(true);
        expect(readFileSync(join(data, 'Trash', 'files', 'a b.ts'), 'utf8')).toBe('x');
        const info = readFileSync(join(data, 'Trash', 'info', 'a b.ts.trashinfo'), 'utf8');
        expect(info).toContain(`Path=${encodeURI(join(root, 'a b.ts'))}\n`);
        expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n/);
    });

    it('says when it cannot trash', () => {
        expect(systemTrash({ HOME: '/nowhere' }, 'darwin')('/nowhere/a')).toBe(false);
        expect(systemTrash({ HOME: '/nowhere' }, 'win32')('/nowhere/a')).toBe(false);
    });
});
