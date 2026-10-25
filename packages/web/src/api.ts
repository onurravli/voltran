import type {
    ConversationChunk,
    CreatePaneBody,
    CreateProjectBody,
    CreateSessionBody,
    CreateWorkspaceBody,
    Diagnostics,
    EditSettingsBody,
    FileContents,
    MovePaneBody,
    NotesLockBody,
    NotesMeta,
    Pane,
    PaneNotes,
    Project,
    ProjectGit,
    PushPairingView,
    PushState,
    SaveNotesBody,
    Session,
    SessionChanges,
    SettingsPatch,
    SettingsState,
    SlashCommand,
    UpdatePaneBody,
    UpdateProjectBody,
    UpdateSessionBody,
    UpdateWorkspaceBody,
    Workspace,
    WorktreeChoice,
} from '@voltran/shared';

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const SESSION_KEY = 'voltran.session';
const WS_PROTOCOL = 'voltran';
const RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The credential this window signed in with. It stays in this origin's storage and goes out as a
// header, never as a cookie, which the browser would also send to every other port on this host.
function browserSession(): string | null {
    try {
        return localStorage.getItem(SESSION_KEY);
    } catch {
        return null;
    }
}

export function authHeaders(): Record<string, string> {
    const session = browserSession();
    return session ? { Authorization: `Bearer ${session}` } : {};
}

export function socketProtocols(): string[] {
    const session = browserSession();
    return session ? [WS_PROTOCOL, session] : [WS_PROTOCOL];
}

// `voltran up` opens /auth?code=…: the one-time code is traded for this window's credential and
// dropped from the address bar before anything else runs.
// Resolves to the session `voltran new` asked the window to open, if any.
export async function signInFromUrl(): Promise<string | null> {
    if (window.location.pathname !== '/auth') {
        return null;
    }
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    window.history.replaceState(null, '', '/');
    if (!code) {
        return null;
    }
    // On failure the window stays signed out and says how to sign in.
    await storeSession(
        fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }),
    );
    return params.get('session');
}

async function storeSession(response: Promise<Response>): Promise<void> {
    try {
        const reply = await response;
        const body = reply.ok ? ((await reply.json()) as { session?: unknown }) : null;
        if (typeof body?.session === 'string') {
            localStorage.setItem(SESSION_KEY, body.session);
        }
    } catch {
        // The window keeps the credential it has.
    }
}

// A credential lapses a while after it was issued, so a window trades it for a fresh one when it loads
// and every few hours while it stays open.
export function keepSessionFresh(): void {
    const renew = (): void => {
        if (browserSession()) {
            void storeSession(fetch('/api/session/renew', { method: 'POST', headers: authHeaders() }));
        }
    };
    renew();
    setInterval(renew, RENEW_INTERVAL_MS);
}

async function request<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
    const init: RequestInit = {
        method,
        headers: { ...authHeaders(), ...(body === undefined || body instanceof Blob ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
        keepalive,
    };

    let response: Response;
    try {
        response = await fetch(path, init);
    } catch {
        throw new ApiError(0, 'Voltran is not reachable. Is the daemon running?');
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
    }
    if (!response.ok) {
        const message =
            parsed && typeof parsed === 'object' && 'error' in parsed ? String(parsed.error) : `Request failed (${response.status})`;
        throw new ApiError(response.status, message);
    }
    return parsed as T;
}

export const api = {
    createProject: (body: CreateProjectBody) => request<Project>('POST', '/api/projects', body),
    updateProject: (id: string, body: UpdateProjectBody) => request<Project>('PATCH', `/api/projects/${id}`, body),
    deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
    projectGit: (id: string) => request<ProjectGit>('GET', `/api/projects/${id}/git`),
    createSession: (body: CreateSessionBody) => request<Session>('POST', '/api/sessions', body),
    updateSession: (id: string, body: UpdateSessionBody) => request<Session>('PATCH', `/api/sessions/${id}`, body),
    deleteSession: (id: string, worktree?: WorktreeChoice) =>
        request<void>('DELETE', `/api/sessions/${id}${worktree ? `?worktree=${worktree}` : ''}`),
    createWorkspace: (body: CreateWorkspaceBody) => request<Workspace>('POST', '/api/workspaces', body),
    updateWorkspace: (id: string, body: UpdateWorkspaceBody) => request<Workspace>('PATCH', `/api/workspaces/${id}`, body),
    deleteWorkspace: (id: string) => request<void>('DELETE', `/api/workspaces/${id}`),
    createPane: (sessionId: string, body: CreatePaneBody) => request<Pane>('POST', `/api/sessions/${sessionId}/panes`, body),
    updatePane: (id: string, body: UpdatePaneBody) => request<Pane>('PATCH', `/api/panes/${id}`, body),
    deletePane: (id: string) => request<void>('DELETE', `/api/panes/${id}`),
    movePane: (id: string, body: MovePaneBody) => request<Pane>('POST', `/api/panes/${id}/move`, body),
    restartPane: (id: string) => request<void>('POST', `/api/panes/${id}/restart`),
    killPane: (id: string) => request<void>('POST', `/api/panes/${id}/kill`),
    seenPane: (id: string) => request<void>('POST', `/api/panes/${id}/seen`),
    commands: (paneId: string) => request<SlashCommand[]>('GET', `/api/panes/${encodeURIComponent(paneId)}/commands`),
    attach: (paneId: string, image: Blob) =>
        request<{ path: string }>('POST', `/api/panes/${encodeURIComponent(paneId)}/attachments`, image),
    paneNotes: (id: string) => request<PaneNotes>('GET', `/api/panes/${id}/notes`),
    saveNotes: (id: string, body: SaveNotesBody, keepalive = false) => request<PaneNotes>('PUT', `/api/panes/${id}/notes`, body, keepalive),
    lockNotes: (id: string, body: NotesLockBody) => request<NotesMeta>('POST', `/api/panes/${id}/notes/lock`, body),
    unlockNotes: (id: string, body: NotesLockBody) => request<void>('POST', `/api/panes/${id}/notes/unlock`, body),
    updateSettings: (patch: SettingsPatch) => request<SettingsState>('PATCH', '/api/settings', patch),
    openSettings: () => request<{ path: string }>('POST', '/api/settings/open'),
    editSettings: (body: EditSettingsBody) => request<Pane>('POST', '/api/settings/edit', body),
    startPairing: () => request<PushPairingView>('POST', '/api/push/pairing'),
    stopPairing: () => request<void>('DELETE', '/api/push/pairing'),
    testPush: (deviceId: string) => request<PushState>('POST', `/api/push/devices/${encodeURIComponent(deviceId)}/test`),
    removePushDevice: (deviceId: string) => request<void>('DELETE', `/api/push/devices/${encodeURIComponent(deviceId)}`),
    health: () => request<{ version: string }>('GET', '/api/health'),
    diagnostics: () => request<Diagnostics>('GET', '/api/diagnostics'),
    changes: (sessionId: string) => request<SessionChanges>('GET', `/api/sessions/${sessionId}/changes`),
    contents: (sessionId: string, path: string) =>
        request<FileContents>('GET', `/api/sessions/${sessionId}/contents?path=${encodeURIComponent(path)}`),
    conversation: (paneId: string, source: string | null, from: number) =>
        request<ConversationChunk>(
            'GET',
            `/api/panes/${encodeURIComponent(paneId)}/conversation?${new URLSearchParams({ source: source ?? '', from: String(from) })}`,
        ),
    viewSubagent: (paneId: string, agentId: string) =>
        request<Pane>('POST', `/api/panes/${encodeURIComponent(paneId)}/subagents/${encodeURIComponent(agentId)}/view`),
};

export function wsUrl(path: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${path}`;
}
