import {
    DEFAULT_SETTINGS,
    MAX_FONT_FAMILY_LENGTH,
    MAX_FONT_SIZE,
    MAX_UI_FONT_SIZE,
    MIN_FONT_SIZE,
    MIN_UI_FONT_SIZE,
} from '@voltran/shared';

export interface TerminalFont {
    family: string;
    size: number;
}

export interface UiFont {
    family: string;
    size: number;
}

export const DEFAULT_FONT: TerminalFont = {
    family: DEFAULT_SETTINGS.terminal.fontFamily,
    size: DEFAULT_SETTINGS.terminal.fontSize,
};
export const DEFAULT_UI_FONT: UiFont = { family: DEFAULT_SETTINGS.ui.fontFamily, size: DEFAULT_SETTINGS.ui.fontSize };
export { MAX_FONT_SIZE, MAX_UI_FONT_SIZE, MIN_FONT_SIZE, MIN_UI_FONT_SIZE };

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

export const UI_FONT_CANDIDATES = [
    'Inter',
    'Helvetica Neue',
    'Helvetica',
    'Arial',
    'Avenir Next',
    'Geneva',
    'Verdana',
    'Lucida Grande',
    'IBM Plex Sans',
    'Source Sans 3',
    'Roboto',
    'Noto Sans',
    'Open Sans',
    'Fira Sans',
    'Ubuntu',
    'Geist',
];

const SYSTEM_UI_STACK = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";

function clamp(size: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(size)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(size)));
}

export function clampFontSize(size: number): number {
    return clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT.size);
}

export function clampUiFontSize(size: number): number {
    return clamp(size, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT.size);
}

export function cleanFamily(family: string): string {
    return family
        .replace(/["\\;{}]/g, '')
        .trim()
        .slice(0, MAX_FONT_FAMILY_LENGTH);
}

export function fontStack(family: string): string {
    const clean = cleanFamily(family);
    const fallback = '"SF Mono", ui-monospace, Menlo, monospace';
    return clean ? `"${clean}", ${fallback}` : fallback;
}

export function uiFontStack(family: string): string {
    const clean = cleanFamily(family);
    return clean ? `"${clean}", ${SYSTEM_UI_STACK}` : SYSTEM_UI_STACK;
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

export function parseUiFont(value: unknown): UiFont {
    if (!value || typeof value !== 'object') {
        return DEFAULT_UI_FONT;
    }
    const { family, size } = value as Partial<Record<keyof UiFont, unknown>>;
    return {
        family: typeof family === 'string' ? cleanFamily(family) : DEFAULT_UI_FONT.family,
        size: typeof size === 'number' ? clampUiFontSize(size) : DEFAULT_UI_FONT.size,
    };
}

export function fontChoices(current: string, installed: (family: string) => boolean = isFontInstalled): string[] {
    const choices = FONT_CANDIDATES.filter(installed);
    const known = choices.some((family) => family.toLowerCase() === current.toLowerCase());
    return known ? choices : [current, ...choices];
}

export function uiFontChoices(current: string, installed: (family: string) => boolean = isFontInstalled): string[] {
    const choices = UI_FONT_CANDIDATES.filter(installed);
    const known = current === '' || choices.some((family) => family.toLowerCase() === current.toLowerCase());
    return known ? ['', ...choices] : ['', current, ...choices];
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
