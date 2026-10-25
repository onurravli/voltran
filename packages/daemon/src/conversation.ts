import { closeSync } from 'node:fs';
import type { ConversationChunk, ConversationEntry, TodoState, ToolDetail } from '@voltran/shared';
import { clip, oneLine, openRegular, readJsonLines, resultText, toolSummary } from './transcripts.ts';

const MAX_TEXT = 40_000;
const MAX_RESULT = 4_000;
const MAX_INPUT = 4_000;
const MAX_NAME = 140;
const MAX_TODOS = 50;

// Local commands print their output with colours; clip only drops the escape character, which would
// leave the rest of each sequence in the text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const text = (value: string, max = MAX_TEXT): string => clip(value.replace(ANSI, ''), max);

const tag = (source: string, name: string): string | null => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(source);
    return match ? match[1] : null;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const TODO_STATES: readonly TodoState[] = ['pending', 'in_progress', 'completed'];

function toolDetail(name: string, input: Record<string, unknown>): ToolDetail | null {
    switch (name) {
        case 'Bash':
            return str(input.command) ? { kind: 'command', command: text(str(input.command)) } : null;
        case 'Edit':
            return str(input.file_path)
                ? { kind: 'edit', path: text(str(input.file_path), MAX_NAME * 4), changes: [{ before: text(str(input.old_string)), after: text(str(input.new_string)) }] }
                : null;
        case 'MultiEdit': {
            const edits = Array.isArray(input.edits) ? input.edits : [];
            const changes = edits
                .filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object')
                .map((edit) => ({ before: text(str(edit.old_string)), after: text(str(edit.new_string)) }));
            return str(input.file_path) ? { kind: 'edit', path: text(str(input.file_path), MAX_NAME * 4), changes } : null;
        }
        case 'Write':
            return str(input.file_path) ? { kind: 'write', path: text(str(input.file_path), MAX_NAME * 4), content: text(str(input.content)) } : null;
        case 'TodoWrite': {
            const todos = Array.isArray(input.todos) ? input.todos.slice(0, MAX_TODOS) : [];
            return {
                kind: 'todos',
                todos: todos
                    .filter((todo): todo is Record<string, unknown> => Boolean(todo) && typeof todo === 'object')
                    .map((todo) => ({
                        text: text(oneLine(todo.content), MAX_NAME * 2),
                        state: TODO_STATES.find((state) => state === todo.status) ?? 'pending',
                    })),
            };
        }
        default: {
            const json = JSON.stringify(input, null, 2);
            return json && json !== '{}' ? { kind: 'input', text: text(json, MAX_INPUT) } : null;
        }
    }
}

// A user record is a prompt, or a local command and its output, which Claude wraps in tags.
function userText(raw: string, images: number, at: number | null): ConversationEntry[] {
    const command = tag(raw, 'command-name');
    if (command !== null) {
        const args = tag(raw, 'command-args') ?? '';
        return [{ kind: 'prompt', text: text(`${command.trim()} ${args.trim()}`.trim()), images, at }];
    }
    const bash = tag(raw, 'bash-input');
    if (bash !== null) {
        return [{ kind: 'prompt', text: text(`! ${bash.trim()}`), images, at }];
    }
    const stdout = tag(raw, 'local-command-stdout') ?? tag(raw, 'bash-stdout');
    const stderr = tag(raw, 'local-command-stderr') ?? tag(raw, 'bash-stderr');
    if (stdout !== null || stderr !== null) {
        const output = [stdout, stderr].map((part) => part?.trim() ?? '').filter(Boolean).join('\n');
        return output ? [{ kind: 'notice', text: text(output, MAX_RESULT), tone: stderr?.trim() && !stdout?.trim() ? 'error' : 'info', at }] : [];
    }
    if (/^\[Request interrupted by user/.test(raw.trim())) {
        return [{ kind: 'notice', text: 'Interrupted', tone: 'info', at }];
    }
    return raw.trim() || images > 0 ? [{ kind: 'prompt', text: text(raw.trim()), images, at }] : [];
}

// Returns the entries one line of a Claude Code transcript contributes, an empty list for records the
// view does not show, or null for a line it does not understand.
export function parseClaudeLine(line: unknown): ConversationEntry[] | null {
    if (!line || typeof line !== 'object') {
        return null;
    }
    const record = line as Record<string, unknown>;
    if (typeof record.type !== 'string') {
        return null;
    }
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || null : null;
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
        return [{ kind: 'notice', text: 'Conversation compacted', tone: 'info', at }];
    }
    if ((record.type !== 'user' && record.type !== 'assistant') || record.isMeta === true || record.isCompactSummary === true || record.isSidechain === true) {
        return [];
    }
    const message = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : null;
    if (!message) {
        return null;
    }
    const model = typeof message.model === 'string' && !message.model.startsWith('<') ? clip(message.model, MAX_NAME) : null;
    const content = message.content;
    if (record.type === 'assistant' && record.isApiErrorMessage === true) {
        const error = typeof content === 'string' ? content : resultText(content);
        return [{ kind: 'notice', text: text(error || 'The request failed', MAX_RESULT), tone: 'error', at }];
    }
    if (typeof content === 'string') {
        return record.type === 'user' ? userText(content, 0, at) : [{ kind: 'text', text: text(content), model, at }];
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const blocks = content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object');
    const entries: ConversationEntry[] = [];
    if (record.type === 'user') {
        const images = blocks.filter((block) => block.type === 'image').length;
        const prompt = blocks.filter((block) => block.type === 'text').map((block) => str(block.text)).join('\n');
        if (prompt.trim() || images > 0) {
            entries.push(...userText(prompt, images, at));
        }
    }
    for (const block of blocks) {
        if (record.type === 'assistant' && block.type === 'text' && str(block.text).trim()) {
            entries.push({ kind: 'text', text: text(str(block.text)), model, at });
        } else if (block.type === 'thinking' && str(block.thinking).trim()) {
            entries.push({ kind: 'thinking', text: text(str(block.thinking)), at });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
            entries.push({
                kind: 'tool',
                id: typeof block.id === 'string' ? block.id : '',
                name: clip(block.name, MAX_NAME),
                summary: block.name === 'Bash' && oneLine(input.description) ? clip(oneLine(input.description), MAX_NAME) : toolSummary(block.name, input),
                detail: toolDetail(block.name, input),
                at,
            });
        } else if (block.type === 'tool_result') {
            entries.push({
                kind: 'result',
                toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
                text: text(resultText(block.content), MAX_RESULT),
                error: block.is_error === true,
                at,
            });
        }
    }
    return entries;
}

export function readClaudeConversation(path: string, source: string, from: number): ConversationChunk | null {
    const fd = openRegular(path);
    if (fd === null) {
        return null;
    }
    try {
        const { entries, next, more } = readJsonLines(fd, from, parseClaudeLine);
        return { source, entries, next, more };
    } finally {
        closeSync(fd);
    }
}
