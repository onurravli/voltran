import { create } from 'zustand';
import type { AppState, LayoutDirection, PaneView, Session, Settings, SettingsPatch, SettingsState, SidebarPosition, VersionInfo, Workspace } from '@voltran/shared';
import { DEFAULT_SETTINGS, SIDEBAR_POSITIONS, applySettingsPatch, needsAttention, paneIds } from '@voltran/shared';
import { api } from './api.ts';
import { DEFAULT_FONT, DEFAULT_UI_FONT, parseFont, parseUiFont, type TerminalFont, type UiFont } from './fonts.ts';
import { DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth } from './sidebar.ts';
import { parseThemeChoice, parseThemeId, schemeOf, themeById, type Appearance, type Scheme } from './themes.ts';

export type Connection = 'connecting' | 'online' | 'offline' | 'unauthenticated';

export type Dialog =
    | { kind: 'project' }
    | { kind: 'session'; projectId?: string }
    | { kind: 'shortcuts' }
    | { kind: 'palette' }
    | { kind: 'confirm'; title: string; body: string; action: string; onConfirm: () => void | Promise<void> };

export interface PaneMenuTarget {
    sessionId: string;
    splitFrom?: string;
    direction?: LayoutDirection;
    workspaceId?: string;
    anchor: { x: number; y: number };
}

export interface Toast {
    id: number;
    message: string;
    tone: 'info' | 'error';
}

export interface UiState {
    app: AppState | null;
    version: VersionInfo | null;
    connection: Connection;
    selectedSessionId: string | null;
    selectedWorkspaceId: string | null;
    focusedPaneId: string | null;
    maximizedPaneId: string | null;
    draggingPaneId: string | null;
    draggingSessionId: string | null;
    findPaneId: string | null;
    findToken: number;
    findStep: { direction: 'next' | 'previous'; token: number } | null;
    collapsedProjects: Record<string, boolean>;
    expandedSessions: Record<string, boolean>;
    showArchived: boolean;
    sidebarHidden: boolean;
    sidebarWidth: number;
    sidebarPosition: SidebarPosition;
    zen: boolean;
    terminalFont: TerminalFont;
    uiFont: UiFont;
    appearance: Appearance;
    themeIds: Record<Scheme, string>;
    settingsFile: SettingsState | null;
    systemScheme: Scheme;
    previewThemeId: string | null;
    dialog: Dialog | null;
    paneMenu: PaneMenuTarget | null;
    toast: Toast | null;
    installable: boolean;
    setApp: (app: AppState) => void;
    setVersion: (version: VersionInfo) => void;
    setConnection: (connection: Connection) => void;
    selectSession: (id: string | null) => void;
    selectWorkspace: (id: string) => void;
    focusPane: (id: string | null) => void;
    toggleMaximize: (id: string) => void;
    setDraggingPane: (id: string | null) => void;
    setDraggingSession: (id: string | null) => void;
    openFind: (paneId: string) => void;
    closeFind: () => void;
    stepFind: (direction: 'next' | 'previous') => void;
    toggleProject: (id: string) => void;
    toggleSessionPanes: (id: string) => void;
    setShowArchived: (value: boolean) => void;
    toggleSidebar: () => void;
    setSidebarWidth: (width: number) => void;
    setZen: (zen: boolean, maximizedPaneId: string | null) => void;
    setTerminalFont: (font: TerminalFont) => void;
    setUiFont: (font: UiFont) => void;
    setAppearance: (appearance: Appearance) => void;
    setTheme: (id: string) => void;
    applySettings: (state: SettingsState) => void;
    saveSettings: (patch: SettingsPatch) => void;
    setPreviewTheme: (id: string | null) => void;
    openDialog: (dialog: Dialog | null) => void;
    openPaneMenu: (target: PaneMenuTarget | null) => void;
    showToast: (message: string, tone?: Toast['tone']) => void;
    setInstallable: (installable: boolean) => void;
}

const STORAGE_KEY = 'voltran.ui';

interface Persisted {
    selectedSessionId: string | null;
    selectedWorkspaceId: string | null;
    collapsedProjects: Record<string, boolean>;
    expandedSessions: Record<string, boolean>;
    showArchived: boolean;
    sidebarHidden: boolean;
    sidebarWidth: number;
    sidebarPosition: SidebarPosition;
    terminalFont: TerminalFont;
    uiFont: UiFont;
    appearance: Appearance;
    themeIds: Record<Scheme, string>;
}

function readPersisted(): Persisted {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<Persisted>;
            return {
                selectedSessionId: typeof parsed.selectedSessionId === 'string' ? parsed.selectedSessionId : null,
                selectedWorkspaceId: typeof parsed.selectedWorkspaceId === 'string' ? parsed.selectedWorkspaceId : null,
                collapsedProjects: parsed.collapsedProjects && typeof parsed.collapsedProjects === 'object' ? parsed.collapsedProjects : {},
                expandedSessions: parsed.expandedSessions && typeof parsed.expandedSessions === 'object' ? parsed.expandedSessions : {},
                showArchived: parsed.showArchived === true,
                sidebarHidden: parsed.sidebarHidden === true,
                sidebarWidth: clampSidebarWidth(parsed.sidebarWidth),
                sidebarPosition: SIDEBAR_POSITIONS.find((position) => position === parsed.sidebarPosition) ?? DEFAULT_SETTINGS.sidebar.position,
                terminalFont: parseFont(parsed.terminalFont),
                uiFont: parseUiFont(parsed.uiFont),
                ...parseThemeChoice(parsed),
            };
        }
    } catch {
        localStorage.removeItem(STORAGE_KEY);
    }
    return {
        selectedSessionId: null,
        selectedWorkspaceId: null,
        collapsedProjects: {},
        expandedSessions: {},
        showArchived: false,
        sidebarHidden: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        sidebarPosition: DEFAULT_SETTINGS.sidebar.position,
        terminalFont: DEFAULT_FONT,
        uiFont: DEFAULT_UI_FONT,
        ...parseThemeChoice({}),
    };
}

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

const systemScheme = (): Scheme => (darkScheme.matches ? 'dark' : 'light');

let toastId = 0;
let migrated = false;

// What this window shows, as settings. Before settings.json existed these lived in localStorage,
// and they still cache the file there so a reload paints the right theme and font straight away.
function shownSettings(state: UiState): Settings {
    return {
        appearance: state.appearance,
        theme: { ...state.themeIds },
        terminal: { fontFamily: state.terminalFont.family, fontSize: state.terminalFont.size },
        ui: { fontFamily: state.uiFont.family, fontSize: state.uiFont.size },
        sidebar: { position: state.sidebarPosition },
        editor: state.settingsFile?.settings.editor ?? DEFAULT_SETTINGS.editor,
    };
}

function settingsProblems(problems: string[]): string {
    return `settings.json: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`;
}

export const useUi = create<UiState>((set, get) => ({
    app: null,
    version: null,
    connection: 'connecting',
    ...readPersisted(),
    systemScheme: systemScheme(),
    previewThemeId: null,
    settingsFile: null,
    focusedPaneId: null,
    maximizedPaneId: null,
    draggingPaneId: null,
    draggingSessionId: null,
    findPaneId: null,
    findToken: 0,
    findStep: null,
    zen: false,
    dialog: null,
    paneMenu: null,
    toast: null,
    installable: false,

    setApp: (app) => {
        const { selectedSessionId, selectedWorkspaceId, focusedPaneId, maximizedPaneId } = get();
        const workspaceExists = selectedWorkspaceId !== null && app.workspaces.some((workspace) => workspace.id === selectedWorkspaceId);
        const sessionExists = selectedSessionId !== null && app.sessions.some((session) => session.id === selectedSessionId);
        const paneIds = new Set(app.panes.map((pane) => pane.id));
        set({
            app,
            selectedWorkspaceId: workspaceExists ? selectedWorkspaceId : null,
            selectedSessionId: workspaceExists ? null : sessionExists ? selectedSessionId : firstOpenSession(app)?.id ?? null,
            focusedPaneId: focusedPaneId && paneIds.has(focusedPaneId) ? focusedPaneId : null,
            maximizedPaneId: maximizedPaneId && paneIds.has(maximizedPaneId) ? maximizedPaneId : null,
        });
    },
    setVersion: (version) => set({ version }),
    setConnection: (connection) => set({ connection }),
    selectSession: (id) => set({ selectedSessionId: id, selectedWorkspaceId: null, maximizedPaneId: null, findPaneId: null }),
    selectWorkspace: (id) => set({ selectedWorkspaceId: id, selectedSessionId: null, maximizedPaneId: null, findPaneId: null }),
    focusPane: (id) => set({ focusedPaneId: id }),
    toggleMaximize: (id) => set({ maximizedPaneId: get().maximizedPaneId === id ? null : id }),
    setDraggingPane: (draggingPaneId) => set({ draggingPaneId }),
    setDraggingSession: (draggingSessionId) => set({ draggingSessionId }),
    openFind: (paneId) => set({ findPaneId: paneId, findToken: get().findToken + 1 }),
    closeFind: () => set({ findPaneId: null }),
    stepFind: (direction) => set({ findStep: { direction, token: (get().findStep?.token ?? 0) + 1 } }),
    toggleProject: (id) => set({ collapsedProjects: { ...get().collapsedProjects, [id]: !get().collapsedProjects[id] } }),
    toggleSessionPanes: (id) => set({ expandedSessions: { ...get().expandedSessions, [id]: !get().expandedSessions[id] } }),
    setShowArchived: (value) => set({ showArchived: value }),
    toggleSidebar: () => set({ sidebarHidden: !get().sidebarHidden }),
    setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
    setZen: (zen, maximizedPaneId) => set({ zen, maximizedPaneId }),
    setTerminalFont: (font) => set({ terminalFont: parseFont(font) }),
    setUiFont: (font) => set({ uiFont: parseUiFont(font) }),
    setAppearance: (appearance) => get().saveSettings({ appearance }),
    setTheme: (id) => {
        const theme = themeById(id);
        get().saveSettings({ theme: { [theme.scheme]: theme.id } });
    },
    applySettings: (state) => {
        const previous = get().settingsFile;
        if (!state.exists && !migrated) {
            migrated = true;
            const shown = shownSettings(get());
            if (JSON.stringify(shown) !== JSON.stringify(DEFAULT_SETTINGS)) {
                set({ settingsFile: state });
                api.updateSettings(shown).then((saved) => get().applySettings(saved)).catch(reportError);
                return;
            }
        }
        const { settings } = state;
        set({
            settingsFile: state,
            appearance: settings.appearance,
            themeIds: { dark: parseThemeId(settings.theme.dark, 'dark'), light: parseThemeId(settings.theme.light, 'light') },
            terminalFont: parseFont({ family: settings.terminal.fontFamily, size: settings.terminal.fontSize }),
            uiFont: parseUiFont({ family: settings.ui.fontFamily, size: settings.ui.fontSize }),
            sidebarPosition: settings.sidebar.position,
        });
        if (state.problems.length > 0 && state.problems.join('\n') !== previous?.problems.join('\n')) {
            get().showToast(settingsProblems(state.problems), 'error');
        }
    },
    saveSettings: (patch) => {
        const settings = applySettingsPatch(shownSettings(get()), patch);
        set({
            appearance: settings.appearance,
            themeIds: { ...settings.theme },
            terminalFont: parseFont({ family: settings.terminal.fontFamily, size: settings.terminal.fontSize }),
            uiFont: parseUiFont({ family: settings.ui.fontFamily, size: settings.ui.fontSize }),
            sidebarPosition: settings.sidebar.position,
        });
        api.updateSettings(patch)
            .then((saved) => get().applySettings(saved))
            .catch((error: unknown) => {
                reportError(error);
                const last = get().settingsFile;
                if (last) {
                    get().applySettings(last);
                }
            });
    },
    setPreviewTheme: (previewThemeId) => set({ previewThemeId }),
    openDialog: (dialog) => set({ dialog, paneMenu: null }),
    openPaneMenu: (paneMenu) => set({ paneMenu }),
    showToast: (message, tone = 'info') => {
        toastId += 1;
        const id = toastId;
        set({ toast: { id, message, tone } });
        setTimeout(() => {
            if (get().toast?.id === id) {
                set({ toast: null });
            }
        }, tone === 'error' ? 6000 : 3000);
    },
    setInstallable: (installable) => set({ installable }),
}));

useUi.subscribe((state) => {
    const persisted: Persisted = {
        selectedSessionId: state.selectedSessionId,
        selectedWorkspaceId: state.selectedWorkspaceId,
        collapsedProjects: state.collapsedProjects,
        expandedSessions: state.expandedSessions,
        showArchived: state.showArchived,
        sidebarHidden: state.sidebarHidden,
        sidebarWidth: state.sidebarWidth,
        sidebarPosition: state.sidebarPosition,
        terminalFont: state.terminalFont,
        uiFont: state.uiFont,
        appearance: state.appearance,
        themeIds: state.themeIds,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
});

darkScheme.addEventListener('change', () => useUi.setState({ systemScheme: systemScheme() }));

export function activeThemeId(state: UiState): string {
    return state.previewThemeId ?? state.themeIds[schemeOf(state.appearance, state.systemScheme)];
}

function firstOpenSession(app: AppState): Session | undefined {
    return app.sessions.find((session) => !session.archived);
}

export function selectedWorkspace(state: UiState): Workspace | undefined {
    return state.selectedWorkspaceId ? state.app?.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) : undefined;
}

export function shownPaneIds(state: UiState): string[] {
    const workspace = selectedWorkspace(state);
    if (workspace) {
        return paneIds(workspace.layout);
    }
    return paneIds(state.app?.sessions.find((session) => session.id === state.selectedSessionId)?.layout ?? null);
}

export function panesOf(app: AppState | null, sessionId: string): PaneView[] {
    return app ? app.panes.filter((pane) => pane.sessionId === sessionId) : [];
}

const ATTENTION_ORDER = { 'needs-input': 0, done: 1 } as const;

export function attentionPanes(app: AppState | null): PaneView[] {
    if (!app) {
        return [];
    }
    const archived = new Set(app.sessions.filter((session) => session.archived).map((session) => session.id));
    return app.panes
        .filter((pane) => needsAttention(pane.status) && !archived.has(pane.sessionId))
        .sort((a, b) => {
            const rank = ATTENTION_ORDER[a.status as keyof typeof ATTENTION_ORDER] - ATTENTION_ORDER[b.status as keyof typeof ATTENTION_ORDER];
            return rank !== 0 ? rank : a.statusAt - b.statusAt;
        });
}

export function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    useUi.getState().showToast(message, 'error');
}
