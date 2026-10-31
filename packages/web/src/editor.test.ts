import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@voltran/shared';
import {
    DEFAULT_TREE_WIDTH,
    MAX_TREE_WIDTH,
    isInside,
    joinPath,
    matchFile,
    movedPath,
    nameProblem,
    parentOf,
    parseMemory,
    rankFiles,
    setUnsaved,
    unsavedIn,
    anyUnsaved,
    editorCommand,
    editorKeys,
    minimalEdit,
    gitMarks,
    editorOptions,
    cleanOnSave,
} from './editor.ts';

describe('matchFile', () => {
    it('matches letters in order, ignoring case and spaces', () => {
        expect(matchFile('SV', 'src/SessionView.tsx')?.positions).toEqual([4, 11]);
        expect(matchFile('ses view', 'src/SessionView.tsx')).not.toBeNull();
        expect(matchFile('xyz', 'src/SessionView.tsx')).toBeNull();
        expect(matchFile('', 'a.ts')).toEqual({ path: 'a.ts', score: 0, positions: [] });
    });

    it('prefers a match in the file name over one spread across folders', () => {
        const ranked = rankFiles('store', [
            'packages/daemon/src/store.ts',
            'scripts/test-overview.ts',
            'packages/web/src/store.test.ts',
        ]);
        expect(ranked.map((match) => match.path)).toEqual([
            'packages/daemon/src/store.ts',
            'packages/web/src/store.test.ts',
            'scripts/test-overview.ts',
        ]);
    });

    it('limits the results', () => {
        const files = Array.from({ length: 100 }, (_, index) => `file${index}.ts`);
        expect(rankFiles('file', files, 5)).toHaveLength(5);
    });
});

describe('paths', () => {
    it('splits and joins paths relative to the folder', () => {
        expect(parentOf('a/b/c.ts')).toBe('a/b');
        expect(parentOf('c.ts')).toBe('');
        expect(joinPath('', 'c.ts')).toBe('c.ts');
        expect(joinPath('a', 'c.ts')).toBe('a/c.ts');
        expect(isInside('a/b', 'a')).toBe(true);
        expect(isInside('ab', 'a')).toBe(false);
        expect(isInside('x', '')).toBe(true);
    });

    it('moves a path and what is inside it, and nothing else', () => {
        expect(movedPath('src/a.ts', 'src/a.ts', 'lib/a.ts')).toBe('lib/a.ts');
        expect(movedPath('src/deep/a.ts', 'src', 'lib')).toBe('lib/deep/a.ts');
        expect(movedPath('srcs/a.ts', 'src', 'lib')).toBeNull();
    });

    it('checks a typed name', () => {
        expect(nameProblem('a/b.ts')).toBeNull();
        for (const bad of ['', '  ', '/a', 'a//b', '../a', 'a/.', 'a/']) {
            expect(nameProblem(bad)).not.toBeNull();
        }
    });
});

describe('parseMemory', () => {
    it('falls back for missing or broken storage', () => {
        const empty = { tabs: [], active: null, expanded: [], treeWidth: DEFAULT_TREE_WIDTH, treeHidden: false };
        expect(parseMemory(null)).toEqual(empty);
        expect(parseMemory('{')).toEqual(empty);
        expect(parseMemory('"x"')).toEqual(empty);
    });

    it('keeps what makes sense of a stored editor', () => {
        const memory = parseMemory(
            JSON.stringify({
                tabs: ['a', 'b', 'a', 3],
                active: 'c',
                expanded: ['src'],
                treeWidth: 9999,
                treeHidden: true,
            }),
        );
        expect(memory).toEqual({
            tabs: ['a', 'b'],
            active: 'a',
            expanded: ['src'],
            treeWidth: MAX_TREE_WIDTH,
            treeHidden: true,
        });
    });
});

describe('unsaved files', () => {
    it('counts per pane', () => {
        setUnsaved('p1', 2);
        expect(unsavedIn('p1')).toBe(2);
        expect(anyUnsaved()).toBe(true);
        setUnsaved('p1', 0);
        expect(unsavedIn('p1')).toBe(0);
        expect(anyUnsaved()).toBe(false);
    });
});

describe('editorCommand', () => {
    const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
        code,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...mods,
    });

    it('uses ⌘ on a Mac and Ctrl elsewhere', () => {
        expect(editorCommand(key('KeyS', { metaKey: true }), true)).toBe('save');
        expect(editorCommand(key('KeyS', { metaKey: true, altKey: true }), true)).toBe('saveAll');
        expect(editorCommand(key('KeyS', { ctrlKey: true }), false)).toBe('save');
        expect(editorCommand(key('KeyS', { ctrlKey: true }), true)).toBeNull();
        expect(editorCommand(key('KeyP', { metaKey: true }), true)).toBe('quickOpen');
        expect(editorCommand(key('KeyB', { ctrlKey: true }), false)).toBe('toggleTree');
        expect(editorCommand(key('KeyS', { metaKey: true, shiftKey: true }), true)).toBeNull();
    });

    it('closes and steps tabs with keys the browser does not keep', () => {
        expect(editorCommand(key('KeyW', { ctrlKey: true }), true)).toBe('closeTab');
        expect(editorCommand(key('KeyW', { altKey: true }), false)).toBe('closeTab');
        expect(editorCommand(key('KeyW', { metaKey: true }), true)).toBeNull();
        expect(editorCommand(key('ArrowRight', { metaKey: true, altKey: true }), true)).toBe('nextTab');
        expect(editorCommand(key('ArrowLeft', { metaKey: true, altKey: true }), true)).toBe('previousTab');
        expect(editorCommand(key('PageDown', { ctrlKey: true, altKey: true }), false)).toBe('nextTab');
        expect(editorCommand(key('ArrowLeft', { ctrlKey: true, altKey: true }), false)).toBeNull();
    });

    it('lists its keys for each platform', () => {
        expect(editorKeys(true)[0].keys).toBe('⌘S');
        expect(editorKeys(false)[0].keys).toBe('Ctrl+S');
    });
});

describe('minimalEdit', () => {
    const apply = (text: string, edit: { start: number; end: number; text: string } | null): string =>
        edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;

    it('replaces only what changed', () => {
        expect(minimalEdit('abc', 'abc')).toBeNull();
        expect(minimalEdit('const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\n')).toEqual({
            start: 23,
            end: 24,
            text: '3',
        });
        for (const [before, after] of [
            ['aaa', 'aa'],
            ['aa', 'aaa'],
            ['', 'x'],
            ['x', ''],
            ['abcabc', 'abXabc'],
            ['hello world', 'hello brave new world'],
        ]) {
            expect(apply(before, minimalEdit(before, after))).toBe(after);
        }
    });
});

describe('gitMarks', () => {
    it('marks changed files inside the folder and the folders above them', () => {
        const marks = gitMarks('packages/web/', [
            { path: 'packages/web/src/a.ts', state: 'modified' },
            { path: 'packages/web/src/new/b.ts', state: 'untracked' },
            { path: 'packages/web/src/new/c.ts', state: 'conflicted' },
            { path: 'packages/web/old.ts', state: 'deleted' },
            { path: 'packages/daemon/x.ts', state: 'modified' },
        ]);
        expect(marks).toEqual({
            'src/a.ts': 'modified',
            src: 'conflicted',
            'src/new/b.ts': 'untracked',
            'src/new': 'conflicted',
            'src/new/c.ts': 'conflicted',
            'old.ts': 'deleted',
        });
    });

    it('lets a change outrank something new in a folder', () => {
        expect(
            gitMarks('', [
                { path: 'd/new.ts', state: 'added' },
                { path: 'd/old.ts', state: 'renamed' },
            ]).d,
        ).toBe('modified');
        expect(
            gitMarks('', [
                { path: 'd/old.ts', state: 'modified' },
                { path: 'd/new.ts', state: 'untracked' },
            ]).d,
        ).toBe('modified');
    });
});

describe('editorOptions', () => {
    const terminal = { family: 'JetBrains Mono', size: 13 };

    it("follows the terminal's font until the editor has its own", () => {
        expect(editorOptions(DEFAULT_SETTINGS.editor, terminal)).toMatchObject({
            fontFamily: 'JetBrains Mono',
            fontSize: 13,
            lineHeight: 0,
            wordWrap: 'off',
            minimap: { enabled: false },
            lineNumbers: 'on',
            autoClosingBrackets: 'languageDefined',
        });
        const own = {
            ...DEFAULT_SETTINGS.editor,
            fontFamily: 'Fira Code',
            fontSize: 15,
            lineHeight: 1.6,
            wordWrap: true,
            minimap: true,
            lineNumbers: 'relative' as const,
            rulers: [80],
            autoClosingBrackets: false,
            stickyScroll: true,
        };
        expect(editorOptions(own, terminal)).toMatchObject({
            fontFamily: 'Fira Code',
            fontSize: 15,
            lineHeight: 1.6,
            wordWrap: 'on',
            minimap: { enabled: true },
            lineNumbers: 'relative',
            rulers: [80],
            autoClosingBrackets: 'never',
            autoClosingQuotes: 'never',
            stickyScroll: { enabled: true },
        });
    });
});

describe('cleanOnSave', () => {
    const both = { trimTrailingWhitespace: true, insertFinalNewline: true };

    it("trims line ends and adds the final newline in the file's own line ending", () => {
        expect(cleanOnSave('a  \nb\t\nc ', both)).toBe('a\nb\nc\n');
        expect(cleanOnSave('a \r\nb', both)).toBe('a\r\nb\r\n');
        expect(cleanOnSave('', both)).toBe('');
        expect(cleanOnSave('keep  \n', { trimTrailingWhitespace: false, insertFinalNewline: true })).toBe('keep  \n');
        expect(cleanOnSave('x  ', { trimTrailingWhitespace: false, insertFinalNewline: false })).toBe('x  ');
    });
});
