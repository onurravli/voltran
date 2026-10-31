import type {
    ChangeState,
    CursorBlinking,
    CursorStyle,
    LineHighlight,
    LineNumbers,
    RenderWhitespace,
    Settings,
} from '@voltran/shared';

export interface FileMatch {
    path: string;
    score: number;
    positions: number[];
}

function isBoundary(path: string, index: number): boolean {
    if (index === 0) {
        return true;
    }
    const before = path[index - 1];
    const char = path[index];
    return (
        before === '/' ||
        before === '-' ||
        before === '_' ||
        before === '.' ||
        before === ' ' ||
        (before === before.toLowerCase() && char !== char.toLowerCase())
    );
}

function subsequence(query: string, path: string, from: number): { score: number; positions: number[] } | null {
    const lower = path.toLowerCase();
    const positions: number[] = [];
    let score = 0;
    let at = from;
    for (const char of query) {
        const index = lower.indexOf(char, at);
        if (index < 0) {
            return null;
        }
        score += 1;
        if (positions.length > 0 && positions[positions.length - 1] === index - 1) {
            score += 4;
        }
        if (isBoundary(path, index)) {
            score += 3;
        }
        positions.push(index);
        at = index + 1;
    }
    return { score, positions };
}

// Matches the letters of the query in order, case-insensitively, preferring a match inside the file
// name, runs of letters and letters that start a word. Spaces in the query are ignored.
export function matchFile(rawQuery: string, path: string): FileMatch | null {
    const query = rawQuery.toLowerCase().replace(/\s+/g, '');
    if (!query) {
        return { path, score: 0, positions: [] };
    }
    const nameStart = path.lastIndexOf('/') + 1;
    const inName = subsequence(query, path, nameStart);
    if (inName) {
        const exact = path.slice(nameStart).toLowerCase().startsWith(query) ? 10 : 0;
        return { path, score: inName.score + 20 + exact - path.length / 100, positions: inName.positions };
    }
    const anywhere = subsequence(query, path, 0);
    return anywhere ? { path, score: anywhere.score - path.length / 100, positions: anywhere.positions } : null;
}

export function rankFiles(query: string, files: string[], limit = 60): FileMatch[] {
    const matches: FileMatch[] = [];
    for (const path of files) {
        const match = matchFile(query, path);
        if (match) {
            matches.push(match);
        }
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return matches.slice(0, limit);
}

// The tab of Voltran's own settings file. A path in the session's folder never starts with a slash,
// so this one cannot name a file there; it goes through the settings routes instead.
export const SETTINGS_TAB = '/settings.json';

export function isSettingsTab(path: string): boolean {
    return path === SETTINGS_TAB;
}

export function parentOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
}

export function nameOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, name: string): string {
    return dir ? `${dir}/${name}` : name;
}

export function isInside(path: string, dir: string): boolean {
    return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

// Where a path ends up when `from` is renamed to `to`: the path itself or anything inside it moves,
// and anything else stays where it is (null).
export function movedPath(path: string, from: string, to: string): string | null {
    if (path === from) {
        return to;
    }
    return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

// A name typed into the tree; it may hold slashes, which create the folders on the way.
export function nameProblem(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
        return 'Type a name';
    }
    if (trimmed.startsWith('/') || trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        return 'A name cannot start with / or hold empty, . or .. parts';
    }
    return null;
}

// Whether two folders of a tree show different things, ignoring the order the server sent them in.
export function sameListing<T>(a: T, b: T): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export interface EditorMemory {
    tabs: string[];
    active: string | null;
    expanded: string[];
    treeWidth: number;
    treeHidden: boolean;
}

export const DEFAULT_TREE_WIDTH = 240;
export const MIN_TREE_WIDTH = 140;
export const MAX_TREE_WIDTH = 640;

const MAX_REMEMBERED = 50;

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_REMEMBERED * 4)
        : [];
}

export function parseMemory(raw: string | null): EditorMemory {
    let value: Record<string, unknown> = {};
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            value = parsed as Record<string, unknown>;
        }
    } catch {
        value = {};
    }
    const tabs = [...new Set(strings(value.tabs))].slice(0, MAX_REMEMBERED);
    const width =
        typeof value.treeWidth === 'number' && Number.isFinite(value.treeWidth) ? value.treeWidth : DEFAULT_TREE_WIDTH;
    return {
        tabs,
        active: typeof value.active === 'string' && tabs.includes(value.active) ? value.active : (tabs[0] ?? null),
        expanded: [...new Set(strings(value.expanded))],
        treeWidth: Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, Math.round(width))),
        treeHidden: value.treeHidden === true,
    };
}

export function memoryKey(paneId: string): string {
    return `voltran.editor.${paneId}`;
}

// How many unsaved files each editor pane holds, so closing a pane or the window can ask first.
const unsaved = new Map<string, number>();

export function setUnsaved(paneId: string, count: number): void {
    if (count > 0) {
        unsaved.set(paneId, count);
    } else {
        unsaved.delete(paneId);
    }
}

export function unsavedIn(paneId: string): number {
    return unsaved.get(paneId) ?? 0;
}

export function anyUnsaved(): boolean {
    return unsaved.size > 0;
}

export interface ChordInput {
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

export type EditorCommand = 'save' | 'saveAll' | 'quickOpen' | 'toggleTree' | 'closeTab' | 'nextTab' | 'previousTab';

// The editor's own keys, which it handles before Monaco does. ⌘W, ⌃Tab and their like belong to the
// browser, so a tab closes with ⌃W on a Mac and Alt+W elsewhere, and tabs step with ⌥⌘←/→ or
// Ctrl+Alt+PageUp/PageDown (Ctrl+Alt+arrows move between panes there).
export function editorCommand(event: ChordInput, mac: boolean): EditorCommand | null {
    const { code, metaKey, ctrlKey, altKey, shiftKey } = event;
    const primary = mac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
    if (primary && !shiftKey) {
        if (code === 'KeyS') {
            return altKey ? 'saveAll' : 'save';
        }
        if (!altKey && code === 'KeyP') {
            return 'quickOpen';
        }
        if (!altKey && code === 'KeyB') {
            return 'toggleTree';
        }
    }
    const close = mac ? ctrlKey && !metaKey && !altKey : altKey && !ctrlKey && !metaKey;
    if (close && !shiftKey && code === 'KeyW') {
        return 'closeTab';
    }
    const step = mac ? metaKey && altKey && !ctrlKey : ctrlKey && altKey && !metaKey;
    if (step && !shiftKey) {
        if (code === (mac ? 'ArrowRight' : 'PageDown')) {
            return 'nextTab';
        }
        if (code === (mac ? 'ArrowLeft' : 'PageUp')) {
            return 'previousTab';
        }
    }
    return null;
}

export function editorKeys(mac: boolean): { keys: string; label: string }[] {
    const pick = (onMac: string, elsewhere: string): string => (mac ? onMac : elsewhere);
    return [
        { keys: pick('⌘S', 'Ctrl+S'), label: 'Save the file' },
        { keys: pick('⌥⌘S', 'Ctrl+Alt+S'), label: 'Save every file' },
        { keys: pick('⌘P', 'Ctrl+P'), label: 'Open a file by name' },
        { keys: pick('⌘B', 'Ctrl+B'), label: 'Show or hide the file tree' },
        { keys: pick('⌃W', 'Alt+W'), label: 'Close the tab' },
        { keys: pick('⌥⌘← / ⌥⌘→', 'Ctrl+Alt+PageUp / PageDown'), label: 'Previous / next tab' },
        { keys: pick('⌘F / ⌥⌘F', 'Ctrl+F / Ctrl+H'), label: 'Find / replace in the file' },
        { keys: pick('⌘/', 'Ctrl+/'), label: 'Comment the line' },
        { keys: 'F1', label: "Every command of the editor's own" },
    ];
}

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

// The one edit that turns `before` into `after`: what lies between their common start and end. Applied
// to an open file, it leaves the cursor and the undo history of the untouched parts alone.
export function minimalEdit(before: string, after: string): TextEdit | null {
    if (before === after) {
        return null;
    }
    let start = 0;
    const shorter = Math.min(before.length, after.length);
    while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) {
        start++;
    }
    let end = 0;
    while (
        end < shorter - start &&
        before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
    ) {
        end++;
    }
    return { start, end: before.length - end, text: after.slice(start, after.length - end) };
}

export interface ChangedPath {
    path: string;
    state: ChangeState;
}

const FOLDER_RANK: Record<ChangeState, number> = {
    conflicted: 3,
    modified: 2,
    deleted: 2,
    renamed: 2,
    added: 1,
    untracked: 1,
};

function folderState(state: ChangeState): ChangeState {
    return state === 'deleted' || state === 'renamed' ? 'modified' : state;
}

// The git state of each changed path inside the session's folder, relative to it as the tree is, and
// of every folder above one: the strongest state of anything in it, a conflict first, then a change.
export function gitMarks(prefix: string, files: ChangedPath[]): Record<string, ChangeState> {
    const marks: Record<string, ChangeState> = {};
    for (const file of files) {
        if (!file.path.startsWith(prefix)) {
            continue;
        }
        const path = file.path.slice(prefix.length);
        marks[path] = file.state;
        const state = folderState(file.state);
        for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) {
            const current = marks[dir];
            if (current && FOLDER_RANK[current] >= FOLDER_RANK[state]) {
                break;
            }
            marks[dir] = state;
        }
    }
    return marks;
}

export interface EditorViewOptions {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    fontLigatures: boolean;
    wordWrap: 'on' | 'off';
    minimap: { enabled: boolean };
    lineNumbers: LineNumbers;
    cursorStyle: CursorStyle;
    cursorBlinking: CursorBlinking;
    renderWhitespace: RenderWhitespace;
    renderLineHighlight: LineHighlight;
    rulers: number[];
    bracketPairColorization: { enabled: boolean };
    autoClosingBrackets: 'languageDefined' | 'never';
    autoClosingQuotes: 'languageDefined' | 'never';
    quickSuggestions: boolean;
    folding: boolean;
    stickyScroll: { enabled: boolean };
    smoothScrolling: boolean;
    scrollBeyondLastLine: boolean;
}

// The editor pane's settings as Monaco takes them; an empty font or a null size is the terminal's,
// and a null line height (0 to Monaco) the font's own.
export function editorOptions(
    editor: Settings['editor'],
    terminal: { family: string; size: number },
): EditorViewOptions {
    const closing = editor.autoClosingBrackets ? 'languageDefined' : 'never';
    return {
        fontFamily: editor.fontFamily.trim() || terminal.family,
        fontSize: editor.fontSize ?? terminal.size,
        lineHeight: editor.lineHeight ?? 0,
        fontLigatures: editor.fontLigatures,
        wordWrap: editor.wordWrap ? 'on' : 'off',
        minimap: { enabled: editor.minimap },
        lineNumbers: editor.lineNumbers,
        cursorStyle: editor.cursorStyle,
        cursorBlinking: editor.cursorBlinking,
        renderWhitespace: editor.renderWhitespace,
        renderLineHighlight: editor.renderLineHighlight,
        rulers: editor.rulers,
        bracketPairColorization: { enabled: editor.bracketPairColorization },
        autoClosingBrackets: closing,
        autoClosingQuotes: closing,
        quickSuggestions: editor.quickSuggestions,
        folding: editor.folding,
        stickyScroll: { enabled: editor.stickyScroll },
        smoothScrolling: editor.smoothScrolling,
        scrollBeyondLastLine: editor.scrollBeyondLastLine,
    };
}

// What a save does to the text first: spaces and tabs at the ends of lines go, and the file ends
// with a newline in the line ending it already uses.
export function cleanOnSave(
    text: string,
    options: { trimTrailingWhitespace: boolean; insertFinalNewline: boolean },
): string {
    let next = options.trimTrailingWhitespace ? text.replace(/[ \t]+(?=\r?\n|$)/g, '') : text;
    if (options.insertFinalNewline && next !== '' && !next.endsWith('\n')) {
        next += next.includes('\r\n') ? '\r\n' : '\n';
    }
    return next;
}
