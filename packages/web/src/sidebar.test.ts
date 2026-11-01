import { describe, expect, it } from 'vitest';
import {
    COLLAPSE_SIDEBAR_BELOW,
    DEFAULT_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    clampSidebarWidth,
    draggedSidebarWidth,
    dropBefore,
    dropSide,
    extendSelection,
    selectionMode,
    stepBefore,
} from './sidebar.ts';

describe('clampSidebarWidth', () => {
    it('keeps widths inside the allowed range, in whole pixels', () => {
        expect(clampSidebarWidth(300)).toBe(300);
        expect(clampSidebarWidth(300.6)).toBe(301);
        expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH - 50)).toBe(MIN_SIDEBAR_WIDTH);
        expect(clampSidebarWidth(MAX_SIDEBAR_WIDTH + 50)).toBe(MAX_SIDEBAR_WIDTH);
    });

    it('falls back to the default for anything that is not a width', () => {
        expect(clampSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH);
        expect(clampSidebarWidth('320')).toBe(DEFAULT_SIDEBAR_WIDTH);
        expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    });
});

describe('draggedSidebarWidth', () => {
    it('follows the pointer between the limits', () => {
        expect(draggedSidebarWidth(320)).toBe(320);
        expect(draggedSidebarWidth(900)).toBe(MAX_SIDEBAR_WIDTH);
    });

    it('holds the minimum while the pointer is just past it', () => {
        expect(draggedSidebarWidth(MIN_SIDEBAR_WIDTH - 1)).toBe(MIN_SIDEBAR_WIDTH);
        expect(draggedSidebarWidth(COLLAPSE_SIDEBAR_BELOW)).toBe(MIN_SIDEBAR_WIDTH);
    });

    it('closes the sidebar once the pointer is well to the left', () => {
        expect(draggedSidebarWidth(COLLAPSE_SIDEBAR_BELOW - 1)).toBeNull();
        expect(draggedSidebarWidth(-40)).toBeNull();
    });
});

describe('dropSide', () => {
    it('is before the target in its top half and after it in its bottom half', () => {
        expect(dropSide(0, 30)).toBe('before');
        expect(dropSide(14.9, 30)).toBe('before');
        expect(dropSide(15, 30)).toBe('after');
        expect(dropSide(30, 30)).toBe('after');
    });
});

describe('dropBefore', () => {
    const ids = ['p7', 'p2', 'p9'];

    it('moves in front of the target, or of the one after it', () => {
        expect(dropBefore(ids, 'p2', 'before')).toBe('p2');
        expect(dropBefore(ids, 'p7', 'after')).toBe('p2');
    });

    it('moves to the end after the last one', () => {
        expect(dropBefore(ids, 'p9', 'after')).toBeNull();
    });
});

describe('stepBefore', () => {
    const ids = ['s4', 's1', 's8'];

    it('moves up in front of the previous one', () => {
        expect(stepBefore(ids, 's1', -1)).toBe('s4');
        expect(stepBefore(ids, 's8', -1)).toBe('s1');
    });

    it('moves down in front of the one after the next, or to the end', () => {
        expect(stepBefore(ids, 's4', 1)).toBe('s8');
        expect(stepBefore(ids, 's1', 1)).toBeNull();
    });

    it('cannot move past either end or move something that is not listed', () => {
        expect(stepBefore(ids, 's4', -1)).toBeUndefined();
        expect(stepBefore(ids, 's8', 1)).toBeUndefined();
        expect(stepBefore(ids, 'gone', 1)).toBeUndefined();
    });
});

describe('selectionMode', () => {
    const click = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

    it('toggles with ⌘ on a Mac and with Ctrl elsewhere', () => {
        expect(selectionMode({ ...click, metaKey: true }, true)).toBe('toggle');
        expect(selectionMode({ ...click, ctrlKey: true }, true)).toBeNull();
        expect(selectionMode({ ...click, ctrlKey: true }, false)).toBe('toggle');
        expect(selectionMode({ ...click, metaKey: true }, false)).toBeNull();
    });

    it('selects a range with Shift and leaves a plain click alone', () => {
        expect(selectionMode({ ...click, shiftKey: true }, true)).toBe('range');
        expect(selectionMode(click, true)).toBeNull();
        expect(selectionMode({ ...click, shiftKey: true, altKey: true }, true)).toBeNull();
    });
});

describe('extendSelection', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'];
    const picked = (ids: string[], anchor: string, kept = ids) => ({ scope: 'p', ids, anchor, kept });

    it('starts with the toggled row alone, leaving out the open one', () => {
        expect(extendSelection(null, 'p', rows, 'd', 'toggle', 'b')).toEqual(picked(['d'], 'd'));
    });

    it('starts a range at the open row only when it is in the scope', () => {
        expect(extendSelection(null, 'p', rows, 'd', 'range', 'b')?.ids).toEqual(['b', 'c', 'd']);
        expect(extendSelection(null, 'p', rows, 'd', 'range', 'x')?.ids).toEqual(['d']);
    });

    it('takes a toggled row back out, and ends the selection with the last one', () => {
        expect(extendSelection(picked(['b', 'd'], 'd'), 'p', rows, 'b', 'toggle', null)).toEqual(picked(['d'], 'b'));
        expect(extendSelection(picked(['d'], 'd'), 'p', rows, 'd', 'toggle', null)).toBeNull();
    });

    it('selects from the anchor to the clicked row, either way', () => {
        expect(extendSelection(picked(['b'], 'b'), 'p', rows, 'd', 'range', null)?.ids).toEqual(['b', 'c', 'd']);
        expect(extendSelection(picked(['b'], 'b'), 'p', rows, 'a', 'range', null)?.ids).toEqual(['a', 'b']);
        expect(extendSelection(null, 'p', rows, 'c', 'range', 'e')?.ids).toEqual(['c', 'd', 'e']);
    });

    it('keeps the rows picked before a range, and lets the range shrink', () => {
        const toggled = extendSelection(picked(['a'], 'a'), 'p', rows, 'c', 'toggle', null);
        expect(toggled).toEqual(picked(['a', 'c'], 'c'));
        const wide = extendSelection(toggled, 'p', rows, 'e', 'range', null);
        expect(wide?.ids).toEqual(['a', 'c', 'd', 'e']);
        expect(extendSelection(wide, 'p', rows, 'd', 'range', null)?.ids).toEqual(['a', 'c', 'd']);
    });

    it('starts over in another scope', () => {
        expect(extendSelection(picked(['b', 'c'], 'c'), 'q', ['x', 'y'], 'y', 'toggle', null)).toEqual({
            scope: 'q',
            ids: ['y'],
            anchor: 'y',
            kept: ['y'],
        });
    });

    it('drops rows that are gone and ignores a row outside the scope', () => {
        const current = picked(['b', 'z'], 'b');
        expect(extendSelection(current, 'p', rows, 'c', 'toggle', null)?.ids).toEqual(['b', 'c']);
        expect(extendSelection(current, 'p', rows, 'q', 'toggle', null)).toBe(current);
    });
});
