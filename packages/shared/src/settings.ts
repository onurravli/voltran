export type Appearance = 'system' | 'dark' | 'light';
export type SidebarPosition = 'left' | 'right';
export type LineNumbers = 'on' | 'relative' | 'off';
export type CursorStyle = 'line' | 'block' | 'underline';
export type CursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
export type RenderWhitespace = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
export type LineHighlight = 'none' | 'gutter' | 'line' | 'all';
export type AutoSave = 'off' | 'afterDelay' | 'onFocusChange';

export interface Settings {
    appearance: Appearance;
    theme: { dark: string; light: string };
    terminal: { fontFamily: string; fontSize: number };
    ui: { fontFamily: string; fontSize: number };
    sidebar: { position: SidebarPosition };
    // The editor pane's font follows the terminal's while fontFamily is empty and fontSize null.
    editor: {
        command: string;
        fontFamily: string;
        fontSize: number | null;
        tabSize: number;
        wordWrap: boolean;
        minimap: boolean;
        lineNumbers: LineNumbers;
        lineHeight: number | null;
        fontLigatures: boolean;
        cursorStyle: CursorStyle;
        cursorBlinking: CursorBlinking;
        renderWhitespace: RenderWhitespace;
        renderLineHighlight: LineHighlight;
        rulers: number[];
        insertSpaces: boolean;
        detectIndentation: boolean;
        bracketPairColorization: boolean;
        autoClosingBrackets: boolean;
        quickSuggestions: boolean;
        folding: boolean;
        stickyScroll: boolean;
        smoothScrolling: boolean;
        scrollBeyondLastLine: boolean;
        trimTrailingWhitespace: boolean;
        insertFinalNewline: boolean;
        autoSave: AutoSave;
        autoSaveDelay: number;
    };
    git: { pullRequests: boolean };
    updates: { check: boolean };
}

export interface SettingsPatch {
    appearance?: Appearance;
    theme?: Partial<Settings['theme']>;
    terminal?: Partial<Settings['terminal']>;
    ui?: Partial<Settings['ui']>;
    sidebar?: Partial<Settings['sidebar']>;
    editor?: Partial<Settings['editor']>;
    git?: Partial<Settings['git']>;
    updates?: Partial<Settings['updates']>;
}

export interface SettingsState {
    settings: Settings;
    problems: string[];
    exists: boolean;
    path: string;
}

export const APPEARANCES: readonly Appearance[] = ['system', 'dark', 'light'];
export const SIDEBAR_POSITIONS: readonly SidebarPosition[] = ['left', 'right'];
export const LINE_NUMBERS: readonly LineNumbers[] = ['on', 'relative', 'off'];
export const CURSOR_STYLES: readonly CursorStyle[] = ['line', 'block', 'underline'];
export const CURSOR_BLINKING: readonly CursorBlinking[] = ['blink', 'smooth', 'phase', 'expand', 'solid'];
export const RENDER_WHITESPACE: readonly RenderWhitespace[] = ['none', 'boundary', 'selection', 'trailing', 'all'];
export const LINE_HIGHLIGHTS: readonly LineHighlight[] = ['none', 'gutter', 'line', 'all'];
export const AUTO_SAVES: readonly AutoSave[] = ['off', 'afterDelay', 'onFocusChange'];
export const DARK_THEME_IDS: readonly string[] = [
    'voltran',
    'tokyo-night',
    'catppuccin-mocha',
    'dracula',
    'nord',
    'gruvbox-dark',
    'one-dark',
    'rose-pine',
    'solarized-dark',
];
export const LIGHT_THEME_IDS: readonly string[] = [
    'voltran-light',
    'catppuccin-latte',
    'solarized-light',
    'github-light',
];
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;
export const MIN_UI_FONT_SIZE = 11;
export const MAX_UI_FONT_SIZE = 18;
export const MAX_FONT_FAMILY_LENGTH = 100;
export const MAX_EDITOR_COMMAND_LENGTH = 200;
export const MIN_TAB_SIZE = 1;
export const MAX_TAB_SIZE = 8;
export const MIN_LINE_HEIGHT = 1;
export const MAX_LINE_HEIGHT = 3;
export const MAX_RULERS = 10;
export const MAX_RULER_COLUMN = 500;
export const MIN_AUTO_SAVE_DELAY = 100;
export const MAX_AUTO_SAVE_DELAY = 60_000;

export const DEFAULT_SETTINGS: Settings = {
    appearance: 'system',
    theme: { dark: 'voltran', light: 'voltran-light' },
    terminal: { fontFamily: 'JetBrains Mono', fontSize: 13 },
    ui: { fontFamily: '', fontSize: 13 },
    sidebar: { position: 'left' },
    editor: {
        command: '',
        fontFamily: '',
        fontSize: null,
        tabSize: 4,
        wordWrap: false,
        minimap: false,
        lineNumbers: 'on',
        lineHeight: null,
        fontLigatures: false,
        cursorStyle: 'line',
        cursorBlinking: 'blink',
        renderWhitespace: 'selection',
        renderLineHighlight: 'gutter',
        rulers: [],
        insertSpaces: true,
        detectIndentation: true,
        bracketPairColorization: true,
        autoClosingBrackets: true,
        quickSuggestions: true,
        folding: true,
        stickyScroll: false,
        smoothScrolling: false,
        scrollBeyondLastLine: false,
        trimTrailingWhitespace: false,
        insertFinalNewline: false,
        autoSave: 'off',
        autoSaveDelay: 1000,
    },
    git: { pullRequests: true },
    updates: { check: true },
};

type Check = (value: unknown) => string | null;

const quoted = (options: readonly string[]): string => {
    const names = options.map((option) => `"${option}"`);
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

const oneOf =
    (options: readonly string[]): Check =>
    (value) =>
        typeof value === 'string' && options.includes(value) ? null : `must be ${quoted(options)}`;

const wholeNumber =
    (min: number, max: number): Check =>
    (value) =>
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

const editorFontFamily: Check = (value) =>
    typeof value === 'string' && value.length <= MAX_FONT_FAMILY_LENGTH
        ? null
        : `must be the name of a font, or empty for the terminal's, at most ${MAX_FONT_FAMILY_LENGTH} characters`;

const editorFontSize: Check = (value) =>
    value === null || wholeNumber(MIN_FONT_SIZE, MAX_FONT_SIZE)(value) === null
        ? null
        : `must be null for the terminal's size, or a whole number from ${MIN_FONT_SIZE} to ${MAX_FONT_SIZE}`;

const lineHeight: Check = (value) =>
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= MIN_LINE_HEIGHT && value <= MAX_LINE_HEIGHT)
        ? null
        : `must be null for the font's own, or a multiple of the font size from ${MIN_LINE_HEIGHT} to ${MAX_LINE_HEIGHT}`;

const rulers: Check = (value) =>
    Array.isArray(value) &&
    value.length <= MAX_RULERS &&
    value.every(
        (column) => typeof column === 'number' && Number.isInteger(column) && column >= 1 && column <= MAX_RULER_COLUMN,
    )
        ? null
        : `must be a list of at most ${MAX_RULERS} columns, each a whole number from 1 to ${MAX_RULER_COLUMN}`;

const flag: Check = (value) => (typeof value === 'boolean' ? null : 'must be true or false');

type Path = [string] | [string, string];

const LEAVES: { path: Path; check: Check }[] = [
    { path: ['appearance'], check: oneOf(APPEARANCES) },
    { path: ['theme', 'dark'], check: oneOf(DARK_THEME_IDS) },
    { path: ['theme', 'light'], check: oneOf(LIGHT_THEME_IDS) },
    { path: ['terminal', 'fontFamily'], check: fontFamily },
    { path: ['terminal', 'fontSize'], check: wholeNumber(MIN_FONT_SIZE, MAX_FONT_SIZE) },
    { path: ['ui', 'fontFamily'], check: uiFontFamily },
    { path: ['ui', 'fontSize'], check: wholeNumber(MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE) },
    { path: ['sidebar', 'position'], check: oneOf(SIDEBAR_POSITIONS) },
    { path: ['editor', 'command'], check: editorCommand },
    { path: ['editor', 'fontFamily'], check: editorFontFamily },
    { path: ['editor', 'fontSize'], check: editorFontSize },
    { path: ['editor', 'tabSize'], check: wholeNumber(MIN_TAB_SIZE, MAX_TAB_SIZE) },
    { path: ['editor', 'wordWrap'], check: flag },
    { path: ['editor', 'minimap'], check: flag },
    { path: ['editor', 'lineNumbers'], check: oneOf(LINE_NUMBERS) },
    { path: ['editor', 'lineHeight'], check: lineHeight },
    { path: ['editor', 'fontLigatures'], check: flag },
    { path: ['editor', 'cursorStyle'], check: oneOf(CURSOR_STYLES) },
    { path: ['editor', 'cursorBlinking'], check: oneOf(CURSOR_BLINKING) },
    { path: ['editor', 'renderWhitespace'], check: oneOf(RENDER_WHITESPACE) },
    { path: ['editor', 'renderLineHighlight'], check: oneOf(LINE_HIGHLIGHTS) },
    { path: ['editor', 'rulers'], check: rulers },
    { path: ['editor', 'insertSpaces'], check: flag },
    { path: ['editor', 'detectIndentation'], check: flag },
    { path: ['editor', 'bracketPairColorization'], check: flag },
    { path: ['editor', 'autoClosingBrackets'], check: flag },
    { path: ['editor', 'quickSuggestions'], check: flag },
    { path: ['editor', 'folding'], check: flag },
    { path: ['editor', 'stickyScroll'], check: flag },
    { path: ['editor', 'smoothScrolling'], check: flag },
    { path: ['editor', 'scrollBeyondLastLine'], check: flag },
    { path: ['editor', 'trimTrailingWhitespace'], check: flag },
    { path: ['editor', 'insertFinalNewline'], check: flag },
    { path: ['editor', 'autoSave'], check: oneOf(AUTO_SAVES) },
    { path: ['editor', 'autoSaveDelay'], check: wholeNumber(MIN_AUTO_SAVE_DELAY, MAX_AUTO_SAVE_DELAY) },
    { path: ['git', 'pullRequests'], check: flag },
    { path: ['updates', 'check'], check: flag },
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
        const holder = name === undefined ? raw : (section as Record<string, unknown>);
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
        git: { ...settings.git, ...patch.git },
        updates: { ...settings.updates, ...patch.updates },
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
        const holder = (name === undefined ? patch : patch[key as keyof SettingsPatch]) as
            | Record<string, unknown>
            | undefined;
        const field = name ?? key;
        if (holder && holder[field] !== undefined) {
            edits.push({ path, value: holder[field] });
        }
    }
    return edits;
}
