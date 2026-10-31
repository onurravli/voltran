import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PaneView } from '@voltran/shared';
import { blockedBy, markNotesSeen, notesFor } from '../notes.ts';
import { useUi } from '../store.ts';
import { keys } from '../shortcuts.ts';
import { peekTerminal } from '../terminals.ts';
import { CloseIcon } from './Icons.tsx';

export function NotesDrawer({ pane, agent, hint }: { pane: PaneView; agent: string | null; hint: string }) {
    const editor = notesFor(pane.id);
    const notes = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
    const focusToken = useUi((state) => (state.notesFocus?.paneId === pane.id ? state.notesFocus.token : null));
    const drawer = useRef<HTMLElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const blocked = blockedBy(pane.notes, notes.holding);
    const writer = agent ?? 'The agent';

    useEffect(() => {
        void editor.load();
        const element = drawer.current;
        return () => {
            void editor.flush();
            markNotesSeen(pane.id);
            if (
                !document.activeElement ||
                document.activeElement === document.body ||
                element?.contains(document.activeElement)
            ) {
                peekTerminal(pane.id)?.focus();
            }
        };
    }, [editor, pane.id]);

    useEffect(() => {
        if (focusToken !== null) {
            textarea.current?.focus();
        }
    }, [focusToken]);

    useEffect(() => {
        markNotesSeen(pane.id);
    }, [pane.id, pane.notes.updatedAt]);

    const status = notes.conflict
        ? ''
        : blocked === 'agent'
          ? `${writer} is writing…`
          : blocked === 'window'
            ? 'Open in another window'
            : notes.saving
              ? 'Saving…'
              : notes.dirty
                ? 'Editing'
                : notes.holding
                  ? 'Saved'
                  : pane.notes.updatedBy === 'agent'
                    ? agent
                        ? `Updated by ${agent}`
                        : 'Changed on disk'
                    : '';

    return (
        <aside ref={drawer} className="notes" aria-label={`Notes for ${pane.title}`}>
            <div className="notes__header">
                <span className="notes__title">Notes</span>
                <span className="notes__status" aria-live="polite">
                    {status}
                </span>
                <button
                    type="button"
                    className="icon-button"
                    title={`Hide notes (${keys('⌃⌥E')})`}
                    onClick={() => useUi.getState().toggleNotes(pane.id)}
                >
                    <CloseIcon size={14} />
                </button>
            </div>
            {notes.conflict ? (
                <div className="notes__conflict" role="alert">
                    <span>{notes.conflict} Your text is kept.</span>
                    <div className="notes__conflict-actions">
                        <button type="button" className="button button--small" onClick={() => editor.keepMine()}>
                            Keep mine
                        </button>
                        <button
                            type="button"
                            className="button button--small button--ghost"
                            onClick={() => editor.takeTheirs()}
                        >
                            Load theirs
                        </button>
                    </div>
                </div>
            ) : null}
            <textarea
                ref={textarea}
                className="notes__text"
                aria-label="Notes"
                placeholder={hint}
                spellCheck={false}
                value={notes.text}
                readOnly={blocked !== null || !notes.loaded}
                onChange={(event) => editor.input(event.target.value)}
                onBlur={() => void editor.flush()}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        peekTerminal(pane.id)?.focus();
                    }
                }}
            />
        </aside>
    );
}
