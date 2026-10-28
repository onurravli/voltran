import {
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesRefused, MAX_EDIT_BYTES, fileVersion, listFolder, pathParts, readEditableFile, saveEditableFile } from './files.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function folder(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-files-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function refusal(read: () => unknown): { status: number } {
    try {
        read();
    } catch (error) {
        expect(error).toBeInstanceOf(FilesRefused);
        return { status: (error as FilesRefused).status };
    }
    throw new Error('expected a refusal');
}

describe('pathParts', () => {
    it('takes a relative path and refuses one that could leave the folder or reach git', () => {
        expect(pathParts('')).toEqual([]);
        expect(pathParts('src/main.ts')).toEqual(['src', 'main.ts']);
        for (const path of ['/etc/passwd', '../outside', 'src/../../x', './a', 'a//b', 'a/', '.git/config', 'sub/.git/hooks/pre-commit']) {
            expect(refusal(() => pathParts(path)).status).toBe(400);
        }
    });
});

describe('listFolder', () => {
    it('lists folders first, hides .git and does not follow links', () => {
        const root = folder();
        mkdirSync(join(root, '.git'));
        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'b.txt'), 'b');
        writeFileSync(join(root, 'a.txt'), 'a');
        symlinkSync('/etc', join(root, 'etc'));
        expect(listFolder(root, '')).toEqual({
            path: '',
            entries: [
                { name: 'src', kind: 'folder' },
                { name: 'a.txt', kind: 'file' },
                { name: 'b.txt', kind: 'file' },
                { name: 'etc', kind: 'link' },
            ],
            truncated: false,
        });
        expect(listFolder(root, 'src').entries).toEqual([]);
        expect(refusal(() => listFolder(root, 'etc')).status).toBe(404);
        expect(refusal(() => listFolder(root, 'a.txt')).status).toBe(404);
    });
});

describe('readEditableFile', () => {
    it('reads a text file with a version of its contents', () => {
        const root = folder();
        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'src', 'main.ts'), '﻿const a = 1;\n');
        expect(readEditableFile(root, 'src/main.ts')).toEqual({
            path: 'src/main.ts',
            text: '﻿const a = 1;\n',
            version: fileVersion(Buffer.from('﻿const a = 1;\n')),
            binary: false,
            tooLarge: false,
            readOnly: false,
        });
    });

    it('shows no text for a binary, non UTF-8 or large file', () => {
        const root = folder();
        writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
        writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        writeFileSync(join(root, 'big.txt'), 'x'.repeat(MAX_EDIT_BYTES + 1));
        expect(readEditableFile(root, 'image.png')).toMatchObject({ text: null, binary: true });
        expect(readEditableFile(root, 'latin1.txt')).toMatchObject({ text: null, binary: true });
        expect(readEditableFile(root, 'big.txt')).toMatchObject({ text: null, tooLarge: true });
    });

    it('never reads through a link, in the file or in a folder on the way', () => {
        const root = folder();
        const outside = folder();
        writeFileSync(join(outside, 'secret'), 'secret');
        symlinkSync(join(outside, 'secret'), join(root, 'secret'));
        symlinkSync(outside, join(root, 'out'));
        expect(refusal(() => readEditableFile(root, 'secret')).status).toBe(409);
        expect(refusal(() => readEditableFile(root, 'out/secret')).status).toBe(404);
        expect(refusal(() => readEditableFile(root, 'missing.txt')).status).toBe(404);
        expect(refusal(() => readEditableFile(root, '')).status).toBe(400);
    });
});

describe('saveEditableFile', () => {
    it('writes the file in place when it still has the contents it was opened with', () => {
        const root = folder();
        const file = join(root, 'run.sh');
        writeFileSync(file, 'echo one\n');
        chmodSync(file, 0o755);
        const opened = readEditableFile(root, 'run.sh');
        const saved = saveEditableFile(root, 'run.sh', 'echo two\n', opened.version!);
        expect(saved).toMatchObject({ text: 'echo two\n', version: fileVersion(Buffer.from('echo two\n')) });
        expect(readFileSync(file, 'utf8')).toBe('echo two\n');
        expect(statSync(file).mode & 0o777).toBe(0o755);
    });

    it('refuses to overwrite a change made on disk since', () => {
        const root = folder();
        writeFileSync(join(root, 'a.txt'), 'one');
        const opened = readEditableFile(root, 'a.txt');
        writeFileSync(join(root, 'a.txt'), 'agent');
        expect(refusal(() => saveEditableFile(root, 'a.txt', 'mine', opened.version!)).status).toBe(409);
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('agent');
    });

    it('never writes through a link or to a file with another hard link', () => {
        const root = folder();
        const outside = folder();
        writeFileSync(join(outside, 'target'), 'keep');
        const version = fileVersion(Buffer.from('keep'));
        symlinkSync(join(outside, 'target'), join(root, 'link'));
        symlinkSync(outside, join(root, 'out'));
        linkSync(join(outside, 'target'), join(root, 'hard'));
        expect(readEditableFile(root, 'hard').readOnly).toBe(true);
        expect(refusal(() => saveEditableFile(root, 'link', 'x', version)).status).toBe(409);
        expect(refusal(() => saveEditableFile(root, 'out/target', 'x', version)).status).toBe(404);
        expect(refusal(() => saveEditableFile(root, 'hard', 'x', version)).status).toBe(409);
        expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('keep');
    });
});
