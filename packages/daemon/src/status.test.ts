import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityTracker, claudeTransition, ringsBell, visibleText, type StatusChange } from './status.ts';

describe('claudeTransition', () => {
    it('maps the hook lifecycle to statuses', () => {
        expect(claudeTransition('SessionStart', {})).toEqual({ status: 'idle', detail: null });
        expect(claudeTransition('UserPromptSubmit', { prompt: 'fix   the\nbanner' })).toEqual({ status: 'working', detail: 'fix the banner' });
        expect(claudeTransition('PreToolUse', { tool_name: 'Bash' })).toEqual({ status: 'working', detail: 'Bash' });
        expect(claudeTransition('Stop', { last_assistant_message: 'Done.' })).toEqual({ status: 'done', detail: 'Done.' });
        expect(claudeTransition('SessionEnd', {})).toBeNull();
    });

    it('treats permission and question notifications as needing input', () => {
        expect(claudeTransition('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
            .toEqual({ status: 'needs-input', detail: 'Claude needs your permission to use Bash' });
        expect(claudeTransition('Notification', {})).toEqual({ status: 'needs-input', detail: 'Waiting for your input' });
    });

    it('ignores idle reminders and auth notices', () => {
        expect(claudeTransition('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting' })).toBeNull();
        expect(claudeTransition('Notification', { notification_type: 'auth_success' })).toBeNull();
    });

    it('truncates long details', () => {
        const change = claudeTransition('Stop', { last_assistant_message: 'x'.repeat(500) });
        expect(change?.detail).toHaveLength(280);
        expect(change?.detail?.endsWith('…')).toBe(true);
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
