import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hub, HttpError } from './hub.ts';
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
        notesDir: join(dir, 'notes'),
        worktreesDir: join(dir, 'worktrees'),
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
        const session = await first.hub.createSession({ projectId: project.id, title: 'kept' });
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

    describe('worktrees', () => {
        const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

        function repository(): { dir: string; repo: string; hub: Hub; store: Store } {
            const dir = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-worktrees-')));
            const repo = join(dir, 'repo');
            mkdirSync(join(repo, 'packages', 'web'), { recursive: true });
            writeFileSync(join(repo, 'packages', 'web', 'index.ts'), 'export {};\n');
            git(repo, 'init', '-q', '-b', 'main');
            git(repo, 'add', '-A');
            git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--no-gpg-sign', '-m', 'first');
            const opened = open(dir);
            cleanups.push(async () => {
                await opened.hub.shutdown();
                opened.store.close();
                rmSync(dir, { recursive: true, force: true });
            });
            return { dir, repo, ...opened };
        }

        const refused = async (action: Promise<unknown>): Promise<HttpError> => {
            const error = await action.then(() => null, (failure: unknown) => failure);
            expect(error).toBeInstanceOf(HttpError);
            return error as HttpError;
        };

        it('describes the project folder', async () => {
            const { dir, repo, hub } = repository();
            git(repo, 'branch', 'feature');
            const project = hub.createProject({ path: repo });
            expect(await hub.projectGit(project.id)).toEqual({ repository: true, branch: 'main', branches: expect.arrayContaining(['main', 'feature']) });
            mkdirSync(join(dir, 'plain'));
            const plain = hub.createProject({ path: join(dir, 'plain') });
            expect((await hub.projectGit(plain.id)).repository).toBe(false);
        });

        it('starts a session in a new worktree on a new branch, in the same subfolder as the project', async () => {
            const { dir, repo, hub } = repository();
            const project = hub.createProject({ name: 'Web App', path: join(repo, 'packages', 'web') });
            const session = await hub.createSession({ projectId: project.id, title: 'Fix login', worktree: { branch: 'fix/login' } });
            expect(session.worktree).toBe(join(dir, 'worktrees', 'web-app', 'fix-login'));
            expect(session.cwd).toBe(join(dir, 'worktrees', 'web-app', 'fix-login', 'packages', 'web'));
            expect(existsSync(join(session.cwd, 'index.ts'))).toBe(true);
            expect(git(session.cwd, 'branch', '--show-current')).toBe('fix/login');
            expect(git(repo, 'branch', '--show-current')).toBe('main');

            const again = await hub.createSession({ projectId: project.id, title: 'Fix login again', worktree: { branch: 'fix-login' } });
            expect(again.worktree).toBe(join(dir, 'worktrees', 'web-app', 'fix-login-2'));
        });

        it('checks out an existing branch and refuses one that is checked out elsewhere', async () => {
            const { repo, hub } = repository();
            git(repo, 'branch', 'feature');
            const project = hub.createProject({ path: repo });
            const session = await hub.createSession({ projectId: project.id, title: 'Feature', worktree: { branch: 'feature' } });
            expect(git(session.cwd, 'branch', '--show-current')).toBe('feature');
            expect((await refused(hub.createSession({ projectId: project.id, title: 'Main', worktree: { branch: 'main' } }))).status).toBe(409);
            expect((await refused(hub.createSession({ projectId: project.id, title: 'Bad', worktree: { branch: 'bad..name' } }))).message).toContain('not a valid branch name');
            expect((await refused(hub.createSession({ projectId: project.id, title: 'Bad base', worktree: { branch: 'new', base: 'nowhere' } }))).message).toContain('not a branch or commit');
            expect(hub.state().sessions).toHaveLength(1);
        });

        it('removes a clean worktree with its session and keeps the branch', async () => {
            const { repo, hub } = repository();
            const project = hub.createProject({ path: repo });
            const session = await hub.createSession({ projectId: project.id, title: 'Clean', worktree: { branch: 'clean' } });
            await hub.deleteSession(session.id);
            expect(existsSync(session.worktree!)).toBe(false);
            expect(git(repo, 'worktree', 'list')).not.toContain(session.worktree!);
            expect(git(repo, 'branch', '--list', 'clean')).toContain('clean');
        });

        it('asks before deleting a worktree with changes, then keeps or removes it', async () => {
            const { repo, hub } = repository();
            const project = hub.createProject({ path: repo });
            const kept = await hub.createSession({ projectId: project.id, title: 'Kept', worktree: { branch: 'kept' } });
            writeFileSync(join(kept.cwd, 'new.ts'), 'export {};\n');
            const error = await refused(hub.deleteSession(kept.id));
            expect(error.status).toBe(409);
            expect(error.message).toBe('its worktree has 1 uncommitted change');
            expect(hub.state().sessions.map((entry) => entry.id)).toContain(kept.id);
            await hub.deleteSession(kept.id, 'keep');
            expect(existsSync(join(kept.cwd, 'new.ts'))).toBe(true);

            const removed = await hub.createSession({ projectId: project.id, title: 'Removed', worktree: { branch: 'removed' } });
            writeFileSync(join(removed.cwd, 'packages', 'web', 'index.ts'), 'changed\n');
            await hub.deleteSession(removed.id, 'remove');
            expect(existsSync(removed.worktree!)).toBe(false);
        });

        it('keeps the worktrees with changes when the project is deleted', async () => {
            const { repo, hub } = repository();
            const project = hub.createProject({ path: repo });
            const clean = await hub.createSession({ projectId: project.id, title: 'Clean', worktree: { branch: 'clean' } });
            const dirty = await hub.createSession({ projectId: project.id, title: 'Dirty', worktree: { branch: 'dirty' } });
            writeFileSync(join(dirty.cwd, 'wip.ts'), 'export {};\n');
            await hub.deleteProject(project.id);
            expect(existsSync(clean.worktree!)).toBe(false);
            expect(existsSync(join(dirty.cwd, 'wip.ts'))).toBe(true);
        });
    });

    it('adds the worktree column to a database from before worktrees', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-hub-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const old = new DatabaseSync(join(dir, 'voltran.db'));
        old.exec(`create table sessions (id text primary key, project_id text not null, title text not null, link text, cwd text not null,
            layout text, archived integer not null default 0, created_at integer not null, updated_at integer not null)`);
        old.exec(`insert into sessions values ('s', 'p', 'old', null, '/tmp', null, 0, 1, 1)`);
        old.close();
        const store = new Store(join(dir, 'voltran.db'));
        cleanups.push(() => store.close());
        expect(store.getSession('s')).toMatchObject({ title: 'old', cwd: '/tmp', worktree: null });
    });
});
