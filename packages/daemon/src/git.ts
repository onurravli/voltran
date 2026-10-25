import { execFile } from 'node:child_process';
import type { GitStatus, PullRequest } from '@voltran/shared';

export type GitRunner = (command: 'git' | 'gh', args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string; missing?: boolean }>;

export interface GitWatcherOptions {
    folders: () => string[];
    onChange: () => void;
    pullRequests: () => boolean;
    run: GitRunner;
    intervalMs?: number;
    pullRequestMs?: number;
    soonMs?: number;
}

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

// fsmonitor is off because a repository's own config could otherwise make `git status` run a
// command; the optional locks are off so polling never holds index.lock while an agent commits.
// Submodules are not looked into: git runs a status inside each one, under that submodule's own
// config and filters, which the overrides below never see. A submodule moved to another commit
// still shows.
export const SUBMODULE_ARGS = ['--ignore-submodules=dirty'];
export const STATUS_ARGS = [
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    ...SUBMODULE_ARGS,
];
export const PULL_REQUEST_ARGS = ['pr', 'view', '--json', 'number,url,state,isDraft,statusCheckRollup'];
export const FILTER_CONFIG_ARGS = ['config', '--show-scope', '-z', '--get-regexp', '^filter\\.'];
const FILTER_NAME = /^[A-Za-z0-9._-]+$/;

// git status runs a file's clean filter when the file's timestamp changed, and a repository's own
// config (or a file it includes) can name any command as one. The filters a repository defines for
// itself are switched off for the poll; the user's global ones, such as Git LFS, are kept. A name
// that cannot be passed through -c intact means no poll at all.
export function repositoryFilterOverrides(output: string): string[] | null {
    const parts = output.split('\0');
    const names = new Set<string>();
    for (let index = 0; index + 1 < parts.length; index += 2) {
        const scope = parts[index];
        const key = parts[index + 1].split('\n')[0];
        if (scope !== 'local' && scope !== 'worktree') {
            continue;
        }
        const name = key.slice('filter.'.length, key.lastIndexOf('.'));
        if (!name) {
            continue;
        }
        if (!FILTER_NAME.test(name)) {
            return null;
        }
        names.add(name);
    }
    return [...names].flatMap((name) => [
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.smudge=`,
        '-c',
        `filter.${name}.process=`,
        '-c',
        `filter.${name}.required=false`,
    ]);
}

export function commandRunner(env: NodeJS.ProcessEnv): GitRunner {
    const commandEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
    return (command, args, cwd) =>
        new Promise((resolve) => {
            execFile(
                command,
                args,
                { cwd, env: commandEnv, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
                (error, stdout) => {
                    resolve({
                        ok: !error,
                        stdout: String(stdout ?? ''),
                        missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT',
                    });
                },
            );
        });
}

export function parseStatus(output: string): Omit<GitStatus, 'pullRequest'> {
    const status: Omit<GitStatus, 'pullRequest'> = {
        branch: null,
        commit: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        changed: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
    };
    const records = output.split('\0');
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.startsWith('# branch.oid ')) {
            const oid = record.slice('# branch.oid '.length);
            status.commit = oid === '(initial)' ? null : oid.slice(0, 7);
        } else if (record.startsWith('# branch.head ')) {
            const head = record.slice('# branch.head '.length);
            status.branch = head === '(detached)' ? null : head;
        } else if (record.startsWith('# branch.upstream ')) {
            status.upstream = record.slice('# branch.upstream '.length);
        } else if (record.startsWith('# branch.ab ')) {
            const match = /^\+(\d+) -(\d+)$/.exec(record.slice('# branch.ab '.length));
            if (match) {
                status.ahead = Number(match[1]);
                status.behind = Number(match[2]);
            }
        } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
            status.changed += 1;
            if (record[2] !== '.') {
                status.staged += 1;
            }
            if (record[3] !== '.') {
                status.unstaged += 1;
            }
            if (record.startsWith('2 ')) {
                index += 1;
            }
        } else if (record.startsWith('u ')) {
            status.changed += 1;
            status.conflicted += 1;
        } else if (record.startsWith('? ')) {
            status.changed += 1;
            status.untracked += 1;
        }
    }
    return status;
}

interface CheckEntry {
    status?: string;
    conclusion?: string;
    state?: string;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

function checksOf(rollup: unknown): PullRequest['checks'] {
    if (!Array.isArray(rollup) || rollup.length === 0) {
        return null;
    }
    const outcomes = (rollup as CheckEntry[]).map((check) => {
        const value = check.state ?? (check.status === 'COMPLETED' ? check.conclusion : check.status) ?? '';
        return FAILED.has(value) ? 'failing' : PENDING.has(value) || value === '' ? 'pending' : 'passing';
    });
    return outcomes.includes('failing') ? 'failing' : outcomes.includes('pending') ? 'pending' : 'passing';
}

export function parsePullRequest(output: string): PullRequest | null {
    let raw: unknown;
    try {
        raw = JSON.parse(output);
    } catch {
        return null;
    }
    const pr = raw as { number?: unknown; url?: unknown; state?: unknown; isDraft?: unknown; statusCheckRollup?: unknown };
    if (typeof pr?.number !== 'number' || typeof pr.url !== 'string' || !/^https:\/\//.test(pr.url)) {
        return null;
    }
    const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft === true ? 'draft' : 'open';
    return { number: pr.number, url: pr.url, state, checks: checksOf(pr.statusCheckRollup) };
}

interface PullRequestCache {
    branch: string;
    fetchedAt: number;
    value: PullRequest | null;
}

// Polls `git status` for every folder a session works in while a window is open, plus shortly
// after an agent used a tool there. One command runs at a time, each with a timeout.
export class GitWatcher {
    private readonly options: Required<GitWatcherOptions>;
    private statuses = new Map<string, GitStatus>();
    private pullRequests = new Map<string, PullRequestCache>();
    private queue = new Set<string>();
    private soon = new Map<string, ReturnType<typeof setTimeout>>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private draining = false;
    private ghMissing = false;
    private stopped = false;

    constructor(options: GitWatcherOptions) {
        this.options = { intervalMs: 10_000, pullRequestMs: 120_000, soonMs: 1_000, ...options };
    }

    snapshot(): Record<string, GitStatus> {
        return Object.fromEntries(this.statuses);
    }

    start(): void {
        if (this.timer || this.stopped) {
            return;
        }
        this.timer = setInterval(() => this.refreshAll(), this.options.intervalMs);
        this.refreshAll();
    }

    pause(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    stop(): void {
        this.stopped = true;
        this.pause();
        for (const timer of this.soon.values()) {
            clearTimeout(timer);
        }
        this.soon.clear();
        this.queue.clear();
    }

    refreshAll(): void {
        const folders = new Set(this.options.folders());
        let dropped = false;
        for (const folder of [...this.statuses.keys()]) {
            if (!folders.has(folder)) {
                this.statuses.delete(folder);
                this.pullRequests.delete(folder);
                dropped = true;
            }
        }
        if (dropped) {
            this.options.onChange();
        }
        for (const folder of folders) {
            this.queue.add(folder);
        }
        void this.drain();
    }

    refreshSoon(folder: string): void {
        if (this.stopped || this.soon.has(folder)) {
            return;
        }
        this.soon.set(
            folder,
            setTimeout(() => {
                this.soon.delete(folder);
                this.queue.add(folder);
                void this.drain();
            }, this.options.soonMs),
        );
    }

    async refresh(folder: string): Promise<void> {
        const filters = repositoryFilterOverrides((await this.options.run('git', FILTER_CONFIG_ARGS, folder)).stdout);
        const result = filters ? await this.options.run('git', [...filters, ...STATUS_ARGS], folder) : { ok: false, stdout: '' };
        if (this.stopped) {
            return;
        }
        const parsed = result.ok ? parseStatus(result.stdout) : null;
        const next = parsed ? { ...parsed, pullRequest: await this.pullRequestFor(folder, parsed.branch) } : null;
        if (this.stopped) {
            return;
        }
        const previous = this.statuses.get(folder);
        if (JSON.stringify(previous ?? null) === JSON.stringify(next)) {
            return;
        }
        if (next) {
            this.statuses.set(folder, next);
        } else {
            this.statuses.delete(folder);
            this.pullRequests.delete(folder);
        }
        this.options.onChange();
    }

    private async drain(): Promise<void> {
        if (this.draining) {
            return;
        }
        this.draining = true;
        try {
            while (this.queue.size > 0 && !this.stopped) {
                const [folder] = this.queue;
                this.queue.delete(folder);
                await this.refresh(folder);
            }
        } finally {
            this.draining = false;
        }
    }

    private async pullRequestFor(folder: string, branch: string | null): Promise<PullRequest | null> {
        if (!branch || this.ghMissing || !this.options.pullRequests()) {
            this.pullRequests.delete(folder);
            return null;
        }
        const cached = this.pullRequests.get(folder);
        if (cached && cached.branch === branch && Date.now() - cached.fetchedAt < this.options.pullRequestMs) {
            return cached.value;
        }
        const result = await this.options.run('gh', PULL_REQUEST_ARGS, folder);
        if (result.missing) {
            this.ghMissing = true;
        }
        const value = result.ok ? parsePullRequest(result.stdout) : null;
        this.pullRequests.set(folder, { branch, fetchedAt: Date.now(), value });
        return value;
    }
}
