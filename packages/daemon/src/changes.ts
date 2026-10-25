import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, FileContents, SessionChanges } from '@voltran/shared';
import { FILTER_CONFIG_ARGS, SUBMODULE_ARGS, repositoryFilterOverrides, type GitRunner } from './git.ts';

export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 512 * 1024;

export class ChangesError extends Error {}

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
            const oldPath = renamed ? (records[++index] ?? null) : null;
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

type Side = { text: string } | 'binary' | 'tooLarge' | null;

// A file in the working tree is opened without following a link, so a file swapped for a link after
// the status was read still shows only the link. A file that is not there reads as null.
export function readWorkingFile(root: string, path: string): Side {
    const file = join(root, path);
    let link: boolean;
    try {
        link = lstatSync(file).isSymbolicLink();
    } catch {
        return null;
    }
    if (link) {
        return { text: readlinkSync(file) };
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
            return 'binary';
        }
        if (stat.size > MAX_FILE_BYTES) {
            return 'tooLarge';
        }
        const buffer = Buffer.alloc(stat.size);
        const content = buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0));
        return content.includes(0) ? 'binary' : { text: content.toString('utf8') };
    } finally {
        closeSync(fd);
    }
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

    private async status(cwd: string): Promise<{ root: string; files: ChangedFile[] }> {
        const root = await this.root(cwd);
        const guards = await this.guards(root);
        const files = parseChangedFiles(
            await this.git([...guards, 'status', '--porcelain=v2', '-z', '--untracked-files=all', ...SUBMODULE_ARGS], root),
        );
        return { root, files };
    }

    // Only a file the status lists right now can be read, so a client cannot name any other path.
    // A side the file does not have, such as the last commit's side of a new file, is null.
    async contents(cwd: string, path: string): Promise<FileContents> {
        const { root, files } = await this.status(cwd);
        const file = files.find((entry) => entry.path === path);
        if (!file) {
            throw new ChangesError(`${path} has no changes`);
        }
        const sides = [file.state === 'untracked' ? null : await this.committed(root, file.oldPath ?? path), readWorkingFile(root, path)];
        const text = sides.map((side) => (side !== null && typeof side === 'object' ? side.text : null));
        return {
            path,
            oldPath: file.oldPath,
            original: text[0],
            modified: text[1],
            binary: sides.includes('binary'),
            tooLarge: sides.includes('tooLarge'),
        };
    }

    // cat-file shows the blob as it is stored, so no filter or textconv of the repository runs.
    private async committed(root: string, path: string): Promise<Side> {
        const object = `HEAD:${path}`;
        const size = await this.run('git', [...QUIET, 'cat-file', '-s', object], root);
        if (!size.ok) {
            return null;
        }
        if (Number(size.stdout.trim()) > MAX_FILE_BYTES) {
            return 'tooLarge';
        }
        const blob = await this.run('git', [...QUIET, 'cat-file', 'blob', object], root);
        if (!blob.ok) {
            return 'binary';
        }
        return blob.stdout.includes('\0') ? 'binary' : { text: blob.stdout };
    }
}
