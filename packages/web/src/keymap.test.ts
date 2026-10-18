import { describe, expect, it } from 'vitest';
import { isPrimaryChord, keyLabel, translateKey, type KeyInput } from './keymap.ts';

type Modifiers = Partial<Omit<KeyInput, 'key'>>;

function press(key: string, modifiers: Modifiers = {}): string | null {
    return translateKey({ key, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...modifiers });
}

describe('translateKey', () => {
    it.each([
        ['⌘←', 'ArrowLeft', { metaKey: true }, '\x01'],
        ['⌘→', 'ArrowRight', { metaKey: true }, '\x05'],
        ['⌥←', 'ArrowLeft', { altKey: true }, '\x1bb'],
        ['⌥→', 'ArrowRight', { altKey: true }, '\x1bf'],
        ['⌘⌫', 'Backspace', { metaKey: true }, '\x15'],
        ['⌥⌫', 'Backspace', { altKey: true }, '\x1b\x7f'],
        ['⌘⌦', 'Delete', { metaKey: true }, '\x0b'],
        ['⌥⌦', 'Delete', { altKey: true }, '\x1bd'],
        ['⇧↩', 'Enter', { shiftKey: true }, '\x1b\r'],
        ['⌥↩', 'Enter', { altKey: true }, '\x1b\r'],
    ] as const)('sends the line-editing bytes for %s', (_label, key, modifiers, expected) => {
        expect(press(key, modifiers)).toBe(expected);
    });

    it.each([
        ['plain ←', 'ArrowLeft', {}],
        ['plain →', 'ArrowRight', {}],
        ['plain ↑', 'ArrowUp', {}],
        ['plain ↓', 'ArrowDown', {}],
        ['⇧←', 'ArrowLeft', { shiftKey: true }],
        ['⇧→', 'ArrowRight', { shiftKey: true }],
        ['⇧⌥←', 'ArrowLeft', { shiftKey: true, altKey: true }],
        ['⇧⌘→', 'ArrowRight', { shiftKey: true, metaKey: true }],
        ['⌃←', 'ArrowLeft', { ctrlKey: true }],
        ['⌘↑', 'ArrowUp', { metaKey: true }],
        ['⌘↓', 'ArrowDown', { metaKey: true }],
        ['⌃⌥↑', 'ArrowUp', { ctrlKey: true, altKey: true }],
        ['⌃⌥↓', 'ArrowDown', { ctrlKey: true, altKey: true }],
        ['⌃⌥←', 'ArrowLeft', { ctrlKey: true, altKey: true }],
        ['⌃⌥↩', 'Enter', { ctrlKey: true, altKey: true }],
        ['⌃⌥J', 'j', { ctrlKey: true, altKey: true }],
        ['⌃⌥⌫', 'Backspace', { ctrlKey: true, altKey: true }],
        ['⌘⌥←', 'ArrowLeft', { metaKey: true, altKey: true }],
        ['plain ⌫', 'Backspace', {}],
        ['⌃⌫', 'Backspace', { ctrlKey: true }],
        ['plain ⌦', 'Delete', {}],
        ['plain ↩', 'Enter', {}],
        ['⌘↩', 'Enter', { metaKey: true }],
        ['⌘C', 'c', { metaKey: true }],
        ['⌘V', 'v', { metaKey: true }],
        ['⌘A', 'a', { metaKey: true }],
        ['⌘K', 'k', { metaKey: true }],
        ['⌥B', 'b', { altKey: true }],
        ['a', 'a', {}],
    ] as const)('leaves %s to xterm and the browser', (_label, key, modifiers) => {
        expect(press(key, modifiers)).toBeNull();
    });
});

describe('isPrimaryChord', () => {
    const chord = (modifiers: Modifiers): KeyInput => ({ key: 'k', metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...modifiers });

    it('is ⌘ alone on a Mac and Ctrl+Shift elsewhere', () => {
        expect(isPrimaryChord(chord({ metaKey: true }), true)).toBe(true);
        expect(isPrimaryChord(chord({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
        expect(isPrimaryChord(chord({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
        expect(isPrimaryChord(chord({ metaKey: true }), false)).toBe(false);
        expect(isPrimaryChord(chord({ ctrlKey: true }), false)).toBe(false);
        expect(isPrimaryChord(chord({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
    });
});

describe('keyLabel', () => {
    it.each([
        ['⌃⌥J', 'Ctrl+Alt+J'],
        ['⌃⌥↑', 'Ctrl+Alt+↑'],
        ['⌃⌥↩', 'Ctrl+Alt+Enter'],
        ['⌘K', 'Ctrl+Shift+K'],
        ['⇧Esc', 'Shift+Esc'],
    ])('names %s as %s off a Mac', (keys, expected) => {
        expect(keyLabel(keys, false)).toBe(expected);
        expect(keyLabel(keys, true)).toBe(keys);
    });
});
