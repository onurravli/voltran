export type AdapterId = 'claude' | 'codex' | 'gemini' | 'shell' | 'command' | 'subagent';

export type PaneKind = 'agent' | 'shell' | 'process';

export type StatusSource = 'hooks' | 'heuristic' | 'process';

export type PaneStatus =
    | 'suspended'
    | 'starting'
    | 'working'
    | 'needs-input'
    | 'done'
    | 'idle'
    | 'running'
    | 'exited';

export type LayoutDirection = 'horizontal' | 'vertical';

export interface LayoutLeaf {
    type: 'pane';
    paneId: string;
}

export interface LayoutSplit {
    type: 'split';
    direction: LayoutDirection;
    children: Layout[];
    sizes: number[];
}

export type Layout = LayoutLeaf | LayoutSplit;

export interface Project {
    id: string;
    name: string;
    path: string;
    color: string;
    createdAt: number;
}

export interface Session {
    id: string;
    projectId: string;
    title: string;
    link: string | null;
    cwd: string;
    layout: Layout | null;
    archived: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface Pane {
    id: string;
    sessionId: string;
    adapter: AdapterId;
    title: string;
    command: string | null;
    cwd: string;
    agentSessionId: string | null;
    agentResumable: boolean;
    ended: boolean;
    createdAt: number;
}

export interface SubagentView {
    id: string;
    type: string;
    description: string;
    background: boolean;
    startedAt: number;
}

export type TranscriptEntry =
    | { kind: 'prompt'; text: string; at: number | null }
    | { kind: 'text'; text: string; at: number | null }
    | { kind: 'tool'; id: string; name: string; summary: string; at: number | null }
    | { kind: 'result'; toolUseId: string; text: string; error: boolean; at: number | null };

export interface TranscriptChunk {
    entries: TranscriptEntry[];
    next: number;
    skipped: number;
}

export interface PaneRuntimeState {
    status: PaneStatus;
    statusAt: number;
    detail: string | null;
    exitCode: number | null;
    pid: number | null;
    foreground: string | null;
    subagents: SubagentView[];
}

export type PaneView = Pane & PaneRuntimeState;

export interface AdapterInfo {
    id: AdapterId;
    label: string;
    kind: PaneKind;
    statusSource: StatusSource;
    resumable: boolean;
    available: boolean;
}

export interface AppState {
    projects: Project[];
    sessions: Session[];
    panes: PaneView[];
    adapters: AdapterInfo[];
}

export interface PaneSpec {
    adapter: AdapterId;
    title?: string;
    command?: string;
}

export interface CreateProjectBody {
    name?: string;
    path: string;
    color?: string;
}

export interface UpdateProjectBody {
    name?: string;
    color?: string;
}

export interface CreateSessionBody {
    projectId: string;
    title: string;
    link?: string | null;
    panes?: PaneSpec[];
}

export interface UpdateSessionBody {
    title?: string;
    link?: string | null;
    archived?: boolean;
    layout?: Layout | null;
}

export interface CreatePaneBody extends PaneSpec {
    splitFrom?: string;
    direction?: LayoutDirection;
}

export interface UpdatePaneBody {
    title?: string;
}

export interface MovePaneBody {
    sessionId: string;
}

export type AttentionStatus = 'needs-input' | 'done' | 'exited';

export interface VersionInfo {
    ui: string | null;
    behind: 'daemon' | 'ui' | 'both' | null;
}

export type ServerEvent =
    | { type: 'state'; state: AppState }
    | ({ type: 'version' } & VersionInfo)
    | {
        type: 'attention';
        paneId: string;
        sessionId: string;
        status: AttentionStatus;
        title: string;
        body: string;
    };

export type PaneServerMessage =
    | { type: 'snapshot'; data: string; cols: number; rows: number }
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'exit'; code: number | null };

export type PaneClientMessage =
    | { type: 'input'; data: string }
    | { type: 'resize'; cols: number; rows: number };
