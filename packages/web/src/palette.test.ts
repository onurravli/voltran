import { describe, expect, it } from 'vitest';
import { filterItems } from './palette.ts';

const items = [
    { label: 'Jump to the next pane that needs you' },
    { label: 'Start a new session' },
    { label: 'Font family…' },
    { label: 'Font size: bigger' },
    { label: 'Font size: smaller' },
    { label: 'Split the focused pane to the right with a shell' },
];

const labels = (query: string): string[] => filterItems(items, query).map((item) => item.label);

describe('filterItems', () => {
    it('returns everything in the original order for an empty query', () => {
        expect(filterItems(items, '   ')).toEqual(items);
    });

    it('matches case-insensitively and requires every word', () => {
        expect(labels('FONT size')).toEqual(['Font size: bigger', 'Font size: smaller']);
        expect(labels('font bigger')).toEqual(['Font size: bigger']);
        expect(labels('font session')).toEqual([]);
    });

    it('ranks label prefixes, then word starts, then inner matches', () => {
        expect(labels('s')[0]).toBe('Start a new session');
        expect(labels('size')).toEqual(['Font size: bigger', 'Font size: smaller']);
        expect(labels('ession')).toEqual(['Start a new session']);
        expect(labels('pane')).toEqual(['Jump to the next pane that needs you', 'Split the focused pane to the right with a shell']);
    });
});
