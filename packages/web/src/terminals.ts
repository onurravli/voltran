import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { PaneServerMessage } from '@voltran/shared';
import { socketProtocols, wsUrl } from './api.ts';
import { fontStack, type TerminalFont } from './fonts.ts';
import { translateKey } from './keymap.ts';
import { isAppShortcut } from './shortcuts.ts';
import { activeThemeId, useUi } from './store.ts';
import { mix, themeById } from './themes.ts';

export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'gone';

const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
const RESIZE_DEBOUNCE_MS = 60;
const RECONNECT_NOTICE_MS = 1000;
const SUBMIT_DELAY_MS = 120;
const IMAGE_ATTACH_TIMEOUT_MS = 5000;

export class TerminalSession {
    readonly paneId: string;
    readonly term: Terminal;
    private readonly fit = new FitAddon();
    private readonly search = new SearchAddon({ highlightLimit: 1000 });
    private searchQuery = '';
    private readonly host: HTMLDivElement;
    private opened = false;
    private webgl: WebglAddon | null = null;
    private socket: WebSocket | null = null;
    private attempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private noticeTimer: ReturnType<typeof setTimeout> | null = null;
    private resizeTimer: ReturnType<typeof setTimeout> | null = null;
    private observer: ResizeObserver | null = null;
    private disposed = false;
    private linkState: LinkState = 'connecting';
    private linkListeners = new Set<(state: LinkState) => void>();
    private focusListeners = new Set<() => void>();

    constructor(paneId: string) {
        this.paneId = paneId;
        this.host = document.createElement('div');
        this.host.className = 'terminal-host';
        const font = useUi.getState().terminalFont;
        const theme = themeById(activeThemeId(useUi.getState()));
        this.term = new Terminal({
            allowProposedApi: true,
            cursorBlink: true,
            fontFamily: fontStack(font.family),
            fontSize: font.size,
            lineHeight: 1.15,
            macOptionClickForcesSelection: true,
            scrollback: 10_000,
            minimumContrastRatio: theme.minimumContrastRatio,
            theme: theme.terminal,
        });
        this.term.loadAddon(this.fit);
        this.term.loadAddon(this.search);
        this.term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener')));
        this.term.loadAddon(new Unicode11Addon());
        this.term.unicode.activeVersion = '11';
        this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
        this.term.onData((data) => this.send({ type: 'input', data }));
        this.term.onBinary((data) => this.send({ type: 'input', data }));
    }

    mount(container: HTMLElement): void {
        if (this.disposed) {
            return;
        }
        container.appendChild(this.host);
        if (!this.opened) {
            this.term.open(this.host);
            this.opened = true;
            this.term.textarea?.addEventListener('focus', () => this.focusListeners.forEach((listener) => listener()));
        }
        this.enableWebgl();
        this.observer = new ResizeObserver(() => this.refit());
        this.observer.observe(container);
        this.refit();
        if (!this.socket && !this.retryTimer) {
            this.connect();
        }
    }

    unmount(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.disableWebgl();
        this.host.remove();
    }

    focus(): void {
        this.term.focus();
    }

    applyFont(font: TerminalFont): void {
        this.term.options.fontFamily = fontStack(font.family);
        this.term.options.fontSize = font.size;
        this.refit();
    }

    get lastSearch(): string {
        return this.searchQuery;
    }

    find(query: string, direction: 'next' | 'previous', incremental = false): void {
        this.searchQuery = query;
        if (!query) {
            this.search.clearDecorations();
            return;
        }
        const options = searchOptions(query, incremental);
        if (direction === 'next') {
            this.search.findNext(query, options);
        } else {
            this.search.findPrevious(query, options);
        }
    }

    clearSearch(): void {
        this.search.clearDecorations();
    }

    onSearchResults(listener: (results: ISearchResultChangeEvent) => void): () => void {
        const subscription = this.search.onDidChangeResults(listener);
        return () => subscription.dispose();
    }

    onLinkState(listener: (state: LinkState) => void): () => void {
        this.linkListeners.add(listener);
        listener(this.linkState);
        return () => this.linkListeners.delete(listener);
    }

    onFocus(listener: () => void): () => void {
        this.focusListeners.add(listener);
        return () => this.focusListeners.delete(listener);
    }

    // The text goes in the way a paste does, so an agent keeps its line breaks as text, and Enter
    // follows on its own: inside the same write an agent can take it as part of the paste. Claude Code
    // takes a paste that is only an image's path as that image, but reads the file after later input
    // has landed, so each image waits until its `[Image #n]` is in the input box. The output stream
    // alone cannot tell: earlier prompts and replies redrawn on screen carry the same text.
    submit(text: string, images: string[] = []): boolean {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            return false;
        }
        void (async () => {
            const before = this.inputImages();
            for (const [index, path] of images.entries()) {
                this.term.paste(path);
                await this.until(() => this.inputImages() > before + index, IMAGE_ATTACH_TIMEOUT_MS);
            }
            if (text) {
                this.term.paste(images.length > 0 ? ` ${text}` : text);
            }
            setTimeout(() => this.send({ type: 'input', data: '\r' }), SUBMIT_DELAY_MS);
        })();
        return true;
    }

    // Claude Code's input box starts at the last line that begins with its prompt and ends at the rule
    // under it.
    private inputImages(): number {
        const buffer = this.term.buffer.active;
        const lines: string[] = [];
        for (let row = buffer.length - 1; row >= 0; row -= 1) {
            const line = buffer.getLine(row)?.translateToString(true) ?? '';
            lines.unshift(line);
            if (line.startsWith('❯')) {
                break;
            }
        }
        const end = lines.findIndex((line) => line.startsWith('─'));
        return (
            lines
                .slice(0, end < 0 ? undefined : end)
                .join('\n')
                .match(/\[Image #\d+\]/g) ?? []
        ).length;
    }

    private until(condition: () => boolean, timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            const done = (): void => {
                clearTimeout(timer);
                subscription.dispose();
                resolve();
            };
            const subscription = this.term.onWriteParsed(() => {
                if (condition()) {
                    done();
                }
            });
            const timer = setTimeout(done, timeoutMs);
        });
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of [this.retryTimer, this.noticeTimer, this.resizeTimer]) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.retryTimer = null;
        this.noticeTimer = null;
        this.resizeTimer = null;
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        this.unmount();
        this.linkListeners.clear();
        this.focusListeners.clear();
        this.term.dispose();
    }

    private handleKey(event: KeyboardEvent): boolean {
        if (isAppShortcut(event)) {
            return false;
        }
        const sequence = translateKey(event);
        if (sequence !== null) {
            if (event.type === 'keydown') {
                event.preventDefault();
                this.term.input(sequence);
            }
            return false;
        }
        return true;
    }

    private refit(): void {
        if (this.fittingSize()) {
            this.scheduleResize();
        }
    }

    private fittingSize(): { cols: number; rows: number } | null {
        if (!this.opened || !this.host.isConnected || this.host.clientWidth === 0 || this.host.clientHeight === 0) {
            return null;
        }
        try {
            const size = this.fit.proposeDimensions();
            return size && Number.isFinite(size.cols) && Number.isFinite(size.rows) ? size : null;
        } catch {
            return null;
        }
    }

    private enableWebgl(): void {
        if (this.webgl) {
            return;
        }
        try {
            const addon = new WebglAddon();
            addon.onContextLoss(() => {
                addon.dispose();
                if (this.webgl === addon) {
                    this.webgl = null;
                }
            });
            this.term.loadAddon(addon);
            this.webgl = addon;
        } catch {
            this.webgl = null;
        }
    }

    private disableWebgl(): void {
        this.webgl?.dispose();
        this.webgl = null;
    }

    private setLinkState(state: LinkState): void {
        if (this.linkState === state) {
            return;
        }
        this.linkState = state;
        this.linkListeners.forEach((listener) => listener(state));
    }

    private connect(): void {
        this.retryTimer = null;
        if (this.disposed) {
            return;
        }
        const socket = new WebSocket(wsUrl(`/ws/panes/${encodeURIComponent(this.paneId)}`), socketProtocols());
        socket.binaryType = 'arraybuffer';
        this.socket = socket;

        socket.onopen = () => {
            this.attempt = 0;
            if (this.noticeTimer) {
                clearTimeout(this.noticeTimer);
                this.noticeTimer = null;
            }
            this.setLinkState('open');
            this.sendSize();
        };

        socket.onmessage = (message) => {
            if (message.data instanceof ArrayBuffer) {
                this.term.write(new Uint8Array(message.data));
                return;
            }
            let parsed: PaneServerMessage;
            try {
                parsed = JSON.parse(String(message.data)) as PaneServerMessage;
            } catch {
                return;
            }
            // The xterm betas parse every queued write before resizing, so a resize called here lands
            // where it arrives in the output stream. Calling it from a write callback instead makes the
            // flush drop the rest of the queue.
            if (parsed.type === 'snapshot') {
                this.term.write('\x1bc');
                this.term.resize(parsed.cols, parsed.rows);
                this.term.write(parsed.data);
            } else if (parsed.type === 'resize') {
                this.term.resize(parsed.cols, parsed.rows);
            }
        };

        socket.onclose = (event) => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = null;
            if (this.disposed) {
                return;
            }
            if (event.code === 4404) {
                this.setLinkState('gone');
                return;
            }
            if (!this.noticeTimer) {
                this.noticeTimer = setTimeout(() => {
                    this.noticeTimer = null;
                    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                        this.setLinkState('reconnecting');
                    }
                }, RECONNECT_NOTICE_MS);
            }
            const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
            this.attempt += 1;
            this.retryTimer = setTimeout(() => this.connect(), delay);
        };
    }

    private scheduleResize(): void {
        if (this.resizeTimer) {
            clearTimeout(this.resizeTimer);
        }
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null;
            this.sendSize();
        }, RESIZE_DEBOUNCE_MS);
    }

    // The terminal never resizes itself: it asks the daemon for the size that fits and applies the
    // daemon's resize where it falls in the output stream, so it never diverges from the process.
    // Every window attached to a pane would otherwise ask for its own size and the last one would
    // win, so only the focused window asks; regaining focus asks again.
    resendSize(): void {
        this.sendSize();
    }

    private sendSize(): void {
        const size = this.fittingSize();
        if (!size || !document.hasFocus()) {
            return;
        }
        this.send({ type: 'resize', cols: size.cols, rows: size.rows });
    }

    private send(message: { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }): void {
        const socket = this.socket;
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    }
}

function searchOptions(query: string, incremental: boolean): ISearchOptions {
    const { background, yellow } = themeById(activeThemeId(useUi.getState())).terminal;
    return {
        caseSensitive: query !== query.toLowerCase(),
        incremental,
        decorations: {
            matchBackground: mix(background, yellow, 0.3),
            matchOverviewRuler: yellow,
            activeMatchBackground: mix(background, yellow, 0.6),
            activeMatchBorder: yellow,
            activeMatchColorOverviewRuler: yellow,
        },
    };
}

const sessions = new Map<string, TerminalSession>();

const resendSizes = (): void => sessions.forEach((session) => session.resendSize());
window.addEventListener('focus', resendSizes);
document.addEventListener('visibilitychange', resendSizes);

useUi.subscribe((state, previous) => {
    if (state.terminalFont !== previous.terminalFont) {
        sessions.forEach((session) => session.applyFont(state.terminalFont));
    }
    const themeId = activeThemeId(state);
    if (themeId !== activeThemeId(previous)) {
        const theme = themeById(themeId);
        sessions.forEach((session) => {
            session.term.options.minimumContrastRatio = theme.minimumContrastRatio;
            session.term.options.theme = theme.terminal;
        });
    }
});

export function terminalFor(paneId: string): TerminalSession {
    let session = sessions.get(paneId);
    if (!session) {
        session = new TerminalSession(paneId);
        sessions.set(paneId, session);
    }
    return session;
}

export function peekTerminal(paneId: string): TerminalSession | undefined {
    return sessions.get(paneId);
}

export function disposeTerminalsExcept(liveIds: Set<string>): void {
    for (const [paneId, session] of sessions) {
        if (!liveIds.has(paneId)) {
            session.dispose();
            sessions.delete(paneId);
        }
    }
}
