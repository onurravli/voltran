import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, DiffHunk, DiffLine, FileDiff, SessionChanges } from '@voltran/shared';
import { FILTER_CONFIG_ARGS, SUBMODULE_ARGS, repositoryFilterOverrides, type GitRunner } from './git.ts';

export const MAX_FILES = 500;
export const MAX_DIFF_LINES = 5000;
const MAX_UNTRACKED_BYTES = 512 * 1024;
const EMPTY_TREE: Record<string, string> = {
    sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

export class ChangesError extends Error {}

// The same guards as the status poll, plus what `git diff` adds: an external diff command or a
// textconv driver from the repository's config would run a program of the repository's choosing.
// The prefixes and paths are pinned so that the user's diff settings cannot change the output's shape.
const DIFF_ARGS = [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
    '--submodule=short', '--find-renames', ...SUBMODULE_ARGS,
];
const QUIET = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];

export function parseChangedFiles(output: string): ChangedFile[] {
    const files: ChangedFile[] = [];
    const records = output.split('\0');
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const fields = record.split(' ');
        if (record.startsWith('1 ') || record.startsWith('2 ')) {
            const [x, y] = [fields[1][0], fields[1][1]];
            const renamed = record.startsWith('2 ');
            const path = fields.slice(renamed ? 9 : 8).join(' ');
            const oldPath = renamed ? records[++index] ?? null : null;
            const state = renamed ? 'renamed' : x === 'A' || y === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : 'modified';
            files.push({ path, oldPath, state, staged: x !== '.', unstaged: y !== '.' });
        } else if (record.startsWith('u ')) {
            files.push({ path: fields.slice(10).join(' '), oldPath: null, state: 'conflicted', staged: false, unstaged: true });
        } else if (record.startsWith('? ')) {
            files.push({ path: record.slice(2), oldPath: null, state: 'untracked', staged: false, unstaged: true });
        }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function parsePatch(patch: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    let hunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;
    for (const text of patch.split('\n')) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (header) {
            hunk = { header: text, lines: [] };
            hunks.push(hunk);
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            continue;
        }
        if (!hunk) {
            continue;
        }
        let line: DiffLine;
        if (text.startsWith('+')) {
            line = { kind: 'add', text: text.slice(1), old: null, new: newLine++ };
        } else if (text.startsWith('-')) {
            line = { kind: 'del', text: text.slice(1), old: oldLine++, new: null };
        } else if (text.startsWith(' ')) {
            line = { kind: 'context', text: text.slice(1), old: oldLine++, new: newLine++ };
        } else if (text.startsWith('\\')) {
            line = { kind: 'note', text: text.slice(2), old: null, new: null };
        } else {
            continue;
        }
        hunk.lines.push(line);
    }
    return hunks;
}

// An untracked file is shown whole, as git would show a new file. It is opened without following a
// link, so a file swapped for a link after the status was read still shows only the link.
export function untrackedDiff(root: string, path: string): FileDiff {
    const file = join(root, path);
    const base: FileDiff = { path, added: 0, removed: 0, binary: false, tooLarge: false, hunks: [] };
    if (lstatSync(file).isSymbolicLink()) {
        return withLines(base, [readlinkSync(file)], false);
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
            return { ...base, binary: true };
        }
        if (stat.size > MAX_UNTRACKED_BYTES) {
            return { ...base, tooLarge: true };
        }
        const buffer = Buffer.alloc(stat.size);
        const read = readSync(fd, buffer, 0, stat.size, 0);
        const content = buffer.subarray(0, read);
        if (content.includes(0)) {
            return { ...base, binary: true };
        }
        const text = content.toString('utf8');
        const lines = text.split('\n');
        const endsWithNewline = text.endsWith('\n');
        if (endsWithNewline) {
            lines.pop();
        }
        if (lines.length > MAX_DIFF_LINES) {
            return { ...base, added: lines.length, tooLarge: true };
        }
        return withLines(base, lines, !endsWithNewline && text.length > 0);
    } finally {
        closeSync(fd);
    }
}

function withLines(base: FileDiff, lines: string[], noNewline: boolean): FileDiff {
    if (lines.length === 0) {
        return base;
    }
    const diffLines: DiffLine[] = lines.map((text, index) => ({ kind: 'add', text, old: null, new: index + 1 }));
    if (noNewline) {
        diffLines.push({ kind: 'note', text: 'No newline at end of file', old: null, new: null });
    }
    return { ...base, added: lines.length, hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: diffLines }] };
}

// Reads what changed in a session's repository, on request only. Every command runs with the
// repository's own filters switched off, as the status poll does, and none of them writes anything.
export class SessionChangesReader {
    private readonly run: GitRunner;

    constructor(run: GitRunner) {
        this.run = run;
    }

    private async git(args: string[], cwd: string): Promise<string> {
        const result = await this.run('git', args, cwd);
        if (!result.ok) {
            throw new ChangesError(`git could not read the changes in ${cwd}`);
        }
        return result.stdout;
    }

    private async guards(root: string): Promise<string[]> {
        const filters = repositoryFilterOverrides((await this.run('git', FILTER_CONFIG_ARGS, root)).stdout);
        if (!filters) {
            throw new ChangesError('the repository names a filter Voltran cannot switch off, so it shows no changes');
        }
        return [...filters, ...QUIET];
    }

    async root(cwd: string): Promise<string> {
        const result = await this.run('git', ['rev-parse', '--show-toplevel'], cwd);
        if (!result.ok || !result.stdout.trim()) {
            throw new ChangesError(`${cwd} is not in a git repository`);
        }
        return result.stdout.trim();
    }

    async list(cwd: string): Promise<SessionChanges> {
        const { root, files } = await this.status(cwd);
        return { root, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
    }

    private async status(cwd: string): Promise<{ root: string; guards: string[]; files: ChangedFile[] }> {
        const root = await this.root(cwd);
        const guards = await this.guards(root);
        const files = parseChangedFiles(await this.git([...guards, 'status', '--porcelain=v2', '-z', '--untracked-files=all', ...SUBMODULE_ARGS], root));
        return { root, guards, files };
    }

    // Only a file the status lists right now can be read, so a client cannot name any other path.
    async diff(cwd: string, path: string): Promise<FileDiff> {
        const { root, guards, files } = await this.status(cwd);
        const file = files.find((entry) => entry.path === path);
        if (!file) {
            throw new ChangesError(`${path} has no changes`);
        }
        if (file.state === 'untracked') {
            return untrackedDiff(root, path);
        }
        const head = await this.run('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root);
        const base = head.ok ? 'HEAD' : EMPTY_TREE[(await this.git(['rev-parse', '--show-object-format'], root)).trim()] ?? EMPTY_TREE.sha1;
        const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
        const numstat = (await this.git([...guards, ...DIFF_ARGS, '--numstat', base, '--', ...paths], root)).split('\n').filter(Boolean);
        const counts = numstat.map((line) => line.split('\t'));
        const binary = counts.some(([added]) => added === '-');
        const added = counts.reduce((sum, [count]) => sum + (Number(count) || 0), 0);
        const removed = counts.reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
        const result: FileDiff = { path, added, removed, binary, tooLarge: added + removed > MAX_DIFF_LINES, hunks: [] };
        if (binary || result.tooLarge) {
            return result;
        }
        return { ...result, hunks: parsePatch(await this.git([...guards, ...DIFF_ARGS, base, '--', ...paths], root)) };
    }
}
