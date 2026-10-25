import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin, { Reporter } from './index.ts';

const event = (type: string, data: Record<string, unknown>) => ({ type, data });

describe('Reporter', () => {
    it('reports a turn of the main session, ending with its last text', () => {
        const reporter = new Reporter();
        const reports = [
            event('session.created', { sessionID: 'ses_main' }),
            event('session.inbox.enqueued', { sessionID: 'ses_main', item: { type: 'user', payload: { text: 'hi' } } }),
            event('session.execution.started', { sessionID: 'ses_main' }),
            event('session.text.delta', { sessionID: 'ses_main', delta: 'Hel' }),
            event('session.text.ended', { sessionID: 'ses_main', text: 'Hello' }),
            event('session.tool.input.started', { sessionID: 'ses_main', name: 'shell' }),
            event('session.tool.success', { sessionID: 'ses_main' }),
            event('session.text.ended', { sessionID: 'ses_main', text: 'Done.' }),
            event('session.execution.succeeded', { sessionID: 'ses_main' }),
        ].map((item) => reporter.report(item));
        expect(reports).toEqual([
            { event: 'SessionCreated', payload: { session_id: 'ses_main' } },
            { event: 'PromptSubmit', payload: { session_id: 'ses_main', prompt: 'hi' } },
            { event: 'TurnStart', payload: { session_id: 'ses_main' } },
            null,
            null,
            { event: 'ToolStart', payload: { session_id: 'ses_main', tool_name: 'shell' } },
            { event: 'ToolEnd', payload: { session_id: 'ses_main' } },
            null,
            { event: 'TurnEnd', payload: { session_id: 'ses_main', outcome: 'succeeded', message: 'Done.' } },
        ]);
    });

    it('reports only the permission prompts and questions of a subagent', () => {
        const reporter = new Reporter();
        expect(reporter.report(event('session.created', { sessionID: 'ses_child', parentID: 'ses_main' }))).toBeNull();
        expect(reporter.report(event('session.execution.started', { sessionID: 'ses_child' }))).toBeNull();
        expect(reporter.report(event('session.tool.input.started', { sessionID: 'ses_child', name: 'shell' }))).toBeNull();
        expect(
            reporter.report(event('permission.asked', { id: 'per_1', sessionID: 'ses_child', action: 'shell', resources: ['ls -A'] })),
        ).toEqual({ event: 'Permission', payload: { request_id: 'per_1', action: 'shell', resources: ['ls -A'] } });
        expect(reporter.report(event('permission.replied', { sessionID: 'ses_child', requestID: 'per_1', reply: 'once' }))).toEqual({
            event: 'PermissionReplied',
            payload: { request_id: 'per_1' },
        });
        expect(reporter.report(event('session.execution.succeeded', { sessionID: 'ses_child' }))).toBeNull();
    });

    it('reports questions, failures and interruptions', () => {
        const reporter = new Reporter();
        const form = {
            id: 'frm_1',
            sessionID: 'ses_main',
            title: 'Questions',
            fields: [{ key: 'q0', title: 'Pick a color', description: 'Red or blue?' }],
        };
        expect(reporter.report(event('form.created', { form }))).toEqual({
            event: 'Question',
            payload: { request_id: 'frm_1', message: 'Red or blue?' },
        });
        expect(reporter.report(event('form.replied', { id: 'frm_1', answer: { q0: 'Red' } }))).toEqual({
            event: 'QuestionAnswered',
            payload: { request_id: 'frm_1' },
        });
        expect(reporter.report(event('session.execution.failed', { sessionID: 'ses_main', error: { message: 'rate limited' } }))).toEqual({
            event: 'TurnEnd',
            payload: { session_id: 'ses_main', outcome: 'failed', message: 'rate limited' },
        });
        expect(reporter.report(event('session.execution.interrupted', { sessionID: 'ses_main', reason: 'user' }))).toEqual({
            event: 'TurnEnd',
            payload: { session_id: 'ses_main', outcome: 'interrupted', message: null },
        });
    });

    it('ignores synthetic messages and everything else', () => {
        const reporter = new Reporter();
        expect(
            reporter.report(
                event('session.inbox.enqueued', { sessionID: 'ses_main', item: { type: 'synthetic', payload: { text: 'x' } } }),
            ),
        ).toBeNull();
        expect(reporter.report(event('vcs.branch.updated', { branch: 'main' }))).toBeNull();
        expect(reporter.report({ type: 'model.updated' })).toBeNull();
    });
});

describe('plugin', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('subscribes again when the event stream fails, until OpenCode unloads it', async () => {
        vi.useFakeTimers();
        vi.stubEnv('VOLTRAN_PANE_ID', 'pane');
        vi.stubEnv('VOLTRAN_HOOK_SECRET', 'secret');
        vi.stubEnv('VOLTRAN_URL', 'http://127.0.0.1:1');
        const posted: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            posted.push(url.split('/').at(-1) ?? '');
            return new Response(null);
        });
        let subscriptions = 0;
        const subscribe = async function* (): AsyncGenerator<{ type: string; data?: unknown }> {
            subscriptions += 1;
            if (subscriptions === 1) {
                throw new Error('the consumer fell behind');
            }
            yield event('session.execution.started', { sessionID: 'ses_main' });
            await new Promise(() => undefined);
        };

        const stop = plugin.setup({ event: { subscribe } });
        await vi.advanceTimersByTimeAsync(1000);
        expect(subscriptions).toBe(2);
        await vi.waitFor(() => expect(posted).toEqual(['Ready', 'TurnStart']));

        stop?.();
        await vi.advanceTimersByTimeAsync(5000);
        expect(subscriptions).toBe(2);
    });
});
