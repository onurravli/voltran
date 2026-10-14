import { DEFAULT_SETTINGS, MAX_FONT_FAMILY_LENGTH, MAX_FONT_SIZE, MIN_FONT_SIZE } from '@voltran/shared';

export interface TerminalFont {
    family: string;
    size: number;
}

export const DEFAULT_FONT: TerminalFont = { family: DEFAULT_SETTINGS.terminal.fontFamily, size: DEFAULT_SETTINGS.terminal.fontSize };
export { MAX_FONT_SIZE, MIN_FONT_SIZE };

export const FONT_CANDIDATES = [
    'JetBrains Mono',
    'SF Mono',
    'Menlo',
    'Monaco',
    'Fira Code',
    'Cascadia Code',
    'Hack',
    'IBM Plex Mono',
    'Source Code Pro',
    'Roboto Mono',
    'Ubuntu Mono',
    'Geist Mono',
    'Iosevka',
    'Berkeley Mono',
    'Victor Mono',
    'Courier New',
];

export function clampFontSize(size: number): number {
    if (!Number.isFinite(size)) {
        return DEFAULT_FONT.size;
    }
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

export function cleanFamily(family: string): string {
    return family.replace(/["\\;{}]/g, '').trim().slice(0, MAX_FONT_FAMILY_LENGTH);
}

export function fontStack(family: string): string {
    const clean = cleanFamily(family);
    const fallback = '"SF Mono", ui-monospace, Menlo, monospace';
    return clean ? `"${clean}", ${fallback}` : fallback;
}

export function parseFont(value: unknown): TerminalFont {
    if (!value || typeof value !== 'object') {
        return DEFAULT_FONT;
    }
    const { family, size } = value as Partial<Record<keyof TerminalFont, unknown>>;
    const clean = typeof family === 'string' ? cleanFamily(family) : '';
    return {
        family: clean || DEFAULT_FONT.family,
        size: typeof size === 'number' ? clampFontSize(size) : DEFAULT_FONT.size,
    };
}

export function fontChoices(current: string, installed: (family: string) => boolean = isFontInstalled): string[] {
    const choices = FONT_CANDIDATES.filter(installed);
    const known = choices.some((family) => family.toLowerCase() === current.toLowerCase());
    return known ? choices : [current, ...choices];
}

const SAMPLE = 'mmmmmmmmmmlli10WQ@#';
const BASELINES = ['monospace', 'sans-serif', 'serif'];
const installed = new Map<string, boolean>();

// Chrome reports every local family as loaded through document.fonts.check, so presence is
// detected by whether the family changes the rendered width against generic fallbacks.
export function isFontInstalled(family: string): boolean {
    const clean = cleanFamily(family);
    const cached = installed.get(clean);
    if (cached !== undefined) {
        return cached;
    }
    const context = document.createElement('canvas').getContext('2d');
    if (!context) {
        return true;
    }
    const widthOf = (font: string): number => {
        context.font = `32px ${font}`;
        return context.measureText(SAMPLE).width;
    };
    const present = BASELINES.some((baseline) => widthOf(`"${clean}", ${baseline}`) !== widthOf(baseline));
    installed.set(clean, present);
    return present;
}
