import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILTER_CONFIG_ARGS, GitWatcher, PULL_REQUEST_ARGS, STATUS_ARGS, commandRunner, parsePullRequest, parseStatus, repositoryFilterOverrides, type GitRunner } from './git.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

const records = (...lines: string[]): string => `${lines.join('\0')}\0`;

describe('parseStatus', () => {
    it('reads the branch, its upstream and how far apart they are', () => {
        expect(parseStatus(records(
            '# branch.oid 0123456789abcdef0123456789abcdef01234567',
            '# branch.head feat/login',
            '# branch.upstream origin/feat/login',
            '# branch.ab +2 -1',
        ))).toEqual({ branch: 'feat/login', commit: '0123456', upstream: 'origin/feat/login', ahead: 2, behind: 1, changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    });

    it('counts staged, unstaged, untracked and conflicted files once each', () => {
        const status = parseStatus(records(
            '# branch.oid 0123456789abcdef0123456789abcdef01234567',
            '# branch.head main',
            '1 M. N... 100644 100644 100644 aaaa bbbb staged.ts',
            '1 .M N... 100644 100644 100644 aaaa bbbb edited.ts',
            '1 MM N... 100644 100644 100644 aaaa bbbb both.ts',
            '2 R. N... 100644 100644 100644 aaaa bbbb R100 renamed.ts',
            'old name.ts',
            'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts',
            '? new file.ts',
            '? 1 M. pretend-header.ts',
        ));
        expect(status).toMatchObject({ changed: 7, staged: 3, unstaged: 2, untracked: 2, conflicted: 1 });
    });

    it('reports a detached head without a branch and a repository without commits without a commit', () => {
        expect(parseStatus(records('# branch.oid 89abcdef0123456789abcdef0123456789abcdef', '# branch.head (detached)'))).toMatchObject({ branch: null, commit: '89abcde', upstream: null });
        expect(parseStatus(records('# branch.oid (initial)', '# branch.head main'))).toMatchObject({ branch: 'main', commit: null });
    });
});

describe('parsePullRequest', () => {
    const pr = (fields: Record<string, unknown>): string => JSON.stringify({ number: 42, url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: false, statusCheckRollup: [], ...fields });

    it('tells open, draft, merged and closed pull requests apart', () => {
        expect(parsePullRequest(pr({}))).toEqual({ number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', checks: null });
        expect(parsePullRequest(pr({ isDraft: true }))?.state).toBe('draft');
        expect(parsePullRequest(pr({ state: 'MERGED' }))?.state).toBe('merged');
        expect(parsePullRequest(pr({ state: 'CLOSED' }))?.state).toBe('closed');
    });

    it('sums up the checks: any failure fails, anything unfinished is pending', () => {
        const run = (status: string, conclusion = ''): Record<string, string> => ({ __typename: 'CheckRun', status, conclusion });
        const context = (state: string): Record<string, string> => ({ __typename: 'StatusContext', state });
        expect(parsePullRequest(pr({ statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), context('SUCCESS')] }))?.checks).toBe('passing');
        expect(parsePullRequest(pr({ statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')] }))?.checks).toBe('pending');
        expect(parsePullRequest(pr({ statusCheckRollup: [run('IN_PROGRESS'), context('ERROR')] }))?.checks).toBe('failing');
        expect(parsePullRequest(pr({ statusCheckRollup: [run('COMPLETED', 'FAILURE')] }))?.checks).toBe('failing');
    });

    it('ignores output that is not a pull request or does not link to https', () => {
        expect(parsePullRequest('no pull requests found for branch "main"')).toBeNull();
        expect(parsePullRequest(pr({ url: 'javascript:alert(1)' }))).toBeNull();
        expect(parsePullRequest(JSON.stringify({ url: 'https://x' }))).toBeNull();
    });
});

const gitIn = (dir: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
};

function repository(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-git-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    gitIn(dir, 'init', '-b', 'main');
    gitIn(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'start');
    return dir;
}

describe('repositoryFilterOverrides', () => {
    const entry = (scope: string, key: string, value: string): string => `${scope}\0${key}\n${value}\0`;

    it('switches off the filters a repository defines and keeps the user\'s own', () => {
        const output = entry('global', 'filter.lfs.clean', 'git-lfs clean -- %f') + entry('local', 'filter.x.clean', 'touch owned') + entry('local', 'filter.x.process', 'y');
        expect(repositoryFilterOverrides(output)).toEqual(['-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=', '-c', 'filter.x.required=false']);
        expect(repositoryFilterOverrides('')).toEqual([]);
    });

    it('gives up on a filter name that -c could not carry intact', () => {
        expect(repositoryFilterOverrides(entry('local', 'filter.a=b.clean', 'evil'))).toBeNull();
        expect(repositoryFilterOverrides(entry('worktree', 'filter.a b.clean', 'evil'))).toBeNull();
    });
});

function watcher(folders: string[], run: GitRunner, pullRequests = true): { watcher: GitWatcher; changes: () => number } {
    let count = 0;
    const instance = new GitWatcher({ folders: () => folders, onChange: () => { count += 1; }, pullRequests: () => pullRequests, run });
    cleanups.push(() => instance.stop());
    return { watcher: instance, changes: () => count };
}

describe('GitWatcher', () => {
    it('reads a real repository and forgets folders that are not one', async () => {
        const dir = repository();
        writeFileSync(join(dir, 'new.txt'), 'hello\n');
        const plain = mkdtempSync(join(tmpdir(), 'voltran-plain-'));
        cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
        const { watcher: git, changes } = watcher([dir, plain], commandRunner(process.env), false);

        await git.refresh(dir);
        await git.refresh(plain);
        expect(git.snapshot()).toEqual({
            [dir]: expect.objectContaining({ branch: 'main', upstream: null, changed: 1, untracked: 1, pullRequest: null }),
        });
        expect(changes()).toBe(1);

        await git.refresh(dir);
        expect(changes()).toBe(1);
    });

    it('asks gh once per branch until the cached answer is old, and never when turned off', async () => {
        const calls: string[] = [];
        let head = 'main';
        const run: GitRunner = async (command, args) => {
            calls.push(`${command} ${args.join(' ')}`);
            return command === 'git'
                ? { ok: true, stdout: records('# branch.oid 0123456789abcdef0123456789abcdef01234567', `# branch.head ${head}`) }
                : { ok: true, stdout: JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, statusCheckRollup: [] }) };
        };
        const { watcher: git } = watcher(['/repo'], run);
        await git.refresh('/repo');
        await git.refresh('/repo');
        expect(calls.filter((call) => call.startsWith('gh'))).toEqual([`gh ${PULL_REQUEST_ARGS.join(' ')}`]);
        expect(git.snapshot()['/repo'].pullRequest).toMatchObject({ number: 7, state: 'open' });

        head = 'feat/other';
        await git.refresh('/repo');
        expect(calls.filter((call) => call.startsWith('gh'))).toHaveLength(2);
        expect(calls.slice(0, 2)).toEqual([`git ${FILTER_CONFIG_ARGS.join(' ')}`, `git ${STATUS_ARGS.join(' ')}`]);

        const off: string[] = [];
        const { watcher: quiet } = watcher(['/repo'], async (command, args) => {
            off.push(command);
            return run(command, args, '/repo');
        }, false);
        await quiet.refresh('/repo');
        expect(off).toEqual(['git', 'git']);
        expect(quiet.snapshot()['/repo'].pullRequest).toBeNull();
    });

    it('never runs a filter command the repository configured for itself', async () => {
        const dir = repository();
        const marker = join(dir, '..', `${dir.split('/').at(-1)}-filter-ran`);
        cleanups.push(() => rmSync(marker, { force: true }));
        writeFileSync(join(dir, '.gitattributes'), '*.txt filter=x\n');
        writeFileSync(join(dir, 'a.txt'), 'hello\n');
        gitIn(dir, 'add', '-A');
        gitIn(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'files');
        gitIn(dir, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
        utimesSync(join(dir, 'a.txt'), new Date(), new Date(Date.now() + 60_000));

        const { watcher: git } = watcher([dir], commandRunner(process.env), false);
        await git.refresh(dir);
        expect(git.snapshot()[dir]).toMatchObject({ branch: 'main', changed: 0 });
        expect(existsSync(marker)).toBe(false);

        execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'ignore' });
        expect(existsSync(marker)).toBe(true);
    });

    it('stops asking gh once it turns out not to be installed', async () => {
        let ghCalls = 0;
        const { watcher: git } = watcher(['/a', '/b'], async (command) => {
            if (command === 'gh') {
                ghCalls += 1;
                return { ok: false, stdout: '', missing: true };
            }
            return { ok: true, stdout: records('# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head main') };
        });
        await git.refresh('/a');
        await git.refresh('/b');
        expect(ghCalls).toBe(1);
    });

    it('drops the status of a folder no session works in any more', async () => {
        const folders = ['/a', '/b'];
        const { watcher: git } = watcher(folders, async () => ({ ok: true, stdout: records('# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head main') }), false);
        await git.refresh('/a');
        await git.refresh('/b');
        folders.pop();
        git.refreshAll();
        expect(Object.keys(git.snapshot())).toEqual(['/a']);
    });
});
