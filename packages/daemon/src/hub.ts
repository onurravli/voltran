import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
    MAX_WORKSPACE_PANES,
    PROJECT_COLORS,
    insertPane,
    isValidLayout,
    paneIds,
    previewUrl,
    removePane,
    samePanes,
    type AdapterInfo,
    type AppState,
    type AttentionStatus,
    type ConversationChunk,
    type CreatePaneBody,
    type CreateProjectBody,
    type CreateSessionBody,
    type CreateWorkspaceBody,
    type EditorFile,
    type FileActionResult,
    type FileContents,
    type FileTree,
    type Layout,
    type MovePaneBody,
    type NotesLockBody,
    type NotesMeta,
    type NotesScope,
    type Pane,
    type PaneNotes,
    type PaneSpec,
    type Project,
    type ProjectView,
    type SaveNotesBody,
    type ServerEvent,
    type Session,
    type ProjectFileList,
    type SearchResult,
    type SavedFile,
    type SessionChanges,
    type SlashCommand,
    type UpdatePaneBody,
    type UpdateProjectBody,
    type UpdateSessionBody,
    type UpdateWorkspaceBody,
    type UpdateNotice,
    type Usage,
    type Workspace,
    type ProjectGit,
    type WorktreeChoice,
    type AdapterId,
    type CreateTaskBody,
    type Task,
    type UpdateTaskBody,
    DELEGATE_ADAPTERS,
    MAX_BROADCAST,
    MAX_TASK_PROMPT,
    taskTitle,
} from '@voltran/shared';
import {
    adapterFor,
    claudeArgsProblem,
    claudeConfigDir,
    isAdapterId,
    isClaudeHookEvent,
    isCodexHookEvent,
    isOpencodeEvent,
    opencodeArgsProblem,
    STATUS_LINE_EVENT,
    voltranSessionId,
} from './adapters.ts';
import { ChangesError, SessionChangesReader } from './changes.ts';
import { readClaudeConversation } from './conversation.ts';
import { FilesError, ProjectFiles, systemTrash, type Trash } from './files.ts';
import { GitWatcher, commandRunner, type GitRunner } from './git.ts';
import { PENDING_TITLE, SessionNamer } from './naming.ts';
import { AttachmentRefused, AttachmentStore } from './attachments.ts';
import { claudeCommands } from './commands.ts';
import { NOTES_GUIDE, NotesRefused, NotesStore, PROJECT_NOTES_GUIDE } from './notes.ts';
import { PaneManager } from './panes.ts';
import { mergeUsage } from './statusline.ts';
import type { Store } from './store.ts';
import { TaskBoard, TaskRefused } from './tasks.ts';
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
    projectNotesDir: string;
    attachmentsDir: string;
    hooksDir: string;
    url: string;
    shell: string;
    path: string;
    baseEnv: NodeJS.ProcessEnv;
    gitRunner?: GitRunner;
    trash?: Trash;
    pullRequests?: () => boolean;
    worktreesDir: string;
    worktreeRunner?: WorktreeRunner;
}

type Listener = (event: ServerEvent) => void;

const BROADCAST_DELAY_MS = 30;
const TITLE_RETRY_MS = 4000;
const MAX_TITLE = 200;
const MAX_COMMAND = 4000;
const NOTES_HOLDER = /^[A-Za-z0-9-]{8,64}$/;
const PANE_NOTES_CHANGED = '.changed';
const PROJECT_NOTES_CHANGED = '.project.changed';

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

const idList = (value: unknown, field: string): string[] => {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string') || value.length > 64) {
        throw new HttpError(400, `${field} must be a list of ids`);
    }
    return value as string[];
};

const hookIds = (value: string | undefined): string[] =>
    value && value.trim() !== 'none'
        ? value
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
        : [];

const hookParent = (value: string): string | null => (value.trim() === 'none' ? null : value.trim());

function refusedAsHttp<T>(action: () => T): T {
    try {
        return action();
    } catch (error) {
        if (error instanceof NotesRefused || error instanceof TaskRefused) {
            throw new HttpError(error.status, error.message);
        }
        throw error;
    }
}

export class Hub {
    readonly panes: PaneManager;
    private readonly git: GitWatcher;
    private readonly changes: SessionChangesReader;
    private readonly files: ProjectFiles;
    private readonly notes: NotesStore;
    private readonly projectNotes: NotesStore;
    private readonly attachments: AttachmentStore;
    private readonly claudeConfig: string | null;
    private readonly worktrees: Worktrees;
    private readonly tasks: TaskBoard;
    private readonly store: Store;
    private readonly adapters: AdapterInfo[];
    private listeners = new Set<Listener>();
    private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly closeOnCleanExit = new Set<string>();
    private readonly namer = new SessionNamer();
    private readonly namingTimers = new Set<ReturnType<typeof setTimeout>>();
    private usage: Usage | null = null;
    private update: UpdateNotice | null = null;

    constructor(options: HubOptions) {
        this.store = options.store;
        this.claudeConfig = claudeConfigDir(options.baseEnv);
        this.adapters = options.adapters;
        this.worktrees = new Worktrees(
            options.worktreesDir,
            options.worktreeRunner ?? worktreeRunner({ ...options.baseEnv, PATH: options.path }),
        );
        this.notes = new NotesStore({
            dir: options.notesDir,
            guide: NOTES_GUIDE,
            onChange: (change) => {
                if (change.by === 'user') {
                    this.notes.markChanged(change.id, PANE_NOTES_CHANGED);
                }
                this.emit({ type: 'notes', scope: 'pane', ...change });
            },
            onMeta: () => this.scheduleBroadcast(),
        });
        this.projectNotes = new NotesStore({
            dir: options.projectNotesDir,
            guide: PROJECT_NOTES_GUIDE,
            onChange: (change) => {
                const editor = change.by === 'agent' ? change.holder : null;
                for (const session of this.store.sessionsOfProject(change.id)) {
                    for (const pane of this.store.panesOfSession(session.id)) {
                        if (pane.id !== editor && pane.adapter !== 'subagent') {
                            this.notes.markChanged(pane.id, PROJECT_NOTES_CHANGED);
                        }
                    }
                }
                this.emit({
                    type: 'notes',
                    scope: 'project',
                    ...change,
                    holder: change.by === 'user' ? change.holder : null,
                });
            },
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
            onStatus: (pane, previous, change) =>
                this.tasks?.statusChanged(pane.id, previous, change.status, change.detail),
            notes: {
                guide: this.notes.guide,
                file: (pane) => (pane.adapter === 'subagent' ? null : this.notes.file(pane.id)),
                projectGuide: this.projectNotes.guide,
                projectFile: (pane) => {
                    const projectId = this.store.getSession(pane.sessionId)?.projectId;
                    return pane.adapter === 'subagent' || !projectId ? null : this.projectNotes.file(projectId);
                },
            },
        });
        for (const pane of this.store.listPanes()) {
            this.panes.load(pane);
        }
        this.tasks = new TaskBoard({
            store: this.store,
            onChange: () => this.scheduleBroadcast(),
            handoff: (paneId) => this.handoffContext(paneId),
            runner: {
                status: (id) => this.panes.status(id),
                running: (id) => this.panes.running(id),
                wake: (id) => {
                    const session = this.store.getSession(this.store.getPane(id)?.sessionId ?? '');
                    if (session && !session.archived) {
                        this.panes.wake(id);
                    }
                },
                submit: (id, text) => this.panes.submit(id, text),
            },
        });
        this.notes.load(this.store.listPanes().map((pane) => pane.id));
        this.projectNotes.load(this.store.listProjects().map((project) => project.id));
        this.attachments = new AttachmentStore(options.attachmentsDir);
        this.attachments.load(this.store.listPanes().map((pane) => pane.id));
        this.notes.watch();
        this.projectNotes.watch();
        this.pruneWorkspaces();
        const gitRunner = options.gitRunner ?? commandRunner({ ...options.baseEnv, PATH: options.path });
        this.git = new GitWatcher({
            folders: () => [
                ...new Set(
                    this.store
                        .listSessions()
                        .filter((session) => !session.archived)
                        .map((session) => session.cwd),
                ),
            ],
            onChange: () => this.scheduleBroadcast(),
            pullRequests: options.pullRequests ?? (() => false),
            run: gitRunner,
        });
        this.changes = new SessionChangesReader(gitRunner);
        this.files = new ProjectFiles({ run: gitRunner, trash: options.trash ?? systemTrash(options.baseEnv) });
    }

    state(): AppState {
        return {
            projects: this.store
                .listProjects()
                .map((project): ProjectView => ({ ...project, notes: this.projectNotes.meta(project.id) })),
            sessions: this.store.listSessions(),
            panes: this.panes.views().map((view) => ({ ...view, notes: this.notes.meta(view.id) })),
            workspaces: this.store.listWorkspaces(),
            tasks: this.tasks.list(),
            git: this.git.snapshot(),
            adapters: this.adapters,
            usage: this.usage,
            update: this.update,
        };
    }

    setUpdate(update: UpdateNotice | null): void {
        if (update?.latest !== this.update?.latest) {
            this.update = update;
            this.scheduleBroadcast();
        }
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
        this.projectNotes.close();
        this.namingTimers.forEach(clearTimeout);
        this.namingTimers.clear();
        this.tasks.close();
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
            color:
                typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color)
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
        const before =
            body.moveBefore === undefined
                ? undefined
                : moveTarget(
                      body.moveBefore,
                      this.store.listProjects().map((project) => project.id),
                      'another project',
                  );
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
        this.projectNotes.remove(id);
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
        const title =
            typeof body.title === 'string' && body.title.trim() ? requireString(body.title, 'title', MAX_TITLE) : null;
        if (title === null && !specs.some((spec) => adapterFor(spec.adapter).reportsHooks)) {
            throw new HttpError(
                400,
                'a session needs a title unless it starts with Claude Code, Codex or OpenCode, which name it',
            );
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
        const before =
            body.moveBefore === undefined
                ? undefined
                : moveTarget(
                      body.moveBefore,
                      this.store.sessionsOfProject(session.projectId).map((entry) => entry.id),
                      'a session of the same project',
                  );
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
                throw new HttpError(
                    409,
                    `${error instanceof Error ? error.message : String(error)}; choose whether to keep the worktree`,
                );
            });
            if (changes > 0) {
                throw new HttpError(
                    409,
                    `its worktree has ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}`,
                );
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
                throw new HttpError(
                    500,
                    `The session is deleted, but its worktree at ${session.worktree} is not: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }
    }

    createPane(sessionId: string, body: CreatePaneBody, options: { closeOnCleanExit?: boolean } = {}): Pane {
        const session = this.mustGetSession(sessionId);
        this.validatePaneSpec(body);
        const workspace =
            body.workspaceId === undefined
                ? null
                : this.mustGetWorkspace(requireString(body.workspaceId, 'workspaceId', 64));
        if (workspace && paneIds(workspace.layout).length >= MAX_WORKSPACE_PANES) {
            throw new HttpError(409, `a workspace holds at most ${MAX_WORKSPACE_PANES} panes`);
        }
        const direction = body.direction === 'vertical' ? 'vertical' : 'horizontal';
        const pane = this.insertPaneRecord(session, body);
        this.store.updateSession(session.id, {
            layout: insertPane(session.layout, pane.id, body.splitFrom, direction),
        });
        if (workspace) {
            this.store.updateWorkspace(workspace.id, {
                layout: insertPane(workspace.layout, pane.id, body.splitFrom, direction),
            });
        }
        if (options.closeOnCleanExit) {
            this.closeOnCleanExit.add(pane.id);
        }
        this.scheduleBroadcast();
        return pane;
    }

    updatePane(id: string, body: UpdatePaneBody): Pane {
        const pane = this.mustGetPane(id);
        if (body.url !== undefined) {
            if (pane.adapter !== 'preview') {
                throw new HttpError(400, 'only a preview pane has a URL');
            }
            const command = this.requirePreviewUrl(body.url);
            this.store.updatePane(id, { command });
            this.panes.updatePane(id, { command });
        }
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
        this.tasks.paneRemoved(id);
        this.panes.remove(id);
        this.notes.remove(id);
        this.attachments.remove(id);
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
        const existing = this.store
            .panesOfSession(parent.sessionId)
            .find((pane) => pane.adapter === 'subagent' && pane.command === subagent.path);
        if (existing) {
            return existing;
        }
        const session = this.mustGetSession(parent.sessionId);
        const pane = this.insertPaneRecord(session, {
            adapter: 'subagent',
            title: subagent.description.slice(0, MAX_TITLE),
            command: subagent.path,
        });
        this.store.updateSession(session.id, { layout: insertPane(session.layout, pane.id, paneId, 'horizontal') });
        this.scheduleBroadcast();
        return pane;
    }

    hook(paneId: string, event: string, secret: string, payload: unknown): boolean {
        if (event === STATUS_LINE_EVENT && payload && typeof payload === 'object') {
            return this.statusLine(paneId, secret, payload as Record<string, unknown>);
        }
        if (
            !(isClaudeHookEvent(event) || isOpencodeEvent(event) || isCodexHookEvent(event)) ||
            !payload ||
            typeof payload !== 'object'
        ) {
            return false;
        }
        const handled = this.panes.hook(paneId, secret, event, payload as Record<string, unknown>);
        if (handled && (event === 'Stop' || event === 'TurnEnd')) {
            const body = payload as Record<string, unknown>;
            this.tasks.reply(paneId, event === 'Stop' ? body.last_assistant_message : body.message);
        }
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
    hookNotes(paneId: string, secret: string, scope: NotesScope): string | null {
        if (!this.panes.isClaudeReport(paneId, secret)) {
            return null;
        }
        if (scope === 'pane') {
            return this.notes.current(paneId);
        }
        const projectId = this.store.getSession(this.store.getPane(paneId)?.sessionId ?? '')?.projectId;
        return projectId ? this.projectNotes.current(projectId) : '';
    }

    createTasks(body: CreateTaskBody, createdBy: string | null = null): Task[] {
        if (!body || typeof body !== 'object') {
            throw new HttpError(400, 'a task needs a prompt');
        }
        const prompt = requireString(body.prompt, 'prompt', MAX_TASK_PROMPT);
        const dependsOn = idList(body.dependsOn, 'dependsOn');
        const parentId =
            body.parentId === undefined || body.parentId === null ? null : requireString(body.parentId, 'parentId', 64);
        const handoffFrom =
            body.handoffFrom === undefined || body.handoffFrom === null
                ? null
                : this.mustGetPane(requireString(body.handoffFrom, 'handoffFrom', 64)).id;
        const title = typeof body.title === 'string' && body.title.trim() ? body.title : undefined;
        let targets: Pane[] = [];
        let projectId: string;
        let sessionId = '';
        if (body.adapter !== undefined) {
            if (!DELEGATE_ADAPTERS.includes(body.adapter)) {
                throw new HttpError(400, 'a new pane for a task runs Claude Code, Codex or OpenCode');
            }
            sessionId = requireString(body.sessionId, 'sessionId', 64);
            projectId = this.taskProject([], sessionId);
        } else {
            const ids = [...new Set(idList(body.paneIds, 'paneIds'))];
            if (ids.length === 0) {
                throw new HttpError(400, 'choose at least one agent pane, or an agent for a new pane');
            }
            if (ids.length > MAX_BROADCAST) {
                throw new HttpError(400, `a prompt goes to at most ${MAX_BROADCAST} panes at once`);
            }
            targets = ids.map((id) => this.mustGetPane(id));
            projectId = this.taskProject(targets);
        }
        if (createdBy && this.taskProject([this.mustGetPane(createdBy)]) !== projectId) {
            throw new HttpError(400, 'an agent can only give tasks to agents of its own project');
        }
        if (handoffFrom && this.taskProject([this.mustGetPane(handoffFrom)]) !== projectId) {
            throw new HttpError(400, 'a handoff comes from a pane of the same project');
        }
        refusedAsHttp(() => this.tasks.check(projectId, dependsOn, parentId));
        if (body.adapter !== undefined) {
            targets = [
                this.createPane(sessionId, {
                    adapter: body.adapter,
                    title: `${adapterFor(body.adapter).label}: ${taskTitle(prompt, 32)}`,
                    splitFrom:
                        createdBy && this.store.getPane(createdBy)?.sessionId === sessionId ? createdBy : undefined,
                }),
            ];
        }
        return refusedAsHttp(() =>
            targets.map((pane) =>
                this.tasks.create({
                    projectId,
                    paneId: pane.id,
                    prompt,
                    title,
                    parentId,
                    dependsOn,
                    handoffFrom: handoffFrom === pane.id ? null : handoffFrom,
                    createdBy,
                }),
            ),
        );
    }

    updateTask(id: string, body: UpdateTaskBody): Task {
        if (!body || typeof body !== 'object') {
            throw new HttpError(400, 'nothing to change');
        }
        return refusedAsHttp(() => {
            if (body.action !== undefined) {
                if (body.action !== 'cancel' && body.action !== 'retry' && body.action !== 'complete') {
                    throw new HttpError(400, 'action must be cancel, retry or complete');
                }
                this.tasks.act(id, body.action);
            }
            if (body.title !== undefined || body.prompt !== undefined) {
                this.tasks.edit(id, {
                    title: body.title === undefined ? undefined : requireString(body.title, 'title', MAX_TITLE),
                    prompt:
                        body.prompt === undefined ? undefined : requireString(body.prompt, 'prompt', MAX_TASK_PROMPT),
                });
            }
            if (body.dependsOn !== undefined || body.parentId !== undefined) {
                this.tasks.link(id, {
                    dependsOn: body.dependsOn === undefined ? undefined : idList(body.dependsOn, 'dependsOn'),
                    parentId:
                        body.parentId === undefined || body.parentId === null
                            ? body.parentId
                            : requireString(body.parentId, 'parentId', 64),
                });
            }
            if (body.moveBefore !== undefined) {
                this.tasks.move(id, body.moveBefore === null ? null : requireString(body.moveBefore, 'moveBefore', 64));
            }
            const task = this.tasks.get(id);
            if (!task) {
                throw new HttpError(404, 'task not found');
            }
            return task;
        });
    }

    deleteTask(id: string): void {
        refusedAsHttp(() => this.tasks.remove(id));
    }

    clearTasks(projectId: string): void {
        this.mustGetProject(projectId);
        this.tasks.clearFinished(projectId);
    }

    // An agent delegates through its pane's hook secret: the options come as headers and the prompt as
    // the body, which a shell script can send without building JSON.
    hookCreateTask(paneId: string, secret: string, prompt: string, options: Record<string, string | undefined>): Task {
        const pane = this.mustReportingPane(paneId, secret);
        const running = this.tasks.runningOn(pane.id);
        const to = options.to?.trim();
        const agent = options.agent?.trim();
        const [task] = this.createTasks(
            {
                prompt,
                title: options.title,
                ...(to
                    ? { paneIds: [to] }
                    : { adapter: (agent || 'codex') as CreateTaskBody['adapter'], sessionId: pane.sessionId }),
                parentId: options.parent?.trim() ? hookParent(options.parent) : (running?.id ?? null),
                dependsOn: hookIds(options.after),
                handoffFrom: options.handoff === '1' ? pane.id : null,
            },
            pane.id,
        );
        return task;
    }

    // An agent steers the project's graph the way the tasks view does: each option is a header, a value of
    // `none` clears a link and `end` moves a task to the end of its queue.
    hookUpdateTask(
        paneId: string,
        secret: string,
        taskId: string,
        options: Record<string, string | undefined>,
        body: string,
    ): Task {
        const pane = this.mustReportingPane(paneId, secret);
        this.mustProjectTask(pane, taskId);
        const update: UpdateTaskBody = {};
        if (options.action?.trim()) {
            update.action = options.action.trim() as UpdateTaskBody['action'];
        }
        if (options.title?.trim()) {
            update.title = options.title;
        }
        if (options.prompt === '1') {
            update.prompt = body;
        }
        if (options.after?.trim()) {
            update.dependsOn = hookIds(options.after);
        }
        if (options.parent?.trim()) {
            update.parentId = hookParent(options.parent);
        }
        if (options.before?.trim()) {
            update.moveBefore = options.before.trim() === 'end' ? null : options.before.trim();
        }
        if (Object.keys(update).length === 0) {
            throw new HttpError(400, 'nothing to change');
        }
        return this.updateTask(taskId, update);
    }

    // `finished` clears the project's finished tasks, as the tasks view's button does.
    hookDeleteTask(paneId: string, secret: string, taskId: string): void {
        const pane = this.mustReportingPane(paneId, secret);
        if (taskId === 'finished') {
            this.tasks.clearFinished(this.taskProject([pane]));
            return;
        }
        const task = this.mustProjectTask(pane, taskId);
        if (task.status === 'running') {
            throw new HttpError(409, 'cancel the task before removing it');
        }
        this.deleteTask(taskId);
    }

    // Opens an agent pane with no task yet, or the session's tasks view, next to the asking pane.
    hookOpenPane(paneId: string, secret: string, options: Record<string, string | undefined>): Pane {
        const pane = this.mustReportingPane(paneId, secret);
        const kind = options.agent?.trim() || 'tasks';
        if (kind === 'tasks') {
            const existing = this.store.panesOfSession(pane.sessionId).find((entry) => entry.adapter === 'tasks');
            return (
                existing ?? this.createPane(pane.sessionId, { adapter: 'tasks', title: 'Tasks', splitFrom: pane.id })
            );
        }
        if (!DELEGATE_ADAPTERS.includes(kind as AdapterId)) {
            throw new HttpError(400, 'open tasks, claude, codex or opencode');
        }
        this.taskProject([], pane.sessionId);
        const label = adapterFor(kind as AdapterId).label;
        return this.createPane(pane.sessionId, {
            adapter: kind as AdapterId,
            title: options.title?.trim() ? options.title.trim().slice(0, MAX_TITLE) : label,
            splitFrom: pane.id,
        });
    }

    private mustProjectTask(pane: Pane, taskId: string): Task {
        const task = this.tasks.get(taskId);
        if (!task || task.projectId !== this.taskProject([pane])) {
            throw new HttpError(404, 'task not found');
        }
        return task;
    }

    // Plain text so the script can read it: the status on the first line, then the result.
    hookTask(paneId: string, secret: string, taskId: string | null): string {
        const pane = this.mustReportingPane(paneId, secret);
        const projectId = this.taskProject([pane]);
        if (taskId === null) {
            const panes = this.store
                .sessionsOfProject(projectId)
                .flatMap((session) => this.store.panesOfSession(session.id))
                .filter((entry) => adapterFor(entry.adapter).kind === 'agent');
            const tasks = this.tasks.list().filter((task) => task.projectId === projectId);
            return [
                'Agent panes (use an id with --to):',
                ...panes.map(
                    (entry) =>
                        `${entry.id}  ${adapterFor(entry.adapter).label}  ${this.panes.status(entry.id) ?? ''}  ${entry.title}${entry.id === pane.id ? '  (you)' : ''}`,
                ),
                '',
                'Tasks:',
                ...(tasks.length === 0
                    ? ['(none)']
                    : tasks.map(
                          (task) =>
                              `${task.id}  ${task.status}  ${this.store.getPane(task.paneId)?.title ?? 'closed pane'}  ${task.title}${task.paneId === pane.id ? '  (yours)' : ''}${task.dependsOn.length > 0 ? `  after: ${task.dependsOn.join(',')}` : ''}${task.parentId ? `  parent: ${task.parentId}` : ''}`,
                      )),
                '',
            ].join('\n');
        }
        const task = this.tasks.get(taskId);
        if (!task || task.projectId !== projectId) {
            throw new HttpError(404, 'task not found');
        }
        return `${task.status}\n${task.result ?? ''}\n`;
    }

    private mustReportingPane(paneId: string, secret: string): Pane {
        const pane = this.store.getPane(paneId);
        if (!pane || !this.panes.isReport(paneId, secret)) {
            throw new HttpError(403, 'hook refused');
        }
        return pane;
    }

    // The project every target belongs to; tasks never cross projects.
    private taskProject(panes: Pane[], sessionId?: string): string {
        const projects = new Set<string>();
        for (const pane of panes) {
            const session = this.mustGetSession(pane.sessionId);
            if (adapterFor(pane.adapter).kind !== 'agent') {
                throw new HttpError(400, `${pane.title} is not an agent pane`);
            }
            if (session.archived) {
                throw new HttpError(409, `restore the session of ${pane.title} first`);
            }
            projects.add(session.projectId);
        }
        if (sessionId) {
            const session = this.mustGetSession(sessionId);
            if (session.archived) {
                throw new HttpError(409, 'restore the session first');
            }
            projects.add(session.projectId);
        }
        if (projects.size !== 1) {
            throw new HttpError(400, 'every pane of a task must belong to the same project');
        }
        return [...projects][0];
    }

    private handoffContext(paneId: string): { label: string; reply: string | null; notes: string } | null {
        const pane = this.store.getPane(paneId);
        if (!pane) {
            return null;
        }
        const finished = this.tasks
            .list()
            .filter((task) => task.paneId === paneId && task.status === 'done' && task.result)
            .slice(-3);
        const reply =
            this.tasks.lastReply(paneId) ??
            finished.at(-1)?.result ??
            this.panes.views().find((view) => view.id === paneId)?.detail ??
            null;
        return {
            label: `${pane.title} (${adapterFor(pane.adapter).label})`,
            reply,
            notes: [
                this.notes.current(paneId),
                ...finished
                    .filter((task) => task.result !== reply)
                    .map((task) => `Finished task "${task.title}":\n${task.result}`),
            ]
                .filter((part) => part.trim())
                .join('\n\n'),
        };
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
        if (
            retry &&
            event === 'Stop' &&
            pane.adapter === 'claude' &&
            (named?.titleSource ?? session.titleSource) === 'prompt'
        ) {
            const timer = setTimeout(() => {
                this.namingTimers.delete(timer);
                this.nameSession(paneId, event, payload, false);
            }, TITLE_RETRY_MS);
            this.namingTimers.add(timer);
        }
    }

    // A client that still shows the same conversation continues from where it stopped reading.
    paneConversation(id: string, source: string | null, from: number): ConversationChunk {
        const pane = this.mustGetPane(id);
        if (pane.adapter !== 'claude') {
            throw new HttpError(400, 'Only Claude Code panes show a conversation so far.');
        }
        const transcript = this.panes.transcript(id);
        if (!transcript) {
            return { source: null, entries: [], next: 0, more: false };
        }
        const start = source === transcript.sessionId && Number.isSafeInteger(from) && from > 0 ? from : 0;
        return (
            readClaudeConversation(transcript.path, transcript.sessionId, start) ?? {
                source: transcript.sessionId,
                entries: [],
                next: 0,
                more: false,
            }
        );
    }

    paneCommands(id: string): SlashCommand[] {
        const pane = this.mustGetPane(id);
        return pane.adapter === 'claude' ? claudeCommands(pane.cwd, this.claudeConfig) : [];
    }

    attach(id: string, bytes: Buffer): { path: string } {
        this.mustGetPane(id);
        try {
            return { path: this.attachments.save(id, bytes) };
        } catch (error) {
            if (error instanceof AttachmentRefused) {
                throw new HttpError(415, error.message);
            }
            throw error;
        }
    }

    readNotes(scope: NotesScope, id: string): PaneNotes {
        return this.notesOf(scope, id).read(id);
    }

    lockNotes(scope: NotesScope, id: string, body: NotesLockBody): NotesMeta {
        const notes = this.notesOf(scope, id);
        const holder = notesHolder(body?.holder);
        if (body.version !== undefined && typeof body.version !== 'string') {
            throw new HttpError(400, 'version must be a string');
        }
        return refusedAsHttp(() => notes.lock(id, holder, body.version));
    }

    unlockNotes(scope: NotesScope, id: string, body: NotesLockBody): void {
        this.notesOf(scope, id).unlock(id, notesHolder(body?.holder));
    }

    saveNotes(scope: NotesScope, id: string, body: SaveNotesBody): PaneNotes {
        const notes = this.notesOf(scope, id);
        const holder = notesHolder(body?.holder);
        if (typeof body.content !== 'string' || typeof body.version !== 'string') {
            throw new HttpError(400, 'content and version are required');
        }
        return refusedAsHttp(() => notes.save(id, holder, body.version, body.content));
    }

    private notesOf(scope: NotesScope, id: string): NotesStore {
        if (scope === 'project') {
            this.mustGetProject(id);
            return this.projectNotes;
        }
        this.mustGetPane(id);
        return this.notes;
    }

    // Claude names the file it is about to edit, so the drawer can wait instead of racing it. Other
    // agents give no notice; their writes show up through the notes watcher.
    private trackNotesEdit(paneId: string, event: string, payload: Record<string, unknown>): void {
        const projectId = this.store.getSession(this.store.getPane(paneId)?.sessionId ?? '')?.projectId;
        if (event === 'Stop' || event === 'SessionEnd') {
            this.notes.agentDone(paneId);
            if (projectId) {
                this.projectNotes.agentDone(projectId, paneId);
            }
            return;
        }
        if (event !== 'PreToolUse' && event !== 'PostToolUse') {
            return;
        }
        const input = payload.tool_input;
        const file = input && typeof input === 'object' ? (input as Record<string, unknown>).file_path : undefined;
        if (payload.tool_name !== 'Edit' && payload.tool_name !== 'Write') {
            return;
        }
        if (this.notes.isFile(paneId, file)) {
            if (event === 'PreToolUse') {
                this.notes.agentEditing(paneId);
            } else {
                this.notes.agentDone(paneId);
            }
        } else if (projectId && this.projectNotes.idOf(file) === projectId) {
            if (event === 'PreToolUse') {
                this.projectNotes.agentEditing(projectId, paneId);
            } else {
                this.projectNotes.agentDone(projectId, paneId);
            }
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
        if (spec.adapter === 'preview') {
            this.requirePreviewUrl(spec.command);
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

    private requirePreviewUrl(value: unknown): string {
        const url = previewUrl(requireString(value, 'url', MAX_COMMAND));
        if (!url) {
            throw new HttpError(400, 'a preview shows a page on this computer, such as localhost:5173');
        }
        return url;
    }

    private insertPaneRecord(session: Session, spec: PaneSpec): Pane {
        const adapter = adapterFor(spec.adapter);
        const takesArgs = spec.adapter === 'claude' || spec.adapter === 'opencode';
        const command =
            spec.adapter === 'preview'
                ? this.requirePreviewUrl(spec.command)
                : spec.adapter === 'command' || spec.adapter === 'subagent' || takesArgs
                  ? spec.command?.trim() || null
                  : null;
        const pane: Pane = {
            id: randomUUID(),
            sessionId: session.id,
            adapter: spec.adapter,
            title:
                spec.title?.trim() ||
                (spec.adapter === 'preview' && command
                    ? new URL(command).host
                    : command && !takesArgs
                      ? command.slice(0, 40)
                      : adapter.label),
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
                const layout = missing.reduce<Layout | null>(
                    (rest, paneId) => removePane(rest, paneId),
                    workspace.layout,
                );
                this.store.updateWorkspace(workspace.id, { layout });
            }
        }
    }

    private async createWorktree(
        project: Project,
        spec: NonNullable<CreateSessionBody['worktree']>,
    ): Promise<{ root: string; cwd: string }> {
        if (!spec || typeof spec !== 'object') {
            throw new HttpError(400, 'worktree must be an object with a branch');
        }
        const branch = requireString(spec.branch, 'branch', MAX_TITLE);
        const base =
            spec.base === undefined || spec.base === null || spec.base === ''
                ? undefined
                : requireString(spec.base, 'base', MAX_TITLE);
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
            this.tasks.paneRemoved(pane.id);
            this.panes.remove(pane.id);
            this.notes.remove(pane.id);
            this.attachments.remove(pane.id);
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
        this.emit({
            type: 'attention',
            paneId: pane.id,
            sessionId: session.id,
            status,
            title: session.title,
            body: body ? `${pane.title}: ${body}` : pane.title,
        });
    }

    async sessionChanges(id: string): Promise<SessionChanges> {
        const session = this.mustGetSession(id);
        return this.readChanges(() => this.changes.list(session.cwd));
    }

    async sessionFileContents(id: string, path: string): Promise<FileContents> {
        const session = this.mustGetSession(id);
        return this.readChanges(() => this.changes.contents(session.cwd, requireString(path, 'path', 4096)));
    }

    // The editor works in the session's folder: the project's, or the session's worktree.
    async sessionTree(id: string, paths: string[]): Promise<FileTree> {
        const session = this.mustGetSession(id);
        return this.useFiles(() => this.files.tree(session.cwd, paths));
    }

    async sessionFileList(id: string): Promise<ProjectFileList> {
        const session = this.mustGetSession(id);
        return this.useFiles(() => this.files.list(session.cwd));
    }

    searchSessionFiles(id: string, query: unknown): Promise<SearchResult> {
        const session = this.mustGetSession(id);
        return this.useFiles(() => this.files.search(session.cwd, query));
    }

    readSessionFile(id: string, path: unknown, known: string | null): Promise<EditorFile> {
        const session = this.mustGetSession(id);
        return this.useFiles(() => this.files.read(session.cwd, path, known));
    }

    async writeSessionFile(
        id: string,
        path: unknown,
        text: string,
        base: string | null,
        force: boolean,
    ): Promise<SavedFile> {
        const session = this.mustGetSession(id);
        const saved = await this.useFiles(() => this.files.write(session.cwd, path, text, base, force));
        this.refreshGitSoon(session.cwd);
        return saved;
    }

    async sessionFileAction(id: string, body: unknown): Promise<FileActionResult> {
        const session = this.mustGetSession(id);
        const result = await this.useFiles(() => this.files.act(session.cwd, body));
        this.refreshGitSoon(session.cwd);
        return result;
    }

    private async useFiles<T>(action: () => T | Promise<T>): Promise<T> {
        try {
            return await action();
        } catch (error) {
            if (error instanceof FilesError) {
                throw new HttpError(error.status, error.message);
            }
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (code === 'EACCES' || code === 'EPERM') {
                throw new HttpError(403, 'permission denied');
            }
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                throw new HttpError(404, 'it is no longer there');
            }
            if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'ELOOP') {
                throw new HttpError(409, (error as Error).message);
            }
            throw error;
        }
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
