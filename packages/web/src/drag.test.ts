import { describe, expect, it } from 'vitest';
import { dropEdgeAt } from './drag.ts';

describe('dropEdgeAt', () => {
    it('swaps in the middle of a pane', () => {
        expect(dropEdgeAt(500, 300, 1000, 600)).toBe('swap');
    });

    it('picks the nearest edge outside the middle', () => {
        expect(dropEdgeAt(50, 300, 1000, 600)).toBe('left');
        expect(dropEdgeAt(950, 300, 1000, 600)).toBe('right');
        expect(dropEdgeAt(500, 20, 1000, 600)).toBe('top');
        expect(dropEdgeAt(500, 590, 1000, 600)).toBe('bottom');
        expect(dropEdgeAt(100, 40, 1000, 600)).toBe('top');
    });

    it('falls back to a swap for an empty area', () => {
        expect(dropEdgeAt(0, 0, 0, 0)).toBe('swap');
    });
});
