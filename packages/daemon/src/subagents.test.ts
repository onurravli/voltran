import { describe, expect, it } from 'vitest';
import { SubagentTracker } from './subagents.ts';

const agentCall = (toolUseId: string, description: string, background = false, type = 'general-purpose') => ({
    tool_name: 'Agent',
    tool_use_id: toolUseId,
    tool_input: { description, prompt: 'do it', subagent_type: type, run_in_background: background },
});

const agentResult = (toolUseId: string, agentId: string, status: string, description: string, background = false) => ({
    ...agentCall(toolUseId, description, background),
    tool_response: { status, agentId, agentType: 'general-purpose', description },
});

const descriptions = (tracker: SubagentTracker): string[] => tracker.list().map((agent) => `${agent.id}:${agent.description}`);

describe('SubagentTracker', () => {
    it('follows a foreground subagent from its Agent call to its stop', () => {
        const tracker = new SubagentTracker();
        expect(tracker.handle('PreToolUse', agentCall('t1', 'say hi'), 1)).toBe(false);
        expect(tracker.handle('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }, 2)).toBe(true);
        expect(tracker.list()).toEqual([{ id: 'a1', type: 'general-purpose', description: 'say hi', background: false, startedAt: 2 }]);

        expect(tracker.handle('SubagentStop', { agent_id: 'a1', last_assistant_message: 'hi' }, 3)).toBe(true);
        expect(tracker.handle('PostToolUse', agentResult('t1', 'a1', 'completed', 'say hi'), 4)).toBe(false);
        expect(tracker.list()).toEqual([]);
    });

    it('keeps a background subagent running past the turn until it stops', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PreToolUse', agentCall('t2', 'say bye', true), 1);
        tracker.handle('SubagentStart', { agent_id: 'a2', agent_type: 'general-purpose' }, 2);
        tracker.handle('PostToolUse', agentResult('t2', 'a2', 'async_launched', 'say bye', true), 2);
        tracker.handle('Stop', { background_tasks: [{ id: 'a2', type: 'subagent', status: 'running', description: 'say bye' }] }, 3);
        expect(tracker.list()).toMatchObject([{ id: 'a2', description: 'say bye', background: true }]);

        expect(tracker.handle('SubagentStop', { agent_id: 'a2' }, 9)).toBe(true);
        expect(tracker.handle('Stop', { background_tasks: [] }, 10)).toBe(false);
        expect(tracker.list()).toEqual([]);
    });

    it('does not let a start reported after its launch consume another queued call', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PreToolUse', agentCall('t1', 'first', true), 1);
        tracker.handle('PreToolUse', agentCall('t2', 'second', true), 1);
        tracker.handle('PostToolUse', agentResult('t1', 'a1', 'async_launched', 'first', true), 2);
        tracker.handle('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }, 2);
        tracker.handle('SubagentStart', { agent_id: 'a2', agent_type: 'general-purpose' }, 3);
        expect(descriptions(tracker)).toEqual(['a1:first', 'a2:second']);
    });

    it('corrects a guessed pairing once the launch links the call to the agent', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PreToolUse', agentCall('t1', 'first', true), 1);
        tracker.handle('PreToolUse', agentCall('t2', 'second', true), 1);
        tracker.handle('SubagentStart', { agent_id: 'a2', agent_type: 'general-purpose' }, 2);
        tracker.handle('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }, 3);
        expect(descriptions(tracker)).toEqual(['a2:first', 'a1:second']);

        tracker.handle('PostToolUse', agentResult('t1', 'a1', 'async_launched', 'first', true), 4);
        tracker.handle('PostToolUse', agentResult('t2', 'a2', 'async_launched', 'second', true), 4);
        expect(descriptions(tracker)).toEqual(['a2:second', 'a1:first']);
    });

    it('pairs a start with a queued call of the same agent type', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PreToolUse', agentCall('t1', 'look around', false, 'Explore'), 1);
        tracker.handle('PreToolUse', agentCall('t2', 'write the plan', false, 'Plan'), 1);
        tracker.handle('SubagentStart', { agent_id: 'p', agent_type: 'Plan' }, 2);
        tracker.handle('SubagentStart', { agent_id: 'e', agent_type: 'Explore' }, 2);
        expect(descriptions(tracker)).toEqual(['p:write the plan', 'e:look around']);
    });

    it('treats the Stop list as the truth about background agents', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PreToolUse', agentCall('t1', 'foreground'), 1);
        tracker.handle('SubagentStart', { agent_id: 'f', agent_type: 'general-purpose' }, 1);
        tracker.handle('PostToolUse', agentResult('t2', 'b', 'async_launched', 'background', true), 1);
        tracker.handle('Stop', { background_tasks: [
            { id: 'b', type: 'subagent', status: 'running', description: 'background' },
            { id: 'x', type: 'subagent', status: 'running', description: 'started elsewhere' },
            { id: 's', type: 'shell', status: 'running', description: 'npm run dev' },
            { id: 'old', type: 'subagent', status: 'completed', description: 'done already' },
        ] }, 5);
        expect(descriptions(tracker)).toEqual(['b:background', 'x:started elsewhere']);

        tracker.handle('Stop', { background_tasks: [] }, 6);
        expect(tracker.list()).toEqual([]);
    });

    it('keeps background agents when a Stop carries no task list at all', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PostToolUse', agentResult('t1', 'b', 'async_launched', 'background', true), 1);
        tracker.handle('Stop', {}, 2);
        expect(descriptions(tracker)).toEqual(['b:background']);
    });

    it('falls back to the agent type and forgets stale calls at a new prompt', () => {
        const tracker = new SubagentTracker();
        tracker.handle('PreToolUse', agentCall('t1', 'denied call'), 1);
        tracker.handle('UserPromptSubmit', { prompt: 'try again' }, 2);
        tracker.handle('SubagentStart', { agent_id: 'a', agent_type: 'general-purpose' }, 3);
        expect(descriptions(tracker)).toEqual(['a:general-purpose']);
    });

    it('ignores other tools and malformed payloads, and stays bounded', () => {
        const tracker = new SubagentTracker();
        expect(tracker.handle('PreToolUse', { tool_name: 'Bash', tool_input: { description: 'ls' } }, 1)).toBe(false);
        expect(tracker.handle('PreToolUse', { tool_name: 'Agent', tool_input: 'nonsense' }, 1)).toBe(false);
        expect(tracker.handle('SubagentStart', { agent_id: 42 }, 1)).toBe(false);
        expect(tracker.handle('PostToolUse', { tool_name: 'Agent', tool_response: ['x'] }, 1)).toBe(false);
        expect(tracker.handle('Stop', { background_tasks: 'all of them' }, 1)).toBe(false);
        for (let i = 0; i < 100; i++) {
            tracker.handle('SubagentStart', { agent_id: `a${i}`, agent_type: 'general-purpose' }, i);
        }
        expect(tracker.list()).toHaveLength(64);
    });

    it('prefers the description Claude stores for the agent and remembers its transcript', () => {
        const tracker = new SubagentTracker((_payload, agentId) => ({ transcriptPath: `/t/agent-${agentId}.jsonl`, description: `stored ${agentId}`, type: 'Explore' }));
        tracker.handle('PreToolUse', agentCall('t1', 'guessed', false, 'Explore'), 1);
        tracker.handle('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, 2);
        expect(descriptions(tracker)).toEqual(['a1:stored a1']);
        expect(tracker.transcript('a1', 3)).toEqual({ path: '/t/agent-a1.jsonl', description: 'stored a1', finished: false });
        expect(tracker.transcript('unknown', 3)).toBeNull();
    });

    it('keeps a finished agent\'s transcript reachable for ten minutes', () => {
        const tracker = new SubagentTracker((_payload, agentId) => ({ transcriptPath: `/t/agent-${agentId}.jsonl`, description: null, type: null }));
        tracker.handle('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }, 0);
        tracker.handle('SubagentStop', { agent_id: 'a1' }, 1000);
        expect(tracker.list()).toEqual([]);
        expect(tracker.transcript('a1', 1000 + 9 * 60_000)).toEqual({ path: '/t/agent-a1.jsonl', description: 'general-purpose', finished: true });
        expect(tracker.transcript('a1', 1000 + 11 * 60_000)).toBeNull();
    });

    it('starts empty again when the Claude session starts or ends', () => {
        const tracker = new SubagentTracker();
        tracker.handle('SubagentStart', { agent_id: 'a', agent_type: 'general-purpose' }, 1);
        expect(tracker.handle('SessionEnd', {}, 2)).toBe(true);
        tracker.handle('SubagentStart', { agent_id: 'b', agent_type: 'general-purpose' }, 3);
        expect(tracker.handle('SessionStart', { session_id: 'next' }, 4)).toBe(true);
        expect(tracker.list()).toEqual([]);
    });
});
