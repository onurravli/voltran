import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ConversationEntry, PaneView, ToolDetail } from '@voltran/shared';
import { api } from '../api.ts';
import { formatDuration, groupTurns, lineDiff, type ConversationItem, type Turn } from '../conversation.ts';
import { renderMarkdown } from '../markdown.ts';
import { keys } from '../shortcuts.ts';
import { useUi } from '../store.ts';
import { terminalFor } from '../terminals.ts';

type Entry<K extends ConversationEntry['kind']> = Extract<ConversationEntry, { kind: K }>;

const POLL_MS = 1500;
const TURNS_PER_PAGE = 30;
const LIVE_STATUSES = new Set(['starting', 'working', 'needs-input']);

const drafts = new Map<string, string>();

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

    useEffect(() => {
        void load();
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
    const input = useRef<HTMLTextAreaElement>(null);

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

    const send = (): void => {
        const text = draft.trim();
        if (!text) {
            return;
        }
        if (!terminalFor(pane.id).submit(text)) {
            useUi.getState().showToast('The pane is not connected yet', 'error');
            return;
        }
        change('');
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
        }
    };

    return (
        <div className="composer">
            <textarea
                ref={input}
                className="composer__input"
                rows={1}
                value={draft}
                placeholder={`Message ${pane.title}…`}
                title="↩ sends, ⇧↩ adds a line"
                aria-label="Message"
                onChange={(event) => change(event.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => {
                    useUi.getState().focusPane(pane.id, false);
                    if (pane.status === 'done' || pane.status === 'needs-input') {
                        api.seenPane(pane.id).catch(() => undefined);
                    }
                }}
            />
            <button type="button" className="button button--small" disabled={!draft.trim()} onClick={send}>
                Send
            </button>
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
