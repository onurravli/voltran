import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, readdirSync, type Stats, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { EditableFile, FolderEntry, FolderListing } from '@voltran/shared';

export const MAX_ENTRIES = 2000;
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

const HIDDEN = '.git';
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class FilesRefused extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// A path is relative to the session's folder, split by '/', and has no empty, '.' or '..' part, so
// it cannot name anything outside the folder. Git's own folder stays out of reach.
export function pathParts(path: string): string[] {
    if (path === '') {
        return [];
    }
    const parts = path.split('/');
    if (
        path.length > 4096 ||
        parts.some((part) => part === '' || part === '.' || part === '..' || part === HIDDEN || part.includes('\0'))
    ) {
        throw new FilesRefused(400, `${path} is not a path inside the session folder`);
    }
    return parts;
}

function lstatOrNull(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch {
        return null;
    }
}

// Every folder on the way is checked without following links, so a link planted in the folder
// cannot lead a read or a write out of it.
function inside(root: string, path: string): string {
    const parts = pathParts(path);
    let current = root;
    for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        if (!lstatOrNull(current)?.isDirectory()) {
            throw new FilesRefused(404, `${path} is not in the session folder`);
        }
    }
    return parts.length === 0 ? root : join(current, parts[parts.length - 1]);
}

function kindOf(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): FolderEntry['kind'] {
    return entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other';
}

export function listFolder(root: string, path: string): FolderListing {
    const folder = inside(root, path);
    if (path !== '' && !lstatOrNull(folder)?.isDirectory()) {
        throw new FilesRefused(404, `${path} is not a folder in the session folder`);
    }
    let entries: FolderEntry[];
    try {
        entries = readdirSync(folder, { withFileTypes: true })
            .filter((entry) => entry.name !== HIDDEN)
            .map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
    } catch {
        throw new FilesRefused(404, `${path || 'The session folder'} cannot be read`);
    }
    entries.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name));
    return { path, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

export function fileVersion(content: Buffer): string {
    return createHash('sha256').update(content).digest('base64url');
}

function open(root: string, path: string, flags: number): { fd: number; stat: Stats } {
    if (path === '') {
        throw new FilesRefused(400, 'a file path is required');
    }
    const file = inside(root, path);
    let fd: number;
    try {
        fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new FilesRefused(404, `${path} is no longer there`);
        }
        if (code === 'ELOOP') {
            throw new FilesRefused(409, `${path} is a link, which Voltran does not follow`);
        }
        if (code === 'EACCES' || code === 'EPERM') {
            throw new FilesRefused(403, `${path} cannot be ${flags & constants.O_RDWR ? 'written' : 'read'}`);
        }
        throw new FilesRefused(409, `${path} cannot be opened`);
    }
    try {
        const stat = fstatSync(fd);
        // A folder on the way that was swapped for a link and back while the file opened would
        // have opened another file; it is not the one the path names now.
        const now = lstatOrNull(inside(root, path));
        if (!now || now.dev !== stat.dev || now.ino !== stat.ino) {
            throw new FilesRefused(409, `${path} changed while it was opened`);
        }
        if (!stat.isFile()) {
            throw new FilesRefused(409, `${path} is not a file`);
        }
        return { fd, stat };
    } catch (error) {
        closeSync(fd);
        throw error;
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

function describe(path: string, content: Buffer | null, stat: Stats): EditableFile {
    // A file with another hard link may be a file outside the folder, so it is shown but not saved.
    const readOnly = stat.nlink > 1;
    if (content === null) {
        return { path, text: null, version: null, binary: false, tooLarge: true, readOnly };
    }
    const version = fileVersion(content);
    if (content.includes(0)) {
        return { path, text: null, version, binary: true, tooLarge: false, readOnly };
    }
    try {
        return { path, text: UTF8.decode(content), version, binary: false, tooLarge: false, readOnly };
    } catch {
        return { path, text: null, version, binary: true, tooLarge: false, readOnly };
    }
}

export function readEditableFile(root: string, path: string): EditableFile {
    const { fd, stat } = open(root, path, constants.O_RDONLY);
    try {
        return describe(path, stat.size > MAX_EDIT_BYTES ? null : readAll(fd, stat.size), stat);
    } finally {
        closeSync(fd);
    }
}

// The file is written in place, so it keeps its mode, owner and links, and only when it still has
// the contents the editor started from.
export function saveEditableFile(root: string, path: string, text: string, version: string): EditableFile {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_EDIT_BYTES) {
        throw new FilesRefused(413, `A file can be at most ${MAX_EDIT_BYTES / 1024 / 1024} MB here`);
    }
    const { fd, stat } = open(root, path, constants.O_RDWR);
    try {
        const current = describe(path, stat.size > MAX_EDIT_BYTES ? null : readAll(fd, stat.size), stat);
        if (current.readOnly || current.binary || current.tooLarge) {
            throw new FilesRefused(409, `${path} cannot be saved from here`);
        }
        if (current.version !== version) {
            throw new FilesRefused(409, `${path} changed on disk since it was opened`);
        }
        ftruncateSync(fd, 0);
        let written = 0;
        while (written < bytes.length) {
            written += writeSync(fd, bytes, written, bytes.length - written, written);
        }
        return { ...current, text, version: fileVersion(bytes) };
    } finally {
        closeSync(fd);
    }
}
