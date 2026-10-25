import { describe, expect, it } from 'vitest';
import { editorTheme } from './editor-theme.ts';
import { THEMES } from './themes.ts';

describe('editorTheme', () => {
    it('gives the editor colours Monaco can read for every theme', () => {
        for (const theme of THEMES) {
            const data = editorTheme(theme);
            expect(data.base, theme.id).toBe(theme.scheme === 'dark' ? 'vs-dark' : 'vs');
            for (const [key, color] of Object.entries(data.colors)) {
                expect(color, `${theme.id} ${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
            }
            for (const rule of data.rules) {
                expect(rule.foreground, `${theme.id} ${rule.token}`).toMatch(/^[0-9a-f]{6}$/i);
            }
        }
    });

    it("draws added and removed lines in the theme's own status colours", () => {
        const [theme] = THEMES;
        const { colors } = editorTheme(theme);
        expect(colors['diffEditor.insertedLineBackground'].slice(0, 7)).toBe(theme.ui['--live']);
        expect(colors['diffEditor.removedLineBackground'].slice(0, 7)).toBe(theme.ui['--fault']);
        expect(colors['editor.background']).toBe(theme.ui['--bay']);
    });
});
