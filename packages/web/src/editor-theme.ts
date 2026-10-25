import type { Theme } from './themes.ts';

export interface EditorThemeRule {
    token: string;
    foreground?: string;
    fontStyle?: string;
}

export interface EditorThemeData {
    base: 'vs' | 'vs-dark';
    inherit: boolean;
    rules: EditorThemeRule[];
    colors: Record<string, string>;
}

function bare(color: string): string {
    return color.slice(1, 7);
}

function translucent(color: string, opacity: number): string {
    return `${color.slice(0, 7)}${Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0')}`;
}

export function editorTheme(theme: Theme): EditorThemeData {
    const { terminal, ui } = theme;
    return {
        base: theme.scheme === 'dark' ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
            { token: '', foreground: bare(terminal.foreground) },
            { token: 'comment', foreground: bare(terminal.brightBlack), fontStyle: 'italic' },
            { token: 'keyword', foreground: bare(terminal.magenta) },
            { token: 'string', foreground: bare(terminal.green) },
            { token: 'string.escape', foreground: bare(terminal.cyan) },
            { token: 'regexp', foreground: bare(terminal.red) },
            { token: 'number', foreground: bare(terminal.yellow) },
            { token: 'constant', foreground: bare(terminal.yellow) },
            { token: 'type', foreground: bare(terminal.cyan) },
            { token: 'annotation', foreground: bare(terminal.blue) },
            { token: 'tag', foreground: bare(terminal.red) },
            { token: 'metatag', foreground: bare(terminal.red) },
            { token: 'attribute.name', foreground: bare(terminal.yellow) },
            { token: 'attribute.value', foreground: bare(terminal.green) },
            { token: 'key', foreground: bare(terminal.blue) },
            { token: 'variable', foreground: bare(terminal.red) },
            { token: 'delimiter', foreground: bare(terminal.foreground) },
            { token: 'operator', foreground: bare(terminal.cyan) },
        ],
        colors: {
            'editor.background': ui['--bay'],
            'editor.foreground': terminal.foreground,
            'editorGutter.background': ui['--bay'],
            'editorLineNumber.foreground': ui['--text-faint'],
            'editorLineNumber.activeForeground': ui['--text-muted'],
            'editorCursor.foreground': terminal.cursor,
            'editor.selectionBackground': terminal.selectionBackground,
            'editor.lineHighlightBackground': '#00000000',
            'editor.lineHighlightBorder': '#00000000',
            'editorWidget.background': ui['--raised'],
            'editorWidget.foreground': ui['--text'],
            'editorWidget.border': ui['--rivet'],
            'input.background': ui['--bay'],
            'input.foreground': ui['--text'],
            focusBorder: ui['--focus'],
            'diffEditor.insertedTextBackground': translucent(ui['--live'], 0.24),
            'diffEditor.removedTextBackground': translucent(ui['--fault'], 0.24),
            'diffEditor.insertedLineBackground': translucent(ui['--live'], 0.11),
            'diffEditor.removedLineBackground': translucent(ui['--fault'], 0.11),
            'diffEditorGutter.insertedLineBackground': translucent(ui['--live'], 0.18),
            'diffEditorGutter.removedLineBackground': translucent(ui['--fault'], 0.18),
            'diffEditor.border': ui['--rivet'],
            'diffEditor.diagonalFill': translucent(ui['--rivet'], 0.5),
            'diffEditor.unchangedRegionBackground': ui['--hull'],
            'diffEditor.unchangedRegionForeground': ui['--text-muted'],
            'diffEditor.unchangedCodeBackground': '#00000000',
            'scrollbarSlider.background': translucent(ui['--rivet-strong'], 0.4),
            'scrollbarSlider.hoverBackground': translucent(ui['--rivet-strong'], 0.6),
            'scrollbarSlider.activeBackground': translucent(ui['--rivet-strong'], 0.8),
        },
    };
}
