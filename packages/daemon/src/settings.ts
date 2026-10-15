import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import {
    DARK_THEME_IDS,
    DEFAULT_SETTINGS,
    LIGHT_THEME_IDS,
    MAX_FONT_SIZE,
    MAX_UI_FONT_SIZE,
    MIN_FONT_SIZE,
    MIN_UI_FONT_SIZE,
    applySettingsPatch,
    parseSettings,
    settingsEdits,
    type Settings,
    type SettingsPatch,
    type SettingsState,
} from '@voltran/shared';
import { HttpError } from './hub.ts';

const RELOAD_DELAY_MS = 50;
const FORMATTING = { insertSpaces: true, tabSize: 4, eol: '\n' };

const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(', ');

export function settingsFileText(settings: Settings): string {
    return [
        '// Voltran settings. Saving this file applies it to every open window.',
        '{',
        '    // "system", "dark" or "light"',
        `    "appearance": ${JSON.stringify(settings.appearance)},`,
        '    "theme": {',
        `        // ${quoted(DARK_THEME_IDS)}`,
        `        "dark": ${JSON.stringify(settings.theme.dark)},`,
        `        // ${quoted(LIGHT_THEME_IDS)}`,
        `        "light": ${JSON.stringify(settings.theme.light)}`,
        '    },',
        '    "terminal": {',
        '        // the name of any installed font',
        `        "fontFamily": ${JSON.stringify(settings.terminal.fontFamily)},`,
        `        // ${MIN_FONT_SIZE} to ${MAX_FONT_SIZE}`,
        `        "fontSize": ${settings.terminal.fontSize}`,
        '    },',
        '    "ui": {',
        '        // the name of any installed font, or empty for the system font',
        `        "fontFamily": ${JSON.stringify(settings.ui.fontFamily)},`,
        `        // ${MIN_UI_FONT_SIZE} to ${MAX_UI_FONT_SIZE}`,
        `        "fontSize": ${settings.ui.fontSize}`,
        '    },',
        '    "sidebar": {',
        '        // "left" or "right"',
        `        "position": ${JSON.stringify(settings.sidebar.position)}`,
        '    },',
        '    "editor": {',
        '        // what "Open the settings file" runs inside Voltran, such as "nvim"',
        '        // empty uses $VISUAL, then $EDITOR, then vim',
        `        "command": ${JSON.stringify(settings.editor.command)}`,
        '    },',
        '    "git": {',
        '        // look up the pull request of each session\'s branch with the GitHub CLI (gh)',
        `        "pullRequests": ${settings.git.pullRequests}`,
        '    }',
        '}',
        '',
    ].join('\n');
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

export function editorCommand(editor: string, path: string, env: NodeJS.ProcessEnv): string {
    return `${editor.trim() || env.VISUAL || env.EDITOR || 'vim'} ${shellQuote(path)}`;
}

function parseText(text: string): { raw: unknown; error: string | null } {
    if (!text.trim()) {
        return { raw: {}, error: null };
    }
    const errors: ParseError[] = [];
    const raw = parse(text, errors, { allowTrailingComma: true });
    if (errors.length === 0) {
        return { raw, error: null };
    }
    const before = text.slice(0, errors[0].offset).split('\n');
    return { raw: null, error: `not valid JSON: ${printParseErrorCode(errors[0].error)} at line ${before.length}, column ${before[before.length - 1].length + 1}` };
}

// The file is the source of truth: the daemon reloads it whenever it changes on disk and writes a
// change made in the UI back into it, editing only the keys that changed so comments survive.
export class SettingsFile {
    readonly path: string;
    private current: SettingsState;
    private lastValid: Settings = DEFAULT_SETTINGS;
    private watcher: FSWatcher | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly onChange: (state: SettingsState) => void;

    constructor(path: string, onChange: (state: SettingsState) => void) {
        this.path = path;
        this.onChange = onChange;
        this.current = this.read();
    }

    state(): SettingsState {
        return this.current;
    }

    update(patch: SettingsPatch): SettingsState {
        const text = existsSync(this.path) ? readFileSync(this.path, 'utf8') : null;
        if (text === null) {
            this.write(settingsFileText(applySettingsPatch(this.current.settings, patch)));
        } else {
            const { raw, error } = parseText(text);
            if (error) {
                throw new HttpError(409, `${this.path} is ${error}. Fix it first.`);
            }
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new HttpError(409, `${this.path} must hold an object. Fix it first.`);
            }
            let next = text.trim() ? text : '{}\n';
            for (const { path, value } of settingsEdits(patch)) {
                next = applyEdits(next, modify(next, path, value, { formattingOptions: FORMATTING }));
            }
            this.write(next);
        }
        this.reload();
        return this.current;
    }

    create(): void {
        if (!existsSync(this.path)) {
            this.write(settingsFileText(this.current.settings));
            this.reload();
        }
    }

    // Editors save by replacing the file, so the folder is watched rather than the file itself.
    watch(): void {
        this.watcher = watch(dirname(this.path), (_event, name) => {
            if (name !== null && name !== basename(this.path)) {
                return;
            }
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.timer = setTimeout(() => {
                this.timer = null;
                this.reload();
            }, RELOAD_DELAY_MS);
        });
        this.watcher.on('error', () => this.close());
    }

    close(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.watcher?.close();
        this.watcher = null;
    }

    private reload(): void {
        const next = this.read();
        if (JSON.stringify(next) !== JSON.stringify(this.current)) {
            this.current = next;
            this.onChange(next);
        }
    }

    private read(): SettingsState {
        if (!existsSync(this.path)) {
            this.lastValid = DEFAULT_SETTINGS;
            return { settings: DEFAULT_SETTINGS, problems: [], exists: false, path: this.path };
        }
        let text: string;
        try {
            text = readFileSync(this.path, 'utf8');
        } catch (error) {
            return { settings: this.lastValid, problems: [`could not be read: ${error instanceof Error ? error.message : error}`], exists: true, path: this.path };
        }
        const { raw, error } = parseText(text);
        if (error) {
            return { settings: this.lastValid, problems: [error], exists: true, path: this.path };
        }
        const { settings, problems } = parseSettings(raw);
        this.lastValid = settings;
        return { settings, problems, exists: true, path: this.path };
    }

    private write(text: string): void {
        const temporary = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, this.path);
    }
}
