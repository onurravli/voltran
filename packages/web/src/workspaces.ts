import type { AppState, DropEdge, Layout, PaneStatus, Workspace } from '@voltran/shared';
import { MAX_WORKSPACE_PANES, aggregateStatus, movePane, paneIds, placeLayout, removePane } from '@voltran/shared';

export type Dragged = { kind: 'pane'; paneId: string } | { kind: 'session'; sessionId: string };

export type DropResult =
    | { kind: 'unchanged' }
    | { kind: 'full' }
    | { kind: 'changed'; layout: Layout | null };

// A pane already in the workspace moves within it; anything else joins it, a session with every pane
// it has that the workspace does not show yet, in the session's own arrangement.
export function dropOnWorkspace(app: AppState, layout: Layout | null, dragged: Dragged, targetId: string | null, edge: DropEdge): DropResult {
    const present = new Set(paneIds(layout));
    let placed: Layout | null = null;
    if (dragged.kind === 'pane') {
        if (present.has(dragged.paneId)) {
            const moved = targetId ? movePane(layout, dragged.paneId, targetId, edge) : layout;
            return moved === layout ? { kind: 'unchanged' } : { kind: 'changed', layout: moved };
        }
        if (app.panes.some((pane) => pane.id === dragged.paneId)) {
            placed = { type: 'pane', paneId: dragged.paneId };
        }
    } else {
        const session = app.sessions.find((entry) => entry.id === dragged.sessionId);
        const sessionLayout = session?.layout ?? null;
        placed = paneIds(sessionLayout).filter((paneId) => present.has(paneId)).reduce<Layout | null>((rest, paneId) => removePane(rest, paneId), sessionLayout);
    }
    if (!placed) {
        return { kind: 'unchanged' };
    }
    if (present.size + paneIds(placed).length > MAX_WORKSPACE_PANES) {
        return { kind: 'full' };
    }
    return { kind: 'changed', layout: placeLayout(layout, placed, targetId, edge) };
}

export function workspaceStatus(app: AppState | null, workspace: Workspace): PaneStatus | null {
    const ids = new Set(paneIds(workspace.layout));
    return aggregateStatus(app?.panes.filter((pane) => ids.has(pane.id)).map((pane) => pane.status) ?? []);
}

export function nextWorkspaceTitle(workspaces: Workspace[]): string {
    const taken = new Set(workspaces.map((workspace) => workspace.title));
    let index = workspaces.length + 1;
    while (taken.has(`Workspace ${index}`)) {
        index += 1;
    }
    return `Workspace ${index}`;
}
