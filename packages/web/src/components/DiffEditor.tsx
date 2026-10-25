import { useEffect, useRef, useState } from 'react';
import type { FileContents } from '@voltran/shared';
import { editorTheme } from '../editor-theme.ts';
import { fontStack } from '../fonts.ts';
import { activeThemeId, useUi } from '../store.ts';
import { themeById } from '../themes.ts';

type Monaco = typeof import('../monaco.ts').monaco;
type DiffWidget = ReturnType<Monaco['editor']['createDiffEditor']>;

export interface DiffStat {
    added: number;
    removed: number;
}

let loading: Promise<Monaco> | null = null;
let editors = 0;

function loadMonaco(): Promise<Monaco> {
    loading ??= import('../monaco.ts').then((module) => module.monaco);
    loading.catch(() => {
        loading = null;
    });
    return loading;
}

function lineCount(start: number, end: number): number {
    return end === 0 ? 0 : end - start + 1;
}

function lines(text: string): number {
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Monaco counts the empty line after a final newline, so a file with only one side is counted here.
function diffStat(widget: DiffWidget, contents: FileContents): DiffStat | null {
    if (contents.original === null || contents.modified === null) {
        return { added: lines(contents.modified ?? ''), removed: lines(contents.original ?? '') };
    }
    const changes = widget.getLineChanges();
    if (!changes) {
        return null;
    }
    return changes.reduce(
        (stat, change) => ({
            added: stat.added + lineCount(change.modifiedStartLineNumber, change.modifiedEndLineNumber),
            removed: stat.removed + lineCount(change.originalStartLineNumber, change.originalEndLineNumber),
        }),
        { added: 0, removed: 0 },
    );
}

export function DiffEditor({ contents, onStat }: { contents: FileContents; onStat: (stat: DiffStat | null) => void }) {
    const host = useRef<HTMLDivElement>(null);
    const [monaco, setMonaco] = useState<Monaco | null>(null);
    const [widget, setWidget] = useState<DiffWidget | null>(null);
    const [failed, setFailed] = useState(false);
    const themeId = useUi(activeThemeId);
    const font = useUi((state) => state.terminalFont);
    const id = useRef(0);
    const reportStat = useRef(onStat);
    reportStat.current = onStat;
    const shown = useRef(contents);
    shown.current = contents;

    useEffect(() => {
        let current = true;
        loadMonaco()
            .then((loaded) => current && setMonaco(loaded))
            .catch(() => current && setFailed(true));
        return () => {
            current = false;
        };
    }, []);

    useEffect(() => {
        if (!monaco) {
            return;
        }
        monaco.editor.defineTheme('voltran', editorTheme(themeById(themeId)));
        monaco.editor.setTheme('voltran');
    }, [monaco, themeId]);

    useEffect(() => {
        if (!monaco || !host.current) {
            return;
        }
        id.current = ++editors;
        const created = monaco.editor.createDiffEditor(host.current, {
            theme: 'voltran',
            readOnly: true,
            originalEditable: false,
            automaticLayout: true,
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: true,
            ignoreTrimWhitespace: false,
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            stickyScroll: { enabled: false },
            renderLineHighlight: 'none',
            lineNumbersMinChars: 4,
            fontLigatures: false,
            scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        });
        const offDiff = created.onDidUpdateDiff(() => reportStat.current(diffStat(created, shown.current)));
        setWidget(created);
        return () => {
            offDiff.dispose();
            const model = created.getModel();
            created.dispose();
            model?.original.dispose();
            model?.modified.dispose();
            setWidget(null);
        };
    }, [monaco]);

    useEffect(() => {
        widget?.updateOptions({ fontFamily: fontStack(font.family), fontSize: font.size });
    }, [widget, font]);

    useEffect(() => {
        if (!monaco || !widget) {
            return;
        }
        const original = contents.original ?? '';
        const modified = contents.modified ?? '';
        const model = widget.getModel();
        const uri = (side: string) => monaco.Uri.from({ scheme: `voltran-${side}`, authority: String(id.current), path: `/${contents.path}` });
        if (model && model.modified.uri.toString() === uri('modified').toString()) {
            if (model.original.getValue() !== original || model.modified.getValue() !== modified) {
                const view = widget.saveViewState();
                model.original.setValue(original);
                model.modified.setValue(modified);
                widget.restoreViewState(view);
            }
            return;
        }
        reportStat.current(null);
        widget.setModel({
            original: monaco.editor.createModel(original, undefined, uri('original')),
            modified: monaco.editor.createModel(modified, undefined, uri('modified')),
        });
        model?.original.dispose();
        model?.modified.dispose();
    }, [monaco, widget, contents]);

    if (failed) {
        return <div className="changes__empty">The editor could not load. Reload the window to try again.</div>;
    }
    return <div className="changes__editor" ref={host} />;
}
