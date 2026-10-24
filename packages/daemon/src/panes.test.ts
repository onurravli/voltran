import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttentionStatus, Pane } from '@voltran/shared';
import { PaneManager, type PaneClient, type PaneManagerOptions } from './panes.ts';

interface Recorded {
    records: Pane[];
    attention: { status: AttentionStatus; body: string }[];
}

class FakeClient implements PaneClient {
    texts: string[] = [];
    output = '';
    stream: unknown[] = [];
    closed: { code: number; reason: string } | null = null;

    sendText(text: string): void {
        this.texts.push(text);
        this.stream.push(JSON.parse(text));
    }

    sendBinary(data: Buffer): void {
        this.output += data.toString('utf8');
        this.stream.push(data.toString('utf8'));
    }

    close(code: number, reason: string): void {
        this.closed = { code, reason };
    }

    snapshot(): string {
        const message = this.texts.map((text) => JSON.parse(text)).find((entry) => entry.type === 'snapshot');
        return message ? message.data : '';
    }
}

type Internals = {
    runtimes: Map<string, { hookSecret: string | null }>;
    write(runtime: unknown, data: string): void;
};

type Mirror = {
    term: {
        write(data: string, done: () => void): void;
        buffer: { active: { getLine(y: number): { translateToString(trim: boolean): string } | undefined } };
    };
};

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()?.();
    }
});

function setup(dir = mkdtempSync(join(tmpdir(), 'voltran-panes-')), overrides: Partial<PaneManagerOptions> = {}) {
    const recorded: Recorded = { records: [], attention: [] };
    const manager = new PaneManager({
        scrollbackDir: dir,
        hooksDir: join(dir, 'hooks'),
        url: 'http://127.0.0.1:1',
        shell: '/bin/sh',
        path: process.env.PATH ?? '/usr/bin:/bin',
        baseEnv: process.env,
        onChange: () => undefined,
        onPaneRecord: (pane) => recorded.records.push(pane),
        onAttention: (_pane, status, body) => recorded.attention.push({ status, body }),
        heuristicQuietMs: 200,
        ...overrides,
    });
    cleanups.push(() => manager.shutdown());
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return { manager, dir, recorded };
}

function makePane(overrides: Partial<Pane> = {}): Pane {
    return {
        id: randomUUID(),
        sessionId: 'session',
        adapter: 'command',
        title: 'test',
        command: 'printf hello',
        cwd: tmpdir(),
        agentSessionId: null,
        agentResumable: false,
        ended: false,
        createdAt: Date.now(),
        ...overrides,
    };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('condition not met in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const view = (manager: PaneManager, id: string) => manager.views().find((entry) => entry.id === id)!;

describe('PaneManager', () => {
    it('keeps a pane asleep until a client sizes it, then runs it to exit', async () => {
        const { manager, recorded } = setup();
        const pane = makePane({ command: 'printf hello-voltran; exit 3' });
        manager.add(pane);
        expect(view(manager, pane.id).status).toBe('suspended');

        const client = new FakeClient();
        manager.attach(pane.id, client);
        manager.resize(pane.id, 80, 24);

        await until(() => view(manager, pane.id).status === 'exited');
        expect(view(manager, pane.id).exitCode).toBe(3);
        expect(client.snapshot() + client.output).toContain('hello-voltran');
        expect(client.texts.map((text) => JSON.parse(text).type)).toContain('exit');
        expect(recorded.attention).toEqual([{ status: 'exited', body: 'Command exited with code 3' }]);
        expect(recorded.records.at(-1)?.ended).toBe(true);
    });

    it('sends a snapshot plus queued output without losing or repeating bytes', async () => {
        const { manager } = setup();
        const pane = makePane();
        manager.add(pane);
        const internals = manager as unknown as Internals;
        const runtime = internals.runtimes.get(pane.id);

        internals.write(runtime, 'first line\r\n');
        const client = new FakeClient();
        manager.attach(pane.id, client);
        internals.write(runtime, 'second line\r\n');

        await until(() => client.texts.length > 0);
        expect(client.snapshot()).toContain('first line');
        expect(client.snapshot()).not.toContain('second line');
        expect(client.output).toBe('second line\r\n');
    });

    it('puts each resize into the output stream, after the output that came before it', async () => {
        const { manager } = setup();
        const pane = makePane({ ended: true });
        manager.add(pane);
        const internals = manager as unknown as Internals;
        const runtime = internals.runtimes.get(pane.id) as unknown as Mirror;
        const client = new FakeClient();
        manager.attach(pane.id, client);
        await until(() => client.texts.length > 0);
        expect(client.stream[0]).toMatchObject({ type: 'snapshot', cols: 120, rows: 32 });

        internals.write(runtime, '\x1b[1;100H*\r\n');
        manager.resize(pane.id, 40, 10);
        internals.write(runtime, 'after');
        manager.resize(pane.id, 40, 10);

        expect(client.stream.slice(1)).toEqual(['\x1b[1;100H*\r\n', { type: 'resize', cols: 40, rows: 10 }, 'after']);
        const lines = await new Promise<string[]>((resolve) => {
            runtime.term.write('', () => resolve([0, 1, 2, 3].map((y) => runtime.term.buffer.active.getLine(y)?.translateToString(true) ?? '')));
        });
        expect(lines).toEqual(['', '', `${' '.repeat(19)}*`, 'after']);
    });

    it('sizes a snapshot to its content and queues a resize that comes before the snapshot is sent', async () => {
        const { manager } = setup();
        const pane = makePane({ ended: true });
        manager.add(pane);
        manager.resize(pane.id, 50, 12);

        const client = new FakeClient();
        manager.attach(pane.id, client);
        manager.resize(pane.id, 60, 14);
        await until(() => client.stream.length >= 2);

        expect(client.stream).toEqual([
            expect.objectContaining({ type: 'snapshot', cols: 50, rows: 12 }),
            { type: 'resize', cols: 60, rows: 14 },
        ]);
    });

    it('accepts hook reports only with the secret of the current process', () => {
        const { manager, recorded } = setup();
        const pane = makePane({ adapter: 'claude', command: null, agentSessionId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b' });
        manager.add(pane);
        const internals = manager as unknown as Internals;
        internals.runtimes.get(pane.id)!.hookSecret = 'per-spawn-secret';

        expect(manager.hook(pane.id, 'wrong-secret!!!!', 'Stop', {})).toBe(false);

        expect(manager.hook(pane.id, 'per-spawn-secret', 'SessionStart', { session_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })).toBe(true);
        expect(recorded.records.at(-1)).toMatchObject({ agentSessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', agentResumable: false });
        manager.hook(pane.id, 'per-spawn-secret', 'SessionStart', { session_id: '--dangerously-skip-permissions' });
        expect(recorded.records.at(-1)).toMatchObject({ agentSessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });

        manager.hook(pane.id, 'per-spawn-secret', 'UserPromptSubmit', { prompt: 'fix it' });
        expect(view(manager, pane.id)).toMatchObject({ status: 'working', detail: 'fix it', agentResumable: true });

        manager.hook(pane.id, 'per-spawn-secret', 'Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' });
        expect(view(manager, pane.id)).toMatchObject({ status: 'needs-input', detail: 'Allow Bash?' });

        manager.hook(pane.id, 'per-spawn-secret', 'Stop', { last_assistant_message: 'Fixed.' });
        expect(view(manager, pane.id)).toMatchObject({ status: 'done', detail: 'Fixed.' });
        expect(recorded.attention.map((entry) => entry.status)).toEqual(['needs-input', 'done']);

        manager.markSeen(pane.id);
        expect(view(manager, pane.id).status).toBe('idle');
    });

    it('lists the running subagents a Claude pane reports through its hooks', () => {
        const { manager } = setup();
        const pane = makePane({ adapter: 'claude', command: null });
        manager.add(pane);
        const internals = manager as unknown as Internals;
        internals.runtimes.get(pane.id)!.hookSecret = 'per-spawn-secret';

        manager.hook(pane.id, 'per-spawn-secret', 'PreToolUse', {
            tool_name: 'Agent',
            tool_use_id: 't1',
            tool_input: { description: 'review the diff', subagent_type: 'general-purpose', run_in_background: true },
        });
        expect(manager.hook(pane.id, 'per-spawn-secret', 'SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' })).toBe(true);
        expect(view(manager, pane.id).subagents).toMatchObject([{ id: 'a1', description: 'review the diff', background: true }]);

        expect(manager.hook(pane.id, 'wrong-secret!!!!', 'SubagentStop', { agent_id: 'a1' })).toBe(false);
        expect(view(manager, pane.id).subagents).toHaveLength(1);

        manager.hook(pane.id, 'per-spawn-secret', 'SubagentStop', { agent_id: 'a1' });
        expect(view(manager, pane.id).subagents).toEqual([]);
    });

    it('runs a subagent pane that follows the transcript and marks the end when the subagent stops', async () => {
        const { manager, dir } = setup();
        const sessionId = '4b09873e-72c8-471c-bbb2-f748e22f70d8';
        const parentTranscript = join(dir, 'projects', `${sessionId}.jsonl`);
        const subagents = join(dir, 'projects', sessionId, 'subagents');
        mkdirSync(subagents, { recursive: true });
        const transcript = join(subagents, 'agent-a1.jsonl');
        writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'Find the Jokers.' } })}\n`);

        const claude = makePane({ adapter: 'claude', command: null });
        manager.add(claude);
        (manager as unknown as Internals).runtimes.get(claude.id)!.hookSecret = 'per-spawn-secret';
        manager.hook(claude.id, 'per-spawn-secret', 'SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose', transcript_path: parentTranscript, session_id: sessionId });
        expect(manager.subagent(claude.id, 'a1')).toMatchObject({ path: transcript, finished: false });

        const viewer = makePane({ adapter: 'subagent', command: transcript });
        manager.add(viewer);
        const client = new FakeClient();
        manager.attach(viewer.id, client);
        manager.resize(viewer.id, 80, 24);
        await until(() => client.output.includes('Find the Jokers.'));

        appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'jokers cast' } }] } })}\n`);
        await until(() => client.output.includes('WebSearch'));

        manager.hook(claude.id, 'per-spawn-secret', 'SubagentStop', { agent_id: 'a1' });
        expect(view(manager, viewer.id)).toMatchObject({ status: 'running', detail: 'Subagent finished' });
        await until(() => client.output.includes('subagent finished'));
    });

    it('does not treat terminal focus reports as the user reading a finished pane', async () => {
        const { manager } = setup();
        const pane = makePane({ adapter: 'claude', command: null, agentSessionId: randomUUID() });
        manager.add(pane);
        const internals = manager as unknown as { runtimes: Map<string, { hookSecret: string | null; pty: unknown }> };
        const runtime = internals.runtimes.get(pane.id)!;
        const written: string[] = [];
        runtime.pty = { write: (data: string) => written.push(data) };
        runtime.hookSecret = 'per-spawn-secret';
        manager.hook(pane.id, 'per-spawn-secret', 'Stop', { last_assistant_message: 'All set.' });

        manager.input(pane.id, '\x1b[O');
        manager.input(pane.id, '\x1b[I');
        expect(view(manager, pane.id).status).toBe('done');
        expect(written).toEqual(['\x1b[O', '\x1b[I']);

        manager.input(pane.id, 'y');
        expect(view(manager, pane.id).status).toBe('idle');
        runtime.pty = null;
    });

    it('ignores the exit of a process replaced by a restart', async () => {
        const { manager } = setup();
        const pane = makePane({ command: 'sleep 5' });
        manager.add(pane);
        manager.attach(pane.id, new FakeClient());
        manager.resize(pane.id, 80, 24);
        await until(() => view(manager, pane.id).pid !== null);
        const firstPid = view(manager, pane.id).pid;

        manager.restart(pane.id);
        await until(() => view(manager, pane.id).pid !== null && view(manager, pane.id).pid !== firstPid);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(view(manager, pane.id).status).toBe('running');
    });

    it('persists scrollback on shutdown and restores it on the next start', async () => {
        const first = setup();
        const pane = makePane({ command: 'printf persisted-output' });
        first.manager.add(pane);
        first.manager.attach(pane.id, new FakeClient());
        first.manager.resize(pane.id, 80, 24);
        await until(() => view(first.manager, pane.id).status === 'exited');
        await first.manager.shutdown();

        const second = setup(first.dir);
        second.manager.load({ ...pane, ended: true });
        const client = new FakeClient();
        second.manager.attach(pane.id, client);
        await until(() => client.texts.length > 0);
        expect(client.snapshot()).toContain('persisted-output');
        expect(client.snapshot()).toContain('restored');
        expect(view(second.manager, pane.id).status).toBe('exited');
    });

    it('saves output that arrived just before shutdown', async () => {
        const first = setup();
        const pane = makePane({ ended: true });
        first.manager.add(pane);
        const internals = first.manager as unknown as Internals;
        internals.write(internals.runtimes.get(pane.id), 'last words before shutdown');
        await first.manager.shutdown();

        const second = setup(first.dir);
        second.manager.load(pane);
        const client = new FakeClient();
        second.manager.attach(pane.id, client);
        await until(() => client.texts.length > 0);
        expect(client.snapshot()).toContain('last words before shutdown');
    });

    it('puts the restored notice after the restored output', async () => {
        const first = setup();
        const pane = makePane({ ended: true });
        first.manager.add(pane);
        const internals = first.manager as unknown as Internals;
        internals.write(internals.runtimes.get(pane.id), 'first line\r\nsecond line\r\nthird line\r\n$ ');
        await first.manager.shutdown();

        const second = setup(first.dir);
        second.manager.load(pane);
        const client = new FakeClient();
        second.manager.attach(pane.id, client);
        await until(() => client.texts.length > 0);
        const lines = client.snapshot().replace(/\x1b\[[0-9;]*m/g, '').split('\r\n');
        expect(lines.slice(0, 4)).toEqual(['first line', 'second line', 'third line', '$ ']);
        expect(lines[4]).toContain('restored');
    });

    it('reports a pane that cannot start instead of throwing', () => {
        const { manager } = setup();
        const pane = makePane({ cwd: '/definitely/not/here' });
        manager.add(pane);
        manager.resize(pane.id, 80, 24);
        expect(view(manager, pane.id)).toMatchObject({ status: 'exited', detail: 'working directory not found: /definitely/not/here' });
    });

    it('marks a hooks agent stuck at a pre-hook prompt as needing input', async () => {
        const { manager } = setup(undefined, { startupPromptMs: 150 });
        const pane = makePane({ adapter: 'claude', command: null, agentSessionId: randomUUID() });
        manager.add(pane);
        const internals = manager as unknown as { maintain(): void; runtimes: Map<string, { pty: unknown; lastOutputAt: number; state: { status: string; statusAt: number } }> };
        const runtime = internals.runtimes.get(pane.id)!;
        runtime.pty = { process: 'claude' };
        runtime.state.status = 'starting';
        runtime.state.statusAt = Date.now() - 1000;
        runtime.lastOutputAt = Date.now() - 1000;
        internals.maintain();
        expect(view(manager, pane.id)).toMatchObject({ status: 'needs-input', detail: 'Waiting at a startup prompt' });
        runtime.pty = null;
    });
});
