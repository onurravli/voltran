// OpenCode loads this folder as a plugin inside the pane's own OpenCode server (`--standalone`), so it
// must stay self-contained: no imports from the daemon, and nothing OpenCode does not provide.

interface OpenCodeEvent {
    type: string;
    data?: unknown;
}

interface PluginContext {
    event: {
        subscribe(options: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent>;
    };
}

export interface Report {
    event: string;
    payload: Record<string, unknown>;
}

const MAX_TEXT = 2000;
const POST_TIMEOUT_MS = 2000;
const RESUBSCRIBE_DELAY_MS = 1000;

const text = (value: unknown): string | null => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : null);

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

// Subagents run as child sessions. Only their permission prompts and questions are reported, because
// those wait on the user too; their turns starting and ending say nothing about the pane.
export class Reporter {
    private readonly children = new Set<string>();
    private readonly lastText = new Map<string, string>();

    report(event: OpenCodeEvent): Report | null {
        const data = record(event.data);
        const sessionId = text(data.sessionID);
        const child = sessionId !== null && this.children.has(sessionId);
        switch (event.type) {
            case 'session.created':
                if (sessionId !== null && typeof data.parentID === 'string') {
                    this.children.add(sessionId);
                    return null;
                }
                return { event: 'SessionCreated', payload: { session_id: sessionId } };
            case 'session.inbox.enqueued': {
                const item = record(data.item);
                if (child || item.type !== 'user') {
                    return null;
                }
                return { event: 'PromptSubmit', payload: { session_id: sessionId, prompt: text(record(item.payload).text) } };
            }
            case 'session.execution.started':
                if (child) {
                    return null;
                }
                this.forget(sessionId);
                return { event: 'TurnStart', payload: { session_id: sessionId } };
            case 'session.text.ended':
                if (!child && sessionId !== null) {
                    this.lastText.set(sessionId, text(data.text) ?? '');
                }
                return null;
            case 'session.tool.input.started':
                return child ? null : { event: 'ToolStart', payload: { session_id: sessionId, tool_name: text(data.name) } };
            case 'session.tool.success':
            case 'session.tool.failed':
                return child ? null : { event: 'ToolEnd', payload: { session_id: sessionId } };
            case 'session.execution.succeeded':
            case 'session.execution.failed':
            case 'session.execution.interrupted': {
                if (child) {
                    return null;
                }
                const outcome = event.type.slice('session.execution.'.length);
                const message = outcome === 'succeeded'
                    ? (sessionId !== null ? this.lastText.get(sessionId) ?? null : null)
                    : outcome === 'failed' ? text(record(data.error).message) : null;
                this.forget(sessionId);
                return { event: 'TurnEnd', payload: { session_id: sessionId, outcome, message } };
            }
            case 'permission.asked': {
                const resources = Array.isArray(data.resources) ? data.resources.slice(0, 5).map(text).filter((value) => value !== null) : [];
                return { event: 'Permission', payload: { request_id: text(data.id), action: text(data.action), resources } };
            }
            case 'permission.replied':
            case 'permission.rejected':
                return { event: 'PermissionReplied', payload: { request_id: text(data.requestID) ?? text(data.id) } };
            case 'form.created': {
                const form = record(data.form);
                const field = record(Array.isArray(form.fields) ? form.fields[0] : null);
                const message = text(field.description) ?? text(field.title) ?? text(form.title);
                return { event: 'Question', payload: { request_id: text(form.id), message } };
            }
            case 'form.replied':
            case 'form.cancelled':
                return { event: 'QuestionAnswered', payload: { request_id: text(data.id) } };
            default:
                return null;
        }
    }

    private forget(sessionId: string | null): void {
        if (sessionId !== null) {
            this.lastText.delete(sessionId);
        }
    }
}

export default {
    id: 'voltran',
    setup(ctx: PluginContext): (() => void) | undefined {
        const paneId = process.env.VOLTRAN_PANE_ID;
        const secret = process.env.VOLTRAN_HOOK_SECRET;
        const url = process.env.VOLTRAN_URL;
        if (!paneId || !secret || !url) {
            return undefined;
        }

        // Reports go out one at a time so the daemon sees them in order; a report must never slow
        // down or break OpenCode, so failures are dropped.
        let queue = Promise.resolve();
        const send = (report: Report): void => {
            queue = queue
                .then(() => fetch(`${url}/api/hooks/${encodeURIComponent(paneId)}/${report.event}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(report.payload),
                    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
                }))
                .then(() => undefined, () => undefined);
        };

        const reporter = new Reporter();
        const controller = new AbortController();
        send({ event: 'Ready', payload: {} });
        // OpenCode's event stream is volatile: it fails when a consumer falls behind or the connection
        // drops, so the plugin subscribes again until OpenCode unloads it.
        void (async () => {
            while (!controller.signal.aborted) {
                try {
                    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                        const report = reporter.report(event);
                        if (report) {
                            send(report);
                        }
                    }
                } catch {
                    // reported by the next subscription, or the plugin was unloaded
                }
                if (!controller.signal.aborted) {
                    await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_DELAY_MS));
                }
            }
        })();
        return () => controller.abort();
    },
};
