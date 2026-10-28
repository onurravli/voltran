import { useEffect, useRef, useState, type RefObject } from 'react';
import { editorTheme } from '../editor-theme.ts';
import { fontStack } from '../fonts.ts';
import { activeThemeId, useUi } from '../store.ts';
import { themeById } from '../themes.ts';
import { loadMonaco, type Monaco } from './DiffEditor.tsx';

type CodeWidget = ReturnType<Monaco['editor']['create']>;

export interface EditorHandle {
    snapshot: () => { text: string; id: number } | null;
    markSaved: (id: number) => void;
}

let editors = 0;

// The editor takes `text` whenever `path`, `text` or `revision` changes and the user's edits in
// between. A new text for the same file goes in as an edit, so it can be undone.
export function CodeEditor({
    path,
    text,
    revision,
    readOnly,
    handle,
    onDirty,
    onSave,
}: {
    path: string;
    text: string;
    revision: number;
    readOnly: boolean;
    handle: RefObject<EditorHandle | null>;
    onDirty: (dirty: boolean) => void;
    onSave: () => void;
}) {
    const host = useRef<HTMLDivElement>(null);
    const [monaco, setMonaco] = useState<Monaco | null>(null);
    const [widget, setWidget] = useState<CodeWidget | null>(null);
    const [failed, setFailed] = useState(false);
    const themeId = useUi(activeThemeId);
    const font = useUi((state) => state.terminalFont);
    const id = useRef(0);
    const saved = useRef(0);
    const callbacks = useRef({ onDirty, onSave });
    callbacks.current = { onDirty, onSave };

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
        const created = monaco.editor.create(host.current, {
            theme: 'voltran',
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            stickyScroll: { enabled: false },
            lineNumbersMinChars: 4,
            fontLigatures: false,
            scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        });
        created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
        const offChange = created.onDidChangeModelContent(() => {
            const model = created.getModel();
            callbacks.current.onDirty(model !== null && model.getAlternativeVersionId() !== saved.current);
        });
        handle.current = {
            snapshot: () => {
                const model = created.getModel();
                return model ? { text: model.getValue(), id: model.getAlternativeVersionId() } : null;
            },
            markSaved: (version) => {
                saved.current = version;
                const model = created.getModel();
                callbacks.current.onDirty(model !== null && model.getAlternativeVersionId() !== version);
            },
        };
        setWidget(created);
        return () => {
            offChange.dispose();
            handle.current = null;
            const model = created.getModel();
            created.dispose();
            model?.dispose();
            setWidget(null);
        };
    }, [monaco, handle]);

    useEffect(() => {
        widget?.updateOptions({ fontFamily: fontStack(font.family), fontSize: font.size });
    }, [widget, font]);

    useEffect(() => {
        widget?.updateOptions({ readOnly });
    }, [widget, readOnly]);

    useEffect(() => {
        if (!monaco || !widget) {
            return;
        }
        const uri = monaco.Uri.from({ scheme: 'voltran-file', authority: String(id.current), path: `/${path}` });
        const model = widget.getModel();
        if (model && model.uri.toString() === uri.toString()) {
            if (model.getValue() !== text) {
                model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
                model.pushStackElement();
            }
        } else {
            widget.setModel(monaco.editor.createModel(text, undefined, uri));
            model?.dispose();
        }
        const shown = widget.getModel();
        saved.current = shown?.getAlternativeVersionId() ?? 0;
        callbacks.current.onDirty(false);
    }, [monaco, widget, path, text, revision]);

    if (failed) {
        return <div className="changes__empty">The editor could not load. Reload the window to try again.</div>;
    }
    return <div className="changes__editor" ref={host} />;
}
