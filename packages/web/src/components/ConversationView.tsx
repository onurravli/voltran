import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MAX_ATTACHMENT_BYTES, type ConversationEntry, type PaneView, type SlashCommand, type ToolDetail } from '@voltran/shared';
import { api } from '../api.ts';
import { formatDuration, groupTurns, lineDiff, type ConversationItem, type Turn } from '../conversation.ts';
import { renderMarkdown } from '../markdown.ts';
import { keys } from '../shortcuts.ts';
import { commandOf, matchCommands, slashQuery } from '../slash.ts';
import { useUi } from '../store.ts';
import { terminalFor } from '../terminals.ts';

type Entry<K extends ConversationEntry['kind']> = Extract<ConversationEntry, { kind: K }>;

const POLL_MS = 1500;
const TURNS_PER_PAGE = 30;
const SETTLE_READS_MS = [500, 1500, 4000];
const LIVE_STATUSES = new Set(['starting', 'working', 'needs-input']);

const drafts = new Map<string, string>();
const imageDrafts = new Map<string, Attachment[]>();

interface Attachment {
    id: number;
    preview: string;
    path: string | null;
}

let nextAttachmentId = 1;

function imagesOf(data: DataTransfer): File[] {
    return [...data.files].filter((file) => file.type.startsWith('image/'));
}

function readPreview(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Reads the conversation from where the last read stopped, until the daemon has nothing more; a call
// that arrives while one runs makes it read once more instead of running alongside.
function useConversation(paneId: string, status: string): { entries: ConversationEntry[]; loaded: boolean; error: string | null } {
    const [entries, setEntries] = useState<ConversationEntry[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cursor = useRef<{ source: string | null; next: number }>({ source: null, next: 0 });
    const busy = useRef(false);
    const again = useRef(false);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const load = useCallback(async () => {
        if (busy.current) {
            again.current = true;
            return;
        }
        busy.current = true;
        try {
            do {
                again.current = false;
                let more = true;
                while (more && alive.current) {
                    const chunk = await api.conversation(paneId, cursor.current.source, cursor.current.next);
                    if (!alive.current) {
                        return;
                    }
                    const reset = chunk.source !== cursor.current.source;
                    cursor.current = { source: chunk.source, next: chunk.next };
                    if (reset) {
                        setEntries(chunk.entries);
                    } else if (chunk.entries.length > 0) {
                        setEntries((previous) => previous.concat(chunk.entries));
                    }
                    more = chunk.more;
                }
            } while (again.current && alive.current);
            setError(null);
        } catch (failure) {
            if (alive.current) {
                setError(message(failure));
            }
        } finally {
            busy.current = false;
            if (alive.current) {
                setLoaded(true);
            }
        }
    }, [paneId]);

    // Claude can run its Stop hook before the last reply is in the transcript, so a pane that has
    // just settled is read a few more times.
    useEffect(() => {
        void load();
        if (LIVE_STATUSES.has(status)) {
            return;
        }
        const timers = SETTLE_READS_MS.map((delay) => setTimeout(() => void load(), delay));
        return () => timers.forEach(clearTimeout);
    }, [load, status]);

    const live = LIVE_STATUSES.has(status);
    useEffect(() => {
        if (!live) {
            return;
        }
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load, live]);

    return { entries, loaded, error };
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
    const html = useMemo(() => renderMarkdown(text), [text]);
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});

function Diff({ before, after }: { before: string; after: string }) {
    const lines = useMemo(() => lineDiff(before, after), [before, after]);
    return (
        <pre className="tool__code tool__diff">
            {lines.map((line, index) => (
                <span key={index} className={`diff__line diff__line--${line.type}`}>
                    {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
                    {line.text}
                    {'\n'}
                </span>
            ))}
        </pre>
    );
}

function ToolBody({ detail }: { detail: ToolDetail }) {
    switch (detail.kind) {
        case 'command':
            return <pre className="tool__code">{`$ ${detail.command}`}</pre>;
        case 'edit':
            return (
                <>
                    {detail.changes.map((change, index) => <Diff key={index} before={change.before} after={change.after} />)}
                </>
            );
        case 'write':
            return <pre className="tool__code">{detail.content}</pre>;
        case 'todos':
            return null;
        case 'input':
            return <pre className="tool__code">{detail.text}</pre>;
    }
}

function Todos({ todos }: { todos: Extract<ToolDetail, { kind: 'todos' }>['todos'] }) {
    return (
        <ul className="todos">
            {todos.map((todo, index) => (
                <li key={index} className={`todos__item todos__item--${todo.state}`}>
                    <span className="todos__mark" aria-hidden="true" />
                    <span>{todo.text}</span>
                </li>
            ))}
        </ul>
    );
}

const ToolRow = memo(function ToolRow({ tool, result, running }: { tool: Entry<'tool'>; result: Entry<'result'> | null; running: boolean }) {
    const state = result ? (result.error ? 'failed' : 'done') : running ? 'running' : 'unknown';
    const path = tool.detail && (tool.detail.kind === 'edit' || tool.detail.kind === 'write') ? tool.detail.path : null;
    if (tool.detail?.kind === 'todos') {
        return (
            <div className="tool tool--todos">
                <div className="tool__row">
                    <span className={`tool__state tool__state--${state}`} aria-hidden="true" />
                    <span className="tool__name">Plan</span>
                </div>
                <Todos todos={tool.detail.todos} />
            </div>
        );
    }
    const hasBody = tool.detail !== null || (result !== null && result.text !== '');
    return (
        <details className="tool">
            <summary className={`tool__row${hasBody ? '' : ' is-empty'}`}>
                <span className={`tool__state tool__state--${state}`} aria-hidden="true" />
                <span className="tool__name">{tool.name}</span>
                <span className="tool__summary" title={path ?? tool.summary}>{tool.summary}</span>
            </summary>
            {hasBody ? (
                <div className="tool__body">
                    {tool.detail ? <ToolBody detail={tool.detail} /> : null}
                    {result && result.text !== '' ? <pre className={`tool__code tool__result${result.error ? ' is-error' : ''}`}>{result.text}</pre> : null}
                </div>
            ) : null}
        </details>
    );
});

function Item({ item, running }: { item: ConversationItem; running: boolean }) {
    switch (item.kind) {
        case 'text':
            return <Markdown text={item.entry.text} />;
        case 'thinking':
            return (
                <details className="thinking">
                    <summary>Thinking</summary>
                    <Markdown text={item.entry.text} />
                </details>
            );
        case 'notice':
            return <div className={`conversation__notice${item.entry.tone === 'error' ? ' is-error' : ''}`}>{item.entry.text}</div>;
        case 'tools':
            return (
                <div className="tools">
                    {item.tools.map(({ tool, result }, index) => <ToolRow key={tool.id || index} tool={tool} result={result} running={running} />)}
                </div>
            );
    }
}

function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TurnView({ turn, live }: { turn: Turn; live: boolean }) {
    const prompt = turn.prompt;
    const stats = [
        turn.model,
        turn.startedAt !== null && turn.endedAt !== null && turn.endedAt > turn.startedAt ? formatDuration(turn.endedAt - turn.startedAt) : null,
        turn.endedAt !== null ? clock(turn.endedAt) : null,
    ].filter(Boolean);
    return (
        <section className="turn">
            {prompt ? (
                <div className="turn__prompt">
                    {prompt.text}
                    {prompt.images > 0 ? <span className="turn__images">{prompt.images === 1 ? '1 image' : `${prompt.images} images`}</span> : null}
                </div>
            ) : null}
            {turn.items.map((item, index) => <Item key={index} item={item} running={live} />)}
            {!live && turn.items.length > 0 && stats.length > 0 ? <div className="turn__stats">{stats.join(' · ')}</div> : null}
        </section>
    );
}

function Composer({ pane, focusToken }: { pane: PaneView; focusToken: number | null }) {
    const [draft, setDraft] = useState(() => drafts.get(pane.id) ?? '');
    const [images, setImages] = useState<Attachment[]>(() => imageDrafts.get(pane.id) ?? []);
    const [dragging, setDragging] = useState(false);
    const [commands, setCommands] = useState<SlashCommand[]>([]);
    const [active, setActive] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const input = useRef<HTMLTextAreaElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const query = slashQuery(draft);
    const opening = query !== null;
    const matches = useMemo(() => (query === null ? [] : matchCommands(commands, query)), [commands, query]);
    const menuOpen = opening && !dismissed && matches.length > 0;

    // Read again each time the menu opens, so a command or skill added on disk shows up.
    useEffect(() => {
        if (!opening) {
            setDismissed(false);
            return;
        }
        let current = true;
        api.commands(pane.id).then((list) => current && setCommands(list), () => undefined);
        return () => {
            current = false;
        };
    }, [opening, pane.id]);

    useEffect(() => setActive(0), [query]);

    useEffect(() => {
        menu.current?.querySelector('.slash-menu__item.is-active')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    useEffect(() => {
        if (focusToken !== null && input.current && document.activeElement !== input.current) {
            input.current.focus();
        }
    }, [focusToken]);

    useLayoutEffect(() => {
        const element = input.current;
        if (element) {
            element.style.height = 'auto';
            element.style.height = `${element.scrollHeight}px`;
        }
    }, [draft]);

    const change = (value: string): void => {
        setDraft(value);
        drafts.set(pane.id, value);
    };

    const updateImages = (update: (current: Attachment[]) => Attachment[]): void => {
        setImages((current) => {
            const next = update(current);
            imageDrafts.set(pane.id, next);
            return next;
        });
    };

    const attach = (files: File[]): void => {
        for (const file of files) {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                useUi.getState().showToast(`${file.name || 'The image'} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`, 'error');
                continue;
            }
            const id = nextAttachmentId++;
            const set = (fields: Partial<Attachment>): void => updateImages((current) => current.map((image) => (image.id === id ? { ...image, ...fields } : image)));
            updateImages((current) => [...current, { id, preview: '', path: null }]);
            readPreview(file).then((preview) => set({ preview }), () => undefined);
            api.attach(pane.id, file)
                .then(({ path }) => set({ path }))
                .catch((error: unknown) => {
                    updateImages((current) => current.filter((image) => image.id !== id));
                    useUi.getState().showToast(message(error), 'error');
                });
        }
    };

    const uploading = images.some((image) => image.path === null);
    const ready = !uploading && (draft.trim() !== '' || images.length > 0);

    // A command that answers in a picker or panel needs the terminal, so the pane shows it.
    const send = (text = draft.trim()): void => {
        if (uploading || (!text && images.length === 0)) {
            return;
        }
        const paths = images.flatMap((image) => (image.path ? [image.path] : []));
        const terminal = terminalFor(pane.id);
        if (!terminal.submit(text, paths)) {
            useUi.getState().showToast('The pane is not connected yet', 'error');
            return;
        }
        change('');
        updateImages(() => []);
        if (commandOf(text, commands)?.terminal) {
            useUi.getState().toggleConversation(pane.id);
            terminal.focus();
        }
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
        if (menuOpen && !event.nativeEvent.isComposing) {
            const chosen = matches[Math.min(active, matches.length - 1)];
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
            }
            if (event.key === 'Tab') {
                event.preventDefault();
                change(`/${chosen.name} `);
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                send(`/${chosen.name}`);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setDismissed(true);
                return;
            }
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
        }
    };

    const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
        const files = imagesOf(event.clipboardData);
        if (files.length > 0) {
            event.preventDefault();
            attach(files);
        }
    };

    const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
        if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDragging(true);
        }
    };

    const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
        setDragging(false);
        const files = imagesOf(event.dataTransfer);
        if (files.length > 0) {
            event.preventDefault();
            attach(files);
        }
    };

    return (
        <div
            className={`composer${dragging ? ' is-drop-target' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
        >
            {menuOpen ? (
                <div ref={menu} className="slash-menu" role="listbox" aria-label="Commands">
                    {matches.map((command, index) => (
                        <div
                            key={command.name}
                            role="option"
                            aria-selected={index === active}
                            className={`slash-menu__item${index === active ? ' is-active' : ''}`}
                            onMouseEnter={() => setActive(index)}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                send(`/${command.name}`);
                            }}
                        >
                            <span className="slash-menu__name">/{command.name}</span>
                            <span className="slash-menu__description">{command.description}</span>
                            {command.terminal ? <span className="slash-menu__tag">terminal</span> : command.source !== 'builtin' ? <span className="slash-menu__tag">{command.source}</span> : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {images.length > 0 ? (
                <div className="composer__images">
                    {images.map((image) => (
                        <div key={image.id} className={`composer__image${image.path ? '' : ' is-uploading'}`}>
                            {image.preview ? <img src={image.preview} alt="" /> : null}
                            <button
                                type="button"
                                className="composer__image-remove"
                                aria-label="Remove image"
                                title="Remove image"
                                onClick={() => updateImages((current) => current.filter((other) => other.id !== image.id))}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            <div className="composer__row">
                <textarea
                    ref={input}
                    className="composer__input"
                    rows={2}
                    value={draft}
                    placeholder={`Message ${pane.title}…`}
                    title="↩ sends, ⇧↩ adds a line, / lists commands, images can be pasted or dropped"
                    aria-label="Message"
                    onChange={(event) => change(event.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onFocus={() => {
                        useUi.getState().focusPane(pane.id, false);
                        if (pane.status === 'done' || pane.status === 'needs-input') {
                            api.seenPane(pane.id).catch(() => undefined);
                        }
                    }}
                />
                <button type="button" className="button button--small" disabled={!ready} onClick={() => send()}>
                    Send
                </button>
            </div>
        </div>
    );
}

export function ConversationView({ pane, focusToken }: { pane: PaneView; focusToken: number | null }) {
    const { entries, loaded, error } = useConversation(pane.id, pane.status);
    const turns = useMemo(() => groupTurns(entries), [entries]);
    const [shown, setShown] = useState(TURNS_PER_PAGE);
    const scroller = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const working = pane.status === 'working' || pane.status === 'starting';
    const hidden = Math.max(0, turns.length - shown);

    useLayoutEffect(() => {
        const element = scroller.current;
        if (element && pinned.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [turns, pane.status, pane.detail]);

    // A composer growing as one types shrinks the log, and a message laid out late grows it; neither
    // scrolls, so whoever was reading the end keeps it in view.
    useEffect(() => {
        const element = scroller.current;
        if (!element) {
            return;
        }
        const observer = new ResizeObserver(() => {
            if (pinned.current) {
                element.scrollTop = element.scrollHeight;
            }
        });
        observer.observe(element);
        if (element.firstElementChild) {
            observer.observe(element.firstElementChild);
        }
        return () => observer.disconnect();
    }, []);

    return (
        <div className="conversation">
            <div
                ref={scroller}
                className="conversation__scroll"
                onScroll={(event) => {
                    const element = event.currentTarget;
                    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
                }}
            >
                <div className="conversation__log">
                    {hidden > 0 ? (
                        <button type="button" className="button button--small button--ghost conversation__earlier" onClick={() => setShown((count) => count + TURNS_PER_PAGE)}>
                            Show {Math.min(hidden, TURNS_PER_PAGE)} earlier {Math.min(hidden, TURNS_PER_PAGE) === 1 ? 'turn' : 'turns'}
                        </button>
                    ) : null}
                    {turns.slice(hidden).map((turn, index, list) => (
                        <TurnView key={turn.key} turn={turn} live={working && index === list.length - 1} />
                    ))}
                    {loaded && turns.length === 0 && !error ? (
                        <div className="conversation__empty">
                            No messages yet. What you send here or type in the terminal shows up as Claude answers.
                        </div>
                    ) : null}
                    {error ? <div className="conversation__notice is-error">{error}</div> : null}
                    {working ? <div className="conversation__working">{pane.detail ?? 'Working…'}</div> : null}
                </div>
            </div>
            {pane.status === 'needs-input' ? (
                <div className="conversation__attention">
                    <span>{pane.detail ?? 'Claude is waiting for you.'} Answer in the terminal.</span>
                    <button type="button" className="button button--small" onClick={() => useUi.getState().toggleConversation(pane.id)}>
                        Show terminal ({keys('⌃⌥C')})
                    </button>
                </div>
            ) : null}
            <Composer pane={pane} focusToken={focusToken} />
        </div>
    );
}
