import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from '@voltran/shared';
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
        attachmentsDir: join(dir, 'attachments'),
        hooksDir: join(dir, 'hooks'),
        worktreesDir: join(dir, 'worktrees'),
        pushDir: join(dir, 'push'),
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
            layout: {
                type: 'split',
                direction: 'horizontal',
                children: [
                    { type: 'pane', paneId: 'gone' },
                    { type: 'pane', paneId: kept },
                ],
                sizes: [50, 50],
            },
        });
        await first.hub.shutdown();
        first.store.close();

        const second = open(dir);
        cleanups.push(async () => {
            await second.hub.shutdown();
            second.store.close();
        });
        expect(second.hub.state().workspaces).toEqual([
            expect.objectContaining({ id: workspace.id, layout: { type: 'pane', paneId: kept } }),
        ]);
    });

    it('sends the new state before it tells windows to open a session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-hub-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const { store, hub } = open(dir);
        cleanups.push(async () => {
            await hub.shutdown();
            store.close();
        });
        const project = hub.createProject({ path: dir });
        const session = await hub.createSession({ projectId: project.id, title: 'new', panes: [{ adapter: 'shell' }] });
        const events: string[] = [];
        hub.subscribe((event) =>
            events.push(event.type === 'state' ? `state:${event.state.sessions.some((entry) => entry.id === session.id)}` : event.type),
        );
        hub.revealSession(session.id);
        expect(events.slice(-2)).toEqual(['state:true', 'reveal']);
        expect(() => hub.revealSession('missing')).toThrow(HttpError);
    });

    it('opens a preview pane only for a page on this computer and lets its address change', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-hub-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const { store, hub } = open(dir);
        cleanups.push(async () => {
            await hub.shutdown();
            store.close();
        });
        const project = hub.createProject({ path: dir });
        const session = await hub.createSession({ projectId: project.id, title: 'web', panes: [{ adapter: 'shell' }] });
        const shell = hub.state().panes.find((pane) => pane.sessionId === session.id)!;
        const pane = hub.createPane(session.id, {
            adapter: 'preview',
            command: 'localhost:5173',
            splitFrom: shell.id,
            direction: 'horizontal',
        });
        expect(pane).toMatchObject({ adapter: 'preview', command: 'http://localhost:5173/', title: 'localhost:5173' });
        for (const command of ['example.com', 'localhost.example.com:80', 'file:///etc/passwd', undefined]) {
            expect(() => hub.createPane(session.id, { adapter: 'preview', command })).toThrow(HttpError);
        }
        expect(hub.updatePane(pane.id, { url: 'http://127.0.0.1:3000/app' }).command).toBe('http://127.0.0.1:3000/app');
        expect(store.getPane(pane.id)?.command).toBe('http://127.0.0.1:3000/app');
        expect(() => hub.updatePane(pane.id, { url: 'https://example.com' })).toThrow(HttpError);
        expect(() => hub.updatePane(shell.id, { url: 'localhost:3000' })).toThrow(HttpError);
    });

    it('opens a changes pane that runs nothing and reads both sides of a changed file', async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-hub-')));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        writeFileSync(join(dir, 'app.ts'), 'const a = 1;\n');
        git('add', '.');
        git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'first');
        writeFileSync(join(dir, 'app.ts'), 'const a = 2;\n');
        const { store, hub } = open(dir);
        cleanups.push(async () => {
            await hub.shutdown();
            store.close();
        });
        const project = hub.createProject({ path: dir });
        const session = await hub.createSession({ projectId: project.id, title: 'review', panes: [{ adapter: 'changes' }] });
        const pane = hub.state().panes.find((entry) => entry.sessionId === session.id)!;
        expect(pane).toMatchObject({ adapter: 'changes', title: 'Changes', command: null, status: 'idle', pid: null });
        expect(await hub.sessionFileContents(session.id, 'app.ts')).toMatchObject({
            original: 'const a = 1;\n',
            modified: 'const a = 2;\n',
        });
        await expect(hub.sessionFileContents(session.id, 'missing.ts')).rejects.toMatchObject({ status: 409 });
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
            const error = await action.then(
                () => null,
                (failure: unknown) => failure,
            );
            expect(error).toBeInstanceOf(HttpError);
            return error as HttpError;
        };

        it('describes the project folder', async () => {
            const { dir, repo, hub } = repository();
            git(repo, 'branch', 'feature');
            const project = hub.createProject({ path: repo });
            expect(await hub.projectGit(project.id)).toEqual({
                repository: true,
                branch: 'main',
                branches: expect.arrayContaining(['main', 'feature']),
            });
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
            expect((await refused(hub.createSession({ projectId: project.id, title: 'Main', worktree: { branch: 'main' } }))).status).toBe(
                409,
            );
            expect(
                (await refused(hub.createSession({ projectId: project.id, title: 'Bad', worktree: { branch: 'bad..name' } }))).message,
            ).toContain('not a valid branch name');
            expect(
                (
                    await refused(
                        hub.createSession({ projectId: project.id, title: 'Bad base', worktree: { branch: 'new', base: 'nowhere' } }),
                    )
                ).message,
            ).toContain('not a branch or commit');
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

        it("counts a worktree's changes without running a filter the repository configured", async () => {
            const { dir, repo, hub } = repository();
            const marker = join(dir, 'filter-ran');
            writeFileSync(join(repo, '.gitattributes'), '*.ts filter=x\n');
            git(repo, 'add', '-A');
            git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--no-gpg-sign', '-m', 'attributes');
            git(repo, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
            const project = hub.createProject({ path: repo });
            const session = await hub.createSession({ projectId: project.id, title: 'Filtered', worktree: { branch: 'filtered' } });
            utimesSync(join(session.cwd, 'packages', 'web', 'index.ts'), new Date(), new Date(Date.now() + 60_000));
            await hub.deleteSession(session.id);
            expect(existsSync(session.worktree!)).toBe(false);
            expect(existsSync(marker)).toBe(false);
        });

        it('asks before deleting a worktree with a checked-out submodule, without looking inside it', async () => {
            const { dir, repo, hub } = repository();
            const inner = join(dir, 'inner');
            mkdirSync(inner);
            writeFileSync(join(inner, '.gitattributes'), '*.ts filter=sub\n');
            writeFileSync(join(inner, 'a.ts'), 'export {};\n');
            git(inner, 'init', '-q', '-b', 'main');
            git(inner, 'add', '-A');
            git(inner, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--no-gpg-sign', '-m', 'inner');
            const project = hub.createProject({ path: repo });
            const session = await hub.createSession({ projectId: project.id, title: 'Submodule', worktree: { branch: 'submodule' } });
            git(session.worktree!, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', inner, 'inner');
            git(
                session.worktree!,
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.com',
                'commit',
                '-q',
                '--no-gpg-sign',
                '-m',
                'submodule',
            );
            const marker = join(dir, 'submodule-filter-ran');
            git(join(session.worktree!, 'inner'), 'config', 'filter.sub.clean', `touch '${marker}'; cat`);
            utimesSync(join(session.worktree!, 'inner', 'a.ts'), new Date(), new Date(Date.now() + 60_000));

            expect((await refused(hub.deleteSession(session.id))).message).toBe('its worktree has 1 uncommitted change');
            expect(existsSync(marker)).toBe(false);
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

    describe('order', () => {
        function opened(): { dir: string; hub: Hub } {
            const dir = mkdtempSync(join(tmpdir(), 'voltran-order-'));
            const { store, hub } = open(dir);
            cleanups.push(async () => {
                await hub.shutdown();
                store.close();
                rmSync(dir, { recursive: true, force: true });
            });
            return { dir, hub };
        }
        const project = (hub: Hub, dir: string, name: string) => {
            mkdirSync(join(dir, name));
            return hub.createProject({ path: join(dir, name) });
        };
        const projectNames = (hub: Hub): string[] => hub.state().projects.map((entry) => entry.name);
        const sessionTitles = (hub: Hub, projectId: string): string[] =>
            hub
                .state()
                .sessions.filter((entry) => entry.projectId === projectId)
                .map((entry) => entry.title);

        it('moves a project in front of another, or to the end', () => {
            const { dir, hub } = opened();
            const [a, b, c] = ['a', 'b', 'c'].map((name) => project(hub, dir, name));
            hub.updateProject(c.id, { moveBefore: a.id });
            expect(projectNames(hub)).toEqual(['c', 'a', 'b']);
            hub.updateProject(c.id, { moveBefore: null });
            expect(projectNames(hub)).toEqual(['a', 'b', 'c']);
            hub.updateProject(a.id, { moveBefore: c.id });
            expect(projectNames(hub)).toEqual(['b', 'a', 'c']);
            hub.updateProject(b.id, { moveBefore: b.id });
            expect(projectNames(hub)).toEqual(['b', 'a', 'c']);
            expect(project(hub, dir, 'd').name).toBe('d');
            expect(projectNames(hub)).toEqual(['b', 'a', 'c', 'd']);
        });

        it('moves a session within its project and puts new sessions last', async () => {
            const { dir, hub } = opened();
            const web = project(hub, dir, 'web');
            const api = project(hub, dir, 'api');
            const created: Session[] = [];
            for (const title of ['one', 'two', 'three']) {
                created.push(await hub.createSession({ projectId: web.id, title }));
            }
            await hub.createSession({ projectId: api.id, title: 'elsewhere' });
            hub.updateSession(created[2].id, { moveBefore: created[0].id });
            expect(sessionTitles(hub, web.id)).toEqual(['three', 'one', 'two']);
            hub.updateSession(created[2].id, { moveBefore: null });
            expect(sessionTitles(hub, web.id)).toEqual(['one', 'two', 'three']);
            hub.updateSession(created[0].id, { moveBefore: created[2].id, archived: true });
            expect(sessionTitles(hub, web.id)).toEqual(['two', 'one', 'three']);
            await hub.createSession({ projectId: web.id, title: 'four' });
            expect(sessionTitles(hub, web.id)).toEqual(['two', 'one', 'three', 'four']);
            expect(sessionTitles(hub, api.id)).toEqual(['elsewhere']);
            hub.updateProject(api.id, { moveBefore: web.id });
            expect(hub.state().sessions.map((entry) => entry.title)).toEqual(['elsewhere', 'two', 'one', 'three', 'four']);
        });

        it('refuses to move in front of anything but a sibling', async () => {
            const { dir, hub } = opened();
            const web = project(hub, dir, 'web');
            const api = project(hub, dir, 'api');
            const session = await hub.createSession({ projectId: web.id, title: 'web' });
            const other = await hub.createSession({ projectId: api.id, title: 'api' });
            const status = (action: () => unknown): number | null => {
                try {
                    action();
                    return null;
                } catch (error) {
                    return error instanceof HttpError ? error.status : -1;
                }
            };
            expect(status(() => hub.updateSession(session.id, { moveBefore: other.id }))).toBe(400);
            expect(status(() => hub.updateSession(session.id, { moveBefore: 3 as unknown as string }))).toBe(400);
            expect(status(() => hub.updateProject(web.id, { moveBefore: session.id }))).toBe(400);
            expect(status(() => hub.updateProject(web.id, { name: 'renamed', moveBefore: 'gone' }))).toBe(400);
            expect(projectNames(hub)).toEqual(['web', 'api']);
        });
    });

    it('reports paired phones without their endpoints and refuses a test push with none paired', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-hub-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        mkdirSync(join(dir, 'push'), { mode: 0o700 });
        writeFileSync(
            join(dir, 'push', 'devices.json'),
            JSON.stringify([
                {
                    id: 'phone',
                    name: 'iPhone',
                    pairedAt: 1,
                    subscription: {
                        endpoint: 'https://web.push.apple.com/secret',
                        keys: {
                            p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
                            auth: 'BTBZMqHH6r4Tts7J_aSIgg',
                        },
                    },
                },
            ]),
        );
        const { store, hub } = open(dir);
        cleanups.push(async () => {
            await hub.shutdown();
            store.close();
        });
        expect(hub.state().push.devices).toEqual([{ id: 'phone', name: 'iPhone', pairedAt: 1, lastSentAt: null, lastError: null }]);
        expect(JSON.stringify(hub.state())).not.toContain('secret');
        await expect(hub.testPush('missing')).rejects.toMatchObject({ status: 404 });
        hub.removePushDevice('phone');
        await expect(hub.testPush()).rejects.toMatchObject({ status: 409 });
    });

    it('numbers the sessions of a database from before ordering in the order they were made', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-hub-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const old = new DatabaseSync(join(dir, 'voltran.db'));
        old.exec(`create table sessions (id text primary key, project_id text not null, title text not null, link text, cwd text not null,
            layout text, archived integer not null default 0, created_at integer not null, updated_at integer not null)`);
        old.exec(`insert into sessions values ('s3', 'p', 'third', null, '/tmp', null, 0, 30, 30), ('s1', 'p', 'first', null, '/tmp', null, 0, 10, 10),
            ('q1', 'q', 'other', null, '/tmp', null, 0, 20, 20), ('s2', 'p', 'second', null, '/tmp', null, 0, 20, 20)`);
        old.close();
        const store = new Store(join(dir, 'voltran.db'));
        cleanups.push(() => store.close());
        expect(store.sessionsOfProject('p').map((session) => session.title)).toEqual(['first', 'second', 'third']);
        store.moveSession('s3', 's1');
        expect(store.sessionsOfProject('p').map((session) => session.title)).toEqual(['third', 'first', 'second']);
        expect(store.sessionsOfProject('q').map((session) => session.title)).toEqual(['other']);
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
