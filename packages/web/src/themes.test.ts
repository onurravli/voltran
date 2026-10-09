import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_THEME_ID,
    TERMINAL_KEYS,
    THEMES,
    UI_VARIABLES,
    contrastRatio,
    parseThemeId,
    themeById,
    themeProperties,
} from './themes.ts';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const COLOR = /^(#[0-9a-f]{6}([0-9a-f]{2})?|rgba\(\d+, \d+, \d+, [\d.]+\))$/i;

function oklab(hex: string): [number, number, number] {
    const [r, g, b] = [1, 3, 5].map((offset) => {
        const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

function distance(a: string, b: string): number {
    const [x, y] = [oklab(a), oklab(b)];
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe('THEMES', () => {
    it('defines every terminal colour and every UI variable for each theme', () => {
        for (const theme of THEMES) {
            for (const key of TERMINAL_KEYS) {
                expect(theme.terminal[key], `${theme.id} ${key}`).toMatch(HEX);
            }
            expect(Object.keys(theme.ui).sort(), theme.id).toEqual([...UI_VARIABLES].sort());
            for (const name of UI_VARIABLES) {
                expect(theme.ui[name], `${theme.id} ${name}`).toMatch(name === '--project-text-mix' ? /^\d+%$/ : COLOR);
            }
            expect(['dark', 'light']).toContain(theme.scheme);
            expect(theme.minimumContrastRatio, theme.id).toBeGreaterThanOrEqual(1);
        }
    });

    it('uses unique ids and names, with the default first and at least two light themes', () => {
        expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
        expect(new Set(THEMES.map((theme) => theme.name)).size).toBe(THEMES.length);
        expect(THEMES[0].id).toBe(DEFAULT_THEME_ID);
        expect(THEMES.filter((theme) => theme.scheme === 'light').length).toBeGreaterThanOrEqual(2);
    });

    it('keeps the main text at 4.5:1 or better in the terminal and on every UI surface', () => {
        for (const theme of THEMES) {
            const { terminal, ui } = theme;
            expect(contrastRatio(terminal.foreground, terminal.background), `${theme.id} terminal`).toBeGreaterThanOrEqual(4.5);
            for (const surface of ['--hull', '--bay', '--plate-solid'] as const) {
                expect(contrastRatio(ui['--text'], ui[surface]), `${theme.id} text on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
            expect(contrastRatio(ui['--text-muted'], ui['--bay']), `${theme.id} muted text`).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(ui['--signal'], ui['--bay']), `${theme.id} signal text`).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(ui['--focus'], ui['--bay']), `${theme.id} link text`).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(ui['--on-signal'], ui['--signal']), `${theme.id} badge text`).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(ui['--on-fault'], ui['--fault']), `${theme.id} danger button text`).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(ui['--error-text'], ui['--plate-solid']), `${theme.id} error text`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('keeps status lamps visible and apart from each other', () => {
        const lamps = ['--signal', '--finished', '--live', '--fault'] as const;
        for (const theme of THEMES) {
            for (const lamp of [...lamps, '--working'] as const) {
                expect(contrastRatio(theme.ui[lamp], theme.ui['--bay']), `${theme.id} ${lamp}`).toBeGreaterThanOrEqual(3);
            }
            lamps.forEach((a, index) => {
                for (const b of lamps.slice(index + 1)) {
                    expect(distance(theme.ui[a], theme.ui[b]), `${theme.id} ${a} vs ${b}`).toBeGreaterThanOrEqual(0.1);
                }
            });
        }
    });

    it('keeps the default theme identical to the stylesheet defaults', () => {
        const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
        const root = /^:root \{([^}]*)\}/m.exec(css)?.[1] ?? '';
        const declared = Object.fromEntries([...root.matchAll(/(--[\w-]+): ([^;]+);/g)].map((match) => [match[1], match[2]]));
        const { ui, scheme } = themeById(DEFAULT_THEME_ID);
        for (const name of UI_VARIABLES) {
            expect(declared[name], name).toBe(ui[name]);
        }
        for (const [name, value] of Object.entries(themeProperties(themeById(DEFAULT_THEME_ID)))) {
            if (name.endsWith('-rgb')) {
                expect(declared[name], name).toBe(value);
            }
        }
        expect(root).toContain(`color-scheme: ${scheme};`);
        expect(themeById(DEFAULT_THEME_ID).minimumContrastRatio).toBe(1);
    });
});

describe('parseThemeId', () => {
    it('keeps a known id', () => {
        expect(parseThemeId('nord')).toBe('nord');
        expect(parseThemeId('github-light')).toBe('github-light');
    });

    it('falls back to the default for unknown or malformed values', () => {
        for (const value of [undefined, null, '', 'Nord', ' nord', 'solarized-dark', 42, {}, ['nord']]) {
            expect(parseThemeId(value)).toBe(DEFAULT_THEME_ID);
        }
    });
});

describe('themeById', () => {
    it('returns the default theme for an unknown id', () => {
        expect(themeById('missing').id).toBe(DEFAULT_THEME_ID);
        expect(themeById('dracula').name).toBe('Dracula');
    });
});

describe('themeProperties', () => {
    it('lists the colour scheme, every UI variable and the channels of translucent colours', () => {
        const properties = themeProperties(themeById('catppuccin-latte'));
        expect(properties['color-scheme']).toBe('light');
        expect(properties['--fault-rgb']).toBe('210, 15, 57');
        for (const name of UI_VARIABLES) {
            expect(properties[name], name).toBe(themeById('catppuccin-latte').ui[name]);
        }
    });

    it('gives every rgb channel variable used in the stylesheet a value', () => {
        const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
        const used = new Set([...css.matchAll(/var\((--[\w-]+-rgb)\)/g)].map((match) => match[1]));
        expect(used.size).toBeGreaterThan(0);
        for (const theme of THEMES) {
            const properties = themeProperties(theme);
            for (const name of used) {
                expect(properties[name], `${theme.id} ${name}`).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
            }
        }
    });
});
