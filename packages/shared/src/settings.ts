export type Appearance = 'system' | 'dark' | 'light';
export type SidebarPosition = 'left' | 'right';

export interface Settings {
    appearance: Appearance;
    theme: { dark: string; light: string };
    terminal: { fontFamily: string; fontSize: number };
    ui: { fontFamily: string; fontSize: number };
    sidebar: { position: SidebarPosition };
    editor: { command: string };
}

export interface SettingsPatch {
    appearance?: Appearance;
    theme?: Partial<Settings['theme']>;
    terminal?: Partial<Settings['terminal']>;
    ui?: Partial<Settings['ui']>;
    sidebar?: Partial<Settings['sidebar']>;
    editor?: Partial<Settings['editor']>;
}

export interface SettingsState {
    settings: Settings;
    problems: string[];
    exists: boolean;
    path: string;
}

export const APPEARANCES: readonly Appearance[] = ['system', 'dark', 'light'];
export const SIDEBAR_POSITIONS: readonly SidebarPosition[] = ['left', 'right'];
export const DARK_THEME_IDS: readonly string[] = ['voltran', 'tokyo-night', 'catppuccin-mocha', 'dracula', 'nord', 'gruvbox-dark', 'one-dark', 'rose-pine'];
export const LIGHT_THEME_IDS: readonly string[] = ['catppuccin-latte', 'solarized-light', 'github-light'];
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;
export const MIN_UI_FONT_SIZE = 11;
export const MAX_UI_FONT_SIZE = 18;
export const MAX_FONT_FAMILY_LENGTH = 100;
export const MAX_EDITOR_COMMAND_LENGTH = 200;

export const DEFAULT_SETTINGS: Settings = {
    appearance: 'system',
    theme: { dark: 'voltran', light: 'github-light' },
    terminal: { fontFamily: 'JetBrains Mono', fontSize: 13 },
    ui: { fontFamily: '', fontSize: 13 },
    sidebar: { position: 'left' },
    editor: { command: '' },
};

type Check = (value: unknown) => string | null;

const quoted = (options: readonly string[]): string => {
    const names = options.map((option) => `"${option}"`);
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

const oneOf = (options: readonly string[]): Check => (value) =>
    typeof value === 'string' && options.includes(value) ? null : `must be ${quoted(options)}`;

const fontSize = (min: number, max: number): Check => (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
        ? null
        : `must be a whole number from ${min} to ${max}`;

const fontFamily: Check = (value) =>
    typeof value === 'string' && value.trim() !== '' && value.length <= MAX_FONT_FAMILY_LENGTH
        ? null
        : `must be the name of a font, at most ${MAX_FONT_FAMILY_LENGTH} characters`;

const uiFontFamily: Check = (value) =>
    typeof value === 'string' && value.length <= MAX_FONT_FAMILY_LENGTH
        ? null
        : `must be the name of a font, or empty for the system font, at most ${MAX_FONT_FAMILY_LENGTH} characters`;

const editorCommand: Check = (value) =>
    typeof value === 'string' && value.length <= MAX_EDITOR_COMMAND_LENGTH && !/[\r\n]/.test(value)
        ? null
        : `must be a command on one line, at most ${MAX_EDITOR_COMMAND_LENGTH} characters`;

type Path = [string] | [string, string];

const LEAVES: { path: Path; check: Check }[] = [
    { path: ['appearance'], check: oneOf(APPEARANCES) },
    { path: ['theme', 'dark'], check: oneOf(DARK_THEME_IDS) },
    { path: ['theme', 'light'], check: oneOf(LIGHT_THEME_IDS) },
    { path: ['terminal', 'fontFamily'], check: fontFamily },
    { path: ['terminal', 'fontSize'], check: fontSize(MIN_FONT_SIZE, MAX_FONT_SIZE) },
    { path: ['ui', 'fontFamily'], check: uiFontFamily },
    { path: ['ui', 'fontSize'], check: fontSize(MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE) },
    { path: ['sidebar', 'position'], check: oneOf(SIDEBAR_POSITIONS) },
    { path: ['editor', 'command'], check: editorCommand },
];

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

// Every value read from the file or sent by a client goes through these checks; nothing else
// decides whether a setting is valid.
function readPatch(raw: unknown): { patch: SettingsPatch; problems: string[] } {
    const problems: string[] = [];
    const patch: Record<string, unknown> = {};
    if (!isObject(raw)) {
        return { patch, problems: ['the settings must be an object'] };
    }
    const sections = new Set(LEAVES.filter((leaf) => leaf.path.length === 2).map((leaf) => leaf.path[0]));
    for (const key of Object.keys(raw)) {
        const known = LEAVES.some((leaf) => leaf.path[0] === key);
        if (!known) {
            problems.push(`unknown setting "${key}"`);
        } else if (sections.has(key)) {
            if (!isObject(raw[key])) {
                problems.push(`"${key}" must be an object`);
                continue;
            }
            for (const name of Object.keys(raw[key])) {
                if (!LEAVES.some((leaf) => leaf.path[0] === key && leaf.path[1] === name)) {
                    problems.push(`unknown setting "${key}.${name}"`);
                }
            }
        }
    }
    for (const { path, check } of LEAVES) {
        const [key, name] = path;
        const section = raw[key];
        if (name !== undefined && !isObject(section)) {
            continue;
        }
        const holder = name === undefined ? raw : section as Record<string, unknown>;
        const field = name ?? key;
        if (!(field in holder)) {
            continue;
        }
        const problem = check(holder[field]);
        if (problem) {
            problems.push(`"${path.join('.')}" ${problem}`);
        } else if (name === undefined) {
            patch[key] = holder[field];
        } else {
            patch[key] = { ...(patch[key] as Record<string, unknown> | undefined), [name]: holder[field] };
        }
    }
    return { patch: patch as SettingsPatch, problems };
}

export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
    return {
        appearance: patch.appearance ?? settings.appearance,
        theme: { ...settings.theme, ...patch.theme },
        terminal: { ...settings.terminal, ...patch.terminal },
        ui: { ...settings.ui, ...patch.ui },
        sidebar: { ...settings.sidebar, ...patch.sidebar },
        editor: { ...settings.editor, ...patch.editor },
    };
}

export function parseSettings(raw: unknown): { settings: Settings; problems: string[] } {
    const { patch, problems } = readPatch(raw);
    return { settings: applySettingsPatch(DEFAULT_SETTINGS, patch), problems };
}

export function parseSettingsPatch(raw: unknown): { patch: SettingsPatch; problems: string[] } {
    return readPatch(raw);
}

export function settingsEdits(patch: SettingsPatch): { path: string[]; value: unknown }[] {
    const edits: { path: string[]; value: unknown }[] = [];
    for (const { path } of LEAVES) {
        const [key, name] = path;
        const holder = (name === undefined ? patch : patch[key as keyof SettingsPatch]) as Record<string, unknown> | undefined;
        const field = name ?? key;
        if (holder && holder[field] !== undefined) {
            edits.push({ path, value: holder[field] });
        }
    }
    return edits;
}
