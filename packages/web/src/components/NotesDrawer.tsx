import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { NotesScope, PaneView, ProjectView } from '@voltran/shared';
import { blockedBy, markNotesSeen, notesFor, notesFresh } from '../notes.ts';
import { useUi } from '../store.ts';
import { keys } from '../shortcuts.ts';
import { peekTerminal } from '../terminals.ts';
import { CloseIcon } from './Icons.tsx';

export function NotesDrawer({
    pane,
    project,
    agent,
    hint,
}: {
    pane: PaneView;
    project: ProjectView | undefined;
    agent: string | null;
    hint: string;
}) {
    const wantsProject = useUi((state) => state.notesProject[pane.id] === true);
    const scope: NotesScope = wantsProject && project ? 'project' : 'pane';
    const id = scope === 'project' && project ? project.id : pane.id;
    const meta = scope === 'project' && project ? project.notes : pane.notes;
    const editor = notesFor(scope, id);
    const notes = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
    const focusToken = useUi((state) => (state.notesFocus?.paneId === pane.id ? state.notesFocus.token : null));
    const drawer = useRef<HTMLElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const blocked = blockedBy(meta, notes.holding);
    const writer = scope === 'pane' && agent ? agent : 'An agent';

    useEffect(() => {
        void editor.load();
        return () => {
            void editor.flush();
            markNotesSeen(scope, id);
        };
    }, [editor, scope, id]);

    useEffect(() => {
        const element = drawer.current;
        return () => {
            if (
                !document.activeElement ||
                document.activeElement === document.body ||
                element?.contains(document.activeElement)
            ) {
                peekTerminal(pane.id)?.focus();
            }
        };
    }, [pane.id]);

    useEffect(() => {
        if (focusToken !== null) {
            textarea.current?.focus();
        }
    }, [focusToken]);

    useEffect(() => {
        markNotesSeen(scope, id);
    }, [scope, id, meta.updatedAt]);

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
                  : meta.updatedBy === 'agent'
                    ? scope === 'pane' && agent
                        ? `Updated by ${agent}`
                        : 'Changed by an agent'
                    : '';

    const tab = (value: NotesScope, label: string, title: string, fresh: boolean) => (
        <button
            type="button"
            role="tab"
            aria-selected={scope === value}
            className={`notes__tab${scope === value ? ' is-active' : ''}${fresh ? ' is-fresh' : ''}`}
            title={title}
            onClick={() => useUi.getState().showNotesOf(pane.id, value)}
        >
            {label}
        </button>
    );

    return (
        <aside
            ref={drawer}
            className="notes"
            aria-label={scope === 'project' && project ? `Notes for ${project.name}` : `Notes for ${pane.title}`}
        >
            <div className="notes__header">
                {project ? (
                    <div className="notes__tabs" role="tablist" aria-label="Notes">
                        {tab(
                            'pane',
                            'Pane',
                            'Notes for this pane',
                            scope !== 'pane' && notesFresh('pane', pane.id, pane.notes),
                        )}
                        {tab(
                            'project',
                            'Project',
                            `Notes for every session of ${project.name}`,
                            scope !== 'project' && notesFresh('project', project.id, project.notes),
                        )}
                    </div>
                ) : (
                    <span className="notes__title">Notes</span>
                )}
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
                aria-label={scope === 'project' ? 'Project notes' : 'Notes'}
                placeholder={
                    scope === 'project' && project
                        ? `Notes for every session of ${project.name}. Claude Code and OpenCode read them when a session starts; other agents find them at $VOLTRAN_PROJECT_NOTES.`
                        : hint
                }
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
