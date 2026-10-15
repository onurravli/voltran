import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from './hub.ts';
import { Store } from './store.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()!();
    }
});

function open(dir: string): { store: Store; hub: Hub } {
    const store = new Store(join(dir, 'voltran.db'));
    const hub = new Hub({
        store,
        adapters: [],
        scrollbackDir: dir,
        claudeSettingsFile: join(dir, 'claude-settings.json'),
        url: 'http://127.0.0.1:1',
        shell: '/bin/sh',
        path: '/usr/bin:/bin',
        baseEnv: {},
    });
    return { store, hub };
}

describe('Hub', () => {
    it('drops panes that no longer exist from workspaces when it starts', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-hub-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const first = open(dir);
        const project = first.hub.createProject({ path: dir });
        const session = first.hub.createSession({ projectId: project.id, title: 'kept' });
        const kept = session.layout?.type === 'pane' ? session.layout.paneId : '';
        const workspace = first.hub.createWorkspace({ title: 'stale' });
        first.store.updateWorkspace(workspace.id, {
            layout: { type: 'split', direction: 'horizontal', children: [{ type: 'pane', paneId: 'gone' }, { type: 'pane', paneId: kept }], sizes: [50, 50] },
        });
        await first.hub.shutdown();
        first.store.close();

        const second = open(dir);
        cleanups.push(async () => {
            await second.hub.shutdown();
            second.store.close();
        });
        expect(second.hub.state().workspaces).toEqual([expect.objectContaining({ id: workspace.id, layout: { type: 'pane', paneId: kept } })]);
    });
});
