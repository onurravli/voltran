import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
    DEFAULT_SETTINGS,
    MAX_WORKSPACE_PANES,
    PROJECT_COLORS,
    insertPane,
    isValidLayout,
    paneIds,
    removePane,
    samePanes,
    type AdapterInfo,
    type AppState,
    type AttentionStatus,
    type CreatePaneBody,
    type CreateProjectBody,
    type CreateSessionBody,
    type CreateWorkspaceBody,
    type FileDiff,
    type Layout,
    type MovePaneBody,
    type NotesLockBody,
    type NotesMeta,
    type Pane,
    type PaneNotes,
    type PaneSpec,
    type Project,
    type SaveNotesBody,
    type ServerEvent,
    type Session,
    type SessionChanges,
    type UpdatePaneBody,
    type UpdateProjectBody,
    type UpdateSessionBody,
    type UpdateWorkspaceBody,
    type Usage,
    type Workspace,
    type ProjectGit,
    type PushPairingView,
    type PushState,
    type Settings,
    type WorktreeChoice,
} from '@voltran/shared';
import { adapterFor, claudeArgsProblem, isAdapterId, isClaudeHookEvent, isCodexHookEvent, isOpencodeEvent, opencodeArgsProblem, STATUS_LINE_EVENT, voltranSessionId } from './adapters.ts';
import { ChangesError, SessionChangesReader } from './changes.ts';
import { GitWatcher, commandRunner, type GitRunner } from './git.ts';
import { PENDING_TITLE, SessionNamer } from './naming.ts';
import { NotesRefused, NotesStore } from './notes.ts';
import { Pairing, type PairingOptions } from './pairing.ts';
import { PaneManager } from './panes.ts';
import { PushDevices, PushNotifier, type PushNotifierOptions } from './push.ts';
import { mergeUsage } from './statusline.ts';
import type { Store } from './store.ts';
import { WorktreeError, Worktrees, worktreeRunner, type WorktreeRunner } from './worktrees.ts';

export class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export interface HubOptions {
    store: Store;
    adapters: AdapterInfo[];
    scrollbackDir: string;
    notesDir: string;
    hooksDir: string;
    url: string;
    shell: string;
    path: string;
    baseEnv: NodeJS.ProcessEnv;
    gitRunner?: GitRunner;
    pullRequests?: () => boolean;
    worktreesDir: string;
    worktreeRunner?: WorktreeRunner;
    pushDir: string;
    pushSettings?: () => Settings['push'];
    pushIcon?: string;
    pushSender?: PushNotifierOptions['send'];
    pairingNetwork?: PairingOptions['network'];
    revealPairing?: PairingOptions['reveal'];
}

type Listener = (event: ServerEvent) => void;

const BROADCAST_DELAY_MS = 30;
const TITLE_RETRY_MS = 4000;
const MAX_TITLE = 200;
const MAX_COMMAND = 4000;
const NOTES_HOLDER = /^[A-Za-z0-9-]{8,64}$/;

const requireString = (value: unknown, field: string, max: number): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(400, `${field} is required`);
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new HttpError(400, `${field} must be at most ${max} characters`);
    }
    return trimmed;
};

const notesHolder = (value: unknown): string => {
    if (typeof value !== 'string' || !NOTES_HOLDER.test(value)) {
        throw new HttpError(400, 'holder must be 8 to 64 letters, digits or dashes');
    }
    return value;
};

const optionalLink = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value !== 'string') {
        throw new HttpError(400, 'link must be a string');
    }
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new HttpError(400, 'link must be a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new HttpError(400, 'link must be an http(s) URL');
    }
    return url.toString();
};

const moveTarget = (value: unknown, siblings: string[], sibling: string): string | null => {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string' || !siblings.includes(value)) {
        throw new HttpError(400, `moveBefore must be ${sibling}, or null for the end`);
    }
    return value;
};

function refusedAsHttp<T>(action: () => T): T {
    try {
        return action();
    } catch (error) {
        if (error instanceof NotesRefused) {
            throw new HttpError(error.status, error.message);
        }
        throw error;
    }
}

export class Hub {
    readonly panes: PaneManager;
    private readonly git: GitWatcher;
    private readonly changes: SessionChangesReader;
    private readonly notes: NotesStore;
    private readonly worktrees: Worktrees;
    private readonly pushDevices: PushDevices;
    private readonly push: PushNotifier;
    private readonly pairing: Pairing;
    private readonly store: Store;
    private readonly adapters: AdapterInfo[];
    private listeners = new Set<Listener>();
    private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly closeOnCleanExit = new Set<string>();
    private readonly namer = new SessionNamer();
    private readonly namingTimers = new Set<ReturnType<typeof setTimeout>>();
    private usage: Usage | null = null;

    constructor(options: HubOptions) {
        this.store = options.store;
        this.adapters = options.adapters;
        this.worktrees = new Worktrees(options.worktreesDir, options.worktreeRunner ?? worktreeRunner({ ...options.baseEnv, PATH: options.path }));
        this.pushDevices = new PushDevices(options.pushDir);
        this.push = new PushNotifier({
            devices: this.pushDevices,
            settings: options.pushSettings ?? (() => DEFAULT_SETTINGS.push),
            pending: (paneId, status) => this.panes.views().some((view) => view.id === paneId && view.status === status),
            onChange: () => this.scheduleBroadcast(),
            send: options.pushSender,
        });
        this.pairing = new Pairing({
            devices: this.pushDevices,
            folder: join(options.pushDir, 'pairing'),
            iconFile: options.pushIcon,
            onChange: () => this.scheduleBroadcast(),
            onPaired: (device) => {
                this.scheduleBroadcast();
                void this.push.test(device.id, 'Paired. This is how Voltran tells you an agent needs you.');
            },
            network: options.pairingNetwork,
            reveal: options.revealPairing,
        });
        this.notes = new NotesStore({
            dir: options.notesDir,
            onChange: (change) => this.emit({ type: 'notes', ...change }),
            onMeta: () => this.scheduleBroadcast(),
        });
        this.panes = new PaneManager({
            scrollbackDir: options.scrollbackDir,
            hooksDir: options.hooksDir,
            url: options.url,
            shell: options.shell,
            path: options.path,
            baseEnv: options.baseEnv,
            onChange: () => this.scheduleBroadcast(),
            onPaneRecord: (pane) => this.store.updatePane(pane.id, pane),
            onAttention: (pane, status, body) => this.attention(pane, status, body),
            onExit: (pane, exitCode) => this.exited(pane, exitCode),
            onUserInput: () => this.push.userInput(),
            notes: { guide: this.notes.guide, file: (pane) => (pane.adapter === 'subagent' ? null : this.notes.file(pane.id)) },
        });
        for (const pane of this.store.listPanes()) {
            this.panes.load(pane);
        }
        this.notes.load(this.store.listPanes().map((pane) => pane.id));
        this.notes.watch();
        this.pruneWorkspaces();
        const gitRunner = options.gitRunner ?? commandRunner({ ...options.baseEnv, PATH: options.path });
        this.git = new GitWatcher({
            folders: () => [...new Set(this.store.listSessions().filter((session) => !session.archived).map((session) => session.cwd))],
            onChange: () => this.scheduleBroadcast(),
            pullRequests: options.pullRequests ?? (() => false),
            run: gitRunner,
        });
        this.changes = new SessionChangesReader(gitRunner);
    }

    state(): AppState {
        return {
            projects: this.store.listProjects(),
            sessions: this.store.listSessions(),
            panes: this.panes.views().map((view) => ({ ...view, notes: this.notes.meta(view.id) })),
            workspaces: this.store.listWorkspaces(),
            git: this.git.snapshot(),
            adapters: this.adapters,
            usage: this.usage,
            push: this.pushState(),
        };
    }

    private pushState(): PushState {
        return { devices: this.pushDevices.views(), pairing: this.pairing.view(), canPair: process.platform === 'darwin' };
    }

    async startPairing(): Promise<PushPairingView> {
        if (process.platform !== 'darwin') {
            throw new HttpError(501, 'Pairing a phone needs macOS for now: the pairing profile goes to the phone by AirDrop.');
        }
        try {
            return await this.pairing.start();
        } catch (error) {
            throw new HttpError(503, error instanceof Error ? error.message : String(error));
        }
    }

    stopPairing(): void {
        this.pairing.stop();
    }

    removePushDevice(id: string): void {
        if (!this.pushDevices.remove(id)) {
            throw new HttpError(404, 'no such phone');
        }
        this.scheduleBroadcast();
    }

    async testPush(id?: string): Promise<PushState> {
        if (id !== undefined && !this.pushDevices.list().some((device) => device.id === id)) {
            throw new HttpError(404, 'no such phone');
        }
        if (this.pushDevices.list().length === 0) {
            throw new HttpError(409, 'No phone is paired. Pair one from the command palette: "Pair a phone for notifications".');
        }
        await this.push.test(id);
        return this.pushState();
    }

    openWindows(): number {
        return this.listeners.size;
    }

    publish(event: ServerEvent): void {
        this.emit(event);
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        this.git.start();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.git.pause();
            }
        };
    }

    shutdown(): Promise<void> {
        this.notes.close();
        this.push.close();
        this.pairing.stop();
        this.namingTimers.forEach(clearTimeout);
        this.namingTimers.clear();
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.listeners.clear();
        this.git.stop();
        return this.panes.shutdown();
    }

    createProject(body: CreateProjectBody): Project {
        const rawPath = requireString(body.path, 'path', 4096).replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
        if (!isAbsolute(rawPath)) {
            throw new HttpError(400, 'path must be absolute');
        }
        const path = resolve(rawPath);
        let isDirectory = false;
        try {
            isDirectory = statSync(path).isDirectory();
        } catch {
            throw new HttpError(400, `path does not exist: ${path}`);
        }
        if (!isDirectory) {
            throw new HttpError(400, `path is not a directory: ${path}`);
        }
        const existing = this.store.listProjects();
        if (existing.some((project) => project.path === path)) {
            throw new HttpError(409, `a project already points at ${path}`);
        }
        const project: Project = {
            id: randomUUID(),
            name: body.name ? requireString(body.name, 'name', MAX_TITLE) : basename(path) || path,
            path,
            color: typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)
                ? body.color
                : PROJECT_COLORS[existing.length % PROJECT_COLORS.length].value,
            createdAt: Date.now(),
        };
        this.store.insertProject(project);
        this.scheduleBroadcast();
        return project;
    }

    updateProject(id: string, body: UpdateProjectBody): Project {
        this.mustGetProject(id);
        const patch: Partial<Pick<Project, 'name' | 'color'>> = {};
        if (body.name !== undefined) {
            patch.name = requireString(body.name, 'name', MAX_TITLE);
        }
        if (body.color !== undefined) {
            if (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)) {
                throw new HttpError(400, 'color must be a #rrggbb hex value');
            }
            patch.color = body.color;
        }
        const before = body.moveBefore === undefined
            ? undefined
            : moveTarget(body.moveBefore, this.store.listProjects().map((project) => project.id), 'another project');
        this.store.updateProject(id, patch);
        if (before !== undefined) {
            this.store.moveProject(id, before);
        }
        this.scheduleBroadcast();
        return this.mustGetProject(id);
    }

    async projectGit(id: string): Promise<ProjectGit> {
        return this.worktrees.describe(this.mustGetProject(id).path);
    }

    // Worktrees with uncommitted or untracked files stay on disk: deleting a project never loses work.
    async deleteProject(id: string): Promise<void> {
        const project = this.mustGetProject(id);
        const sessions = this.store.sessionsOfProject(id);
        for (const session of sessions) {
            this.removeSessionPanes(session.id);
        }
        this.store.deleteProject(id);
        this.pruneWorkspaces();
        this.scheduleBroadcast();
        for (const session of sessions) {
            if (session.worktree && (await this.worktrees.changes(session.worktree).catch(() => 1)) === 0) {
                await this.worktrees.remove(project.path, session.worktree).catch(() => undefined);
            }
        }
    }

    async createSession(body: CreateSessionBody): Promise<Session> {
        const project = this.mustGetProject(body.projectId);
        const specs = Array.isArray(body.panes) && body.panes.length > 0 ? body.panes : [{ adapter: 'shell' as const }];
        if (specs.length > 8) {
            throw new HttpError(400, 'a session starts with at most 8 panes');
        }
        specs.forEach((spec) => this.validatePaneSpec(spec));
        const title = typeof body.title === 'string' && body.title.trim() ? requireString(body.title, 'title', MAX_TITLE) : null;
        if (title === null && !specs.some((spec) => adapterFor(spec.adapter).reportsHooks)) {
            throw new HttpError(400, 'a session needs a title unless it starts with Claude Code, Codex or OpenCode, which name it');
        }
        const link = optionalLink(body.link);
        const worktree = body.worktree === undefined ? null : await this.createWorktree(project, body.worktree);
        if (!this.store.getProject(project.id)) {
            if (worktree) {
                await this.worktrees.remove(project.path, worktree.root).catch(() => undefined);
            }
            throw new HttpError(404, 'project not found');
        }

        const now = Date.now();
        const session: Session = {
            id: randomUUID(),
            projectId: project.id,
            title: title ?? PENDING_TITLE,
            titleSource: title === null ? 'pending' : 'user',
            link,
            cwd: worktree?.cwd ?? project.path,
            worktree: worktree?.root ?? null,
            layout: null,
            archived: false,
            createdAt: now,
            updatedAt: now,
        };
        this.store.insertSession(session);

        let layout: Layout | null = null;
        let previous: string | undefined;
        specs.forEach((spec, index) => {
            const pane = this.insertPaneRecord(session, spec);
            layout = insertPane(layout, pane.id, previous, index <= 1 ? 'horizontal' : 'vertical');
            previous = pane.id;
        });
        this.store.updateSession(session.id, { layout });
        this.refreshGitSoon(session.cwd);
        this.scheduleBroadcast();
        return this.mustGetSession(session.id);
    }

    updateSession(id: string, body: UpdateSessionBody): Session {
        const session = this.mustGetSession(id);
        const patch: Partial<Pick<Session, 'title' | 'titleSource' | 'link' | 'archived' | 'layout'>> = {};
        if (body.title !== undefined) {
            patch.title = requireString(body.title, 'title', MAX_TITLE);
            patch.titleSource = 'user';
            this.namer.forget(id);
        }
        if (body.link !== undefined) {
            patch.link = optionalLink(body.link);
        }
        if (body.layout !== undefined) {
            if (body.layout !== null && !isValidLayout(body.layout)) {
                throw new HttpError(400, 'layout is malformed');
            }
            if (!samePanes(body.layout, session.layout)) {
                throw new HttpError(409, 'layout does not match the session panes');
            }
            patch.layout = body.layout;
        }
        const before = body.moveBefore === undefined
            ? undefined
            : moveTarget(body.moveBefore, this.store.sessionsOfProject(session.projectId).map((entry) => entry.id), 'a session of the same project');
        if (body.archived !== undefined) {
            patch.archived = Boolean(body.archived);
            if (patch.archived && !session.archived) {
                for (const pane of this.store.panesOfSession(id)) {
                    this.panes.suspend(pane.id);
                }
            }
        }
        this.store.updateSession(id, patch);
        if (before !== undefined) {
            this.store.moveSession(id, before);
        }
        this.scheduleBroadcast();
        return this.mustGetSession(id);
    }

    // A worktree with uncommitted or untracked files is only removed when the caller says so, after
    // the user has seen how many there are.
    async deleteSession(id: string, choice: WorktreeChoice | null = null): Promise<void> {
        const session = this.mustGetSession(id);
        const project = this.mustGetProject(session.projectId);
        let removeWorktree = session.worktree !== null && choice !== 'keep';
        if (session.worktree && choice === null) {
            const changes = await this.worktrees.changes(session.worktree).catch((error: unknown) => {
                throw new HttpError(409, `${error instanceof Error ? error.message : String(error)}; choose whether to keep the worktree`);
            });
            if (changes > 0) {
                throw new HttpError(409, `its worktree has ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}`);
            }
            removeWorktree = true;
        }
        if (!this.store.getSession(id)) {
            return;
        }
        this.removeSessionPanes(id);
        this.store.deleteSession(id);
        this.namer.forget(id);
        this.pruneWorkspaces();
        this.scheduleBroadcast();
        if (removeWorktree && session.worktree) {
            await this.worktrees.remove(project.path, session.worktree).catch((error: unknown) => {
                throw new HttpError(500, `The session is deleted, but its worktree at ${session.worktree} is not: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
    }

    createPane(sessionId: string, body: CreatePaneBody, options: { closeOnCleanExit?: boolean } = {}): Pane {
        const session = this.mustGetSession(sessionId);
        this.validatePaneSpec(body);
        const workspace = body.workspaceId === undefined ? null : this.mustGetWorkspace(requireString(body.workspaceId, 'workspaceId', 64));
        if (workspace && paneIds(workspace.layout).length >= MAX_WORKSPACE_PANES) {
            throw new HttpError(409, `a workspace holds at most ${MAX_WORKSPACE_PANES} panes`);
        }
        const direction = body.direction === 'vertical' ? 'vertical' : 'horizontal';
        const pane = this.insertPaneRecord(session, body);
        this.store.updateSession(session.id, { layout: insertPane(session.layout, pane.id, body.splitFrom, direction) });
        if (workspace) {
            this.store.updateWorkspace(workspace.id, { layout: insertPane(workspace.layout, pane.id, body.splitFrom, direction) });
        }
        if (options.closeOnCleanExit) {
            this.closeOnCleanExit.add(pane.id);
        }
        this.scheduleBroadcast();
        return pane;
    }

    updatePane(id: string, body: UpdatePaneBody): Pane {
        this.mustGetPane(id);
        if (body.title !== undefined) {
            const title = requireString(body.title, 'title', MAX_TITLE);
            this.store.updatePane(id, { title });
            this.panes.updatePane(id, { title });
        }
        return this.mustGetPane(id);
    }

    movePane(id: string, body: MovePaneBody): Pane {
        const pane = this.mustGetPane(id);
        const from = this.mustGetSession(pane.sessionId);
        const to = this.mustGetSession(requireString(body?.sessionId, 'sessionId', 64));
        if (to.id === from.id) {
            return pane;
        }
        if (to.projectId !== from.projectId) {
            throw new HttpError(400, 'a pane can only move to another session of the same project');
        }
        if (to.archived) {
            throw new HttpError(409, 'restore the session before moving panes into it');
        }
        this.store.updatePane(id, { sessionId: to.id });
        this.panes.updatePane(id, { sessionId: to.id });
        this.store.updateSession(from.id, { layout: removePane(from.layout, id) });
        this.store.updateSession(to.id, { layout: insertPane(to.layout, id) });
        this.scheduleBroadcast();
        return this.mustGetPane(id);
    }

    deletePane(id: string): void {
        const pane = this.mustGetPane(id);
        const session = this.store.getSession(pane.sessionId);
        this.closeOnCleanExit.delete(id);
        this.panes.remove(id);
        this.notes.remove(id);
        this.store.deletePane(id);
        if (session) {
            this.store.updateSession(session.id, { layout: removePane(session.layout, id) });
        }
        this.pruneWorkspaces();
        this.scheduleBroadcast();
    }

    createWorkspace(body: CreateWorkspaceBody): Workspace {
        const now = Date.now();
        const workspace: Workspace = {
            id: randomUUID(),
            title: requireString(body?.title, 'title', MAX_TITLE),
            layout: null,
            createdAt: now,
            updatedAt: now,
        };
        this.store.insertWorkspace(workspace);
        this.scheduleBroadcast();
        return workspace;
    }

    updateWorkspace(id: string, body: UpdateWorkspaceBody): Workspace {
        this.mustGetWorkspace(id);
        const patch: Partial<Pick<Workspace, 'title' | 'layout'>> = {};
        if (body.title !== undefined) {
            patch.title = requireString(body.title, 'title', MAX_TITLE);
        }
        if (body.layout !== undefined) {
            if (body.layout !== null) {
                this.validateWorkspaceLayout(body.layout);
            }
            patch.layout = body.layout;
        }
        this.store.updateWorkspace(id, patch);
        this.scheduleBroadcast();
        return this.mustGetWorkspace(id);
    }

    deleteWorkspace(id: string): void {
        this.mustGetWorkspace(id);
        this.store.deleteWorkspace(id);
        this.scheduleBroadcast();
    }

    restartPane(id: string): void {
        this.mustGetPane(id);
        this.panes.restart(id);
    }

    killPane(id: string): void {
        this.mustGetPane(id);
        this.panes.kill(id);
    }

    seenPane(id: string): void {
        this.mustGetPane(id);
        this.panes.markSeen(id);
    }

    viewSubagent(paneId: string, agentId: string): Pane {
        const parent = this.mustGetPane(paneId);
        const subagent = this.panes.subagent(paneId, agentId);
        if (!subagent) {
            throw new HttpError(404, 'This subagent is not running and finished too long ago to show.');
        }
        if (!subagent.path) {
            throw new HttpError(404, 'Claude did not report where this subagent writes its transcript.');
        }
        const existing = this.store.panesOfSession(parent.sessionId).find((pane) => pane.adapter === 'subagent' && pane.command === subagent.path);
        if (existing) {
            return existing;
        }
        const session = this.mustGetSession(parent.sessionId);
        const pane = this.insertPaneRecord(session, { adapter: 'subagent', title: subagent.description.slice(0, MAX_TITLE), command: subagent.path });
        this.store.updateSession(session.id, { layout: insertPane(session.layout, pane.id, paneId, 'horizontal') });
        this.scheduleBroadcast();
        return pane;
    }

    hook(paneId: string, event: string, secret: string, payload: unknown): boolean {
        if (event === STATUS_LINE_EVENT && payload && typeof payload === 'object') {
            return this.statusLine(paneId, secret, payload as Record<string, unknown>);
        }
        if (!(isClaudeHookEvent(event) || isOpencodeEvent(event) || isCodexHookEvent(event)) || !payload || typeof payload !== 'object') {
            return false;
        }
        const handled = this.panes.hook(paneId, secret, event, payload as Record<string, unknown>);
        if (handled) {
            this.trackNotesEdit(paneId, event, payload as Record<string, unknown>);
            this.nameSession(paneId, event, payload as Record<string, unknown>, true);
        }
        if (handled && (event === 'PostToolUse' || event === 'Stop' || event === 'ToolEnd' || event === 'TurnEnd')) {
            const session = this.store.getSession(this.store.getPane(paneId)?.sessionId ?? '');
            if (session) {
                this.refreshGitSoon(session.cwd);
            }
        }
        return handled;
    }

    // The notes hook asks the daemon for the notes instead of reading the file itself: the folder is
    // the agent's, and a shell cannot open a file without following a link planted there.
    hookNotes(paneId: string, secret: string): string | null {
        return this.panes.isClaudeReport(paneId, secret) ? this.notes.current(paneId) : null;
    }

    private statusLine(paneId: string, secret: string, payload: Record<string, unknown>): boolean {
        if (!this.panes.isClaudeReport(paneId, secret)) {
            return false;
        }
        const usage = mergeUsage(this.usage, payload);
        if (usage !== this.usage) {
            this.usage = usage;
            this.scheduleBroadcast();
        }
        return true;
    }

    // Claude can finish naming the conversation after a short first turn has already stopped, so a
    // Stop looks once more a little later.
    private nameSession(paneId: string, event: string, payload: Record<string, unknown>, retry: boolean): void {
        const pane = this.store.getPane(paneId);
        const session = pane ? this.store.getSession(pane.sessionId) : undefined;
        if (!pane || !session) {
            return;
        }
        const named = this.namer.name(session, pane, event, payload);
        if (named) {
            this.store.updateSession(session.id, named);
            this.scheduleBroadcast();
        }
        if (retry && event === 'Stop' && pane.adapter === 'claude' && (named?.titleSource ?? session.titleSource) === 'prompt') {
            const timer = setTimeout(() => {
                this.namingTimers.delete(timer);
                this.nameSession(paneId, event, payload, false);
            }, TITLE_RETRY_MS);
            this.namingTimers.add(timer);
        }
    }

    paneNotes(id: string): PaneNotes {
        this.mustGetPane(id);
        return this.notes.read(id);
    }

    lockNotes(id: string, body: NotesLockBody): NotesMeta {
        this.mustGetPane(id);
        const holder = notesHolder(body?.holder);
        if (body.version !== undefined && typeof body.version !== 'string') {
            throw new HttpError(400, 'version must be a string');
        }
        return refusedAsHttp(() => this.notes.lock(id, holder, body.version));
    }

    unlockNotes(id: string, body: NotesLockBody): void {
        this.mustGetPane(id);
        this.notes.unlock(id, notesHolder(body?.holder));
    }

    saveNotes(id: string, body: SaveNotesBody): PaneNotes {
        this.mustGetPane(id);
        const holder = notesHolder(body?.holder);
        if (typeof body.content !== 'string' || typeof body.version !== 'string') {
            throw new HttpError(400, 'content and version are required');
        }
        return refusedAsHttp(() => this.notes.save(id, holder, body.version, body.content));
    }

    // Claude names the file it is about to edit, so the drawer can wait instead of racing it. Other
    // agents give no notice; their writes show up through the notes watcher.
    private trackNotesEdit(paneId: string, event: string, payload: Record<string, unknown>): void {
        if (event === 'Stop' || event === 'SessionEnd') {
            this.notes.agentDone(paneId);
            return;
        }
        if (event !== 'PreToolUse' && event !== 'PostToolUse') {
            return;
        }
        const input = payload.tool_input;
        const file = input && typeof input === 'object' ? (input as Record<string, unknown>).file_path : undefined;
        if ((payload.tool_name !== 'Edit' && payload.tool_name !== 'Write') || !this.notes.isFile(paneId, file)) {
            return;
        }
        if (event === 'PreToolUse') {
            this.notes.agentEditing(paneId);
        } else {
            this.notes.agentDone(paneId);
        }
    }

    private refreshGitSoon(folder: string): void {
        if (this.listeners.size > 0) {
            this.git.refreshSoon(folder);
        }
    }

    private validatePaneSpec(spec: PaneSpec): void {
        if (!isAdapterId(spec.adapter)) {
            throw new HttpError(400, `unknown adapter "${String(spec.adapter)}"`);
        }
        if (spec.adapter === 'subagent') {
            throw new HttpError(400, 'subagent panes open from a subagent in the sidebar');
        }
        if (spec.adapter === 'command') {
            requireString(spec.command, 'command', MAX_COMMAND);
        }
        if ((spec.adapter === 'claude' || spec.adapter === 'opencode') && spec.command !== undefined) {
            const command = requireString(spec.command, 'command', MAX_COMMAND);
            const problem = spec.adapter === 'claude' ? claudeArgsProblem(command) : opencodeArgsProblem(command);
            if (problem) {
                throw new HttpError(400, problem);
            }
        }
        if (spec.title !== undefined) {
            requireString(spec.title, 'title', MAX_TITLE);
        }
    }

    private insertPaneRecord(session: Session, spec: PaneSpec): Pane {
        const adapter = adapterFor(spec.adapter);
        const takesArgs = spec.adapter === 'claude' || spec.adapter === 'opencode';
        const command = spec.adapter === 'command' || spec.adapter === 'subagent' || takesArgs ? spec.command?.trim() || null : null;
        const pane: Pane = {
            id: randomUUID(),
            sessionId: session.id,
            adapter: spec.adapter,
            title: spec.title?.trim() || (command && !takesArgs ? command.slice(0, 40) : adapter.label),
            command,
            cwd: session.cwd,
            agentSessionId: voltranSessionId(spec.adapter),
            agentResumable: false,
            ended: false,
            createdAt: Date.now(),
        };
        this.store.insertPane(pane);
        this.panes.add(pane);
        return pane;
    }

    private validateWorkspaceLayout(layout: unknown): void {
        if (!isValidLayout(layout)) {
            throw new HttpError(400, 'layout is malformed');
        }
        const ids = paneIds(layout);
        if (new Set(ids).size !== ids.length) {
            throw new HttpError(400, 'a pane can be in a workspace only once');
        }
        if (ids.length > MAX_WORKSPACE_PANES) {
            throw new HttpError(400, `a workspace holds at most ${MAX_WORKSPACE_PANES} panes`);
        }
        if (ids.some((paneId) => !this.store.getPane(paneId))) {
            throw new HttpError(409, 'layout names a pane that does not exist');
        }
    }

    // Workspaces only point at panes, so every path that deletes panes ends here.
    private pruneWorkspaces(): void {
        const existing = new Set(this.store.listPanes().map((pane) => pane.id));
        for (const workspace of this.store.listWorkspaces()) {
            const missing = paneIds(workspace.layout).filter((paneId) => !existing.has(paneId));
            if (missing.length > 0) {
                const layout = missing.reduce<Layout | null>((rest, paneId) => removePane(rest, paneId), workspace.layout);
                this.store.updateWorkspace(workspace.id, { layout });
            }
        }
    }

    private async createWorktree(project: Project, spec: NonNullable<CreateSessionBody['worktree']>): Promise<{ root: string; cwd: string }> {
        if (!spec || typeof spec !== 'object') {
            throw new HttpError(400, 'worktree must be an object with a branch');
        }
        const branch = requireString(spec.branch, 'branch', MAX_TITLE);
        const base = spec.base === undefined || spec.base === null || spec.base === '' ? undefined : requireString(spec.base, 'base', MAX_TITLE);
        try {
            return await this.worktrees.create(project.path, project.name, branch, base);
        } catch (error) {
            if (error instanceof WorktreeError) {
                throw new HttpError(409, error.message);
            }
            throw error;
        }
    }

    private removeSessionPanes(sessionId: string): void {
        for (const pane of this.store.panesOfSession(sessionId)) {
            this.closeOnCleanExit.delete(pane.id);
            this.panes.remove(pane.id);
            this.notes.remove(pane.id);
        }
    }

    private exited(pane: Pane, exitCode: number): void {
        if (exitCode !== 0 || !this.closeOnCleanExit.has(pane.id)) {
            return;
        }
        setImmediate(() => {
            if (this.closeOnCleanExit.has(pane.id) && this.store.getPane(pane.id)) {
                this.deletePane(pane.id);
            }
        });
    }

    private attention(pane: Pane, status: AttentionStatus, body: string): void {
        const session = this.store.getSession(pane.sessionId);
        if (!session) {
            return;
        }
        const text = body ? `${pane.title}: ${body}` : pane.title;
        this.emit({ type: 'attention', paneId: pane.id, sessionId: session.id, status, title: session.title, body: text });
        this.push.attention({ paneId: pane.id, status, sessionTitle: session.title, body: text });
    }

    async sessionChanges(id: string): Promise<SessionChanges> {
        const session = this.mustGetSession(id);
        return this.readChanges(() => this.changes.list(session.cwd));
    }

    async sessionDiff(id: string, path: string): Promise<FileDiff> {
        const session = this.mustGetSession(id);
        return this.readChanges(() => this.changes.diff(session.cwd, requireString(path, 'path', 4096)));
    }

    private async readChanges<T>(read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (error) {
            if (error instanceof ChangesError) {
                throw new HttpError(409, error.message);
            }
            throw error;
        }
    }

    // The state goes out first, so a window that is told to open a session it has just been created
    // already knows it.
    revealSession(id: string): void {
        this.mustGetSession(id);
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.emit({ type: 'state', state: this.state() });
        this.emit({ type: 'reveal', sessionId: id });
    }

    private scheduleBroadcast(): void {
        if (this.broadcastTimer) {
            return;
        }
        this.broadcastTimer = setTimeout(() => {
            this.broadcastTimer = null;
            this.emit({ type: 'state', state: this.state() });
        }, BROADCAST_DELAY_MS);
    }

    private emit(event: ServerEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error('[voltran] event listener failed:', error);
            }
        }
    }

    private mustGetProject(id: string): Project {
        const project = this.store.getProject(id);
        if (!project) {
            throw new HttpError(404, 'project not found');
        }
        return project;
    }

    private mustGetSession(id: string): Session {
        const session = this.store.getSession(id);
        if (!session) {
            throw new HttpError(404, 'session not found');
        }
        return session;
    }

    private mustGetWorkspace(id: string): Workspace {
        const workspace = this.store.getWorkspace(id);
        if (!workspace) {
            throw new HttpError(404, 'workspace not found');
        }
        return workspace;
    }

    private mustGetPane(id: string): Pane {
        const pane = this.store.getPane(id);
        if (!pane) {
            throw new HttpError(404, 'pane not found');
        }
        return pane;
    }
}
