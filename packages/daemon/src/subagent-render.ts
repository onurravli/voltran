import type { TranscriptEntry } from '@voltran/shared';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESULT_LINES = 3;
const RESULT_WIDTH = 160;

export interface RenderState {
    tools: Map<string, string>;
    lastToolId: string | null;
}

export function createRenderState(): RenderState {
    return { tools: new Map(), lastToolId: null };
}

const indent = (lines: string[], first: string, rest = '  '): string =>
    lines.map((line, index) => `${index === 0 ? first : rest}${line}`).join('\r\n');

function inline(text: string): string {
    return text
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `$1 ${DIM}($2)${RESET}`)
        .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, `$1${ITALIC}$2${RESET}`)
        .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);
}

function markdown(text: string): string[] {
    const lines: string[] = [];
    let inCode = false;
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        if (/^\s*```/.test(raw)) {
            inCode = !inCode;
            continue;
        }
        if (inCode) {
            lines.push(`${CYAN}${raw}${RESET}`);
        } else if (/^#{1,6}\s/.test(raw)) {
            lines.push(`${BOLD}${raw.replace(/^#{1,6}\s+/, '')}${RESET}`);
        } else {
            lines.push(inline(raw));
        }
    }
    while (lines.length > 0 && lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

function result(entry: Extract<TranscriptEntry, { kind: 'result' }>, state: RenderState): string | null {
    if (!state.tools.has(entry.toolUseId)) {
        return null;
    }
    const color = entry.error ? RED : DIM;
    const all = entry.text
        .replace(/\r/g, '')
        .split('\n')
        .filter((line, index, list) => line.trim() || index < list.length - 1)
        .map((line) => (line.length > RESULT_WIDTH ? `${line.slice(0, RESULT_WIDTH - 1)}…` : line));
    const shown = all.length > 0 ? all.slice(0, RESULT_LINES) : ['(no output)'];
    const name = state.tools.get(entry.toolUseId);
    const label = entry.toolUseId !== state.lastToolId && name ? `(${name}) ` : '';
    const body = shown.map((line, index) => `${index === 0 ? '  ⎿  ' : '     '}${color}${index === 0 ? label : ''}${line}${RESET}`);
    if (all.length > RESULT_LINES) {
        body.push(`     ${DIM}… +${all.length - RESULT_LINES} lines${RESET}`);
    }
    return body.join('\r\n');
}

// Lays the entries out the way Claude Code shows a conversation: a dimmed prompt, ● for each message
// and tool call, and ⎿ for the first lines of a tool's result.
export function renderEntries(entries: TranscriptEntry[], state: RenderState): string {
    const blocks: string[] = [];
    for (const entry of entries) {
        switch (entry.kind) {
            case 'prompt':
                blocks.push(
                    indent(
                        entry.text
                            .replace(/\r/g, '')
                            .split('\n')
                            .map((line) => `${DIM}${line}${RESET}`),
                        `${DIM}> ${RESET}`,
                    ),
                );
                break;
            case 'text':
                blocks.push(indent(markdown(entry.text), '● '));
                break;
            case 'tool':
                state.tools.set(entry.id, entry.name);
                state.lastToolId = entry.id;
                blocks.push(`● ${BOLD}${entry.name}${RESET}${entry.summary ? `(${entry.summary})` : ''}`);
                break;
            case 'result': {
                const rendered = result(entry, state);
                if (rendered !== null) {
                    blocks.push(rendered);
                }
                break;
            }
        }
    }
    return blocks
        .map((block) => `${block}\r\n`)
        .join('')
        .replace(/(^|\r\n)(● )/g, '$1\r\n$2');
}

export function renderNote(text: string, tone: 'dim' | 'error' = 'dim'): string {
    return `\r\n${tone === 'error' ? RED : DIM}── ${text} ──${RESET}\r\n`;
}
