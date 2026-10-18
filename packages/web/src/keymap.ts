export type KeyInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'altKey' | 'ctrlKey' | 'shiftKey'>;

// Bytes follow iTerm2's "Natural Text Editing" key preset, so shell and agent CLI line editing behaves as in iTerm2.
const SEQUENCES = new Map<string, string>([
    // Meta+Enter: agent CLIs read it as "insert newline".
    ['Shift+Enter', '\x1b\r'],
    ['Alt+Enter', '\x1b\r'],
    ['Meta+ArrowLeft', '\x01'],
    ['Meta+ArrowRight', '\x05'],
    ['Alt+ArrowLeft', '\x1bb'],
    ['Alt+ArrowRight', '\x1bf'],
    ['Meta+Backspace', '\x15'],
    ['Alt+Backspace', '\x1b\x7f'],
    // Not in the iTerm2 preset: the forward twin of Meta+Backspace, Ctrl+K (kill to end of line).
    ['Meta+Delete', '\x0b'],
    ['Alt+Delete', '\x1bd'],
]);

function chord(event: KeyInput): string {
    const parts: string[] = [];
    if (event.ctrlKey) {
        parts.push('Ctrl');
    }
    if (event.altKey) {
        parts.push('Alt');
    }
    if (event.shiftKey) {
        parts.push('Shift');
    }
    if (event.metaKey) {
        parts.push('Meta');
    }
    parts.push(event.key);
    return parts.join('+');
}

export function translateKey(event: KeyInput): string | null {
    return SEQUENCES.get(chord(event)) ?? null;
}

// Elsewhere ⌘ is the Super key, which the desktop keeps for itself, so the shortcuts that use ⌘ on a
// Mac use Ctrl+Shift there, as Linux terminals do: plain Ctrl+K and Ctrl+F belong to the terminal.
export function isPrimaryChord(event: KeyInput, mac: boolean): boolean {
    return mac
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}

const KEY_NAMES: [string, string][] = [['⌃', 'Ctrl+'], ['⌥', 'Alt+'], ['⇧', 'Shift+'], ['⌘', 'Ctrl+Shift+'], ['↩', 'Enter'], ['⌫', 'Backspace']];

export function keyLabel(keys: string, mac: boolean): string {
    return mac ? keys : KEY_NAMES.reduce((label, [glyph, name]) => label.replaceAll(glyph, name), keys);
}
