import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT, MAX_FONT_SIZE, MIN_FONT_SIZE, clampFontSize, fontChoices, fontStack, parseFont } from './fonts.ts';

describe('clampFontSize', () => {
    it('keeps sizes inside the supported range', () => {
        expect(clampFontSize(14)).toBe(14);
        expect(clampFontSize(MIN_FONT_SIZE - 1)).toBe(MIN_FONT_SIZE);
        expect(clampFontSize(MAX_FONT_SIZE + 1)).toBe(MAX_FONT_SIZE);
        expect(clampFontSize(13.6)).toBe(14);
    });

    it('falls back to the default for values that are not numbers', () => {
        expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT.size);
        expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT.size);
    });
});

describe('parseFont', () => {
    it('reads a stored font back', () => {
        expect(parseFont({ family: 'Fira Code', size: 15 })).toEqual({ family: 'Fira Code', size: 15 });
    });

    it('replaces missing, empty or malformed fields with the defaults', () => {
        expect(parseFont(undefined)).toEqual(DEFAULT_FONT);
        expect(parseFont('Menlo')).toEqual(DEFAULT_FONT);
        expect(parseFont({ family: '  ', size: '15' })).toEqual(DEFAULT_FONT);
        expect(parseFont({ family: 'Menlo', size: 400 })).toEqual({ family: 'Menlo', size: MAX_FONT_SIZE });
    });

    it('strips characters that could break out of a CSS font list', () => {
        expect(parseFont({ family: 'Evil", serif; color: red', size: 13 }).family).toBe('Evil, serif color: red');
    });
});

describe('fontStack', () => {
    it('quotes the family and keeps monospace fallbacks', () => {
        expect(fontStack('Fira Code')).toBe('"Fira Code", "SF Mono", ui-monospace, Menlo, monospace');
    });

    it('falls back cleanly when nothing usable is left', () => {
        expect(fontStack('""')).toBe('"SF Mono", ui-monospace, Menlo, monospace');
    });
});

describe('fontChoices', () => {
    const installed = (family: string): boolean => ['Menlo', 'SF Mono', 'Fira Code'].includes(family);

    it('lists only installed candidates', () => {
        expect(fontChoices('Menlo', installed)).toEqual(['SF Mono', 'Menlo', 'Fira Code']);
    });

    it('keeps a custom current font at the top so it can be reselected', () => {
        expect(fontChoices('Iosevka Term', installed)).toEqual(['Iosevka Term', 'SF Mono', 'Menlo', 'Fira Code']);
    });

    it('matches the current font without regard to case', () => {
        expect(fontChoices('fira code', installed)).toEqual(['SF Mono', 'Menlo', 'Fira Code']);
    });
});
