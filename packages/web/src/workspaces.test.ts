import { describe, expect, it } from 'vitest';
import { MAX_WORKSPACE_PANES, paneIds, type AppState, type Layout, type PaneView, type Session, type Workspace } from '@voltran/shared';
import { dropOnWorkspace, nextWorkspaceTitle, workspaceStatus } from './workspaces.ts';

const leaf = (paneId: string): Layout => ({ type: 'pane', paneId });
const row = (...ids: string[]): Layout => ({ type: 'split', direction: 'horizontal', children: ids.map(leaf), sizes: ids.map(() => 100 / ids.length) });
const column = (...ids: string[]): Layout => ({ type: 'split', direction: 'vertical', children: ids.map(leaf), sizes: ids.map(() => 100 / ids.length) });

const session = (id: string, layout: Layout | null): Session => ({ id, projectId: 'p', title: id, titleSource: 'user', link: null, cwd: '/tmp', worktree: null, layout, archived: false, createdAt: 0, updatedAt: 0 });
const pane = (id: string, sessionId: string, status: PaneView['status'] = 'idle'): PaneView => ({ id, sessionId, status } as PaneView);
const workspace = (layout: Layout | null, title = 'w'): Workspace => ({ id: 'w', title, layout, createdAt: 0, updatedAt: 0 });

const app = {
    projects: [],
    sessions: [session('a', row('a1', 'a2')), session('b', leaf('b1')), session('c', column('c1', 'c2', 'c3'))],
    panes: [pane('a1', 'a'), pane('a2', 'a'), pane('b1', 'b', 'needs-input'), pane('c1', 'c'), pane('c2', 'c', 'working'), pane('c3', 'c')],
    workspaces: [],
    git: {},
    adapters: [],
} as AppState;

describe('dropOnWorkspace', () => {
    it('starts an empty workspace with the dropped pane or session', () => {
        expect(dropOnWorkspace(app, null, { kind: 'pane', paneId: 'b1' }, null, 'swap')).toEqual({ kind: 'changed', layout: leaf('b1') });
        expect(dropOnWorkspace(app, null, { kind: 'session', sessionId: 'c' }, null, 'swap')).toEqual({ kind: 'changed', layout: column('c1', 'c2', 'c3') });
    });

    it('places a pane from another project on the edge it was dropped on', () => {
        const result = dropOnWorkspace(app, row('a1', 'a2'), { kind: 'pane', paneId: 'b1' }, 'a1', 'left');
        expect(result.kind === 'changed' && paneIds(result.layout)).toEqual(['b1', 'a1', 'a2']);
    });

    it('adds only the panes of a session that the workspace does not show yet, in their arrangement', () => {
        const result = dropOnWorkspace(app, row('a1', 'c2'), { kind: 'session', sessionId: 'c' }, 'a1', 'bottom');
        expect(result).toEqual({
            kind: 'changed',
            layout: {
                type: 'split',
                direction: 'horizontal',
                children: [{ type: 'split', direction: 'vertical', children: [leaf('a1'), column('c1', 'c3')], sizes: [50, 50] }, leaf('c2')],
                sizes: [50, 50],
            },
        });
        expect(dropOnWorkspace(app, row('c1', 'c2', 'c3'), { kind: 'session', sessionId: 'c' }, 'c1', 'left')).toEqual({ kind: 'unchanged' });
    });

    it('moves a pane the workspace already shows instead of adding it twice', () => {
        const result = dropOnWorkspace(app, row('a1', 'b1'), { kind: 'pane', paneId: 'b1' }, 'a1', 'swap');
        expect(result).toEqual({ kind: 'changed', layout: row('b1', 'a1') });
        expect(dropOnWorkspace(app, row('a1', 'b1'), { kind: 'pane', paneId: 'b1' }, null, 'swap')).toEqual({ kind: 'unchanged' });
    });

    it('ignores panes and sessions that no longer exist', () => {
        expect(dropOnWorkspace(app, leaf('a1'), { kind: 'pane', paneId: 'gone' }, 'a1', 'left')).toEqual({ kind: 'unchanged' });
        expect(dropOnWorkspace(app, leaf('a1'), { kind: 'session', sessionId: 'gone' }, 'a1', 'left')).toEqual({ kind: 'unchanged' });
    });

    it('refuses to grow past the limit', () => {
        const ids = Array.from({ length: MAX_WORKSPACE_PANES - 1 }, (_, index) => `x${index}`);
        expect(dropOnWorkspace(app, row(...ids), { kind: 'pane', paneId: 'b1' }, null, 'swap').kind).toBe('changed');
        expect(dropOnWorkspace(app, row(...ids), { kind: 'session', sessionId: 'a' }, null, 'swap')).toEqual({ kind: 'full' });
    });
});

describe('workspaceStatus', () => {
    it('reports the most urgent status of the panes it shows', () => {
        expect(workspaceStatus(app, workspace(row('a1', 'b1', 'c2')))).toBe('needs-input');
        expect(workspaceStatus(app, workspace(row('a1', 'c2')))).toBe('working');
        expect(workspaceStatus(app, workspace(null))).toBeNull();
    });
});

describe('nextWorkspaceTitle', () => {
    it('numbers new workspaces without reusing a title', () => {
        expect(nextWorkspaceTitle([])).toBe('Workspace 1');
        expect(nextWorkspaceTitle([workspace(null, 'Workspace 2')])).toBe('Workspace 3');
        expect(nextWorkspaceTitle([workspace(null, 'Release')])).toBe('Workspace 2');
    });
});
