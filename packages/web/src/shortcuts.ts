import type { AppState, Session } from '@voltran/shared';
import { paneIds } from '@voltran/shared';
import { api } from './api.ts';
import { revealPane } from './notify.ts';
import { attentionPanes, reportError, useUi } from './store.ts';

interface Shortcut {
    code: string;
    keys: string;
    label: string;
    run: () => void;
}

export function orderedSessions(app: AppState | null, showArchived: boolean): Session[] {
    if (!app) {
        return [];
    }
    return app.projects.flatMap((project) =>
        app.sessions.filter((session) => session.projectId === project.id && (showArchived || !session.archived)));
}

function stepSession(delta: number): void {
    const { app, showArchived, selectedSessionId, selectSession } = useUi.getState();
    const sessions = orderedSessions(app, showArchived);
    if (sessions.length === 0) {
        return;
    }
    const index = sessions.findIndex((session) => session.id === selectedSessionId);
    const next = sessions[(index + delta + sessions.length) % sessions.length];
    selectSession(next.id);
}

function stepPane(delta: number): void {
    const { app, selectedSessionId, focusedPaneId, maximizedPaneId, focusPane, toggleMaximize } = useUi.getState();
    const session = app?.sessions.find((entry) => entry.id === selectedSessionId);
    const ids = paneIds(session?.layout ?? null);
    if (ids.length < 2) {
        return;
    }
    const index = focusedPaneId ? ids.indexOf(focusedPaneId) : -1;
    const next = index < 0 ? ids[delta > 0 ? 0 : ids.length - 1] : ids[(index + delta + ids.length) % ids.length];
    if (maximizedPaneId && maximizedPaneId !== next) {
        toggleMaximize(next);
    }
    focusPane(next);
}

function jumpToAttention(): void {
    const { app, focusedPaneId } = useUi.getState();
    const queue = attentionPanes(app);
    if (queue.length === 0) {
        useUi.getState().showToast('Nothing needs you right now');
        return;
    }
    const index = queue.findIndex((pane) => pane.id === focusedPaneId);
    const next = queue[(index + 1) % queue.length];
    revealPane(next.sessionId, next.id);
}

function splitFocused(direction: 'horizontal' | 'vertical'): void {
    const { focusedPaneId, selectedSessionId } = useUi.getState();
    if (!selectedSessionId) {
        return;
    }
    api.createPane(selectedSessionId, { adapter: 'shell', splitFrom: focusedPaneId ?? undefined, direction })
        .then((pane) => useUi.getState().focusPane(pane.id))
        .catch(reportError);
}

export function togglePalette(): void {
    const { dialog, openDialog } = useUi.getState();
    openDialog(dialog?.kind === 'palette' ? null : { kind: 'palette' });
}

interface KeyboardLock {
    lock(codes?: string[]): Promise<void>;
    unlock(): void;
}

const keyboardLock = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

let maximizedBeforeZen: string | null = null;

function leaveZen(): void {
    keyboardLock()?.unlock();
    useUi.getState().setZen(false, maximizedBeforeZen);
    maximizedBeforeZen = null;
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => undefined);
    }
}

export function toggleZen(): void {
    const { zen, app, focusedPaneId, maximizedPaneId, selectedSessionId, setZen, showToast } = useUi.getState();
    if (zen) {
        leaveZen();
        return;
    }
    if (!selectedSessionId) {
        showToast('Open a session to use zen mode');
        return;
    }
    const sessionPanes = app?.panes.filter((pane) => pane.sessionId === selectedSessionId) ?? [];
    const target = sessionPanes.find((pane) => pane.id === focusedPaneId) ?? sessionPanes[0];
    maximizedBeforeZen = maximizedPaneId;
    setZen(true, target?.id ?? maximizedPaneId);
    document.documentElement.requestFullscreen()
        .then(() => keyboardLock()?.lock(['Escape']))
        .catch(() => undefined);
    showToast('Zen mode. ⇧Esc or ⌃⌥Z to leave');
}

function closeFocused(): void {
    const { focusedPaneId, app, openDialog } = useUi.getState();
    const pane = app?.panes.find((entry) => entry.id === focusedPaneId);
    if (!pane) {
        return;
    }
    openDialog({
        kind: 'confirm',
        title: `Close ${pane.title}?`,
        body: 'The process in this pane stops and its scrollback is deleted.',
        action: 'Close pane',
        onConfirm: () => api.deletePane(pane.id),
    });
}

export const SHORTCUTS: Shortcut[] = [
    { code: 'KeyK', keys: '⌘K', label: 'Open the command palette', run: togglePalette },
    { code: 'KeyJ', keys: '⌃⌥J', label: 'Jump to the next pane that needs you', run: jumpToAttention },
    { code: 'KeyB', keys: '⌃⌥B', label: 'Show or hide the sidebar', run: () => useUi.getState().toggleSidebar() },
    { code: 'KeyZ', keys: '⌃⌥Z', label: 'Zen mode: the focused pane, full screen, nothing else (⇧Esc leaves)', run: toggleZen },
    { code: 'KeyN', keys: '⌃⌥N', label: 'Start a new session', run: () => useUi.getState().openDialog({ kind: 'session' }) },
    { code: 'ArrowUp', keys: '⌃⌥↑', label: 'Previous session', run: () => stepSession(-1) },
    { code: 'ArrowDown', keys: '⌃⌥↓', label: 'Next session', run: () => stepSession(1) },
    { code: 'ArrowLeft', keys: '⌃⌥←', label: 'Previous pane in this session', run: () => stepPane(-1) },
    { code: 'ArrowRight', keys: '⌃⌥→', label: 'Next pane in this session', run: () => stepPane(1) },
    { code: 'Backslash', keys: '⌃⌥\\', label: 'Split the focused pane to the right with a shell', run: () => splitFocused('horizontal') },
    { code: 'Minus', keys: '⌃⌥-', label: 'Split the focused pane downward with a shell', run: () => splitFocused('vertical') },
    {
        code: 'Enter',
        keys: '⌃⌥↩',
        label: 'Maximize or restore the focused pane',
        run: () => {
            const { focusedPaneId, toggleMaximize } = useUi.getState();
            if (focusedPaneId) {
                toggleMaximize(focusedPaneId);
            }
        },
    },
    { code: 'KeyW', keys: '⌃⌥W', label: 'Close the focused pane', run: closeFocused },
    { code: 'Slash', keys: '⌃⌥/', label: 'Show keyboard shortcuts', run: () => useUi.getState().openDialog({ kind: 'shortcuts' }) },
];

const BY_CODE = new Map(SHORTCUTS.map((shortcut) => [shortcut.code, shortcut]));

function isPaletteKey(event: KeyboardEvent): boolean {
    return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyK';
}

export function visibleFocusedPane(): string | null {
    const { app, focusedPaneId, selectedSessionId } = useUi.getState();
    const pane = app?.panes.find((entry) => entry.id === focusedPaneId);
    return pane && pane.sessionId === selectedSessionId ? pane.id : null;
}

function findablePane(): string | null {
    return useUi.getState().dialog ? null : visibleFocusedPane();
}

function isFindKey(event: KeyboardEvent): boolean {
    return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyF' && findablePane() !== null;
}

function isFindStepKey(event: KeyboardEvent): boolean {
    return event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyG' && useUi.getState().findPaneId !== null;
}

export const FIND_SHORTCUT = { keys: '⌘F', label: 'Find in the focused terminal' };

export const FIND_KEYS = [FIND_SHORTCUT, { keys: '⌘G / ⇧⌘G', label: 'Next / previous match' }];

function isZenExitKey(event: KeyboardEvent): boolean {
    return event.key === 'Escape' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && useUi.getState().zen;
}

export function isAppShortcut(event: KeyboardEvent): boolean {
    return isPaletteKey(event) || isFindKey(event) || isFindStepKey(event) || isZenExitKey(event)
        || (event.ctrlKey && event.altKey && !event.metaKey && BY_CODE.has(event.code));
}

export function installShortcuts(): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.type !== 'keydown' || !isAppShortcut(event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (isZenExitKey(event)) {
            leaveZen();
            return;
        }
        const ui = useUi.getState();
        const findable = isFindKey(event) ? findablePane() : null;
        if (findable) {
            ui.openFind(findable);
            return;
        }
        if (isFindStepKey(event)) {
            ui.stepFind(event.shiftKey ? 'previous' : 'next');
            return;
        }
        BY_CODE.get(event.code)?.run();
    };
    const onFullscreenChange = (): void => {
        if (!document.fullscreenElement && useUi.getState().zen) {
            leaveZen();
        }
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
        window.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
}
