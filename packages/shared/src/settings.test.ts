import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    MAX_EDITOR_COMMAND_LENGTH,
    MAX_FONT_FAMILY_LENGTH,
    MAX_FONT_SIZE,
    MAX_UI_FONT_SIZE,
    MIN_UI_FONT_SIZE,
    applySettingsPatch,
    parseSettings,
    parseSettingsPatch,
    settingsEdits,
} from './settings.ts';

describe('parseSettings', () => {
    it('reads every setting from nested sections', () => {
        const raw = {
            appearance: 'dark',
            theme: { dark: 'nord', light: 'solarized-light' },
            terminal: { fontFamily: 'Menlo', fontSize: 15 },
            ui: { fontFamily: 'Inter', fontSize: 14 },
            sidebar: { position: 'right' },
            editor: {
                command: 'nvim -p',
                fontFamily: 'Fira Code',
                fontSize: 14,
                tabSize: 2,
                wordWrap: true,
                minimap: true,
                lineNumbers: 'relative',
                lineHeight: 1.5,
                fontLigatures: true,
                cursorStyle: 'block',
                cursorBlinking: 'solid',
                renderWhitespace: 'all',
                renderLineHighlight: 'line',
                rulers: [80, 120],
                insertSpaces: false,
                detectIndentation: false,
                bracketPairColorization: false,
                autoClosingBrackets: false,
                quickSuggestions: false,
                folding: false,
                stickyScroll: true,
                smoothScrolling: true,
                scrollBeyondLastLine: true,
                trimTrailingWhitespace: true,
                insertFinalNewline: true,
                autoSave: 'afterDelay',
                autoSaveDelay: 500,
            },
            git: { pullRequests: false },
            updates: { check: false },
        };
        expect(parseSettings(raw)).toEqual({ settings: raw, problems: [] });
    });

    it('fills what is missing with the defaults', () => {
        expect(parseSettings({})).toEqual({ settings: DEFAULT_SETTINGS, problems: [] });
        expect(parseSettings({ terminal: { fontSize: 16 } }).settings).toEqual({
            ...DEFAULT_SETTINGS,
            terminal: { ...DEFAULT_SETTINGS.terminal, fontSize: 16 },
        });
    });

    it('keeps the default for each invalid value and says why', () => {
        const { settings, problems } = parseSettings({
            appearance: 'dim',
            theme: { dark: 'github-light' },
            terminal: { fontSize: '15', fontFamily: '  ' },
            ui: { fontFamily: 12, fontSize: 24 },
            sidebar: { position: 'top' },
            editor: { command: 'vim\nrm -rf ~' },
            git: { pullRequests: 'no' },
        });
        expect(settings).toEqual(DEFAULT_SETTINGS);
        expect(problems).toEqual([
            '"appearance" must be "system", "dark" or "light"',
            expect.stringMatching(/^"theme\.dark" must be "voltran", .* or "solarized-dark"$/),
            expect.stringMatching(/^"terminal\.fontFamily" must be the name of a font/),
            `"terminal.fontSize" must be a whole number from 9 to ${MAX_FONT_SIZE}`,
            expect.stringMatching(/^"ui\.fontFamily" must be the name of a font, or empty for the system font/),
            `"ui.fontSize" must be a whole number from ${MIN_UI_FONT_SIZE} to ${MAX_UI_FONT_SIZE}`,
            '"sidebar.position" must be "left" or "right"',
            `"editor.command" must be a command on one line, at most ${MAX_EDITOR_COMMAND_LENGTH} characters`,
            '"git.pullRequests" must be true or false',
        ]);
    });

    it('checks the rest of the editor options', () => {
        const { settings, problems } = parseSettings({
            editor: {
                lineHeight: 5,
                cursorStyle: 'beam',
                renderWhitespace: true,
                rulers: [80, 0],
                autoSave: 'always',
                autoSaveDelay: 10,
            },
        });
        expect(settings).toEqual(DEFAULT_SETTINGS);
        expect(problems).toEqual([
            '"editor.lineHeight" must be null for the font\'s own, or a multiple of the font size from 1 to 3',
            '"editor.cursorStyle" must be "line", "block" or "underline"',
            '"editor.renderWhitespace" must be "none", "boundary", "selection", "trailing" or "all"',
            '"editor.rulers" must be a list of at most 10 columns, each a whole number from 1 to 500',
            '"editor.autoSave" must be "off", "afterDelay" or "onFocusChange"',
            '"editor.autoSaveDelay" must be a whole number from 100 to 60000',
        ]);
        expect(
            parseSettings({ editor: { rulers: Array.from({ length: 11 }, (_, index) => index + 1) } }).problems,
        ).toHaveLength(1);
    });

    it("lets the editor pane follow the terminal's font, and checks its own options", () => {
        expect(parseSettings({ editor: { fontFamily: '', fontSize: null } })).toEqual({
            settings: DEFAULT_SETTINGS,
            problems: [],
        });
        const { settings, problems } = parseSettings({
            editor: { fontSize: 40, tabSize: 0, wordWrap: 'on', minimap: 1, lineNumbers: 'interval' },
        });
        expect(settings).toEqual(DEFAULT_SETTINGS);
        expect(problems).toEqual([
            `"editor.fontSize" must be null for the terminal's size, or a whole number from 9 to ${MAX_FONT_SIZE}`,
            '"editor.tabSize" must be a whole number from 1 to 8',
            '"editor.wordWrap" must be true or false',
            '"editor.minimap" must be true or false',
            '"editor.lineNumbers" must be "on", "relative" or "off"',
        ]);
    });

    it('accepts an empty editor command, which means the default editor, and rejects a long one', () => {
        expect(parseSettings({ editor: { command: '' } })).toEqual({ settings: DEFAULT_SETTINGS, problems: [] });
        expect(parseSettings({ editor: { command: 'x'.repeat(MAX_EDITOR_COMMAND_LENGTH + 1) } }).problems).toHaveLength(
            1,
        );
    });

    it('rejects font sizes outside the range and fractions', () => {
        for (const fontSize of [8, MAX_FONT_SIZE + 1, 13.5, Number.NaN]) {
            expect(parseSettings({ terminal: { fontSize } }).settings.terminal.fontSize).toBe(
                DEFAULT_SETTINGS.terminal.fontSize,
            );
        }
    });

    it('accepts an empty UI font family, which means the system font, and its own size range', () => {
        expect(parseSettings({ ui: { fontFamily: '' } })).toEqual({ settings: DEFAULT_SETTINGS, problems: [] });
        expect(parseSettings({ ui: { fontFamily: 'x'.repeat(MAX_FONT_FAMILY_LENGTH + 1) } }).problems).toHaveLength(1);
        for (const fontSize of [MIN_UI_FONT_SIZE - 1, MAX_UI_FONT_SIZE + 1, 13.5]) {
            expect(parseSettings({ ui: { fontSize } }).settings.ui.fontSize).toBe(DEFAULT_SETTINGS.ui.fontSize);
        }
        expect(parseSettings({ ui: { fontSize: MAX_UI_FONT_SIZE } }).settings.ui.fontSize).toBe(MAX_UI_FONT_SIZE);
    });

    it('names unknown settings and sections that are not objects', () => {
        expect(parseSettings({ termnal: { fontSize: 14 }, terminal: { size: 14 }, theme: 'nord' }).problems).toEqual([
            'unknown setting "termnal"',
            'unknown setting "terminal.size"',
            '"theme" must be an object',
        ]);
    });

    it('treats anything but an object as no settings', () => {
        for (const raw of [null, [], 'dark', 3]) {
            expect(parseSettings(raw)).toEqual({
                settings: DEFAULT_SETTINGS,
                problems: ['the settings must be an object'],
            });
        }
    });
});

describe('parseSettingsPatch', () => {
    it('keeps only what was sent', () => {
        expect(parseSettingsPatch({ terminal: { fontSize: 14 } })).toEqual({
            patch: { terminal: { fontSize: 14 } },
            problems: [],
        });
    });

    it('reports invalid values instead of dropping them silently', () => {
        expect(parseSettingsPatch({ sidebar: { position: 'top' } }).problems).toEqual([
            '"sidebar.position" must be "left" or "right"',
        ]);
    });
});

describe('applySettingsPatch', () => {
    it('changes only the patched settings', () => {
        expect(applySettingsPatch(DEFAULT_SETTINGS, { theme: { light: 'solarized-light' } })).toEqual({
            ...DEFAULT_SETTINGS,
            theme: { dark: DEFAULT_SETTINGS.theme.dark, light: 'solarized-light' },
        });
    });
});

describe('settingsEdits', () => {
    it('lists one path per patched setting', () => {
        expect(settingsEdits({ appearance: 'light', terminal: { fontFamily: 'Menlo', fontSize: 12 } })).toEqual([
            { path: ['appearance'], value: 'light' },
            { path: ['terminal', 'fontFamily'], value: 'Menlo' },
            { path: ['terminal', 'fontSize'], value: 12 },
        ]);
        expect(settingsEdits({})).toEqual([]);
    });
});
