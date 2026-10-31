import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { TranscriptChunk, TranscriptEntry } from '@voltran/shared';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_RESULT = 2_000;
const MAX_SUMMARY = 140;
const MAX_TITLE_SCAN_BYTES = 512 * 1024;
const MAX_META_BYTES = 64 * 1024;

export const isClaudeSessionId = (value: unknown): value is string =>
    typeof value === 'string' && SESSION_ID.test(value);

// Hook payloads name these files, so the file is checked on the descriptor that is read: a link or a
// pipe swapped in after a check of the path would otherwise be followed, or block the daemon.
export function openRegular(path: string): number | null {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        return null;
    }
    if (fstatSync(fd).isFile()) {
        return fd;
    }
    closeSync(fd);
    return null;
}

function readStart(fd: number, limit: number): string {
    const buffer = Buffer.alloc(Math.min(fstatSync(fd).size, limit));
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
}

export interface SubagentMeta {
    description: string | null;
    type: string | null;
}

// The transcript path is derived from the parent transcript Claude reports, never taken from a client,
// and must keep Claude's own layout: <dir>/<session>.jsonl → <dir>/<session>/subagents/agent-<id>.jsonl.
export function subagentTranscriptPath(parentTranscript: unknown, sessionId: unknown, agentId: string): string | null {
    if (typeof parentTranscript !== 'string' || typeof sessionId !== 'string' || !isAbsolute(parentTranscript)) {
        return null;
    }
    if (!SESSION_ID.test(sessionId) || !AGENT_ID.test(agentId) || basename(parentTranscript) !== `${sessionId}.jsonl`) {
        return null;
    }
    return join(dirname(parentTranscript), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

// A transcript path from a hook must name the conversation the same hook reported.
export function isClaudeTranscript(transcript: unknown, sessionId: unknown): transcript is string {
    return (
        typeof transcript === 'string' &&
        isAbsolute(transcript) &&
        isClaudeSessionId(sessionId) &&
        basename(transcript) === `${sessionId}.jsonl`
    );
}

// Claude keeps each conversation at <config>/projects/<folder>/<session>.jsonl. A pane that has not
// reported a hook since the daemon started knows only its session, so the folder is looked up.
export function findClaudeTranscript(configDir: string | null, sessionId: string): string | null {
    if (!configDir || !isClaudeSessionId(sessionId)) {
        return null;
    }
    const projects = join(configDir, 'projects');
    let folders: string[];
    try {
        folders = readdirSync(projects);
    } catch {
        return null;
    }
    for (const folder of folders) {
        const candidate = join(projects, folder, `${sessionId}.jsonl`);
        try {
            if (lstatSync(candidate).isFile()) {
                return candidate;
            }
        } catch {}
    }
    return null;
}

// Claude Code names a conversation during its first turn with an internal `ai-title` entry near the
// top of the transcript, so only the start of the file is read. The path must name the conversation
// the hook reported and be a regular file.
export function readAiTitle(transcript: unknown, sessionId: unknown): string | null {
    if (!isClaudeTranscript(transcript, sessionId)) {
        return null;
    }
    const fd = openRegular(transcript);
    if (fd === null) {
        return null;
    }
    let text: string;
    try {
        text = readStart(fd, MAX_TITLE_SCAN_BYTES);
    } catch {
        return null;
    } finally {
        closeSync(fd);
    }
    let title: string | null = null;
    for (const line of text.split('\n')) {
        if (!line.includes('"ai-title"')) {
            continue;
        }
        try {
            const entry = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
            if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
                title = entry.aiTitle.replace(/\s+/g, ' ').replace(CONTROL, '').trim() || title;
            }
        } catch {}
    }
    return title;
}

function insideSubagents(path: string): boolean {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return false;
        }
        const folder = dirname(path);
        const run =
            basename(dirname(folder)) === 'workflows' && RUN_ID.test(basename(folder))
                ? ['workflows', basename(folder)]
                : [];
        const session = dirname(run.length > 0 ? dirname(dirname(folder)) : folder);
        return realpathSync(folder) === join(realpathSync(dirname(session)), basename(session), 'subagents', ...run);
    } catch {
        return false;
    }
}

// An agent that a workflow starts writes under subagents/workflows/<run>/ instead, and its hooks do
// not say which run, so the file is looked up there by name.
function locate(path: string): string | null {
    if (insideSubagents(path)) {
        return path;
    }
    const workflows = join(dirname(path), 'workflows');
    let runs: string[];
    try {
        runs = readdirSync(workflows);
    } catch {
        return null;
    }
    for (const run of runs) {
        const candidate = join(workflows, run, basename(path));
        if (RUN_ID.test(run) && insideSubagents(candidate)) {
            return candidate;
        }
    }
    return null;
}

export function readSubagentMeta(transcriptPath: string): SubagentMeta | null {
    const metaPath = locate(transcriptPath.replace(/\.jsonl$/, '.meta.json'));
    const fd = metaPath ? openRegular(metaPath) : null;
    if (fd === null) {
        return null;
    }
    try {
        const meta = JSON.parse(readStart(fd, MAX_META_BYTES)) as Record<string, unknown>;
        return {
            description: typeof meta.description === 'string' ? meta.description : null,
            type: typeof meta.agentType === 'string' ? meta.agentType : null,
        };
    } catch {
        return null;
    } finally {
        closeSync(fd);
    }
}

// Every string an entry carries goes through here. The subagent viewer writes entries to a terminal,
// and a transcript holds whatever its tools read or fetched, so control characters are dropped:
// escape sequences in a tool result could otherwise move the cursor and hide or forge earlier lines.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export const clip = (text: string, max: number): string => {
    const clean = text.replace(CONTROL, '');
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export const oneLine = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

export function toolSummary(name: string, input: Record<string, unknown>): string {
    const pick = (...keys: string[]): string => {
        for (const key of keys) {
            const value = oneLine(input[key]);
            if (value) {
                return value;
            }
        }
        return '';
    };
    const known: Record<string, () => string> = {
        Bash: () => pick('command', 'description'),
        Read: () => pick('file_path'),
        Edit: () => pick('file_path'),
        Write: () => pick('file_path'),
        Grep: () => pick('pattern'),
        Glob: () => pick('pattern'),
        WebSearch: () => pick('query'),
        WebFetch: () => pick('url'),
        Agent: () => pick('description'),
        Task: () => pick('description'),
    };
    const summary = known[name]?.() || Object.values(input).map(oneLine).find(Boolean) || '';
    return clip(summary, MAX_SUMMARY);
}

export function resultText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((block) =>
                block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
                    ? String((block as Record<string, unknown>).text ?? '')
                    : '',
            )
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

// Returns the entries one transcript line contributes, an empty list for lines Voltran deliberately
// skips (attachments, thinking, system records), or null for a line it does not understand.
export function parseTranscriptLine(line: unknown): TranscriptEntry[] | null {
    if (!line || typeof line !== 'object') {
        return null;
    }
    const record = line as Record<string, unknown>;
    if (typeof record.type !== 'string') {
        return null;
    }
    if ((record.type !== 'user' && record.type !== 'assistant') || record.isMeta === true) {
        return [];
    }
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || null : null;
    const message =
        record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    if (!message) {
        return null;
    }
    const content = message.content;
    if (typeof content === 'string') {
        return record.type === 'user'
            ? [{ kind: 'prompt', text: clip(content, MAX_TEXT), at }]
            : [{ kind: 'text', text: clip(content, MAX_TEXT), at }];
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const entries: TranscriptEntry[] = [];
    for (const raw of content) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const block = raw as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            entries.push(
                record.type === 'user'
                    ? { kind: 'prompt', text: clip(block.text, MAX_TEXT), at }
                    : { kind: 'text', text: clip(block.text, MAX_TEXT), at },
            );
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const input =
                block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
            if (block.name === 'SubagentHandback' && typeof input.message === 'string') {
                entries.push({ kind: 'text', text: clip(input.message, MAX_TEXT), at });
                continue;
            }
            entries.push({
                kind: 'tool',
                id: typeof block.id === 'string' ? block.id : '',
                name: clip(block.name, MAX_SUMMARY),
                summary: toolSummary(block.name, input),
                at,
            });
        } else if (block.type === 'tool_result') {
            entries.push({
                kind: 'result',
                toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
                text: clip(resultText(block.content), MAX_RESULT),
                error: block.is_error === true,
                at,
            });
        }
    }
    return entries;
}

export interface JsonLines<T> {
    entries: T[];
    next: number;
    skipped: number;
    more: boolean;
}

// Reads whole lines from `from` on, at most a chunk at a time. A line still being written is left for
// the next read, and `next` points at its start.
export function readJsonLines<T>(fd: number, from: number, parse: (line: unknown) => T[] | null): JsonLines<T> {
    const size = fstatSync(fd).size;
    const start = Number.isSafeInteger(from) && from >= 0 && from <= size ? from : 0;
    const length = Math.min(size - start, MAX_CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const read = length > 0 ? readSync(fd, buffer, 0, length, start) : 0;
    const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
    if (lastNewline < 0) {
        return read === MAX_CHUNK_BYTES
            ? { entries: [], next: start + read, skipped: 1, more: true }
            : { entries: [], next: start, skipped: 0, more: false };
    }
    const entries: T[] = [];
    let skipped = 0;
    for (const line of buffer.subarray(0, lastNewline).toString('utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let parsed: T[] | null = null;
        try {
            parsed = parse(JSON.parse(line));
        } catch {
            parsed = null;
        }
        if (parsed === null) {
            skipped += 1;
        } else {
            entries.push(...parsed);
        }
    }
    return { entries, next: start + lastNewline + 1, skipped, more: start + length < size };
}

export function readTranscript(path: string, from: number): TranscriptChunk | null {
    const file = locate(path);
    const fd = file ? openRegular(file) : null;
    if (fd === null) {
        return null;
    }
    try {
        const { entries, next, skipped } = readJsonLines(fd, from, parseTranscriptLine);
        return { entries, next, skipped };
    } finally {
        closeSync(fd);
    }
}
