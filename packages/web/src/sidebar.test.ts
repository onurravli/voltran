import { describe, expect, it } from 'vitest';
import { COLLAPSE_SIDEBAR_BELOW, DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, clampSidebarWidth, draggedSidebarWidth } from './sidebar.ts';

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
