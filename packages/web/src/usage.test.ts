import { describe, expect, it } from 'vitest';
import { isReset, resetCountdown, usageLevel, usageRows } from './usage.ts';

describe('usageRows', () => {
    it('lists only the windows Claude reported, the five-hour one first', () => {
        const fiveHour = { usedPercent: 38, resetsAt: 1000 };
        const sevenDay = { usedPercent: 61, resetsAt: null };
        expect(usageRows(null)).toEqual([]);
        expect(usageRows({ fiveHour: null, sevenDay })).toEqual([{ label: '7d', name: 'Weekly limit', window: sevenDay }]);
        expect(usageRows({ fiveHour, sevenDay }).map((row) => row.label)).toEqual(['5h', '7d']);
    });
});

describe('usageLevel', () => {
    it('turns yellow past half and red past four fifths', () => {
        expect([0, 50, 50.5, 80, 80.5, 100].map(usageLevel)).toEqual(['low', 'low', 'warn', 'warn', 'high', 'high']);
    });
});

describe('isReset', () => {
    it('is true once the reset time has passed, and never without one', () => {
        expect(isReset({ usedPercent: 90, resetsAt: 1000 }, 999)).toBe(false);
        expect(isReset({ usedPercent: 90, resetsAt: 1000 }, 1000)).toBe(true);
        expect(isReset({ usedPercent: 90, resetsAt: null }, 1000)).toBe(false);
    });
});

describe('resetCountdown', () => {
    const minute = 60_000;

    it('counts down in minutes, hours and minutes, or days and hours', () => {
        expect(resetCountdown(18 * minute, 0)).toBe('18m');
        expect(resetCountdown(132 * minute, 0)).toBe('2h12m');
        expect(resetCountdown((3 * 1440 + 4 * 60 + 30) * minute, 0)).toBe('3d4h');
    });

    it('rounds up, so it never shows zero before the reset', () => {
        expect(resetCountdown(1, 0)).toBe('1m');
        expect(resetCountdown(59 * minute + 1, 0)).toBe('1h0m');
    });
});
