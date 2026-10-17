import { DatabaseSync } from 'node:sqlite';
import type { AdapterId, Layout, Pane, Project, Session, Workspace } from '@voltran/shared';

const SCHEMA_VERSION = 2;

const SCHEMA = `
create table if not exists projects (
    id text primary key,
    name text not null,
    path text not null,
    color text not null,
    position integer not null,
    created_at integer not null
);
create table if not exists sessions (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    title text not null,
    link text,
    cwd text not null,
    worktree text,
    layout text,
    archived integer not null default 0,
    created_at integer not null,
    updated_at integer not null
);
create table if not exists panes (
    id text primary key,
    session_id text not null references sessions(id) on delete cascade,
    adapter text not null,
    title text not null,
    command text,
    cwd text not null,
    agent_session_id text,
    agent_resumable integer not null default 0,
    ended integer not null default 0,
    created_at integer not null
);
create table if not exists workspaces (
    id text primary key,
    title text not null,
    layout text,
    created_at integer not null,
    updated_at integer not null
);
`;

type Row = Record<string, string | number | null>;

const toProject = (row: Row): Project => ({
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    color: String(row.color),
    createdAt: Number(row.created_at),
});

const toSession = (row: Row): Session => ({
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    link: row.link === null ? null : String(row.link),
    cwd: String(row.cwd),
    worktree: row.worktree === null || row.worktree === undefined ? null : String(row.worktree),
    layout: row.layout ? (JSON.parse(String(row.layout)) as Layout) : null,
    archived: Number(row.archived) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
});

const toPane = (row: Row): Pane => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    adapter: String(row.adapter) as AdapterId,
    title: String(row.title),
    command: row.command === null ? null : String(row.command),
    cwd: String(row.cwd),
    agentSessionId: row.agent_session_id === null ? null : String(row.agent_session_id),
    agentResumable: Number(row.agent_resumable) === 1,
    ended: Number(row.ended) === 1,
    createdAt: Number(row.created_at),
});

const toWorkspace = (row: Row): Workspace => ({
    id: String(row.id),
    title: String(row.title),
    layout: row.layout ? (JSON.parse(String(row.layout)) as Layout) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
});

export class Store {
    private db: DatabaseSync;

    constructor(file: string) {
        this.db = new DatabaseSync(file);
        this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
        this.db.exec(SCHEMA);
        const sessionColumns = this.db.prepare('pragma table_info(sessions)').all() as Row[];
        if (!sessionColumns.some((column) => column.name === 'worktree')) {
            this.db.exec('alter table sessions add column worktree text');
        }
        // Gemini CLI panes from before Antigravity replaced it would name an adapter that no longer exists.
        this.db.exec(`update panes set adapter = 'antigravity' where adapter = 'gemini'`);
        this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
    }

    close(): void {
        this.db.close();
    }

    listProjects(): Project[] {
        return (this.db.prepare('select * from projects order by position, created_at').all() as Row[]).map(toProject);
    }

    listSessions(): Session[] {
        return (this.db.prepare('select * from sessions order by created_at').all() as Row[]).map(toSession);
    }

    listPanes(): Pane[] {
        return (this.db.prepare('select * from panes order by created_at').all() as Row[]).map(toPane);
    }

    listWorkspaces(): Workspace[] {
        return (this.db.prepare('select * from workspaces order by created_at').all() as Row[]).map(toWorkspace);
    }

    getProject(id: string): Project | null {
        const row = this.db.prepare('select * from projects where id = ?').get(id) as Row | undefined;
        return row ? toProject(row) : null;
    }

    getSession(id: string): Session | null {
        const row = this.db.prepare('select * from sessions where id = ?').get(id) as Row | undefined;
        return row ? toSession(row) : null;
    }

    getPane(id: string): Pane | null {
        const row = this.db.prepare('select * from panes where id = ?').get(id) as Row | undefined;
        return row ? toPane(row) : null;
    }

    getWorkspace(id: string): Workspace | null {
        const row = this.db.prepare('select * from workspaces where id = ?').get(id) as Row | undefined;
        return row ? toWorkspace(row) : null;
    }

    panesOfSession(sessionId: string): Pane[] {
        return (this.db.prepare('select * from panes where session_id = ? order by created_at').all(sessionId) as Row[]).map(toPane);
    }

    sessionsOfProject(projectId: string): Session[] {
        return (this.db.prepare('select * from sessions where project_id = ? order by created_at').all(projectId) as Row[]).map(toSession);
    }

    insertProject(project: Project): void {
        const position = (this.db.prepare('select coalesce(max(position), -1) + 1 as next from projects').get() as Row).next;
        this.db.prepare('insert into projects (id, name, path, color, position, created_at) values (?, ?, ?, ?, ?, ?)')
            .run(project.id, project.name, project.path, project.color, Number(position), project.createdAt);
    }

    updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'color'>>): void {
        const current = this.getProject(id);
        if (!current) {
            return;
        }
        const next = { ...current, ...patch };
        this.db.prepare('update projects set name = ?, color = ? where id = ?').run(next.name, next.color, id);
    }

    deleteProject(id: string): void {
        this.db.prepare('delete from projects where id = ?').run(id);
    }

    insertSession(session: Session): void {
        this.db.prepare(`insert into sessions (id, project_id, title, link, cwd, worktree, layout, archived, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                session.id,
                session.projectId,
                session.title,
                session.link,
                session.cwd,
                session.worktree,
                session.layout ? JSON.stringify(session.layout) : null,
                session.archived ? 1 : 0,
                session.createdAt,
                session.updatedAt,
            );
    }

    updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'link' | 'archived' | 'layout'>>): void {
        const current = this.getSession(id);
        if (!current) {
            return;
        }
        const next = { ...current, ...patch, updatedAt: Date.now() };
        this.db.prepare('update sessions set title = ?, link = ?, archived = ?, layout = ?, updated_at = ? where id = ?')
            .run(next.title, next.link, next.archived ? 1 : 0, next.layout ? JSON.stringify(next.layout) : null, next.updatedAt, id);
    }

    deleteSession(id: string): void {
        this.db.prepare('delete from sessions where id = ?').run(id);
    }

    insertPane(pane: Pane): void {
        this.db.prepare(`insert into panes (id, session_id, adapter, title, command, cwd, agent_session_id, agent_resumable, ended, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                pane.id,
                pane.sessionId,
                pane.adapter,
                pane.title,
                pane.command,
                pane.cwd,
                pane.agentSessionId,
                pane.agentResumable ? 1 : 0,
                pane.ended ? 1 : 0,
                pane.createdAt,
            );
    }

    updatePane(id: string, patch: Partial<Pick<Pane, 'sessionId' | 'title' | 'agentSessionId' | 'agentResumable' | 'ended'>>): void {
        const current = this.getPane(id);
        if (!current) {
            return;
        }
        const next = { ...current, ...patch };
        this.db.prepare('update panes set session_id = ?, title = ?, agent_session_id = ?, agent_resumable = ?, ended = ? where id = ?')
            .run(next.sessionId, next.title, next.agentSessionId, next.agentResumable ? 1 : 0, next.ended ? 1 : 0, id);
    }

    deletePane(id: string): void {
        this.db.prepare('delete from panes where id = ?').run(id);
    }

    insertWorkspace(workspace: Workspace): void {
        this.db.prepare('insert into workspaces (id, title, layout, created_at, updated_at) values (?, ?, ?, ?, ?)')
            .run(workspace.id, workspace.title, workspace.layout ? JSON.stringify(workspace.layout) : null, workspace.createdAt, workspace.updatedAt);
    }

    updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'title' | 'layout'>>): void {
        const current = this.getWorkspace(id);
        if (!current) {
            return;
        }
        const next = { ...current, ...patch, updatedAt: Date.now() };
        this.db.prepare('update workspaces set title = ?, layout = ?, updated_at = ? where id = ?')
            .run(next.title, next.layout ? JSON.stringify(next.layout) : null, next.updatedAt, id);
    }

    deleteWorkspace(id: string): void {
        this.db.prepare('delete from workspaces where id = ?').run(id);
    }
}
