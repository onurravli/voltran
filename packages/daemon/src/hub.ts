import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
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
    type Layout,
    type MovePaneBody,
    type Pane,
    type PaneSpec,
    type Project,
    type ServerEvent,
    type Session,
    type UpdatePaneBody,
    type UpdateProjectBody,
    type UpdateSessionBody,
    type UpdateWorkspaceBody,
    type Workspace,
} from '@voltran/shared';
import { adapterFor, claudeArgsProblem, isAdapterId, isClaudeHookEvent } from './adapters.ts';
import { PaneManager } from './panes.ts';
import type { Store } from './store.ts';

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
    claudeSettingsFile: string;
    url: string;
    shell: string;
    path: string;
    baseEnv: NodeJS.ProcessEnv;
}

type Listener = (event: ServerEvent) => void;

const BROADCAST_DELAY_MS = 30;
const MAX_TITLE = 200;
const MAX_COMMAND = 4000;

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

export class Hub {
    readonly panes: PaneManager;
    private readonly store: Store;
    private readonly adapters: AdapterInfo[];
    private listeners = new Set<Listener>();
    private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly closeOnCleanExit = new Set<string>();

    constructor(options: HubOptions) {
        this.store = options.store;
        this.adapters = options.adapters;
        this.panes = new PaneManager({
            scrollbackDir: options.scrollbackDir,
            claudeSettingsFile: options.claudeSettingsFile,
            url: options.url,
            shell: options.shell,
            path: options.path,
            baseEnv: options.baseEnv,
            onChange: () => this.scheduleBroadcast(),
            onPaneRecord: (pane) => this.store.updatePane(pane.id, pane),
            onAttention: (pane, status, body) => this.attention(pane, status, body),
            onExit: (pane, exitCode) => this.exited(pane, exitCode),
        });
        for (const pane of this.store.listPanes()) {
            this.panes.load(pane);
        }
        this.pruneWorkspaces();
    }

    state(): AppState {
        return {
            projects: this.store.listProjects(),
            sessions: this.store.listSessions(),
            panes: this.panes.views(),
            workspaces: this.store.listWorkspaces(),
            adapters: this.adapters,
        };
    }

    openWindows(): number {
        return this.listeners.size;
    }

    publish(event: ServerEvent): void {
        this.emit(event);
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    shutdown(): Promise<void> {
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.listeners.clear();
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
        this.store.updateProject(id, patch);
        this.scheduleBroadcast();
        return this.mustGetProject(id);
    }

    deleteProject(id: string): void {
        this.mustGetProject(id);
        for (const session of this.store.sessionsOfProject(id)) {
            this.removeSessionPanes(session.id);
        }
        this.store.deleteProject(id);
        this.pruneWorkspaces();
        this.scheduleBroadcast();
    }

    createSession(body: CreateSessionBody): Session {
        const project = this.mustGetProject(body.projectId);
        const specs = Array.isArray(body.panes) && body.panes.length > 0 ? body.panes : [{ adapter: 'shell' as const }];
        if (specs.length > 8) {
            throw new HttpError(400, 'a session starts with at most 8 panes');
        }
        specs.forEach((spec) => this.validatePaneSpec(spec));

        const now = Date.now();
        const session: Session = {
            id: randomUUID(),
            projectId: project.id,
            title: requireString(body.title, 'title', MAX_TITLE),
            link: optionalLink(body.link),
            cwd: project.path,
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
        this.scheduleBroadcast();
        return this.mustGetSession(session.id);
    }

    updateSession(id: string, body: UpdateSessionBody): Session {
        const session = this.mustGetSession(id);
        const patch: Partial<Pick<Session, 'title' | 'link' | 'archived' | 'layout'>> = {};
        if (body.title !== undefined) {
            patch.title = requireString(body.title, 'title', MAX_TITLE);
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
        if (body.archived !== undefined) {
            patch.archived = Boolean(body.archived);
            if (patch.archived && !session.archived) {
                for (const pane of this.store.panesOfSession(id)) {
                    this.panes.suspend(pane.id);
                }
            }
        }
        this.store.updateSession(id, patch);
        this.scheduleBroadcast();
        return this.mustGetSession(id);
    }

    deleteSession(id: string): void {
        this.mustGetSession(id);
        this.removeSessionPanes(id);
        this.store.deleteSession(id);
        this.pruneWorkspaces();
        this.scheduleBroadcast();
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
        if (!isClaudeHookEvent(event) || !payload || typeof payload !== 'object') {
            return false;
        }
        return this.panes.hook(paneId, secret, event, payload as Record<string, unknown>);
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
        if (spec.adapter === 'claude' && spec.command !== undefined) {
            const problem = claudeArgsProblem(requireString(spec.command, 'command', MAX_COMMAND));
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
        const command = spec.adapter === 'command' || spec.adapter === 'subagent' || spec.adapter === 'claude' ? spec.command?.trim() || null : null;
        const pane: Pane = {
            id: randomUUID(),
            sessionId: session.id,
            adapter: spec.adapter,
            title: spec.title?.trim() || (command && spec.adapter !== 'claude' ? command.slice(0, 40) : adapter.label),
            command,
            cwd: session.cwd,
            agentSessionId: spec.adapter === 'claude' ? randomUUID() : null,
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

    private removeSessionPanes(sessionId: string): void {
        for (const pane of this.store.panesOfSession(sessionId)) {
            this.closeOnCleanExit.delete(pane.id);
            this.panes.remove(pane.id);
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
