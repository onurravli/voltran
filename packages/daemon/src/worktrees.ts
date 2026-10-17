import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { branchFromTitle, type ProjectGit } from '@voltran/shared';

export type WorktreeRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const COMMAND_TIMEOUT_MS = 60_000;

export class WorktreeError extends Error {}

export function worktreeRunner(env: NodeJS.ProcessEnv): WorktreeRunner {
    const commandEnv = { ...env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
    return (args, cwd) => new Promise((resolve) => {
        execFile('git', args, { cwd, env: commandEnv, timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
            const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
            resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: missing ? 'git is not installed' : String(stderr ?? '') });
        });
    });
}

const gitMessage = (stderr: string, fallback: string): string => {
    const line = stderr.split('\n').map((entry) => entry.replace(/^(fatal|error): /, '').trim()).find(Boolean);
    return line ?? fallback;
};

export interface CreatedWorktree {
    root: string;
    cwd: string;
}

// Each session's worktree lives under the daemon's home, one folder per project, so nothing is added
// inside or next to the user's repository.
export class Worktrees {
    private readonly dir: string;
    private readonly run: WorktreeRunner;

    constructor(dir: string, run: WorktreeRunner) {
        this.dir = dir;
        this.run = run;
    }

    async describe(folder: string): Promise<ProjectGit> {
        const inside = await this.run(['rev-parse', '--is-inside-work-tree'], folder);
        if (!inside.ok || inside.stdout.trim() !== 'true') {
            return { repository: false, branch: null, branches: [] };
        }
        const [head, refs] = await Promise.all([
            this.run(['symbolic-ref', '--short', '-q', 'HEAD'], folder),
            this.run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], folder),
        ]);
        return {
            repository: true,
            branch: head.ok ? head.stdout.trim() || null : null,
            branches: refs.ok ? refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [],
        };
    }

    async create(folder: string, projectName: string, branch: string, base: string | undefined): Promise<CreatedWorktree> {
        if (branch.startsWith('-') || !(await this.run(['check-ref-format', '--branch', branch], folder)).ok) {
            throw new WorktreeError(`"${branch}" is not a valid branch name`);
        }
        if (base !== undefined && (base.startsWith('-') || !(await this.run(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], folder)).ok)) {
            throw new WorktreeError(`"${base}" is not a branch or commit in this repository`);
        }
        const prefix = await this.run(['rev-parse', '--show-prefix'], folder);
        if (!prefix.ok) {
            throw new WorktreeError(`${folder} is not in a git repository`);
        }
        const exists = (await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], folder)).ok;
        const root = this.freeFolder(projectName, branch);
        mkdirSync(join(root, '..'), { recursive: true, mode: 0o700 });
        const args = exists ? ['worktree', 'add', root, branch] : ['worktree', 'add', '-b', branch, root, base ?? 'HEAD'];
        const added = await this.run(args, folder);
        if (!added.ok) {
            throw new WorktreeError(gitMessage(added.stderr, `git could not create a worktree for ${branch}`));
        }
        return { root, cwd: resolve(root, prefix.stdout.trim()) };
    }

    // Counts what removing the worktree would lose: uncommitted and untracked files. A worktree whose
    // folder is gone has nothing left to lose.
    async changes(root: string): Promise<number> {
        if (!existsSync(root)) {
            return 0;
        }
        const status = await this.run(['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '-z'], root);
        if (!status.ok) {
            throw new WorktreeError(gitMessage(status.stderr, `git could not read the status of ${root}`));
        }
        return status.stdout.split('\0').filter((entry) => /^[ MADRCUT?!]{2} /.test(entry)).length;
    }

    async remove(folder: string, root: string): Promise<void> {
        if (existsSync(root)) {
            const removed = await this.run(['worktree', 'remove', '--force', root], folder);
            if (!removed.ok) {
                throw new WorktreeError(gitMessage(removed.stderr, `git could not remove the worktree at ${root}`));
            }
        }
        await this.run(['worktree', 'prune'], folder);
    }

    private freeFolder(projectName: string, branch: string): string {
        const parent = join(this.dir, branchFromTitle(projectName) || 'project');
        const name = branchFromTitle(branch.replace(/\//g, '-')) || 'session';
        let candidate = join(parent, name);
        for (let index = 2; existsSync(candidate); index += 1) {
            candidate = join(parent, `${name}-${index}`);
        }
        return candidate;
    }
}
