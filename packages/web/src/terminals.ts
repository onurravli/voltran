import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { PaneServerMessage } from '@voltran/shared';
import { wsUrl } from './api.ts';
import { fontStack, type TerminalFont } from './fonts.ts';
import { translateKey } from './keymap.ts';
import { isAppShortcut } from './shortcuts.ts';
import { useUi } from './store.ts';
import { themeById } from './themes.ts';

export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'gone';

const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
const RESIZE_DEBOUNCE_MS = 60;
const RECONNECT_NOTICE_MS = 1000;

export class TerminalSession {
    readonly paneId: string;
    readonly term: Terminal;
    private readonly fit = new FitAddon();
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
        const theme = themeById(useUi.getState().themeId);
        this.term = new Terminal({
            allowProposedApi: true,
            cursorBlink: true,
            fontFamily: fontStack(font.family),
            fontSize: font.size,
            lineHeight: 1.15,
            scrollback: 10_000,
            minimumContrastRatio: theme.minimumContrastRatio,
            theme: theme.terminal,
        });
        this.term.loadAddon(this.fit);
        this.term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener')));
        this.term.loadAddon(new Unicode11Addon());
        this.term.unicode.activeVersion = '11';
        this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
        this.term.onData((data) => this.send({ type: 'input', data }));
        this.term.onBinary((data) => this.send({ type: 'input', data }));
        this.term.onResize(() => this.scheduleResize());
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

    onLinkState(listener: (state: LinkState) => void): () => void {
        this.linkListeners.add(listener);
        listener(this.linkState);
        return () => this.linkListeners.delete(listener);
    }

    onFocus(listener: () => void): () => void {
        this.focusListeners.add(listener);
        return () => this.focusListeners.delete(listener);
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
        if (!this.host.isConnected || this.host.clientWidth === 0 || this.host.clientHeight === 0) {
            return;
        }
        try {
            this.fit.fit();
        } catch {
            // renderer not ready yet; the next observer tick fits again
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
        const socket = new WebSocket(wsUrl(`/ws/panes/${encodeURIComponent(this.paneId)}`));
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
            if (parsed.type === 'snapshot') {
                this.term.reset();
                this.term.write(parsed.data);
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

    private sendSize(): void {
        this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
    }

    private send(message: { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }): void {
        const socket = this.socket;
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    }
}

const sessions = new Map<string, TerminalSession>();

useUi.subscribe((state, previous) => {
    if (state.terminalFont !== previous.terminalFont) {
        sessions.forEach((session) => session.applyFont(state.terminalFont));
    }
    if (state.themeId !== previous.themeId) {
        const theme = themeById(state.themeId);
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
