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
