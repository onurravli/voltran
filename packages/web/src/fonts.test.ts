import { describe, expect, it } from 'vitest';
import {
    DEFAULT_FONT,
    DEFAULT_UI_FONT,
    MAX_FONT_SIZE,
    MAX_UI_FONT_SIZE,
    MIN_FONT_SIZE,
    MIN_UI_FONT_SIZE,
    clampFontSize,
    clampUiFontSize,
    fontChoices,
    fontStack,
    parseFont,
    parseUiFont,
    uiFontChoices,
    uiFontStack,
} from './fonts.ts';

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

describe('clampUiFontSize', () => {
    it('keeps sizes inside the UI range, which is narrower than the terminal one', () => {
        expect(clampUiFontSize(15)).toBe(15);
        expect(clampUiFontSize(MIN_UI_FONT_SIZE - 1)).toBe(MIN_UI_FONT_SIZE);
        expect(clampUiFontSize(MAX_UI_FONT_SIZE + 1)).toBe(MAX_UI_FONT_SIZE);
        expect(clampUiFontSize(Number.NaN)).toBe(DEFAULT_UI_FONT.size);
    });
});

describe('parseUiFont', () => {
    it('keeps an empty family, which means the system font', () => {
        expect(parseUiFont({ family: '', size: 14 })).toEqual({ family: '', size: 14 });
        expect(parseUiFont({ family: 'Inter', size: 40 })).toEqual({ family: 'Inter', size: MAX_UI_FONT_SIZE });
        expect(parseUiFont(undefined)).toEqual(DEFAULT_UI_FONT);
        expect(parseUiFont({ family: 3, size: '14' })).toEqual(DEFAULT_UI_FONT);
    });
});

describe('uiFontStack', () => {
    it('puts the family in front of the system font, or uses the system font alone', () => {
        expect(uiFontStack('Inter')).toBe(`"Inter", -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`);
        expect(uiFontStack('')).toBe(`-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`);
    });
});

describe('uiFontChoices', () => {
    const installed = (family: string): boolean => ['Inter', 'Helvetica'].includes(family);

    it('lists the system font first, then the installed candidates', () => {
        expect(uiFontChoices('', installed)).toEqual(['', 'Inter', 'Helvetica']);
        expect(uiFontChoices('inter', installed)).toEqual(['', 'Inter', 'Helvetica']);
    });

    it('keeps a custom current font right after the system font', () => {
        expect(uiFontChoices('Avenir', installed)).toEqual(['', 'Avenir', 'Inter', 'Helvetica']);
    });
});
