import { describe, expect, it } from 'vitest';
import type { FolderListing } from '@voltran/shared';
import { childPath, parentPath, shownFolders, treeRows } from './files.ts';

const listing = (path: string, entries: FolderListing['entries']): FolderListing => ({ path, entries, truncated: false });

describe('treeRows', () => {
    const listings = {
        '': listing('', [
            { name: 'src', kind: 'folder' },
            { name: 'docs', kind: 'folder' },
            { name: 'README.md', kind: 'file' },
        ]),
        src: listing('src', [
            { name: 'lib', kind: 'folder' },
            { name: 'main.ts', kind: 'file' },
        ]),
        'src/lib': listing('src/lib', [{ name: 'util.ts', kind: 'file' }]),
    };

    it('shows the entries of expanded folders under them', () => {
        expect(treeRows(listings, new Set(['src', 'src/lib'])).map((row) => [row.path, row.depth, row.expanded])).toEqual([
            ['src', 0, true],
            ['src/lib', 1, true],
            ['src/lib/util.ts', 2, false],
            ['src/main.ts', 1, false],
            ['docs', 0, false],
            ['README.md', 0, false],
        ]);
    });

    it('hides what is under a collapsed folder, and an expanded folder not read yet shows nothing', () => {
        expect(treeRows(listings, new Set(['src/lib', 'docs'])).map((row) => row.path)).toEqual(['src', 'docs', 'README.md']);
    });
});

describe('shownFolders', () => {
    it('keeps the root and the expanded folders whose parents are expanded', () => {
        expect(shownFolders(new Set(['src', 'src/lib', 'docs/api']))).toEqual(['', 'src', 'src/lib']);
    });
});

describe('paths', () => {
    it('joins and splits paths relative to the session folder', () => {
        expect(childPath('', 'src')).toBe('src');
        expect(childPath('src', 'main.ts')).toBe('src/main.ts');
        expect(parentPath('src/lib/util.ts')).toBe('src/lib');
        expect(parentPath('README.md')).toBe('');
    });
});
