import type { AppState, PaneView, Session } from '@voltran/shared';
import { api } from './api.ts';
import { revealPane } from './notify.ts';
import { attentionPanes, reportError, selectedWorkspace, shownPaneIds, useUi } from './store.ts';
import { removeFromWorkspace } from './workspace-actions.ts';

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
    const { app, showArchived, selectedSessionId, selectedWorkspaceId, selectSession, selectWorkspace } = useUi.getState();
    const views = [
        ...(app?.workspaces ?? []).map((workspace) => ({ id: workspace.id, select: () => selectWorkspace(workspace.id) })),
        ...orderedSessions(app, showArchived).map((session) => ({ id: session.id, select: () => selectSession(session.id) })),
    ];
    if (views.length === 0) {
        return;
    }
    const index = views.findIndex((view) => view.id === (selectedWorkspaceId ?? selectedSessionId));
    views[(index + delta + views.length) % views.length].select();
}

function stepPane(delta: number): void {
    const { focusedPaneId, maximizedPaneId, focusPane, toggleMaximize } = useUi.getState();
    const ids = shownPaneIds(useUi.getState());
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
    const state = useUi.getState();
    const workspace = selectedWorkspace(state);
    const focused = visibleFocusedPane();
    const sessionId = workspace ? state.app?.panes.find((pane) => pane.id === focused)?.sessionId : state.selectedSessionId;
    if (!sessionId) {
        if (workspace) {
            state.showToast('Click a pane first; the new one joins its session');
        }
        return;
    }
    api.createPane(sessionId, { adapter: 'shell', splitFrom: focused ?? undefined, direction, workspaceId: workspace?.id })
        .then((pane) => useUi.getState().focusPane(pane.id))
        .catch(reportError);
}

export function openSettingsInApp(): void {
    api.openSettings()
        .then(({ path }) => useUi.getState().showToast(`Opened ${path}`))
        .catch(reportError);
}

// The editor runs in a pane next to the focused one; without an open session there is nowhere to put
// it, so the file opens in the system's editor instead.
export function editSettings(): void {
    const { app, selectedSessionId } = useUi.getState();
    const session = app?.sessions.find((entry) => entry.id === selectedSessionId);
    if (!session || session.archived) {
        openSettingsInApp();
        return;
    }
    const returnTo = visibleFocusedPane();
    api.editSettings({ sessionId: session.id, splitFrom: returnTo ?? undefined })
        .then((pane) => {
            const { maximizedPaneId, toggleMaximize, focusPane } = useUi.getState();
            if (maximizedPaneId) {
                toggleMaximize(pane.id);
            }
            focusPane(pane.id);
            const stop = useUi.subscribe((state) => {
                if (!state.app || state.app.panes.some((entry) => entry.id === pane.id)) {
                    return;
                }
                stop();
                if (state.focusedPaneId === null && returnTo && state.app.panes.some((entry) => entry.id === returnTo)) {
                    state.focusPane(returnTo);
                }
            });
        })
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
    const { zen, focusedPaneId, maximizedPaneId, selectedSessionId, setZen, showToast } = useUi.getState();
    if (zen) {
        leaveZen();
        return;
    }
    if (!selectedSessionId && !selectedWorkspace(useUi.getState())) {
        showToast('Open a session or a workspace to use zen mode');
        return;
    }
    const shown = shownPaneIds(useUi.getState());
    const target = shown.find((id) => id === focusedPaneId) ?? shown[0];
    maximizedBeforeZen = maximizedPaneId;
    setZen(true, target ?? maximizedPaneId);
    document.documentElement.requestFullscreen()
        .then(() => keyboardLock()?.lock(['Escape']))
        .catch(() => undefined);
    showToast('Zen mode. ⇧Esc or ⌃⌥Z to leave');
}

// An exited pane has no process left to stop, so closing it does not ask first.
export function closePane(pane: PaneView): void {
    if (pane.status === 'exited') {
        api.deletePane(pane.id).catch(reportError);
        return;
    }
    useUi.getState().openDialog({
        kind: 'confirm',
        title: `Close ${pane.title}?`,
        body: 'The process in this pane stops and its scrollback is deleted.',
        action: 'Close pane',
        onConfirm: () => api.deletePane(pane.id),
    });
}

function closeFocused(): void {
    const state = useUi.getState();
    const workspace = selectedWorkspace(state);
    const pane = state.app?.panes.find((entry) => entry.id === state.focusedPaneId);
    if (workspace && pane && shownPaneIds(state).includes(pane.id)) {
        removeFromWorkspace(workspace.id, pane.id);
    } else if (pane) {
        closePane(pane);
    }
}

function toggleFocusedNotes(): void {
    const state = useUi.getState();
    const paneId = visibleFocusedPane();
    const pane = state.app?.panes.find((entry) => entry.id === paneId);
    if (!pane || pane.adapter === 'subagent') {
        state.showToast('Focus a terminal pane to see its notes');
        return;
    }
    state.toggleNotes(pane.id);
}

export const SHORTCUTS: Shortcut[] = [
    { code: 'KeyK', keys: '⌘K', label: 'Open the command palette', run: togglePalette },
    { code: 'KeyJ', keys: '⌃⌥J', label: 'Jump to the next pane that needs you', run: jumpToAttention },
    { code: 'KeyB', keys: '⌃⌥B', label: 'Show or hide the sidebar', run: () => useUi.getState().toggleSidebar() },
    { code: 'KeyZ', keys: '⌃⌥Z', label: 'Zen mode: the focused pane, full screen, nothing else (⇧Esc leaves)', run: toggleZen },
    { code: 'KeyN', keys: '⌃⌥N', label: 'Start a new session', run: () => useUi.getState().openDialog({ kind: 'session' }) },
    { code: 'ArrowUp', keys: '⌃⌥↑', label: 'Previous workspace or session', run: () => stepSession(-1) },
    { code: 'ArrowDown', keys: '⌃⌥↓', label: 'Next workspace or session', run: () => stepSession(1) },
    { code: 'ArrowLeft', keys: '⌃⌥←', label: 'Previous pane on screen', run: () => stepPane(-1) },
    { code: 'ArrowRight', keys: '⌃⌥→', label: 'Next pane on screen', run: () => stepPane(1) },
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
    { code: 'KeyW', keys: '⌃⌥W', label: 'Close the focused pane, or take it out of the workspace', run: closeFocused },
    { code: 'KeyE', keys: '⌃⌥E', label: 'Show or hide the notes of the focused pane', run: toggleFocusedNotes },
    { code: 'Slash', keys: '⌃⌥/', label: 'Show keyboard shortcuts', run: () => useUi.getState().openDialog({ kind: 'shortcuts' }) },
];

const BY_CODE = new Map(SHORTCUTS.map((shortcut) => [shortcut.code, shortcut]));

function isPaletteKey(event: KeyboardEvent): boolean {
    return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyK';
}

export function visibleFocusedPane(): string | null {
    const state = useUi.getState();
    return state.focusedPaneId && shownPaneIds(state).includes(state.focusedPaneId) ? state.focusedPaneId : null;
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
