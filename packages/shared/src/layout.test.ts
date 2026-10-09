import { describe, expect, it } from 'vitest';
import { insertPane, isValidLayout, movePane, normalizeSizes, paneIds, removePane, samePanes } from './layout.ts';
import type { Layout, LayoutSplit } from './types.ts';

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

describe('movePane', () => {
    const row = (...ids: string[]): LayoutSplit => ({ type: 'split', direction: 'horizontal', children: ids.map((paneId) => ({ type: 'pane', paneId })), sizes: ids.map(() => 100 / ids.length) });

    it('places a pane on the left or right of another pane in the same row', () => {
        expect(paneIds(movePane(row('a', 'b', 'c'), 'c', 'a', 'left'))).toEqual(['c', 'a', 'b']);
        expect(paneIds(movePane(row('a', 'b', 'c'), 'a', 'b', 'right'))).toEqual(['b', 'a', 'c']);
    });

    it('splits the target the other way for a top or bottom drop', () => {
        const next = movePane(row('a', 'b', 'c'), 'c', 'a', 'top');
        expect(next).toMatchObject({
            type: 'split',
            direction: 'horizontal',
            children: [
                { type: 'split', direction: 'vertical', children: [{ paneId: 'c' }, { paneId: 'a' }], sizes: [50, 50] },
                { type: 'pane', paneId: 'b' },
            ],
        });
        expect(next?.type === 'split' && next.sizes).toEqual([50, 50]);
        expect(paneIds(movePane(row('a', 'b'), 'a', 'b', 'bottom'))).toEqual(['b', 'a']);
    });

    it('moves a pane out of a nested split and collapses what it leaves behind', () => {
        const nested: Layout = {
            type: 'split',
            direction: 'horizontal',
            children: [
                { type: 'pane', paneId: 'a' },
                { type: 'split', direction: 'vertical', children: [{ type: 'pane', paneId: 'b' }, { type: 'pane', paneId: 'c' }], sizes: [40, 60] },
            ],
            sizes: [30, 70],
        };
        expect(movePane(nested, 'c', 'a', 'left')).toEqual({
            type: 'split',
            direction: 'horizontal',
            children: [{ type: 'pane', paneId: 'c' }, { type: 'pane', paneId: 'a' }, { type: 'pane', paneId: 'b' }],
            sizes: [15, 15, 70],
        });
    });

    it('swaps two panes and keeps their slots and sizes', () => {
        const layout: Layout = { ...row('a', 'b', 'c'), sizes: [20, 30, 50] };
        expect(movePane(layout, 'a', 'c', 'swap')).toEqual({ ...row('c', 'b', 'a'), sizes: [20, 30, 50] });
    });

    it('leaves the layout alone for a pane dropped on itself or panes that are not in it', () => {
        const layout = row('a', 'b');
        expect(movePane(layout, 'a', 'a', 'left')).toBe(layout);
        expect(movePane(layout, 'x', 'a', 'left')).toBe(layout);
        expect(movePane(layout, 'a', 'x', 'swap')).toBe(layout);
        expect(movePane(null, 'a', 'b', 'left')).toBeNull();
    });

    it('always keeps the same set of panes', () => {
        const layout = row('a', 'b', 'c');
        for (const edge of ['left', 'right', 'top', 'bottom', 'swap'] as const) {
            const next = movePane(layout, 'b', 'c', edge);
            expect(samePanes(next, layout)).toBe(true);
            expect(isValidLayout(next)).toBe(true);
        }
    });
});
