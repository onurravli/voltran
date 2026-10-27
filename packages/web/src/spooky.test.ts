import { describe, expect, it } from 'vitest';
import { isHalloween, quietLabel, sequenceMatcher } from './spooky.ts';

const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

function feed(keys: string[]): boolean[] {
    const matches = sequenceMatcher();
    return keys.map((key) => matches(key));
}

describe('sequenceMatcher', () => {
    it('matches only on the last key of the sequence', () => {
        expect(feed(CODE)).toEqual([...CODE.slice(1).map(() => false), true]);
    });

    it('ignores the case of letters and finds the sequence after other keys', () => {
        expect(feed(['x', 'ArrowUp', ...CODE.slice(0, -2), 'B', 'A']).at(-1)).toBe(true);
    });

    it('does not match a broken sequence, and starts over after a match', () => {
        expect(feed([...CODE.slice(0, 5), 'Enter', ...CODE.slice(5)])).not.toContain(true);
        expect(feed([...CODE, 'a']).at(-1)).toBe(false);
        expect(feed([...CODE, ...CODE]).filter(Boolean)).toHaveLength(2);
    });
});

describe('isHalloween', () => {
    it('is true on the 31st of October only', () => {
        expect(isHalloween(new Date(2026, 9, 31, 23, 59))).toBe(true);
        expect(isHalloween(new Date(2026, 9, 30))).toBe(false);
        expect(isHalloween(new Date(2026, 10, 1))).toBe(false);
        expect(isHalloween(new Date(2026, 11, 31))).toBe(false);
    });
});

describe('quietLabel', () => {
    it('says nothing needs you, except on Halloween', () => {
        expect(quietLabel(new Date(2026, 5, 1))).toBe('Nothing needs you');
        expect(quietLabel(new Date(2026, 9, 31))).toBe('Nothing haunts you 👻');
    });
});
