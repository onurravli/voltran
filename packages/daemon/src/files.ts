import { createHash } from 'node:crypto';
import {
    closeSync,
    constants,
    type Dirent,
    existsSync,
    fstatSync,
    ftruncateSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, sep } from 'node:path';
import type {
    DirListing,
    EditorFile,
    FileAction,
    FileActionResult,
    FileEntry,
    FileTree,
    ProjectFileList,
    SavedFile,
} from '@voltran/shared';
import type { GitRunner } from './git.ts';

export const MAX_EDIT_BYTES = 4 * 1024 * 1024;
export const MAX_DIR_ENTRIES = 5000;
export const MAX_LISTED_FILES = 20_000;
const MAX_TREE_DIRS = 200;
const MAX_PATH = 4096;
const IGNORE_BATCH = 1000;
const HIDDEN = new Set(['.git', '.DS_Store']);
const WALK_SKIPPED = new Set(['.git', 'node_modules']);
const QUIET = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];

export class FilesError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// Moves a path to the trash and says whether it could; the caller then offers to delete it instead.
export type Trash = (path: string) => boolean;

export function relativePath(value: unknown, allowRoot = false): string {
    if (typeof value !== 'string' || value.length > MAX_PATH || value.includes('\0')) {
        throw new FilesError(400, 'path is malformed');
    }
    if (value === '') {
        if (allowRoot) {
            return '';
        }
        throw new FilesError(400, 'path is empty');
    }
    if (value.startsWith('/') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new FilesError(400, 'path must stay inside the folder');
    }
    return value;
}

function versionOf(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}

// A file is text only when it is valid UTF-8 without NUL bytes, so a save never rewrites bytes the
// editor could not show. A byte order mark stays in the text and is written back as it was.
function decodeText(bytes: Buffer): string | null {
    if (bytes.includes(0)) {
        return null;
    }
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return null;
    }
}

function readAll(fd: number, size: number): Buffer {
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
        const count = readSync(fd, buffer, read, size - read, read);
        if (count === 0) {
            break;
        }
        read += count;
    }
    return buffer.subarray(0, read);
}

function trashName(dir: string, name: string): string {
    if (!existsSync(join(dir, name))) {
        return name;
    }
    const ext = extname(name);
    const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (let index = 0; ; index++) {
        const candidate = `${stem} ${stamp}${index ? ` ${index}` : ''}${ext && ext !== name ? ext : ''}`;
        if (!existsSync(join(dir, candidate))) {
            return candidate;
        }
    }
}

// macOS: the user's ~/.Trash. Linux: the freedesktop.org home trash, with the .trashinfo file a file
// manager needs to put it back. A path on another volume cannot be renamed there and is not trashed.
export function systemTrash(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Trash {
    const home = env.HOME || homedir();
    return (path) => {
        try {
            if (platform === 'darwin') {
                const dir = join(home, '.Trash');
                renameSync(path, join(dir, trashName(dir, basename(path))));
                return true;
            }
            if (platform === 'linux') {
                const trash = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'Trash');
                mkdirSync(join(trash, 'files'), { recursive: true, mode: 0o700 });
                mkdirSync(join(trash, 'info'), { recursive: true, mode: 0o700 });
                const name = trashName(join(trash, 'files'), basename(path));
                const info = join(trash, 'info', `${name}.trashinfo`);
                const date = new Date().toISOString().slice(0, 19);
                writeFileSync(info, `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${date}\n`, {
                    flag: 'wx',
                    mode: 0o600,
                });
                try {
                    renameSync(path, join(trash, 'files', name));
                } catch (error) {
                    rmSync(info, { force: true });
                    throw error;
                }
                return true;
            }
        } catch {
            return false;
        }
        return false;
    };
}

// The files of one folder, which the editor pane browses and edits. Every path a client names is
// relative to that folder and is checked to resolve inside it, links included, before anything is
// read or written.
export class ProjectFiles {
    private readonly run: GitRunner;
    private readonly trash: Trash;

    constructor(options: { run: GitRunner; trash: Trash }) {
        this.run = options.run;
        this.trash = options.trash;
    }

    private realRoot(root: string): string {
        try {
            return realpathSync(root);
        } catch {
            throw new FilesError(404, `${root} is not there`);
        }
    }

    private contained(realRoot: string, real: string): boolean {
        return real === realRoot || real.startsWith(realRoot + sep);
    }

    // The path with every link resolved; it must exist and stay inside the folder.
    private resolve(root: string, path: string): string {
        const realRoot = this.realRoot(root);
        let real: string;
        try {
            real = realpathSync(join(realRoot, path));
        } catch {
            throw new FilesError(404, `${path} is not there`);
        }
        if (!this.contained(realRoot, real)) {
            throw new FilesError(403, `${path} leads outside the folder`);
        }
        return real;
    }

    // The entry itself, not what a link points to, for moving or deleting it; its folder must be
    // inside. The folder itself can be neither.
    private entry(root: string, path: string): string {
        const realRoot = this.realRoot(root);
        const parent = dirname(path) === '.' ? realRoot : this.resolve(root, dirname(path));
        const absolute = join(parent, basename(path));
        if (!this.contained(realRoot, parent)) {
            throw new FilesError(403, `${path} leads outside the folder`);
        }
        try {
            lstatSync(absolute);
        } catch {
            throw new FilesError(404, `${path} is not there`);
        }
        return absolute;
    }

    // Where a new entry goes: nothing may be there yet, and the closest folder that exists must be
    // inside. Missing folders on the way are created.
    private fresh(root: string, path: string): string {
        const realRoot = this.realRoot(root);
        const parts = path.split('/');
        let existing = realRoot;
        let index = 0;
        for (; index < parts.length - 1; index++) {
            const next = join(existing, parts[index]);
            if (!existsSync(next)) {
                break;
            }
            existing = realpathSync(next);
            if (!this.contained(realRoot, existing) || !statSync(existing).isDirectory()) {
                throw new FilesError(409, `${parts.slice(0, index + 1).join('/')} is not a folder inside the folder`);
            }
        }
        const absolute = join(existing, ...parts.slice(index));
        try {
            lstatSync(absolute);
            throw new FilesError(409, `${path} already exists`);
        } catch (error) {
            if (error instanceof FilesError) {
                throw error;
            }
        }
        mkdirSync(dirname(absolute), { recursive: true });
        return absolute;
    }

    // A rename that only changes case finds the entry itself at the new name on a case-insensitive disk.
    private sameEntry(from: string, fromPath: string, toPath: string): boolean {
        if (dirname(fromPath) !== dirname(toPath) || fromPath.toLowerCase() !== toPath.toLowerCase()) {
            return false;
        }
        try {
            const a = lstatSync(from);
            const b = lstatSync(join(dirname(from), basename(toPath)));
            return a.ino === b.ino && a.dev === b.dev;
        } catch {
            return false;
        }
    }

    async tree(root: string, paths: string[]): Promise<FileTree> {
        if (paths.length > MAX_TREE_DIRS) {
            throw new FilesError(400, `at most ${MAX_TREE_DIRS} folders at once`);
        }
        const dirs: FileTree['dirs'] = {};
        for (const raw of paths) {
            try {
                const path = relativePath(raw, true);
                dirs[path] = this.listDir(root, path);
            } catch (error) {
                dirs[String(raw)] = { error: error instanceof Error ? error.message : String(error) };
            }
        }
        await this.markIgnored(root, dirs);
        return { root, dirs };
    }

    private listDir(root: string, path: string): DirListing {
        const real = path ? this.resolve(root, path) : this.realRoot(root);
        if (!statSync(real).isDirectory()) {
            throw new FilesError(409, `${path} is not a folder`);
        }
        const names = readdirSync(real).filter((name) => !HIDDEN.has(name));
        const entries: FileEntry[] = names.slice(0, MAX_DIR_ENTRIES).map((name) => {
            const absolute = join(real, name);
            let link = false;
            let kind: FileEntry['kind'] = 'other';
            try {
                const stat = lstatSync(absolute);
                link = stat.isSymbolicLink();
                const target = link ? statSync(absolute) : stat;
                kind = target.isDirectory() ? 'dir' : target.isFile() ? 'file' : 'other';
            } catch {
                kind = 'other';
            }
            return { name, kind, link, ignored: false };
        });
        entries.sort((a, b) =>
            a.kind === 'dir' && b.kind !== 'dir'
                ? -1
                : b.kind === 'dir' && a.kind !== 'dir'
                  ? 1
                  : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
        );
        return { entries, truncated: names.length > MAX_DIR_ENTRIES };
    }

    // git prints a path it has to quote (a newline, a quote or a backslash in it) in quotes, so
    // such a name is never matched here and simply shows as not ignored.
    private async markIgnored(root: string, dirs: FileTree['dirs']): Promise<void> {
        const candidates: { path: string; entry: FileEntry }[] = [];
        for (const [dir, listing] of Object.entries(dirs)) {
            if ('entries' in listing) {
                for (const entry of listing.entries) {
                    candidates.push({ path: dir ? `${dir}/${entry.name}` : entry.name, entry });
                }
            }
        }
        for (let start = 0; start < candidates.length; start += IGNORE_BATCH) {
            const batch = candidates.slice(start, start + IGNORE_BATCH);
            const result = await this.run(
                'git',
                [...QUIET, 'check-ignore', '--', ...batch.map((item) => item.path)],
                root,
            );
            if (result.missing) {
                return;
            }
            const ignored = new Set(result.stdout.split('\n'));
            for (const item of batch) {
                item.entry.ignored = ignored.has(item.path);
            }
        }
    }

    // Every file under the folder, for finding one by name: what git tracks plus untracked files it
    // does not ignore, or, outside a repository, a walk that skips .git and node_modules.
    async list(root: string): Promise<ProjectFileList> {
        const realRoot = this.realRoot(root);
        const git = await this.run(
            'git',
            [...QUIET, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            realRoot,
        );
        if (git.ok) {
            const files = [...new Set(git.stdout.split('\0').filter(Boolean))].filter((path) => {
                try {
                    const stat = lstatSync(join(realRoot, path));
                    return stat.isFile() || stat.isSymbolicLink();
                } catch {
                    return false;
                }
            });
            return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES };
        }
        const files: string[] = [];
        const queue = [''];
        while (queue.length > 0 && files.length <= MAX_LISTED_FILES) {
            const dir = queue.shift() as string;
            let entries: Dirent[];
            try {
                entries = readdirSync(join(realRoot, dir), { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const path = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isDirectory() && !WALK_SKIPPED.has(entry.name)) {
                    queue.push(path);
                } else if (entry.isFile() || entry.isSymbolicLink()) {
                    files.push(path);
                }
            }
        }
        files.sort();
        return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES };
    }

    read(root: string, raw: unknown, known: string | null): EditorFile {
        const path = relativePath(raw);
        const real = this.resolve(root, path);
        const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile()) {
                throw new FilesError(409, `${path} is not a file`);
            }
            if (stat.size > MAX_EDIT_BYTES) {
                return {
                    path,
                    version: `size:${stat.size}:${stat.mtimeMs}`,
                    text: null,
                    binary: false,
                    tooLarge: true,
                    unchanged: false,
                };
            }
            const bytes = readAll(fd, stat.size);
            const version = versionOf(bytes);
            if (version === known) {
                return { path, version, text: null, binary: false, tooLarge: false, unchanged: true };
            }
            const text = decodeText(bytes);
            return { path, version, text, binary: text === null, tooLarge: false, unchanged: false };
        } finally {
            closeSync(fd);
        }
    }

    // Writes in place, as an editor does, so the file keeps its mode, owner and links. `base` is the
    // version the client edited; when the file on disk is no longer that version (an agent wrote
    // it), nothing is written unless the client forces it.
    write(root: string, raw: unknown, text: string, base: string | null, force: boolean): SavedFile {
        const path = relativePath(raw);
        const bytes = Buffer.from(text, 'utf8');
        if (bytes.length > MAX_EDIT_BYTES) {
            throw new FilesError(413, 'the file is too large to save from here');
        }
        let real: string;
        try {
            real = this.resolve(root, path);
        } catch (error) {
            if (error instanceof FilesError && error.status === 404) {
                if (!force && base !== null) {
                    throw new FilesError(409, `${path} was deleted on disk`);
                }
                const fresh = this.fresh(root, path);
                writeFileSync(fresh, bytes, { flag: 'wx' });
                return { path, version: versionOf(bytes) };
            }
            throw error;
        }
        const fd = openSync(real, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile()) {
                throw new FilesError(409, `${path} is not a file`);
            }
            if (!force) {
                const current = stat.size > MAX_EDIT_BYTES ? null : versionOf(readAll(fd, stat.size));
                if (current !== base) {
                    throw new FilesError(409, `${path} changed on disk`);
                }
            }
            ftruncateSync(fd, 0);
            let written = 0;
            while (written < bytes.length) {
                written += writeSync(fd, bytes, written, bytes.length - written, written);
            }
        } finally {
            closeSync(fd);
        }
        return { path, version: versionOf(bytes) };
    }

    act(root: string, body: unknown): FileActionResult {
        if (!body || typeof body !== 'object') {
            throw new FilesError(400, 'body must be an object');
        }
        const action = body as FileAction;
        switch (action.action) {
            case 'create': {
                if (action.kind !== 'file' && action.kind !== 'dir') {
                    throw new FilesError(400, 'kind must be "file" or "dir"');
                }
                const absolute = this.fresh(root, relativePath(action.path));
                if (action.kind === 'dir') {
                    mkdirSync(absolute);
                } else {
                    writeFileSync(absolute, '', { flag: 'wx' });
                }
                return { trashed: false };
            }
            case 'rename': {
                const fromPath = relativePath(action.from);
                const from = this.entry(root, fromPath);
                const to = relativePath(action.to);
                if (`${to}/`.startsWith(`${fromPath}/`)) {
                    throw new FilesError(409, 'a folder cannot move into itself');
                }
                renameSync(
                    from,
                    this.sameEntry(from, fromPath, to) ? join(dirname(from), basename(to)) : this.fresh(root, to),
                );
                return { trashed: false };
            }
            case 'trash':
                return { trashed: this.trash(this.entry(root, relativePath(action.path))) };
            case 'delete':
                rmSync(this.entry(root, relativePath(action.path)), { recursive: true });
                return { trashed: false };
            default:
                throw new FilesError(400, 'action must be create, rename, trash or delete');
        }
    }
}
