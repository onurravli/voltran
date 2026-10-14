import type { ServerEvent } from '@voltran/shared';
import { wsUrl } from './api.ts';
import { notifyAttention } from './notify.ts';
import { useUi } from './store.ts';

const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
const OFFLINE_DEBOUNCE_MS = 1200;

export function connectEvents(): () => void {
    let socket: WebSocket | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const clearOfflineTimer = (): void => {
        if (offlineTimer) {
            clearTimeout(offlineTimer);
            offlineTimer = null;
        }
    };

    const markOfflineSoon = (): void => {
        if (offlineTimer || useUi.getState().connection === 'offline') {
            return;
        }
        offlineTimer = setTimeout(() => {
            offlineTimer = null;
            if (!stopped && useUi.getState().connection !== 'unauthenticated') {
                useUi.getState().setConnection('offline');
            }
        }, OFFLINE_DEBOUNCE_MS);
    };

    const scheduleRetry = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        try {
            const probe = await fetch('/api/health', { credentials: 'same-origin' });
            if (probe.status === 401) {
                clearOfflineTimer();
                useUi.getState().setConnection('unauthenticated');
                return;
            }
        } catch {
            // daemon down; keep retrying
        }
        const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt += 1;
        retryTimer = setTimeout(open, delay);
    };

    const open = (): void => {
        retryTimer = null;
        if (stopped) {
            return;
        }
        const current = new WebSocket(wsUrl('/ws/events'));
        socket = current;

        current.onopen = () => {
            attempt = 0;
            clearOfflineTimer();
            useUi.getState().setConnection('online');
        };
        current.onmessage = (message) => {
            let event: ServerEvent;
            try {
                event = JSON.parse(String(message.data)) as ServerEvent;
            } catch {
                return;
            }
            if (event.type === 'settings') {
                useUi.getState().applySettings({ settings: event.settings, problems: event.problems, exists: event.exists, path: event.path });
            } else if (event.type === 'state') {
                useUi.getState().setApp(event.state);
            } else if (event.type === 'version') {
                useUi.getState().setVersion({ ui: event.ui, behind: event.behind });
            } else if (event.type === 'attention') {
                notifyAttention(event);
            }
        };
        current.onclose = () => {
            if (socket !== current) {
                return;
            }
            socket = null;
            markOfflineSoon();
            void scheduleRetry();
        };
    };

    open();

    return () => {
        stopped = true;
        clearOfflineTimer();
        if (retryTimer) {
            clearTimeout(retryTimer);
        }
        const current = socket;
        socket = null;
        current?.close();
    };
}
