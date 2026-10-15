import type { DropEdge, Layout } from '@voltran/shared';
import { MAX_WORKSPACE_PANES, removePane } from '@voltran/shared';
import { api } from './api.ts';
import { PANE_DRAG_TYPE, SESSION_DRAG_TYPE } from './drag.ts';
import { reportError, useUi } from './store.ts';
import { dropOnWorkspace, nextWorkspaceTitle, type Dragged } from './workspaces.ts';

export interface PaneHost {
    kind: 'session' | 'workspace';
    id: string;
    layout: Layout | null;
}

export function saveHostLayout(host: PaneHost, layout: Layout | null): void {
    const saved = host.kind === 'session' ? api.updateSession(host.id, { layout }) : api.updateWorkspace(host.id, { layout });
    saved.catch(reportError);
}

// Browsers hide drag data until the drop, so while dragging the store says what is being dragged.
export function draggedItem(data: DataTransfer | null): Dragged | null {
    const { draggingPaneId, draggingSessionId } = useUi.getState();
    const paneId = data?.getData(PANE_DRAG_TYPE) || draggingPaneId;
    if (paneId) {
        return { kind: 'pane', paneId };
    }
    const sessionId = data?.getData(SESSION_DRAG_TYPE) || draggingSessionId;
    return sessionId ? { kind: 'session', sessionId } : null;
}

export function endDrag(): void {
    const state = useUi.getState();
    state.setDraggingPane(null);
    state.setDraggingSession(null);
}

export function dropIntoWorkspace(workspaceId: string, dragged: Dragged, targetId: string | null, edge: DropEdge): void {
    const { app, showToast } = useUi.getState();
    const workspace = app?.workspaces.find((entry) => entry.id === workspaceId);
    if (!app || !workspace) {
        return;
    }
    const result = dropOnWorkspace(app, workspace.layout, dragged, targetId, edge);
    if (result.kind === 'full') {
        showToast(`A workspace shows at most ${MAX_WORKSPACE_PANES} panes`, 'error');
    } else if (result.kind === 'changed') {
        api.updateWorkspace(workspace.id, { layout: result.layout }).catch(reportError);
    }
}

export function removeFromWorkspace(workspaceId: string, paneId: string): void {
    const workspace = useUi.getState().app?.workspaces.find((entry) => entry.id === workspaceId);
    if (workspace) {
        api.updateWorkspace(workspace.id, { layout: removePane(workspace.layout, paneId) }).catch(reportError);
    }
}

export function createWorkspace(): void {
    const workspaces = useUi.getState().app?.workspaces ?? [];
    api.createWorkspace({ title: nextWorkspaceTitle(workspaces) })
        .then((workspace) => useUi.getState().selectWorkspace(workspace.id))
        .catch(reportError);
}
