import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as nodePty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { AttentionStatus, Pane, PaneRuntimeState, PaneServerMessage, PaneStatus } from '@voltran/shared';
import { adapterFor, childEnv, isClaudeHookEvent, isOpencodeEvent, resolveBinary, type ClaudeHookEvent, type OpencodeEvent } from './adapters.ts';
import { safeEqual } from './security.ts';
import { ActivityTracker, claudeTransition, OpencodeStatus, type StatusChange } from './status.ts';
import { SubagentTracker, type SubagentLocation, type SubagentTranscript } from './subagents.ts';
import { readSubagentMeta, subagentTranscriptPath } from './transcripts.ts';

export interface PaneClient {
    sendText(text: string): void;
    sendBinary(data: Buffer): void;
    close(code: number, reason: string): void;
}

interface Attachment {
    client: PaneClient;
    live: boolean;
    queue: (string | PaneServerMessage)[];
}

interface Runtime {
    pane: Pane;
    term: headless.Terminal;
    serializer: serialize.SerializeAddon;
    pty: nodePty.IPty | null;
    generation: number;
    hookSecret: string | null;
    state: PaneRuntimeState;
    attachments: Set<Attachment>;
    tracker: ActivityTracker | null;
    opencode: OpencodeStatus | null;
    subagents: SubagentTracker;
    cols: number;
    rows: number;
    lastOutputAt: number;
    dirty: boolean;
    killTimer: ReturnType<typeof setTimeout> | null;
}

export interface PaneManagerOptions {
    scrollbackDir: string;
    claudeSettingsFile: string;
    url: string;
    shell: string;
    path: string;
    baseEnv: NodeJS.ProcessEnv;
    onChange: () => void;
    onPaneRecord: (pane: Pane) => void;
    onAttention: (pane: Pane, status: AttentionStatus, body: string) => void;
    onExit?: (pane: Pane, exitCode: number) => void;
    notes?: { guide: string; file: (pane: Pane) => string | null };
    heuristicQuietMs?: number;
    hooksSilenceMs?: number;
    startupPromptMs?: number;
}

const SCROLLBACK_LINES = 5000;
const PERSIST_LINES = 2000;
const PERSIST_INTERVAL_MS = 20_000;
const MAINTENANCE_INTERVAL_MS = 2000;
const KILL_GRACE_MS = 3000;
const VIEWER_SIGNAL_DELAY_MS = 750;
const SHUTDOWN_FLUSH_MS = 1000;
const ECHO_WINDOW_MS = 400;

const RESET_MODES = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m';

const notice = (text: string, tone: 'dim' | 'error' = 'dim'): string =>
    `\r\n${tone === 'error' ? '\x1b[31m' : '\x1b[2m'}── ${text} ──\x1b[0m\r\n`;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(value)));

export class PaneManager {
    private runtimes = new Map<string, Runtime>();
    private shuttingDown = false;
    private persistTimer: ReturnType<typeof setInterval>;
    private maintenanceTimer: ReturnType<typeof setInterval>;
    private readonly options: PaneManagerOptions;

    constructor(options: PaneManagerOptions) {
        this.options = options;
        this.persistTimer = setInterval(() => this.persistDirty(), PERSIST_INTERVAL_MS);
        this.maintenanceTimer = setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS);
    }

    load(pane: Pane): void {
        const runtime = this.createRuntime(pane);
        const file = this.scrollbackFile(pane.id);
        if (existsSync(file)) {
            runtime.term.write(readFileSync(file, 'utf8'));
            runtime.term.write(RESET_MODES + notice(`restored · ${new Date().toLocaleString()}`));
        }
    }

    add(pane: Pane): void {
        this.createRuntime(pane);
        this.options.onChange();
    }

    has(id: string): boolean {
        return this.runtimes.has(id);
    }

    views(): (Pane & PaneRuntimeState)[] {
        return [...this.runtimes.values()].map((runtime) => ({ ...runtime.pane, ...runtime.state }));
    }

    pane(id: string): Pane | null {
        return this.runtimes.get(id)?.pane ?? null;
    }

    updatePane(id: string, patch: Partial<Pane>): void {
        const runtime = this.runtimes.get(id);
        if (runtime) {
            runtime.pane = { ...runtime.pane, ...patch };
            this.options.onChange();
        }
    }

    attach(id: string, client: PaneClient): (() => void) | null {
        const runtime = this.runtimes.get(id);
        if (!runtime) {
            return null;
        }
        const attachment: Attachment = { client, live: false, queue: [] };
        runtime.attachments.add(attachment);

        // The empty write's callback runs once everything written before this point is parsed, and
        // before anything written after it, so the snapshot plus the queued chunks lose nothing.
        runtime.term.write('', () => {
            if (!runtime.attachments.has(attachment)) {
                return;
            }
            const snapshot = runtime.serializer.serialize({ scrollback: SCROLLBACK_LINES });
            this.sendMessage(client, { type: 'snapshot', data: snapshot, cols: runtime.term.cols, rows: runtime.term.rows });
            for (const entry of attachment.queue) {
                if (typeof entry === 'string') {
                    client.sendBinary(Buffer.from(entry, 'utf8'));
                } else {
                    this.sendMessage(client, entry);
                }
            }
            attachment.queue = [];
            attachment.live = true;
        });

        return () => {
            runtime.attachments.delete(attachment);
        };
    }

    input(id: string, data: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime?.pty) {
            return;
        }
        runtime.pty.write(data);
        if (!isUserInput(data)) {
            return;
        }
        runtime.tracker?.input();
        if (runtime.state.status === 'done') {
            this.setStatus(runtime, { status: 'idle', detail: runtime.state.detail });
        }
    }

    resize(id: string, cols: number, rows: number): void {
        const runtime = this.runtimes.get(id);
        if (!runtime || !Number.isFinite(cols) || !Number.isFinite(rows)) {
            return;
        }
        const nextCols = clamp(cols, 2, 1000);
        const nextRows = clamp(rows, 2, 500);
        if (nextCols !== runtime.cols || nextRows !== runtime.rows) {
            runtime.cols = nextCols;
            runtime.rows = nextRows;
            // Clients resize their terminals at this marker and the mirror after the output already
            // written, so every copy sees the same output at the same size as the process did.
            runtime.term.write('', () => runtime.term.resize(nextCols, nextRows));
            runtime.pty?.resize(nextCols, nextRows);
            this.broadcast(runtime, { type: 'resize', cols: nextCols, rows: nextRows });
        }
        if (!runtime.pty && !runtime.pane.ended) {
            this.spawn(runtime);
        }
    }

    restart(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime) {
            return;
        }
        this.stopProcess(runtime);
        this.updateRecord(runtime, { ended: false });
        this.write(runtime, notice('restarting'));
        this.spawn(runtime);
    }

    suspend(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime?.pty) {
            return;
        }
        this.stopProcess(runtime);
        runtime.tracker?.reset('suspended');
        this.write(runtime, RESET_MODES + notice('suspended'));
        this.setStatus(runtime, { status: 'suspended', detail: null });
    }

    kill(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime?.pty) {
            return;
        }
        const pty = runtime.pty;
        const generation = runtime.generation;
        pty.kill();
        runtime.killTimer = setTimeout(() => {
            runtime.killTimer = null;
            if (runtime.generation === generation && runtime.pty === pty) {
                pty.kill('SIGKILL');
            }
        }, KILL_GRACE_MS);
    }

    markSeen(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime) {
            return;
        }
        const heuristicPrompt = runtime.state.status === 'needs-input' && runtime.tracker !== null;
        if (runtime.state.status === 'done' || heuristicPrompt) {
            runtime.tracker?.reset('idle');
            this.setStatus(runtime, { status: 'idle', detail: runtime.state.detail });
        }
    }

    hook(id: string, secret: string, event: string, payload: Record<string, unknown>): boolean {
        const runtime = this.runtimes.get(id);
        if (!runtime?.hookSecret || !safeEqual(secret, runtime.hookSecret)) {
            return false;
        }
        if (runtime.pane.adapter === 'claude' && isClaudeHookEvent(event)) {
            this.claudeHook(runtime, event, payload);
            return true;
        }
        if (runtime.opencode && isOpencodeEvent(event)) {
            this.opencodeHook(runtime, runtime.opencode, event, payload);
            return true;
        }
        return false;
    }

    private claudeHook(runtime: Runtime, event: ClaudeHookEvent, payload: Record<string, unknown>): void {
        const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
        if (sessionId && sessionId !== runtime.pane.agentSessionId) {
            this.updateRecord(runtime, { agentSessionId: sessionId, agentResumable: false });
        }
        if (event === 'UserPromptSubmit' && !runtime.pane.agentResumable) {
            this.updateRecord(runtime, { agentResumable: true });
        }

        const before = runtime.subagents.runningTranscripts();
        const subagentsChanged = runtime.subagents.handle(event, payload, Date.now());
        if (subagentsChanged) {
            runtime.state.subagents = runtime.subagents.list();
            this.notifyViewers(runtime, before);
        }
        const change = claudeTransition(event, payload);
        if (change) {
            this.setStatus(runtime, change);
        }
        if (!change || subagentsChanged) {
            this.options.onChange();
        }
    }

    // The plugin reports subagents' sessions only for their prompts, so any other session it names is
    // one the user opened in the pane, which is the one to resume.
    private opencodeHook(runtime: Runtime, status: OpencodeStatus, event: OpencodeEvent, payload: Record<string, unknown>): void {
        const sessionId = typeof payload.session_id === 'string' && payload.session_id.startsWith('ses') ? payload.session_id : null;
        let recordChanged = false;
        if (sessionId && sessionId !== runtime.pane.agentSessionId) {
            this.updateRecord(runtime, { agentSessionId: sessionId, agentResumable: true });
            recordChanged = true;
        } else if (event === 'PromptSubmit' && !runtime.pane.agentResumable) {
            this.updateRecord(runtime, { agentResumable: true });
            recordChanged = true;
        }
        const change = status.transition(event, payload, runtime.state.status);
        if (change) {
            this.setStatus(runtime, change);
        } else if (recordChanged) {
            this.options.onChange();
        }
    }

    subagent(id: string, agentId: string): SubagentTranscript | null {
        return this.runtimes.get(id)?.subagents.transcript(agentId, Date.now()) ?? null;
    }

    remove(id: string): void {
        const runtime = this.runtimes.get(id);
        if (!runtime) {
            return;
        }
        this.stopProcess(runtime);
        runtime.tracker?.dispose();
        for (const attachment of runtime.attachments) {
            attachment.client.close(4404, 'pane removed');
        }
        runtime.attachments.clear();
        runtime.term.dispose();
        rmSync(this.scrollbackFile(id), { force: true });
        this.runtimes.delete(id);
        this.options.onChange();
    }

    // The headless terminal parses writes asynchronously, so scrollback is saved only once each one has
    // caught up with the output it was given; otherwise the last output before a shutdown is lost.
    async shutdown(): Promise<void> {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        clearInterval(this.persistTimer);
        clearInterval(this.maintenanceTimer);
        const runtimes = [...this.runtimes.values()];
        for (const runtime of runtimes) {
            this.stopProcess(runtime);
            runtime.tracker?.dispose();
            for (const attachment of runtime.attachments) {
                attachment.client.close(1012, 'daemon restarting');
            }
        }
        await Promise.all(runtimes.map((runtime) => parsed(runtime.term, SHUTDOWN_FLUSH_MS)));
        for (const runtime of runtimes) {
            this.persist(runtime);
            runtime.term.dispose();
        }
    }

    private updateRecord(runtime: Runtime, patch: Partial<Pick<Pane, 'ended' | 'agentSessionId' | 'agentResumable'>>): void {
        runtime.pane = { ...runtime.pane, ...patch };
        this.options.onPaneRecord(runtime.pane);
    }

    private createRuntime(pane: Pane): Runtime {
        const term = new headless.Terminal({ cols: 120, rows: 32, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
        const serializer = new serialize.SerializeAddon();
        term.loadAddon(serializer);

        const runtime: Runtime = {
            pane,
            term,
            serializer,
            pty: null,
            generation: 0,
            hookSecret: null,
            state: {
                status: pane.ended ? 'exited' : 'suspended',
                statusAt: Date.now(),
                detail: null,
                exitCode: null,
                pid: null,
                foreground: null,
                subagents: [],
            },
            attachments: new Set(),
            tracker: null,
            opencode: pane.adapter === 'opencode' ? new OpencodeStatus() : null,
            subagents: new SubagentTracker(locateSubagent),
            cols: 120,
            rows: 32,
            lastOutputAt: 0,
            dirty: false,
            killTimer: null,
        };

        if (adapterFor(pane.adapter).statusSource === 'heuristic') {
            runtime.tracker = new ActivityTracker({
                quietMs: this.options.heuristicQuietMs ?? 5000,
                echoWindowMs: ECHO_WINDOW_MS,
                onChange: (change) => this.setStatus(runtime, change),
            });
        }

        this.runtimes.set(pane.id, runtime);
        return runtime;
    }

    private spawn(runtime: Runtime): void {
        const { pane } = runtime;
        const adapter = adapterFor(pane.adapter);
        const generation = ++runtime.generation;
        const secret = adapter.statusSource === 'hooks' ? randomBytes(24).toString('hex') : null;
        const subagentRunning = pane.adapter === 'subagent' && this.isFollowedTranscript(pane.command);
        const notesFile = this.options.notes?.file(pane) ?? null;
        const spec = adapter.launch({
            pane,
            shell: this.options.shell,
            claudeSettingsFile: this.options.claudeSettingsFile,
            subagentRunning,
            baseEnv: this.options.baseEnv,
            notesFile,
            notesGuide: this.options.notes?.guide ?? null,
        });
        const extraEnv: Record<string, string> = {
            ...spec.env,
            ...(notesFile ? { VOLTRAN_NOTES: notesFile } : {}),
            ...(secret ? { VOLTRAN_PANE_ID: pane.id, VOLTRAN_HOOK_SECRET: secret, VOLTRAN_URL: this.options.url } : {}),
        };
        runtime.opencode?.reset();

        let pty: nodePty.IPty;
        try {
            if (!existsSync(pane.cwd)) {
                throw new Error(`working directory not found: ${pane.cwd}`);
            }
            pty = nodePty.spawn(resolveBinary(spec.file, this.options.path), spec.args, {
                name: 'xterm-256color',
                cols: runtime.cols,
                rows: runtime.rows,
                cwd: pane.cwd,
                env: childEnv(this.options.baseEnv, this.options.path, extraEnv),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.write(runtime, notice(`could not start ${adapter.label}: ${message}`, 'error'));
            this.updateRecord(runtime, { ended: true });
            runtime.state.exitCode = null;
            runtime.state.pid = null;
            this.setStatus(runtime, { status: 'exited', detail: message });
            return;
        }

        runtime.pty = pty;
        runtime.hookSecret = secret;
        runtime.lastOutputAt = Date.now();
        runtime.state.pid = pty.pid;
        runtime.state.exitCode = null;
        runtime.state.foreground = null;
        runtime.tracker?.reset('starting');
        this.setStatus(runtime, {
            status: adapter.kind === 'agent' ? 'starting' : 'running',
            detail: pane.adapter === 'subagent' && !subagentRunning ? 'Subagent finished' : null,
        });

        pty.onData((data) => {
            if (generation !== runtime.generation) {
                return;
            }
            runtime.lastOutputAt = Date.now();
            this.write(runtime, data);
            runtime.tracker?.output(data);
        });

        pty.onExit(({ exitCode }) => {
            if (this.shuttingDown || generation !== runtime.generation) {
                return;
            }
            this.clearKillTimer(runtime);
            runtime.pty = null;
            runtime.hookSecret = null;
            this.updateRecord(runtime, { ended: true });
            runtime.tracker?.reset('exited');
            runtime.opencode?.reset();
            runtime.state.exitCode = exitCode;
            runtime.state.pid = null;
            runtime.state.foreground = null;
            this.clearSubagents(runtime);
            this.write(runtime, notice(`exited with code ${exitCode}`, exitCode === 0 ? 'dim' : 'error'));
            for (const attachment of runtime.attachments) {
                this.sendMessage(attachment.client, { type: 'exit', code: exitCode });
            }
            this.setStatus(runtime, { status: 'exited', detail: exitCode === 0 ? null : `exit code ${exitCode}` });
            if (exitCode !== 0 && adapter.kind !== 'shell') {
                this.options.onAttention(runtime.pane, 'exited', `${adapter.label} exited with code ${exitCode}`);
            }
            this.options.onExit?.(runtime.pane, exitCode);
        });
    }

    private stopProcess(runtime: Runtime): void {
        runtime.generation += 1;
        runtime.hookSecret = null;
        this.clearKillTimer(runtime);
        if (runtime.pty) {
            try {
                runtime.pty.kill();
            } catch {
                // already gone
            }
            runtime.pty = null;
        }
        runtime.state.pid = null;
        runtime.opencode?.reset();
        this.clearSubagents(runtime);
    }

    private clearSubagents(runtime: Runtime): void {
        const before = runtime.subagents.runningTranscripts();
        if (runtime.subagents.clear()) {
            runtime.state.subagents = [];
            this.notifyViewers(runtime, before);
            this.options.onChange();
        }
    }

    private isFollowedTranscript(transcriptPath: string | null): boolean {
        return transcriptPath !== null && [...this.runtimes.values()].some((runtime) => runtime.subagents.isFollowing(transcriptPath));
    }

    // Tells the panes viewing a subagent that stopped to read the rest of its transcript and mark it
    // finished. The delay lets the viewer finish starting up and Claude flush the last lines.
    private notifyViewers(parent: Runtime, before: Map<string, string>): void {
        const still = parent.subagents.runningTranscripts();
        for (const [agentId, transcriptPath] of before) {
            if (still.has(agentId)) {
                continue;
            }
            for (const viewer of this.runtimes.values()) {
                if (viewer.pane.adapter !== 'subagent' || viewer.pane.command !== transcriptPath || !viewer.pty) {
                    continue;
                }
                const pty = viewer.pty;
                setTimeout(() => {
                    if (viewer.pty === pty) {
                        pty.kill('SIGUSR2');
                    }
                }, VIEWER_SIGNAL_DELAY_MS);
                this.setStatus(viewer, { status: viewer.state.status, detail: 'Subagent finished' });
            }
        }
    }

    private clearKillTimer(runtime: Runtime): void {
        if (runtime.killTimer) {
            clearTimeout(runtime.killTimer);
            runtime.killTimer = null;
        }
    }

    private write(runtime: Runtime, data: string): void {
        runtime.term.write(data);
        runtime.dirty = true;
        for (const attachment of runtime.attachments) {
            if (attachment.live) {
                attachment.client.sendBinary(Buffer.from(data, 'utf8'));
            } else {
                attachment.queue.push(data);
            }
        }
    }

    private broadcast(runtime: Runtime, message: PaneServerMessage): void {
        for (const attachment of runtime.attachments) {
            if (attachment.live) {
                this.sendMessage(attachment.client, message);
            } else {
                attachment.queue.push(message);
            }
        }
    }

    private sendMessage(client: PaneClient, message: PaneServerMessage): void {
        client.sendText(JSON.stringify(message));
    }

    private setStatus(runtime: Runtime, change: StatusChange): void {
        const previous = runtime.state.status;
        if (previous === change.status && runtime.state.detail === change.detail) {
            return;
        }
        runtime.state.status = change.status;
        runtime.state.detail = change.detail;
        if (previous !== change.status) {
            runtime.state.statusAt = Date.now();
        }
        this.options.onChange();
        if (previous !== change.status && isAttention(change.status)) {
            this.options.onAttention(runtime.pane, change.status, change.detail ?? '');
        }
    }

    private maintain(): void {
        const now = Date.now();
        const silenceMs = this.options.hooksSilenceMs ?? 90_000;
        const startupPromptMs = this.options.startupPromptMs ?? 4000;
        let changed = false;
        for (const runtime of this.runtimes.values()) {
            if (!runtime.pty) {
                continue;
            }
            const adapter = adapterFor(runtime.pane.adapter);
            const quietFor = now - runtime.lastOutputAt;
            if (adapter.statusSource === 'hooks' && runtime.state.status === 'working' && quietFor > silenceMs) {
                this.setStatus(runtime, { status: 'idle', detail: 'No activity, possibly interrupted' });
            }
            // Prompts shown before the agent's first hook (folder trust, login, update notices) would
            // otherwise sit under "Starting" forever.
            if (adapter.statusSource === 'hooks' && runtime.state.status === 'starting'
                && quietFor > startupPromptMs && now - runtime.state.statusAt > startupPromptMs) {
                this.setStatus(runtime, { status: 'needs-input', detail: 'Waiting at a startup prompt' });
            }
            if (adapter.kind !== 'agent') {
                const foreground = foregroundOf(runtime.pty, this.options.shell);
                if (foreground !== runtime.state.foreground) {
                    runtime.state.foreground = foreground;
                    changed = true;
                }
            }
        }
        if (changed) {
            this.options.onChange();
        }
    }

    private persistDirty(): void {
        for (const runtime of this.runtimes.values()) {
            if (runtime.dirty) {
                this.persist(runtime);
            }
        }
    }

    private persist(runtime: Runtime): void {
        const file = this.scrollbackFile(runtime.pane.id);
        const temp = `${file}.tmp`;
        try {
            writeFileSync(temp, runtime.serializer.serialize({ scrollback: PERSIST_LINES }), { mode: 0o600 });
            renameSync(temp, file);
            runtime.dirty = false;
        } catch (error) {
            console.error(`[voltran] could not persist scrollback for pane ${runtime.pane.id}:`, error);
        }
    }

    private scrollbackFile(id: string): string {
        return join(this.options.scrollbackDir, `${id}.ans`);
    }
}

// Terminals emit focus reports (ESC [ I / ESC [ O) on their own when a pane gains or loses
// focus; they say nothing about the user having read the pane.
const FOCUS_REPORT = /\x1b\[[IO]/g;

function isUserInput(data: string): boolean {
    return data.replace(FOCUS_REPORT, '').length > 0;
}

function parsed(term: headless.Terminal, timeoutMs: number): Promise<void> {
    return new Promise((resolveParsed) => {
        const timer = setTimeout(resolveParsed, timeoutMs);
        term.write('', () => {
            clearTimeout(timer);
            resolveParsed();
        });
    });
}

function locateSubagent(payload: Record<string, unknown>, agentId: string): SubagentLocation | null {
    const transcriptPath = subagentTranscriptPath(payload.transcript_path, payload.session_id, agentId);
    if (!transcriptPath) {
        return null;
    }
    const meta = readSubagentMeta(transcriptPath);
    return { transcriptPath, description: meta?.description ?? null, type: meta?.type ?? null };
}

function isAttention(status: PaneStatus): status is 'needs-input' | 'done' {
    return status === 'needs-input' || status === 'done';
}

function foregroundOf(pty: nodePty.IPty, shell: string): string | null {
    let name: string;
    try {
        name = basename(pty.process || '');
    } catch {
        return null;
    }
    if (!name || name === basename(shell) || name === `-${basename(shell)}`) {
        return null;
    }
    return name;
}
