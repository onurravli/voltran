import { create } from 'zustand';
import type { AppState, LayoutDirection, PaneView, Session } from '@voltran/shared';
import { needsAttention } from '@voltran/shared';

export type Connection = 'connecting' | 'online' | 'offline' | 'unauthenticated';

export type Dialog =
    | { kind: 'project' }
    | { kind: 'session'; projectId?: string }
    | { kind: 'shortcuts' }
    | { kind: 'confirm'; title: string; body: string; action: string; onConfirm: () => void | Promise<void> };

export interface PaneMenuTarget {
    sessionId: string;
    splitFrom?: string;
    direction?: LayoutDirection;
    anchor: { x: number; y: number };
}

export interface Toast {
    id: number;
    message: string;
    tone: 'info' | 'error';
}

interface UiState {
    app: AppState | null;
    connection: Connection;
    selectedSessionId: string | null;
    focusedPaneId: string | null;
    maximizedPaneId: string | null;
    collapsedProjects: Record<string, boolean>;
    showArchived: boolean;
    dialog: Dialog | null;
    paneMenu: PaneMenuTarget | null;
    toast: Toast | null;
    setApp: (app: AppState) => void;
    setConnection: (connection: Connection) => void;
    selectSession: (id: string | null) => void;
    focusPane: (id: string | null) => void;
    toggleMaximize: (id: string) => void;
    toggleProject: (id: string) => void;
    setShowArchived: (value: boolean) => void;
    openDialog: (dialog: Dialog | null) => void;
    openPaneMenu: (target: PaneMenuTarget | null) => void;
    showToast: (message: string, tone?: Toast['tone']) => void;
}

const STORAGE_KEY = 'voltran.ui';

interface Persisted {
    selectedSessionId: string | null;
    collapsedProjects: Record<string, boolean>;
    showArchived: boolean;
}

function readPersisted(): Persisted {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<Persisted>;
            return {
                selectedSessionId: typeof parsed.selectedSessionId === 'string' ? parsed.selectedSessionId : null,
                collapsedProjects: parsed.collapsedProjects && typeof parsed.collapsedProjects === 'object' ? parsed.collapsedProjects : {},
                showArchived: parsed.showArchived === true,
            };
        }
    } catch {
        localStorage.removeItem(STORAGE_KEY);
    }
    return { selectedSessionId: null, collapsedProjects: {}, showArchived: false };
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
    app: null,
    connection: 'connecting',
    ...readPersisted(),
    focusedPaneId: null,
    maximizedPaneId: null,
    dialog: null,
    paneMenu: null,
    toast: null,

    setApp: (app) => {
        const { selectedSessionId, focusedPaneId, maximizedPaneId } = get();
        const sessionExists = selectedSessionId !== null && app.sessions.some((session) => session.id === selectedSessionId);
        const paneIds = new Set(app.panes.map((pane) => pane.id));
        set({
            app,
            selectedSessionId: sessionExists ? selectedSessionId : firstOpenSession(app)?.id ?? null,
            focusedPaneId: focusedPaneId && paneIds.has(focusedPaneId) ? focusedPaneId : null,
            maximizedPaneId: maximizedPaneId && paneIds.has(maximizedPaneId) ? maximizedPaneId : null,
        });
    },
    setConnection: (connection) => set({ connection }),
    selectSession: (id) => set({ selectedSessionId: id, maximizedPaneId: null }),
    focusPane: (id) => set({ focusedPaneId: id }),
    toggleMaximize: (id) => set({ maximizedPaneId: get().maximizedPaneId === id ? null : id }),
    toggleProject: (id) => set({ collapsedProjects: { ...get().collapsedProjects, [id]: !get().collapsedProjects[id] } }),
    setShowArchived: (value) => set({ showArchived: value }),
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
}));

useUi.subscribe((state) => {
    const persisted: Persisted = {
        selectedSessionId: state.selectedSessionId,
        collapsedProjects: state.collapsedProjects,
        showArchived: state.showArchived,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
});

function firstOpenSession(app: AppState): Session | undefined {
    return app.sessions.find((session) => !session.archived);
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
