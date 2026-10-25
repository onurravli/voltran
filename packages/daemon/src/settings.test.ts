import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, type Settings, type SettingsState } from '@voltran/shared';
import { HttpError } from './hub.ts';
import { SettingsFile, editorCommand, settingsFileText } from './settings.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function setup(): { path: string; file: SettingsFile; changes: SettingsState[] } {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-settings-'));
    const path = join(dir, 'settings.json');
    const changes: SettingsState[] = [];
    const file = new SettingsFile(path, (state) => changes.push(state));
    cleanups.push(() => {
        file.close();
        rmSync(dir, { recursive: true, force: true });
    });
    return { path, file, changes };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('condition not met in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('SettingsFile', () => {
    it('uses the defaults while there is no file', () => {
        const { path, file } = setup();
        expect(file.state()).toEqual({ settings: DEFAULT_SETTINGS, problems: [], exists: false, path });
    });

    it('writes every setting, with what each accepts, the first time one changes', () => {
        const { path, file, changes } = setup();
        const state = file.update({ sidebar: { position: 'right' } });
        expect(state).toMatchObject({ exists: true, problems: [], settings: { ...DEFAULT_SETTINGS, sidebar: { position: 'right' } } });
        expect(changes).toEqual([state]);
        const text = readFileSync(path, 'utf8');
        expect(text).toBe(settingsFileText(state.settings));
        expect(text).toContain('// "left" or "right"');
        expect(text.endsWith('}\n')).toBe(true);
    });

    it('changes only the keys it is given and keeps the comments', () => {
        const { path, file } = setup();
        writeFileSync(path, '{\n    // mine\n    "appearance": "dark", // keep\n    "terminal": { "fontSize": 15 },\n}\n');
        file.update({ terminal: { fontFamily: 'Menlo' }, theme: { dark: 'nord' } });
        const text = readFileSync(path, 'utf8');
        expect(text).toContain('// mine');
        expect(text).toContain('"appearance": "dark", // keep');
        expect(parseSettings(parse(text, [], { allowTrailingComma: true })).settings).toMatchObject({
            appearance: 'dark',
            theme: { dark: 'nord' },
            terminal: { fontSize: 15, fontFamily: 'Menlo' },
        });
    });

    it('reloads when the file is edited on disk', async () => {
        const { path, file, changes } = setup();
        file.update({ appearance: 'light' });
        file.watch();
        // macOS can miss a change made in the first moments of a new watch; the daemon starts
        // watching at launch, long before anyone edits the file.
        await new Promise((resolve) => setTimeout(resolve, 100));
        writeFileSync(path, '{ "appearance": "dark", "terminal": { "fontSize": 99 } }\n');
        await until(() => changes.length === 2);
        expect(changes[1].settings.appearance).toBe('dark');
        expect(changes[1].settings.terminal.fontSize).toBe(DEFAULT_SETTINGS.terminal.fontSize);
        expect(changes[1].problems).toEqual(['"terminal.fontSize" must be a whole number from 9 to 28']);
    });

    it('keeps the last valid settings while the file is broken, and refuses to write into it', () => {
        const { path, file } = setup();
        writeFileSync(path, '{ "appearance": "light" }\n');
        expect(new SettingsFile(path, () => undefined).state().settings.appearance).toBe('light');
        file.update({ appearance: 'light' });
        writeFileSync(path, '{ "appearance": "dark",, }\n');
        const broken = new SettingsFile(path, () => undefined);
        expect(broken.state().problems).toEqual([expect.stringMatching(/^not valid JSON: .* at line 1, column \d+$/)]);
        expect(() => file.update({ appearance: 'dark' })).toThrow(HttpError);
        expect(readFileSync(path, 'utf8')).toBe('{ "appearance": "dark",, }\n');
    });

    it('treats an empty file as no settings', () => {
        const { path } = setup();
        writeFileSync(path, '\n');
        expect(new SettingsFile(path, () => undefined).state()).toMatchObject({ settings: DEFAULT_SETTINGS, problems: [], exists: true });
    });

    it('writes a template that reads back as the same settings', () => {
        const settings: Settings = {
            ...DEFAULT_SETTINGS,
            ui: { fontFamily: 'Inter', fontSize: 15 },
            editor: { command: 'nvim' },
            git: { pullRequests: false },
            push: { enabled: false, events: ['needs-input', 'done'], content: 'titles', delaySeconds: 90 },
        };
        expect(parseSettings(parse(settingsFileText(settings), [], { allowTrailingComma: true }))).toEqual({ settings, problems: [] });
    });

    it('creates the file on request without touching an existing one', () => {
        const { path, file } = setup();
        file.create();
        expect(readFileSync(path, 'utf8')).toBe(settingsFileText(DEFAULT_SETTINGS));
        writeFileSync(path, '{ "appearance": "dark" }\n');
        file.create();
        expect(readFileSync(path, 'utf8')).toBe('{ "appearance": "dark" }\n');
    });
});

describe('editorCommand', () => {
    it('runs the configured editor, then $VISUAL, then $EDITOR, then vim', () => {
        const env = { VISUAL: 'hx', EDITOR: 'nano' };
        expect(editorCommand(' nvim -p ', '/a/settings.json', env)).toBe("nvim -p '/a/settings.json'");
        expect(editorCommand('', '/a/settings.json', env)).toBe("hx '/a/settings.json'");
        expect(editorCommand('', '/a/settings.json', { EDITOR: 'nano' })).toBe("nano '/a/settings.json'");
        expect(editorCommand('', '/a/settings.json', {})).toBe("vim '/a/settings.json'");
    });

    it('quotes the path for the shell', () => {
        expect(editorCommand('vim', "/Users/o'neil/my home/settings.json", {})).toBe("vim '/Users/o'\\''neil/my home/settings.json'");
    });
});
