import type { AppState, PaneStatus } from '@voltran/shared';
import { aggregateStatus, paneIds } from '@voltran/shared';
import { workspaceStatus } from './workspaces.ts';

export interface Searchable {
    label: string;
    keywords?: string;
}

export function filterItems<T extends Searchable>(items: T[], query: string): T[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return items;
    }
    const ranked: { item: T; rank: number; order: number }[] = [];
    items.forEach((item, order) => {
        const label = item.label.toLowerCase();
        const text = item.keywords ? `${label} ${item.keywords.toLowerCase()}` : label;
        if (!tokens.every((token) => text.includes(token))) {
            return;
        }
        const position = label.indexOf(tokens[0]);
        if (position < 0) {
            ranked.push({ item, rank: 3, order });
            return;
        }
        const atWordStart = position === 0 || /[\s(:/-]/.test(label[position - 1]);
        ranked.push({ item, rank: position === 0 ? 0 : atWordStart ? 1 : 2, order });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
    return ranked.map((entry) => entry.item);
}

export interface Destination extends Searchable {
    id: string;
    kind: 'workspace' | 'session' | 'pane';
    workspaceId: string | null;
    sessionId: string | null;
    paneId: string | null;
    status: PaneStatus | null;
}

export function destinations(app: AppState | null): Destination[] {
    if (!app) {
        return [];
    }
    const projects = new Map(app.projects.map((project) => [project.id, project.name]));
    const open = app.sessions.filter((session) => !session.archived);
    const panesOf = (sessionId: string) => app.panes.filter((pane) => pane.sessionId === sessionId);
    const workspaces: Destination[] = app.workspaces.map((workspace) => ({
        id: `workspace:${workspace.id}`,
        kind: 'workspace',
        label: workspace.title,
        keywords: `workspace ${paneIds(workspace.layout).length === 1 ? '1 pane' : `${paneIds(workspace.layout).length} panes`}`,
        workspaceId: workspace.id,
        sessionId: null,
        paneId: null,
        status: workspaceStatus(app, workspace),
    }));
    const sessions: Destination[] = open.map((session) => ({
        id: `session:${session.id}`,
        kind: 'session',
        label: session.title,
        keywords: projects.get(session.projectId),
        workspaceId: null,
        sessionId: session.id,
        paneId: null,
        status: aggregateStatus(panesOf(session.id).map((pane) => pane.status)),
    }));
    const panes: Destination[] = open.flatMap((session) =>
        panesOf(session.id).map((pane) => ({
            id: `pane:${pane.id}`,
            kind: 'pane' as const,
            label: `${pane.title} · ${session.title}`,
            keywords: projects.get(session.projectId),
            workspaceId: null,
            sessionId: session.id,
            paneId: pane.id,
            status: pane.status,
        })),
    );
    return [...workspaces, ...sessions, ...panes];
}
