import {
    type KeyboardEvent,
    type PointerEvent,
    type RefObject,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type { NotesScope, PaneView, ProjectView } from '@voltran/shared';
import {
    DEFAULT_NOTES_WIDTH,
    MAX_NOTES_WIDTH,
    MIN_NOTES_WIDTH,
    NOTES_WIDTH_STEP,
    blockedBy,
    clampNotesWidth,
    draggedNotesWidth,
    markNotesSeen,
    notesFor,
    notesFresh,
} from '../notes.ts';
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
            <NotesResizer paneId={pane.id} drawer={drawer} />
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

// The pane caps the drawer (see `.pane__body`), so a drag works from the width it shows.
function NotesResizer({ paneId, drawer }: { paneId: string; drawer: RefObject<HTMLElement | null> }) {
    const width = useUi((state) => state.notesWidth);
    const setNotesWidth = useUi((state) => state.setNotesWidth);
    const drag = useRef<{ x: number; width: number; max: number } | null>(null);
    const [dragging, setDragging] = useState(false);

    const shown = (): number => drawer.current?.getBoundingClientRect().width ?? width;
    const limit = (): number => {
        const body = drawer.current?.parentElement?.getBoundingClientRect().width;
        return body ? Math.max(body / 2, body - 160) : MAX_NOTES_WIDTH;
    };
    const start = (event: PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: shown(), max: limit() };
        setDragging(true);
    };
    const end = (): void => {
        drag.current = null;
        setDragging(false);
    };
    const step = (event: KeyboardEvent<HTMLDivElement>): void => {
        const delta = event.key === 'ArrowLeft' ? NOTES_WIDTH_STEP : event.key === 'ArrowRight' ? -NOTES_WIDTH_STEP : 0;
        if (delta !== 0) {
            event.preventDefault();
            setNotesWidth(Math.min(shown() + delta, limit()));
        }
    };

    return (
        <div
            className={`notes__resizer${dragging ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Notes width"
            aria-valuemin={MIN_NOTES_WIDTH}
            aria-valuemax={MAX_NOTES_WIDTH}
            aria-valuenow={clampNotesWidth(width)}
            tabIndex={0}
            title="Drag to resize, double-click to reset"
            onPointerDown={start}
            onPointerMove={(event) => {
                if (!drag.current) {
                    return;
                }
                const next = draggedNotesWidth(drag.current.width - (event.clientX - drag.current.x));
                if (next !== null) {
                    setNotesWidth(Math.min(next, drag.current.max));
                } else {
                    setNotesWidth(drag.current.width);
                    end();
                    useUi.getState().toggleNotes(paneId);
                }
            }}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
            onDoubleClick={() => setNotesWidth(DEFAULT_NOTES_WIDTH)}
            onKeyDown={step}
        />
    );
}
