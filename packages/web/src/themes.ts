export type Scheme = 'dark' | 'light';

export const TERMINAL_KEYS = [
    'background',
    'foreground',
    'cursor',
    'cursorAccent',
    'selectionBackground',
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
] as const;

export type TerminalTheme = Record<(typeof TERMINAL_KEYS)[number], string> & { selectionForeground?: string };

export const UI_VARIABLES = [
    '--hull',
    '--bay',
    '--plate-solid',
    '--plate-hover',
    '--rivet',
    '--rivet-soft',
    '--rivet-strong',
    '--pane-focus',
    '--text',
    '--text-strong',
    '--text-muted',
    '--text-faint',
    '--project-text-mix',
    '--signal',
    '--on-signal',
    '--finished',
    '--working',
    '--live',
    '--fault',
    '--fault-hover',
    '--on-fault',
    '--error-text',
    '--toast-error-text',
    '--focus',
    '--hover-tint',
    '--shadow',
    '--backdrop',
] as const;

export type UiPalette = Record<(typeof UI_VARIABLES)[number], string>;

export interface Theme {
    id: string;
    name: string;
    scheme: Scheme;
    terminal: TerminalTheme;
    minimumContrastRatio: number;
    ui: UiPalette;
}

type Accent = 'signal' | 'finished' | 'working' | 'live' | 'fault' | 'focus';

function channels(color: string): number[] {
    return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

export function mix(from: string, to: string, amount: number): string {
    const a = channels(from);
    const b = channels(to);
    return `#${a.map((value, index) => Math.round(value + (b[index] - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(color: string): number {
    const [r, g, b] = channels(color).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

function withContrast(color: string, background: string, ratio: number, toward: string): string {
    for (let step = 0; step <= 50; step += 1) {
        const candidate = mix(color, toward, step / 50);
        if (contrastRatio(candidate, background) >= ratio) {
            return candidate;
        }
    }
    return toward;
}

function deriveUi(scheme: Scheme, t: TerminalTheme, accents: Partial<Record<Accent, string>>): UiPalette {
    const dark = scheme === 'dark';
    const extreme = dark ? '#ffffff' : '#000000';
    const tone = (amount: number): string => mix(t.background, t.foreground, amount);
    const bay = tone(0.04);
    const plate = tone(0.09);
    const text = withContrast(t.foreground, plate, 4.5, extreme);
    const textAt = (ratio: number): string => withContrast(t.background, bay, ratio, text);
    const accent = (name: Accent, normal: string, bright: string, ratio: number): string =>
        withContrast(accents[name] ?? (dark ? bright : normal), bay, ratio, extreme);
    const readableOn = (color: string): string =>
        [t.background, text, '#000000', '#ffffff'].find((candidate) => contrastRatio(candidate, color) >= 4.5) ?? extreme;
    const signal = accent('signal', t.yellow, t.brightYellow, 4.5);
    const fault = accent('fault', t.red, t.brightRed, 3);
    const focus = accent('focus', t.blue, t.brightBlue, 4.5);
    const errorText = withContrast(fault, plate, 4.5, extreme);
    return {
        '--hull': t.background,
        '--bay': bay,
        '--plate-solid': plate,
        '--plate-hover': tone(0.12),
        '--rivet': tone(0.15),
        '--rivet-soft': tone(0.11),
        '--rivet-strong': tone(0.22),
        '--pane-focus': mix(t.background, focus, dark ? 0.33 : 0.45),
        '--text': text,
        '--text-strong': mix(text, extreme, 0.5),
        '--text-muted': textAt(5),
        '--text-faint': textAt(3),
        '--project-text-mix': dark ? '100%' : '50%',
        '--signal': signal,
        '--on-signal': readableOn(signal),
        '--finished': accent('finished', t.blue, t.brightBlue, 3),
        '--working': accent('working', t.magenta, t.brightMagenta, 3),
        '--live': accent('live', t.green, t.brightGreen, 3),
        '--fault': fault,
        '--fault-hover': mix(fault, extreme, 0.15),
        '--on-fault': readableOn(fault),
        '--error-text': errorText,
        '--toast-error-text': errorText,
        '--focus': focus,
        '--hover-tint': dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)',
        '--shadow': dark ? '#000000' : mix(text, t.background, 0.4),
        '--backdrop': dark ? `${mix(t.background, '#000000', 0.5)}99` : `${mix(text, '#000000', 0.3)}4d`,
    };
}

function defineTheme(
    id: string,
    name: string,
    scheme: Scheme,
    terminal: TerminalTheme,
    accents: Partial<Record<Accent, string>> = {},
): Theme {
    return { id, name, scheme, terminal, minimumContrastRatio: scheme === 'light' ? 3 : 1, ui: deriveUi(scheme, terminal, accents) };
}

export const DEFAULT_THEME_ID = 'voltran';

const VOLTRAN: Theme = {
    id: DEFAULT_THEME_ID,
    name: 'Voltran',
    scheme: 'dark',
    terminal: {
        background: '#12151d',
        foreground: '#d8dce6',
        cursor: '#d8dce6',
        cursorAccent: '#12151d',
        selectionBackground: '#3a4565',
        black: '#1d2130',
        red: '#ff6b6b',
        green: '#8fd18b',
        yellow: '#ffcb6b',
        blue: '#7aa2f7',
        magenta: '#c49cf7',
        cyan: '#6cc4ff',
        white: '#c3c8d4',
        brightBlack: '#5b6378',
        brightRed: '#ff8f8f',
        brightGreen: '#a8e2a4',
        brightYellow: '#ffd98f',
        brightBlue: '#9bbaff',
        brightMagenta: '#d7b8ff',
        brightCyan: '#94d6ff',
        brightWhite: '#eef0f5',
    },
    minimumContrastRatio: 1,
    ui: {
        '--hull': '#12151d',
        '--bay': '#181c26',
        '--plate-solid': '#222838',
        '--plate-hover': '#283044',
        '--rivet': '#2e3446',
        '--rivet-soft': '#262b3a',
        '--rivet-strong': '#3c4459',
        '--pane-focus': '#3d4865',
        '--text': '#d8dce6',
        '--text-strong': '#ffffff',
        '--text-muted': '#8a91a3',
        '--text-faint': '#5e6578',
        '--project-text-mix': '100%',
        '--signal': '#ffb547',
        '--on-signal': '#261a05',
        '--finished': '#6cc4ff',
        '--working': '#a594ff',
        '--live': '#78c49a',
        '--fault': '#ff6b6b',
        '--fault-hover': '#ff8585',
        '--on-fault': '#1b0d0d',
        '--error-text': '#ff9a9a',
        '--toast-error-text': '#ffb0b0',
        '--focus': '#8fb0ff',
        '--hover-tint': 'rgba(255, 255, 255, 0.04)',
        '--shadow': '#000000',
        '--backdrop': 'rgba(8, 10, 15, 0.6)',
    },
};

export const THEMES: Theme[] = [
    VOLTRAN,
    defineTheme('tokyo-night', 'Tokyo Night', 'dark', {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
        selectionBackground: '#283457',
        selectionForeground: '#c0caf5',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#ff899d',
        brightGreen: '#9fe044',
        brightYellow: '#faba4a',
        brightBlue: '#8db0ff',
        brightMagenta: '#c7a9ff',
        brightCyan: '#a4daff',
        brightWhite: '#c0caf5',
    }),
    defineTheme('catppuccin-mocha', 'Catppuccin Mocha', 'dark', {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#f5e0dc',
        selectionForeground: '#1e1e2e',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
    }),
    defineTheme('dracula', 'Dracula', 'dark', {
        background: '#282a36',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        cursorAccent: '#282a36',
        selectionBackground: '#44475a',
        selectionForeground: '#ffffff',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
    }),
    defineTheme('nord', 'Nord', 'dark', {
        background: '#2e3440',
        foreground: '#d8dee9',
        cursor: '#d8dee9',
        cursorAccent: '#2e3440',
        selectionBackground: '#4c566a',
        black: '#3b4252',
        red: '#bf616a',
        green: '#a3be8c',
        yellow: '#ebcb8b',
        blue: '#81a1c1',
        magenta: '#b48ead',
        cyan: '#88c0d0',
        white: '#e5e9f0',
        brightBlack: '#4c566a',
        brightRed: '#bf616a',
        brightGreen: '#a3be8c',
        brightYellow: '#ebcb8b',
        brightBlue: '#81a1c1',
        brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb',
        brightWhite: '#eceff4',
    }),
    defineTheme('gruvbox-dark', 'Gruvbox Dark', 'dark', {
        background: '#282828',
        foreground: '#ebdbb2',
        cursor: '#ebdbb2',
        cursorAccent: '#282828',
        selectionBackground: '#665c54',
        black: '#282828',
        red: '#cc241d',
        green: '#98971a',
        yellow: '#d79921',
        blue: '#458588',
        magenta: '#b16286',
        cyan: '#689d6a',
        white: '#a89984',
        brightBlack: '#928374',
        brightRed: '#fb4934',
        brightGreen: '#b8bb26',
        brightYellow: '#fabd2f',
        brightBlue: '#83a598',
        brightMagenta: '#d3869b',
        brightCyan: '#8ec07c',
        brightWhite: '#ebdbb2',
    }),
    defineTheme('one-dark', 'One Dark', 'dark', {
        background: '#282c34',
        foreground: '#abb2bf',
        cursor: '#528bff',
        cursorAccent: '#282c34',
        selectionBackground: '#abb2bf30',
        black: '#3f4451',
        red: '#e05561',
        green: '#8cc265',
        yellow: '#d18f52',
        blue: '#4aa5f0',
        magenta: '#c162de',
        cyan: '#42b3c2',
        white: '#d7dae0',
        brightBlack: '#4f5666',
        brightRed: '#ff616e',
        brightGreen: '#a5e075',
        brightYellow: '#f0a45d',
        brightBlue: '#4dc4ff',
        brightMagenta: '#de73ff',
        brightCyan: '#4cd1e0',
        brightWhite: '#e6e6e6',
    }),
    defineTheme('rose-pine', 'Rosé Pine', 'dark', {
        background: '#191724',
        foreground: '#e0def4',
        cursor: '#524f67',
        cursorAccent: '#e0def4',
        selectionBackground: '#403d52',
        selectionForeground: '#e0def4',
        black: '#26233a',
        red: '#eb6f92',
        green: '#31748f',
        yellow: '#f6c177',
        blue: '#9ccfd8',
        magenta: '#c4a7e7',
        cyan: '#ebbcba',
        white: '#e0def4',
        brightBlack: '#6e6a86',
        brightRed: '#eb6f92',
        brightGreen: '#31748f',
        brightYellow: '#f6c177',
        brightBlue: '#9ccfd8',
        brightMagenta: '#c4a7e7',
        brightCyan: '#ebbcba',
        brightWhite: '#e0def4',
    }),
    defineTheme('catppuccin-latte', 'Catppuccin Latte', 'light', {
        background: '#eff1f5',
        foreground: '#4c4f69',
        cursor: '#dc8a78',
        cursorAccent: '#eff1f5',
        selectionBackground: '#dc8a78',
        selectionForeground: '#eff1f5',
        black: '#5c5f77',
        red: '#d20f39',
        green: '#40a02b',
        yellow: '#df8e1d',
        blue: '#1e66f5',
        magenta: '#ea76cb',
        cyan: '#179299',
        white: '#acb0be',
        brightBlack: '#6c6f85',
        brightRed: '#d20f39',
        brightGreen: '#40a02b',
        brightYellow: '#df8e1d',
        brightBlue: '#1e66f5',
        brightMagenta: '#ea76cb',
        brightCyan: '#179299',
        brightWhite: '#bcc0cc',
    }),
    defineTheme('solarized-light', 'Solarized Light', 'light', {
        background: '#fdf6e3',
        // base01: Solarized's usual body tone, base00, is only 4.1:1 on base3.
        foreground: '#586e75',
        cursor: '#657b83',
        cursorAccent: '#eee8d5',
        selectionBackground: '#eee8d5',
        selectionForeground: '#586e75',
        black: '#073642',
        red: '#dc322f',
        green: '#859900',
        yellow: '#b58900',
        blue: '#268bd2',
        magenta: '#d33682',
        cyan: '#2aa198',
        white: '#eee8d5',
        brightBlack: '#002b36',
        brightRed: '#cb4b16',
        brightGreen: '#586e75',
        brightYellow: '#657b83',
        brightBlue: '#839496',
        brightMagenta: '#6c71c4',
        brightCyan: '#93a1a1',
        brightWhite: '#fdf6e3',
    }),
    // The signal lamp uses Primer's attention colour: GitHub's ANSI yellow is a dark brown.
    defineTheme('github-light', 'GitHub Light', 'light', {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#0969da',
        cursorAccent: '#ffffff',
        selectionBackground: '#add6ff',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d2d00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#8c959f',
    }, { signal: '#9a6700' }),
];

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export function parseThemeId(value: unknown): string {
    return typeof value === 'string' && BY_ID.has(value) ? value : DEFAULT_THEME_ID;
}

export function themeById(id: string): Theme {
    return BY_ID.get(id) ?? VOLTRAN;
}

const TRANSLUCENT: (keyof UiPalette)[] = ['--signal', '--working', '--fault', '--shadow'];

export function themeProperties(theme: Theme): Record<string, string> {
    const properties: Record<string, string> = { 'color-scheme': theme.scheme, ...theme.ui };
    for (const name of TRANSLUCENT) {
        properties[`${name}-rgb`] = channels(theme.ui[name]).join(', ');
    }
    return properties;
}
