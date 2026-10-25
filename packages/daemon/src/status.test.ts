import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityTracker, claudeTransition, codexTransition, OpencodeStatus, ringsBell, visibleText, type StatusChange } from './status.ts';

describe('codexTransition', () => {
    it('maps Codex hooks to statuses', () => {
        expect(codexTransition('SessionStart', {}, 'starting')).toEqual({ status: 'idle', detail: null });
        expect(codexTransition('SessionStart', {}, 'working')).toBeNull();
        expect(codexTransition('UserPromptSubmit', { prompt: 'bump\n  postgres' }, 'idle')).toEqual({
            status: 'working',
            detail: 'bump postgres',
        });
        expect(codexTransition('PostToolUse', { tool_name: 'apply_patch' }, 'working')).toEqual({
            status: 'working',
            detail: 'apply_patch',
        });
        expect(
            codexTransition('PermissionRequest', { tool_name: 'shell', tool_input: { description: 'Run terraform plan' } }, 'working'),
        ).toEqual({ status: 'needs-input', detail: 'Run terraform plan' });
        expect(codexTransition('PermissionRequest', { tool_name: 'shell', tool_input: {} }, 'working')).toEqual({
            status: 'needs-input',
            detail: 'Allow shell?',
        });
        expect(codexTransition('Stop', { last_assistant_message: 'Plan is clean.' }, 'working')).toEqual({
            status: 'done',
            detail: 'Plan is clean.',
        });
        expect(codexTransition('Interrupt', {}, 'working')).toEqual({ status: 'idle', detail: null });
    });
});

describe('claudeTransition', () => {
    it('maps the hook lifecycle to statuses', () => {
        expect(claudeTransition('SessionStart', {})).toEqual({ status: 'idle', detail: null });
        expect(claudeTransition('UserPromptSubmit', { prompt: 'fix   the\nbanner' })).toEqual({
            status: 'working',
            detail: 'fix the banner',
        });
        expect(claudeTransition('PreToolUse', { tool_name: 'Bash' })).toEqual({ status: 'working', detail: 'Bash' });
        expect(claudeTransition('Stop', { last_assistant_message: 'Done.' })).toEqual({ status: 'done', detail: 'Done.' });
        expect(claudeTransition('SessionEnd', {})).toBeNull();
    });

    it('treats permission and question notifications as needing input', () => {
        expect(
            claudeTransition('Notification', {
                notification_type: 'permission_prompt',
                message: 'Claude needs your permission to use Bash',
            }),
        ).toEqual({ status: 'needs-input', detail: 'Claude needs your permission to use Bash' });
        expect(claudeTransition('Notification', {})).toEqual({ status: 'needs-input', detail: 'Waiting for your input' });
    });

    it('ignores idle reminders and auth notices', () => {
        expect(claudeTransition('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting' })).toBeNull();
        expect(claudeTransition('Notification', { notification_type: 'auth_success' })).toBeNull();
    });

    it('drops escape sequences and other control characters from details', () => {
        expect(claudeTransition('Notification', { message: 'Allow\u001b]0;pwned\u0007 rm?\u009b2J' })?.detail).toBe('Allow]0;pwned rm?2J');
    });

    it('truncates long details', () => {
        const change = claudeTransition('Stop', { last_assistant_message: 'x'.repeat(500) });
        expect(change?.detail).toHaveLength(280);
        expect(change?.detail?.endsWith('…')).toBe(true);
    });
});

describe('OpencodeStatus', () => {
    it('maps a turn to statuses', () => {
        const status = new OpencodeStatus();
        expect(status.transition('Ready', {}, 'starting')).toEqual({ status: 'idle', detail: null });
        expect(status.transition('PromptSubmit', { prompt: 'fix   the\nbanner' }, 'idle')).toEqual({
            status: 'working',
            detail: 'fix the banner',
        });
        expect(status.transition('TurnStart', {}, 'working')).toBeNull();
        expect(status.transition('ToolStart', { tool_name: 'shell' }, 'working')).toEqual({ status: 'working', detail: 'shell' });
        expect(status.transition('ToolEnd', {}, 'working')).toBeNull();
        expect(status.transition('TurnEnd', { outcome: 'succeeded', message: 'Done.' }, 'working')).toEqual({
            status: 'done',
            detail: 'Done.',
        });
    });

    it('does not let a second plugin load reset a working pane', () => {
        expect(new OpencodeStatus().transition('Ready', {}, 'working')).toBeNull();
    });

    it('needs input until every permission prompt and question is answered', () => {
        const status = new OpencodeStatus();
        expect(status.transition('Permission', { request_id: 'per_1', action: 'shell', resources: ['echo hi'] }, 'working')).toEqual({
            status: 'needs-input',
            detail: 'Allow shell: echo hi',
        });
        expect(status.transition('Question', { request_id: 'frm_1', message: 'Red or blue?' }, 'needs-input')).toEqual({
            status: 'needs-input',
            detail: 'Red or blue?',
        });
        expect(status.transition('ToolStart', { tool_name: 'read' }, 'needs-input')).toBeNull();
        expect(status.transition('PermissionReplied', { request_id: 'per_1' }, 'needs-input')).toEqual({
            status: 'needs-input',
            detail: 'Red or blue?',
        });
        expect(status.transition('QuestionAnswered', { request_id: 'frm_1' }, 'needs-input')).toEqual({ status: 'working', detail: null });
        expect(status.transition('QuestionAnswered', { request_id: 'frm_1' }, 'working')).toBeNull();
    });

    it('keeps a bounded number of open prompts with ids of a sane length', () => {
        const status = new OpencodeStatus();
        status.transition('Permission', { request_id: 'x'.repeat(129), action: 'shell' }, 'working');
        expect(status.transition('PermissionReplied', { request_id: 'x'.repeat(129) }, 'needs-input')).toBeNull();
        for (let index = 0; index < 100; index++) {
            status.transition('Question', { request_id: `frm_${index}`, message: `Question ${index}` }, 'needs-input');
        }
        expect(status.transition('QuestionAnswered', { request_id: 'frm_0' }, 'needs-input')).toBeNull();
        expect(status.transition('QuestionAnswered', { request_id: 'frm_99' }, 'needs-input')).toEqual({
            status: 'needs-input',
            detail: 'Question 36',
        });
    });

    it('reports failures and treats an interruption as idle', () => {
        const status = new OpencodeStatus();
        status.transition('Permission', { request_id: 'per_1', action: 'edit' }, 'working');
        expect(status.transition('TurnEnd', { outcome: 'interrupted' }, 'needs-input')).toEqual({ status: 'idle', detail: null });
        expect(status.transition('PermissionReplied', { request_id: 'per_1' }, 'needs-input')).toBeNull();
        expect(status.transition('TurnEnd', { outcome: 'failed', message: 'rate limited' }, 'working')).toEqual({
            status: 'done',
            detail: 'Failed: rate limited',
        });
    });
});

describe('terminal text helpers', () => {
    it('strips escape sequences to find visible text', () => {
        expect(visibleText('\x1b[31mred\x1b[0m\x1b]0;title\x07')).toBe('red');
        expect(visibleText('\x1b[2J\x1b[H')).toBe('');
    });

    it('does not mistake an OSC terminator for a bell', () => {
        expect(ringsBell('\x1b]0;my title\x07')).toBe(false);
        expect(ringsBell('done\x07')).toBe(true);
    });
});

describe('ActivityTracker', () => {
    let changes: StatusChange[];
    let now: number;
    let tracker: ActivityTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        changes = [];
        now = 1_000_000;
        tracker = new ActivityTracker({ quietMs: 1000, echoWindowMs: 300, now: () => now, onChange: (change) => changes.push(change) });
    });

    afterEach(() => {
        tracker.dispose();
        vi.useRealTimers();
    });

    const advance = (ms: number): void => {
        now += ms;
        vi.advanceTimersByTime(ms);
    };

    it('settles a starting agent to idle without claiming it finished work', () => {
        tracker.reset('starting');
        tracker.output('Welcome to the agent');
        advance(1100);
        expect(changes).toEqual([{ status: 'idle', detail: null }]);
    });

    it('reports working while output streams and done once it goes quiet', () => {
        tracker.reset('idle');
        tracker.output('thinking…');
        advance(500);
        tracker.output('still thinking…');
        advance(900);
        expect(changes.map((change) => change.status)).toEqual(['working']);
        advance(200);
        expect(changes.map((change) => change.status)).toEqual(['working', 'done']);
    });

    it('ignores the echo of what the user just typed', () => {
        tracker.reset('idle');
        tracker.input();
        advance(50);
        tracker.output('h');
        advance(2000);
        expect(changes).toEqual([]);
    });

    it('ignores cursor-only redraws', () => {
        tracker.reset('idle');
        tracker.output('\x1b[?25l\x1b[3;1H\x1b[?25h');
        advance(2000);
        expect(changes).toEqual([]);
    });

    it('flags a bell as needing input', () => {
        tracker.reset('idle');
        tracker.output('Approve? \x07');
        expect(changes).toEqual([{ status: 'needs-input', detail: 'Bell: the agent is asking for attention' }]);
    });
});
