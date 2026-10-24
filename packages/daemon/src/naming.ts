import type { Pane, Session, TitleSource } from '@voltran/shared';
import { withoutControls } from './status.ts';
import { readAiTitle } from './transcripts.ts';

export const PENDING_TITLE = 'New session';

const MAX_PROMPT_TITLE = 60;
const MAX_AGENT_TITLE = 120;
const CHECK_INTERVAL_MS = 2000;
const MAX_CHECKS = 30;
const PROMPT_EVENTS = new Set(['UserPromptSubmit', 'PromptSubmit']);

export interface SessionTitle {
    title: string;
    titleSource: TitleSource;
}

// The first line of the prompt, cut at a word. A slash command says nothing about the work.
export function titleFromPrompt(prompt: unknown): string | null {
    if (typeof prompt !== 'string') {
        return null;
    }
    const line = withoutControls((prompt.split('\n').find((entry) => entry.trim()) ?? '').replace(/\s+/g, ' ')).trim();
    if (!line || line.startsWith('/')) {
        return null;
    }
    if (line.length <= MAX_PROMPT_TITLE) {
        return line;
    }
    const space = line.slice(0, MAX_PROMPT_TITLE + 1).lastIndexOf(' ');
    const cut = line.slice(0, space > MAX_PROMPT_TITLE / 2 ? space : MAX_PROMPT_TITLE);
    return `${cut.replace(/[\s,.;:–-]+$/, '')}…`;
}

// A session started without a title takes the first prompt any of its agents reports, then the title
// Claude Code gives the conversation, until the user renames it. Claude's title is an internal
// transcript entry, so the prompt stays when it never appears; each session is checked a bounded
// number of times.
export class SessionNamer {
    private checks = new Map<string, { at: number; count: number }>();

    name(session: Session, pane: Pane, event: string, payload: Record<string, unknown>, now = Date.now()): SessionTitle | null {
        if (session.titleSource !== 'pending' && session.titleSource !== 'prompt') {
            return null;
        }
        let named: SessionTitle | null = null;
        if (session.titleSource === 'pending' && PROMPT_EVENTS.has(event)) {
            const title = titleFromPrompt(payload.prompt);
            if (title) {
                named = { title, titleSource: 'prompt' };
            }
        }
        if (pane.adapter !== 'claude' || typeof payload.transcript_path !== 'string') {
            return named;
        }
        const check = this.checks.get(session.id) ?? { at: -Infinity, count: 0 };
        if (check.count >= MAX_CHECKS || now - check.at < CHECK_INTERVAL_MS) {
            return named;
        }
        this.checks.set(session.id, { at: now, count: check.count + 1 });
        const title = readAiTitle(payload.transcript_path, payload.session_id);
        if (!title) {
            return named;
        }
        this.checks.delete(session.id);
        return { title: title.slice(0, MAX_AGENT_TITLE), titleSource: 'agent' };
    }

    forget(sessionId: string): void {
        this.checks.delete(sessionId);
    }
}
