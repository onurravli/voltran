import { describe, expect, it } from 'vitest';
import type { AppState, PaneView, Session } from '@voltran/shared';
import { destinations, filterItems } from './palette.ts';

const items = [
    { label: 'Jump to the next pane that needs you' },
    { label: 'Start a new session' },
    { label: 'Font family…' },
    { label: 'Font size: bigger' },
    { label: 'Font size: smaller' },
    { label: 'Split the focused pane to the right with a shell' },
];

const labels = (query: string): string[] => filterItems(items, query).map((item) => item.label);

describe('filterItems', () => {
    it('returns everything in the original order for an empty query', () => {
        expect(filterItems(items, '   ')).toEqual(items);
    });

    it('matches case-insensitively and requires every word', () => {
        expect(labels('FONT size')).toEqual(['Font size: bigger', 'Font size: smaller']);
        expect(labels('font bigger')).toEqual(['Font size: bigger']);
        expect(labels('font session')).toEqual([]);
    });

    it('ranks label prefixes, then word starts, then inner matches', () => {
        expect(labels('s')[0]).toBe('Start a new session');
        expect(labels('size')).toEqual(['Font size: bigger', 'Font size: smaller']);
        expect(labels('ession')).toEqual(['Start a new session']);
        expect(labels('pane')).toEqual(['Jump to the next pane that needs you', 'Split the focused pane to the right with a shell']);
    });
});

const session = (id: string, title: string, archived = false): Session => ({
    id,
    projectId: 'project',
    title,
    link: null,
    cwd: '/tmp',
    layout: null,
    archived,
    createdAt: 0,
    updatedAt: 0,
});

const pane = (id: string, sessionId: string, title: string, status: PaneView['status']): PaneView => ({ id, sessionId, title, status } as PaneView);

const app = {
    projects: [{ id: 'project', name: 'checkout', path: '/tmp', color: '#7aa2f7', createdAt: 0 }],
    sessions: [session('one', 'Fix flaky total'), session('two', 'Old spike', true)],
    panes: [pane('a', 'one', 'Claude', 'needs-input'), pane('b', 'one', 'tests', 'running'), pane('c', 'two', 'zsh', 'idle')],
    workspaces: [],
    adapters: [],
} as AppState;

describe('destinations', () => {
    it('lists open sessions, then their panes, and finds them by project name too', () => {
        expect(destinations(app).map((entry) => [entry.kind, entry.label, entry.keywords, entry.status])).toEqual([
            ['session', 'Fix flaky total', 'checkout', 'needs-input'],
            ['pane', 'Claude · Fix flaky total', 'checkout', 'needs-input'],
            ['pane', 'tests · Fix flaky total', 'checkout', 'running'],
        ]);
    });

    it('knows which session and pane to open', () => {
        const [first, second] = destinations(app);
        expect([first.sessionId, first.paneId]).toEqual(['one', null]);
        expect([second.sessionId, second.paneId]).toEqual(['one', 'a']);
    });

    it('lists nothing before the state arrives', () => {
        expect(destinations(null)).toEqual([]);
    });

    it('ranks a session above its panes, and keyword-only matches last', () => {
        const items = [{ label: 'Start a new session' }, ...destinations(app)];
        expect(filterItems(items, 'fix').map((item) => item.label)).toEqual(['Fix flaky total', 'Claude · Fix flaky total', 'tests · Fix flaky total']);
        expect(filterItems(items, 'checkout').map((item) => item.label)).toEqual(['Fix flaky total', 'Claude · Fix flaky total', 'tests · Fix flaky total']);
        expect(filterItems(items, 'checkout tests').map((item) => item.label)).toEqual(['tests · Fix flaky total']);
    });
});
