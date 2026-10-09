import type {
    CreatePaneBody,
    CreateProjectBody,
    CreateSessionBody,
    Pane,
    Project,
    Session,
    UpdatePaneBody,
    UpdateProjectBody,
    UpdateSessionBody,
} from '@voltran/shared';

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
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
        const message = parsed && typeof parsed === 'object' && 'error' in parsed ? String(parsed.error) : `Request failed (${response.status})`;
        throw new ApiError(response.status, message);
    }
    return parsed as T;
}

export const api = {
    createProject: (body: CreateProjectBody) => request<Project>('POST', '/api/projects', body),
    updateProject: (id: string, body: UpdateProjectBody) => request<Project>('PATCH', `/api/projects/${id}`, body),
    deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
    createSession: (body: CreateSessionBody) => request<Session>('POST', '/api/sessions', body),
    updateSession: (id: string, body: UpdateSessionBody) => request<Session>('PATCH', `/api/sessions/${id}`, body),
    deleteSession: (id: string) => request<void>('DELETE', `/api/sessions/${id}`),
    createPane: (sessionId: string, body: CreatePaneBody) => request<Pane>('POST', `/api/sessions/${sessionId}/panes`, body),
    updatePane: (id: string, body: UpdatePaneBody) => request<Pane>('PATCH', `/api/panes/${id}`, body),
    deletePane: (id: string) => request<void>('DELETE', `/api/panes/${id}`),
    restartPane: (id: string) => request<void>('POST', `/api/panes/${id}/restart`),
    killPane: (id: string) => request<void>('POST', `/api/panes/${id}/kill`),
    seenPane: (id: string) => request<void>('POST', `/api/panes/${id}/seen`),
    viewSubagent: (paneId: string, agentId: string) =>
        request<Pane>('POST', `/api/panes/${encodeURIComponent(paneId)}/subagents/${encodeURIComponent(agentId)}/view`),
};

export function wsUrl(path: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${path}`;
}
