import { useEffect } from 'react';
import { connectEvents } from './events.ts';
import { syncAttentionBadge } from './notify.ts';
import { installShortcuts } from './shortcuts.ts';
import { selectedWorkspace, useUi } from './store.ts';
import { disposeTerminalsExcept } from './terminals.ts';
import { Dialogs, PaneMenu, ToastView } from './components/Dialogs.tsx';
import { FolderIcon, VoltranMark } from './components/Icons.tsx';
import { SessionView } from './components/SessionView.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { WorkspaceView } from './components/WorkspaceView.tsx';

function Welcome() {
    const hasProjects = useUi((state) => (state.app?.projects.length ?? 0) > 0);
    const openDialog = useUi((state) => state.openDialog);

    return (
        <div className="welcome">
            <VoltranMark size={56} />
            {hasProjects ? (
                <>
                    <h1 className="welcome__title">Pick a session, or start one</h1>
                    <p className="welcome__body">A session groups the agents and terminals for one piece of work.</p>
                    <button type="button" className="button button--primary" onClick={() => openDialog({ kind: 'session' })}>Start a session</button>
                </>
            ) : (
                <>
                    <h1 className="welcome__title">Bring your agents into one place</h1>
                    <p className="welcome__body">
                        Add a folder you work in. Each session there gets its own agents and terminals, and Voltran tells you which one is waiting on you.
                    </p>
                    <button type="button" className="button button--primary" onClick={() => openDialog({ kind: 'project' })}>
                        <FolderIcon size={14} /> Add a project
                    </button>
                </>
            )}
        </div>
    );
}

function SignedOut() {
    return (
        <div className="welcome welcome--full">
            <VoltranMark size={56} />
            <h1 className="welcome__title">This window is not signed in</h1>
            <p className="welcome__body">Run <code>voltran up</code> in a terminal. It opens a signed-in window.</p>
        </div>
    );
}

export function App() {
    const connection = useUi((state) => state.connection);
    const app = useUi((state) => state.app);
    const selectedSessionId = useUi((state) => state.selectedSessionId);
    const sidebarHidden = useUi((state) => state.sidebarHidden);
    const sidebarWidth = useUi((state) => state.sidebarWidth);
    const sidebarRight = useUi((state) => state.sidebarPosition === 'right');
    const zen = useUi((state) => state.zen);
    const workspace = useUi(selectedWorkspace);
    const session = app?.sessions.find((entry) => entry.id === selectedSessionId);
    const showing = Boolean(workspace || session);
    const hideSidebar = showing && (sidebarHidden || zen);

    useEffect(() => {
        const stopEvents = connectEvents();
        const stopShortcuts = installShortcuts();
        const stopBadge = syncAttentionBadge();
        return () => {
            stopEvents();
            stopShortcuts();
            stopBadge();
        };
    }, []);

    useEffect(() => {
        if (app) {
            disposeTerminalsExcept(new Set(app.panes.map((pane) => pane.id)));
        }
    }, [app]);

    if (connection === 'unauthenticated') {
        return <SignedOut />;
    }

    return (
        <div
            className={`app${hideSidebar ? ' app--no-sidebar' : ''}${zen && showing ? ' app--zen' : ''}${sidebarRight ? ' app--sidebar-right' : ''}`}
            style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
        >
            <Sidebar />
            <main className="main">
                {!app ? (
                    <div className="loading">Connecting to Voltran…</div>
                ) : workspace ? (
                    <WorkspaceView key={workspace.id} workspace={workspace} />
                ) : session ? (
                    <SessionView key={session.id} session={session} />
                ) : (
                    <Welcome />
                )}
            </main>
            <Dialogs />
            <PaneMenu />
            <ToastView />
            <UpdateBanner />
        </div>
    );
}
