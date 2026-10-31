import { useState } from 'react';
import type { Workspace } from '@voltran/shared';
import { paneIds } from '@voltran/shared';
import { api } from '../api.ts';
import { workspaceMenu } from '../menus.ts';
import { keys } from '../shortcuts.ts';
import { useUi } from '../store.ts';
import { draggedItem, dropIntoWorkspace, endDrag, saveHostLayout, type PaneHost } from '../workspace-actions.ts';
import { InlineEdit, MoreMenu } from './Controls.tsx';
import { SidebarIcon } from './Icons.tsx';
import { LayoutNode, PaneBox, setSizesAt } from './SessionView.tsx';

function WorkspaceHeader({ workspace }: { workspace: Workspace }) {
    const sidebarHidden = useUi((state) => state.sidebarHidden);
    const toggleSidebar = useUi((state) => state.toggleSidebar);
    const [renaming, setRenaming] = useState(false);
    const count = paneIds(workspace.layout).length;

    return (
        <header className="session-header">
            <button
                type="button"
                className="icon-button icon-button--bar"
                title={sidebarHidden ? `Show the sidebar (${keys('⌃⌥B')})` : `Hide the sidebar (${keys('⌃⌥B')})`}
                aria-label={sidebarHidden ? 'Show the sidebar' : 'Hide the sidebar'}
                aria-pressed={!sidebarHidden}
                onClick={toggleSidebar}
            >
                <SidebarIcon size={16} />
            </button>
            <div className="session-header__crumb">
                <span className="session-header__project session-header__project--plain">Workspace</span>
                <span className="session-header__slash" aria-hidden="true">
                    /
                </span>
                <InlineEdit
                    className="session-header__title"
                    label="Workspace name"
                    value={workspace.title}
                    editing={renaming}
                    onEditingChange={setRenaming}
                    onSave={(title) => api.updateWorkspace(workspace.id, { title })}
                />
            </div>
            <span className="workspace__count">{count === 1 ? '1 pane' : `${count} panes`}</span>
            <div className="session-header__actions">
                <MoreMenu
                    label="Workspace actions"
                    items={() => workspaceMenu(workspace, () => setRenaming(true), 'header')}
                />
            </div>
        </header>
    );
}

function EmptyWorkspace({ workspace }: { workspace: Workspace }) {
    const dragging = useUi((state) => state.draggingPaneId !== null || state.draggingSessionId !== null);
    const [over, setOver] = useState(false);

    return (
        <div
            className={`empty workspace__empty${dragging ? ' is-drop-candidate' : ''}${dragging && over ? ' is-drop-target' : ''}`}
            onDragOver={(event) => {
                if (dragging) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                    setOver(true);
                }
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                setOver(false);
                const dragged = draggedItem(event.dataTransfer);
                endDrag();
                if (dragged) {
                    event.preventDefault();
                    dropIntoWorkspace(workspace.id, dragged, null, 'swap');
                }
            }}
        >
            <p>Drag panes or whole sessions here from the sidebar.</p>
            <p className="workspace__hint">
                They keep running in their own sessions; a workspace only shows them side by side.
            </p>
        </div>
    );
}

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
    const app = useUi((state) => state.app);
    const maximizedPaneId = useUi((state) => state.maximizedPaneId);
    const panes = new Map((app?.panes ?? []).map((pane) => [pane.id, pane]));
    const shown = new Set(paneIds(workspace.layout));
    const maximized = maximizedPaneId && shown.has(maximizedPaneId) ? panes.get(maximizedPaneId) : undefined;
    const host: PaneHost = { kind: 'workspace', id: workspace.id, layout: workspace.layout };

    const onSizes = (path: number[], sizes: number[]): void => {
        if (workspace.layout) {
            saveHostLayout(host, setSizesAt(workspace.layout, path, sizes));
        }
    };

    return (
        <div className="session">
            <WorkspaceHeader workspace={workspace} />
            <div className="session__body">
                {maximized ? (
                    <PaneBox pane={maximized} host={host} />
                ) : workspace.layout ? (
                    <LayoutNode node={workspace.layout} path={[]} host={host} panes={panes} onSizes={onSizes} />
                ) : (
                    <EmptyWorkspace workspace={workspace} />
                )}
            </div>
        </div>
    );
}
