import { describe, expect, it } from 'vitest';
import { insertPane, isValidLayout, normalizeSizes, paneIds, removePane, samePanes } from './layout.ts';
import type { Layout } from './types.ts';

describe('insertPane', () => {
    it('starts a layout with a single leaf', () => {
        expect(insertPane(null, 'a')).toEqual({ type: 'pane', paneId: 'a' });
    });

    it('splits a leaf in the requested direction', () => {
        expect(insertPane({ type: 'pane', paneId: 'a' }, 'b', 'a', 'vertical')).toEqual({
            type: 'split',
            direction: 'vertical',
            children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'b' }],
            sizes: [50, 50],
        });
    });

    it('inserts next to the target inside a same-direction split and halves its size', () => {
        const layout = insertPane(insertPane(null, 'a'), 'b', 'a', 'horizontal');
        const next = insertPane(layout, 'c', 'a', 'horizontal');
        expect(paneIds(next)).toEqual(['a', 'c', 'b']);
        expect(next.type === 'split' && next.sizes).toEqual([25, 25, 50]);
    });

    it('nests a split when the direction differs from the parent', () => {
        const layout = insertPane(insertPane(null, 'a'), 'b', 'a', 'horizontal');
        const next = insertPane(layout, 'c', 'b', 'vertical');
        expect(next).toMatchObject({
            type: 'split',
            direction: 'horizontal',
            children: [{ paneId: 'a' }, { type: 'split', direction: 'vertical', children: [{ paneId: 'b' }, { paneId: 'c' }] }],
        });
    });

    it('appends to the root when the target is unknown', () => {
        const layout = insertPane(insertPane(null, 'a'), 'b');
        expect(paneIds(insertPane(layout, 'c', 'missing'))).toEqual(['a', 'b', 'c']);
    });
});

describe('removePane', () => {
    const layout: Layout = {
        type: 'split',
        direction: 'horizontal',
        children: [
            { type: 'pane', paneId: 'a' },
            { type: 'split', direction: 'vertical', children: [{ type: 'pane', paneId: 'b' }, { type: 'pane', paneId: 'c' }], sizes: [50, 50] },
        ],
        sizes: [40, 60],
    };

    it('collapses a split left with one child', () => {
        expect(removePane(layout, 'c')).toEqual({
            type: 'split',
            direction: 'horizontal',
            children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'b' }],
            sizes: [40, 60],
        });
    });

    it('rescales sibling sizes to fill the gap', () => {
        const three: Layout = {
            type: 'split',
            direction: 'horizontal',
            children: [{ type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'b' }, { type: 'pane', paneId: 'c' }],
            sizes: [50, 25, 25],
        };
        const next = removePane(three, 'a');
        expect(next?.type === 'split' && next.sizes).toEqual([50, 50]);
    });

    it('returns null when the last pane goes', () => {
        expect(removePane({ type: 'pane', paneId: 'a' }, 'a')).toBeNull();
    });
});

describe('validation helpers', () => {
    it('normalizes sizes to 100 and falls back to even sizes', () => {
        expect(normalizeSizes([1, 3])).toEqual([25, 75]);
        expect(normalizeSizes([0, Number.NaN])).toEqual([50, 50]);
    });

    it('accepts only well-formed layouts', () => {
        expect(isValidLayout({ type: 'pane', paneId: 'a' })).toBe(true);
        expect(isValidLayout({ type: 'split', direction: 'horizontal', children: [{ type: 'pane', paneId: 'a' }], sizes: [100] })).toBe(false);
        expect(isValidLayout({ type: 'split', direction: 'diagonal', children: [], sizes: [] })).toBe(false);
        expect(isValidLayout({ type: 'pane' })).toBe(false);
    });

    it('compares pane membership regardless of order', () => {
        const a = insertPane(insertPane(null, 'x'), 'y');
        const b = insertPane(insertPane(null, 'y'), 'x', 'y', 'vertical');
        expect(samePanes(a, b)).toBe(true);
        expect(samePanes(a, insertPane(null, 'x'))).toBe(false);
    });
});
