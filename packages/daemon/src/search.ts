import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { SearchFile, SearchMatch, SearchQuery, SearchResult } from '@voltran/shared';

export const MAX_QUERY_LENGTH = 1000;
export const MAX_SEARCH_MATCHES = 2000;
export const MAX_FILE_MATCHES = 500;
export const MAX_SEARCH_BYTES = 1024 * 1024;
const PREVIEW_BEFORE = 40;
const PREVIEW_LENGTH = 240;

export interface SearchJob {
    root: string;
    files: string[];
    query: SearchQuery;
    budgetMs: number;
}

export function parseSearchQuery(value: unknown): SearchQuery | string {
    if (!value || typeof value !== 'object') {
        return 'the query must be an object';
    }
    const { text, caseSensitive, wholeWord, regex } = value as Record<string, unknown>;
    if (typeof text !== 'string' || text === '' || text.length > MAX_QUERY_LENGTH) {
        return `text must hold 1 to ${MAX_QUERY_LENGTH} characters`;
    }
    if (text.includes('\n')) {
        return 'text must fit on one line';
    }
    return { text, caseSensitive: caseSensitive === true, wholeWord: wholeWord === true, regex: regex === true };
}

// The query as a regular expression, or why it is not one. Each line is searched on its own, so ^
// and $ mean its start and end.
export function searchPattern(query: SearchQuery): RegExp | string {
    const source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        new RegExp(source);
        return new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, query.caseSensitive ? 'g' : 'gi');
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function matchLine(pattern: RegExp, text: string, line: number, limit: number): SearchMatch[] {
    const matches: SearchMatch[] = [];
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found && matches.length < limit; found = pattern.exec(text)) {
        if (found[0].length === 0) {
            pattern.lastIndex++;
            continue;
        }
        const start = found.index > PREVIEW_BEFORE ? found.index - PREVIEW_BEFORE : 0;
        matches.push({
            line,
            column: found.index + 1,
            length: found[0].length,
            preview: text.slice(start, Math.max(start + PREVIEW_LENGTH, found.index + found[0].length)),
            previewStart: found.index - start,
        });
    }
    return matches;
}

export function matchText(pattern: RegExp, text: string, limit: number): SearchMatch[] {
    const matches: SearchMatch[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length && matches.length < limit; index++) {
        const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
        matches.push(...matchLine(pattern, line, index + 1, limit - matches.length));
    }
    return matches;
}

// Only a regular file that resolves inside the folder, without a link at its end, valid UTF-8 and
// free of NUL, is searched, as the editor would open it.
function readText(root: string, path: string): string | null {
    let real: string;
    try {
        real = realpathSync(join(root, path));
    } catch {
        return null;
    }
    if (!real.startsWith(root + sep)) {
        return null;
    }
    let fd: number;
    try {
        fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        return null;
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_SEARCH_BYTES) {
            return null;
        }
        const bytes = Buffer.alloc(stat.size);
        let read = 0;
        while (read < stat.size) {
            const count = readSync(fd, bytes, read, stat.size - read, read);
            if (count === 0) {
                break;
            }
            read += count;
        }
        const content = bytes.subarray(0, read);
        if (content.includes(0)) {
            return null;
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
        return null;
    } finally {
        closeSync(fd);
    }
}

export function searchFiles(job: SearchJob, now: () => number = Date.now): SearchResult {
    const pattern = searchPattern(job.query);
    if (typeof pattern === 'string') {
        throw new Error(pattern);
    }
    const deadline = now() + job.budgetMs;
    const files: SearchFile[] = [];
    let matches = 0;
    let searched = 0;
    for (const path of job.files) {
        if (matches >= MAX_SEARCH_MATCHES) {
            return { files, matches, searched, truncated: 'matches' };
        }
        if (now() > deadline) {
            return { files, matches, searched, truncated: 'time' };
        }
        searched++;
        const text = readText(job.root, path);
        if (text === null) {
            continue;
        }
        const found = matchText(pattern, text, Math.min(MAX_FILE_MATCHES, MAX_SEARCH_MATCHES - matches));
        if (found.length > 0) {
            files.push({ path, matches: found });
            matches += found.length;
        }
    }
    return { files, matches, searched, truncated: null };
}
