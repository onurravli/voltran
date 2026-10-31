import {
    PROJECT_COLORS,
    type PaneSpec,
    type PaneView,
    type Project,
    type Session,
    type Workspace,
} from '@voltran/shared';
import { api } from './api.ts';
import { shortPath } from './labels.ts';
import { revealPane } from './notify.ts';
import { closePane, orderedSessions } from './shortcuts.ts';
import { stepBefore } from './sidebar.ts';
import { panesOf, reportError, useUi } from './store.ts';
import { addToWorkspace, createWorkspace, deleteWorkspace } from './workspace-actions.ts';
import { dropOnWorkspace, type Dragged } from './workspaces.ts';

interface MenuAction {
    label: string;
    note?: string;
    danger?: boolean;
    separated?: boolean;
    disabled?: boolean;
    onSelect: () => void;
}

interface MenuSwatches {
    label: string;
    swatches: readonly { name: string; value: string }[];
    selected: string;
    separated?: boolean;
    onPick: (value: string) => void;
}

interface MenuSubmenu {
    label: string;
    items: MenuItem[];
    separated?: boolean;
    disabled?: boolean;
}

export type MenuItem = MenuAction | MenuSwatches | MenuSubmenu;

function copy(text: string, what: string): void {
    navigator.clipboard
        .writeText(text)
        .then(() => useUi.getState().showToast(`Copied the ${what}`))
        .catch(reportError);
}

function addPaneItems(sessionId: string): MenuItem[] {
    const app = useUi.getState().app;
    const session = app?.sessions.find((entry) => entry.id === sessionId);
    const inGit = session ? Boolean(app?.git[session.cwd]) : false;
    const create = (spec: PaneSpec): void => {
        api.createPane(sessionId, spec)
            .then((pane) => revealPane(sessionId, pane.id))
            .catch(reportError);
    };
    const adapters = (app?.adapters ?? []).filter(
        (adapter) => adapter.kind !== 'page' && adapter.id !== 'command' && adapter.id !== 'subagent',
    );
    return [
        ...adapters.map((adapter) => ({
            label: adapter.label,
            note: adapter.available ? (adapter.kind === 'agent' ? 'agent' : undefined) : 'not installed',
            disabled: !adapter.available,
            onSelect: () => create({ adapter: adapter.id }),
        })),
        {
            label: 'Changes',
            note: inGit ? undefined : 'not in git',
            disabled: !inGit,
            onSelect: () => create({ adapter: 'changes' }),
        },
        { label: 'Editor', note: 'files', onSelect: () => create({ adapter: 'editor' }) },
    ];
}

function workspaceItems(dragged: Dragged): MenuItem[] {
    const app = useUi.getState().app;
    const workspaces = app?.workspaces ?? [];
    return [
        ...workspaces.map((workspace) => {
            const result = app ? dropOnWorkspace(app, workspace.layout, dragged, null, 'swap').kind : 'unchanged';
            return {
                label: workspace.title,
                note: result === 'unchanged' ? 'already there' : result === 'full' ? 'full' : undefined,
                disabled: result !== 'changed',
                onSelect: () => addToWorkspace(workspace.id, dragged),
            };
        }),
        { label: 'New workspace', separated: workspaces.length > 0, onSelect: () => addToWorkspace(null, dragged) },
    ];
}

function moveItems(ids: string[], id: string, move: (before: string | null) => Promise<unknown>): MenuItem[] {
    const up = stepBefore(ids, id, -1);
    const down = stepBefore(ids, id, 1);
    return [
        {
            label: 'Move up',
            separated: true,
            disabled: up === undefined,
            onSelect: () => {
                if (up !== undefined) {
                    move(up).catch(reportError);
                }
            },
        },
        {
            label: 'Move down',
            disabled: down === undefined,
            onSelect: () => {
                if (down !== undefined) {
                    move(down).catch(reportError);
                }
            },
        },
    ];
}

export function removeProject(project: Project): void {
    const sessions = useUi.getState().app?.sessions.filter((session) => session.projectId === project.id) ?? [];
    useUi.getState().openDialog({
        kind: 'confirm',
        title: `Remove ${project.name}?`,
        body: `Its ${sessions.length === 1 ? 'session' : `${sessions.length} sessions`} and every process in them stop. Files in ${project.path} are not touched.${
            sessions.some((session) => session.worktree)
                ? ' Session worktrees without uncommitted changes are removed; the others and every branch stay.'
                : ''
        }`,
        action: 'Remove project',
        onConfirm: () => api.deleteProject(project.id),
    });
}

export function deleteSession(session: Session): void {
    const { app, openDialog } = useUi.getState();
    const git = app?.git[session.cwd];
    const stops =
        'Every process in this session stops and its scrollback is deleted. Agent conversations stay in their own history.';
    const changes = git?.changed ?? 0;
    const branch = git?.branch ? `the branch ${git.branch}` : 'its branch';
    if (session.worktree && changes > 0) {
        openDialog({
            kind: 'confirm',
            title: `Delete ${session.title}?`,
            body: `${stops} Its worktree at ${shortPath(session.worktree)} has ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}. Keep the worktree to come back to it later, or delete it along with the changes. ${branch[0].toUpperCase()}${branch.slice(1)} stays either way.`,
            action: 'Delete the changes too',
            onConfirm: () => api.deleteSession(session.id, 'remove'),
            alternative: { action: 'Keep the worktree', onConfirm: () => api.deleteSession(session.id, 'keep') },
        });
        return;
    }
    openDialog({
        kind: 'confirm',
        title: `Delete ${session.title}?`,
        body: session.worktree
            ? `${stops} Its worktree at ${shortPath(session.worktree)} is removed; ${branch} stays.`
            : stops,
        action: 'Delete session',
        onConfirm: () => api.deleteSession(session.id),
    });
}

export function projectMenu(project: Project, rename: () => void): MenuItem[] {
    const ui = useUi.getState();
    const collapsed = Boolean(ui.collapsedProjects[project.id]);
    return [
        { label: 'New session…', onSelect: () => ui.openDialog({ kind: 'session', projectId: project.id }) },
        ...(ui.app?.git[project.path]
            ? [
                  {
                      label: 'New session in a worktree…',
                      onSelect: () => ui.openDialog({ kind: 'session', projectId: project.id, worktree: true }),
                  },
              ]
            : []),
        { label: 'Rename', separated: true, onSelect: rename },
        {
            label: 'Colour',
            swatches: PROJECT_COLORS,
            selected: project.color,
            onPick: (color) => api.updateProject(project.id, { color }).catch(reportError),
        },
        { label: collapsed ? 'Expand' : 'Collapse', onSelect: () => ui.toggleProject(project.id) },
        { label: 'Copy folder path', onSelect: () => copy(project.path, 'folder path') },
        ...moveItems(
            (ui.app?.projects ?? []).map((entry) => entry.id),
            project.id,
            (moveBefore) => api.updateProject(project.id, { moveBefore }),
        ),
        { label: 'Remove project…', danger: true, separated: true, onSelect: () => removeProject(project) },
    ];
}

// The header has its own Add pane button and shows no pane list, so those two items are sidebar only.
export function sessionMenu(
    session: Session,
    actions: { rename: () => void; editLink: () => void },
    where: 'sidebar' | 'header',
): MenuItem[] {
    const ui = useUi.getState();
    const panes = panesOf(ui.app, session.id);
    const branch = session.worktree ? (ui.app?.git[session.cwd]?.branch ?? null) : null;
    const finished = panes.filter((pane) => pane.status === 'done');
    const link = session.link;
    const sidebar = where === 'sidebar';
    const siblings = orderedSessions(ui.app, ui.showArchived)
        .filter((entry) => entry.projectId === session.projectId)
        .map((entry) => entry.id);
    return [
        ...(sidebar ? [{ label: 'Add pane', items: addPaneItems(session.id), disabled: session.archived }] : []),
        { label: 'Rename', onSelect: actions.rename },
        { label: link ? 'Edit link' : 'Add link', onSelect: actions.editLink },
        ...(link ? [{ label: 'Open link', onSelect: () => window.open(link, '_blank', 'noopener,noreferrer') }] : []),
        { label: 'Copy folder path', onSelect: () => copy(session.cwd, 'folder path') },
        ...(branch ? [{ label: 'Copy branch name', onSelect: () => copy(branch, 'branch name') }] : []),
        ...(sidebar && panes.length > 0
            ? [
                  {
                      label: ui.expandedSessions[session.id] ? 'Hide panes' : 'Show panes',
                      onSelect: () => ui.toggleSessionPanes(session.id),
                  },
              ]
            : []),
        {
            label: 'Add to workspace',
            items: workspaceItems({ kind: 'session', sessionId: session.id }),
            disabled: panes.length === 0,
        },
        ...(finished.length > 0
            ? [
                  {
                      label: finished.length === 1 ? 'Mark as seen' : 'Mark all as seen',
                      onSelect: () => finished.forEach((pane) => api.seenPane(pane.id).catch(reportError)),
                  },
              ]
            : []),
        ...(sidebar
            ? moveItems(siblings, session.id, (moveBefore) => api.updateSession(session.id, { moveBefore }))
            : []),
        session.archived
            ? {
                  label: 'Restore session',
                  separated: true,
                  onSelect: () => api.updateSession(session.id, { archived: false }).catch(reportError),
              }
            : {
                  label: 'Archive session',
                  note: 'stops its processes',
                  separated: true,
                  onSelect: () => api.updateSession(session.id, { archived: true }).catch(reportError),
              },
        { label: 'Delete session…', danger: true, onSelect: () => deleteSession(session) },
    ];
}

// revealPane selects the pane's session unless the open workspace shows it, and selecting a session
// restores any maximized pane, so the wanted state is set after revealing.
function maximize(pane: PaneView, on: boolean): void {
    revealPane(pane.sessionId, pane.id);
    const ui = useUi.getState();
    if ((ui.maximizedPaneId === pane.id) !== on) {
        ui.toggleMaximize(pane.id);
    }
}

function showNotes(pane: PaneView, on: boolean): void {
    revealPane(pane.sessionId, pane.id);
    const ui = useUi.getState();
    if (Boolean(ui.notesOpen[pane.id]) !== on) {
        ui.toggleNotes(pane.id);
    }
}

function showConversation(pane: PaneView, on: boolean): void {
    revealPane(pane.sessionId, pane.id);
    const ui = useUi.getState();
    if (Boolean(ui.conversationOpen[pane.id]) !== on) {
        ui.toggleConversation(pane.id);
    }
}

export function paneMenu(pane: PaneView): MenuItem[] {
    const ui = useUi.getState();
    const session = ui.app?.sessions.find((entry) => entry.id === pane.sessionId);
    if (!ui.app || !session) {
        return [];
    }
    const adapter = ui.app.adapters.find((entry) => entry.id === pane.adapter);
    const maximized = ui.maximizedPaneId === pane.id;
    const notesOpen = Boolean(ui.notesOpen[pane.id]);
    const conversationOpen = Boolean(ui.conversationOpen[pane.id]);
    const others = ui.app.sessions.filter(
        (entry) => entry.projectId === session.projectId && entry.id !== session.id && !entry.archived,
    );
    return [
        { label: 'Show', onSelect: () => revealPane(session.id, pane.id) },
        { label: maximized ? 'Restore size' : 'Maximize', onSelect: () => maximize(pane, !maximized) },
        ...(pane.adapter === 'claude'
            ? [
                  {
                      label: conversationOpen ? 'Show terminal' : 'Show conversation',
                      onSelect: () => showConversation(pane, !conversationOpen),
                  },
              ]
            : []),
        ...(pane.adapter === 'subagent' ||
        pane.adapter === 'preview' ||
        pane.adapter === 'changes' ||
        pane.adapter === 'editor'
            ? []
            : [{ label: notesOpen ? 'Hide notes' : 'Show notes', onSelect: () => showNotes(pane, !notesOpen) }]),
        {
            label: adapter?.resumable ? 'Restart and resume' : 'Restart',
            separated: true,
            disabled: session.archived,
            onSelect: () => api.restartPane(pane.id).catch(reportError),
        },
        ...(pane.pid !== null
            ? [{ label: 'Stop process', onSelect: () => api.killPane(pane.id).catch(reportError) }]
            : []),
        {
            label: 'Move to session',
            disabled: others.length === 0,
            items: others.map((target) => ({
                label: target.title,
                onSelect: () => {
                    api.movePane(pane.id, { sessionId: target.id })
                        .then(() => useUi.getState().showToast(`Moved to ${target.title}`))
                        .catch(reportError);
                },
            })),
        },
        { label: 'Add to workspace', items: workspaceItems({ kind: 'pane', paneId: pane.id }) },
        ...(pane.status === 'done'
            ? [{ label: 'Mark as seen', onSelect: () => api.seenPane(pane.id).catch(reportError) }]
            : []),
        {
            label: pane.status === 'exited' ? 'Close pane' : 'Close pane…',
            danger: true,
            separated: true,
            onSelect: () => closePane(pane),
        },
    ];
}

export function workspaceMenu(workspace: Workspace, rename: () => void, where: 'sidebar' | 'header'): MenuItem[] {
    return [
        ...(where === 'sidebar'
            ? [{ label: 'Open', onSelect: () => useUi.getState().selectWorkspace(workspace.id) }]
            : []),
        { label: 'Rename', onSelect: rename },
        { label: 'Delete workspace…', danger: true, separated: true, onSelect: () => deleteWorkspace(workspace) },
    ];
}

export function sidebarMenu(): MenuItem[] {
    const ui = useUi.getState();
    const hasProjects = (ui.app?.projects.length ?? 0) > 0;
    const archived = ui.app?.sessions.some((session) => session.archived) ?? false;
    return [
        ...(hasProjects ? [{ label: 'New session…', onSelect: () => ui.openDialog({ kind: 'session' }) }] : []),
        { label: 'Add project…', onSelect: () => ui.openDialog({ kind: 'project' }) },
        { label: 'New workspace', onSelect: createWorkspace },
        ...(archived || ui.showArchived
            ? [
                  {
                      label: ui.showArchived ? 'Hide archived sessions' : 'Show archived sessions',
                      separated: true,
                      onSelect: () => ui.setShowArchived(!ui.showArchived),
                  },
              ]
            : []),
    ];
}
