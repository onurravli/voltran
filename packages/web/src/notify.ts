import type { ServerEvent } from '@voltran/shared';
import { api } from './api.ts';
import { attentionPanes, useUi } from './store.ts';

type AttentionEvent = Extract<ServerEvent, { type: 'attention' }>;

const BASE_ICON = '/favicon.svg';

const ATTENTION_ICON = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#181c26"/>'
    + '<g transform="translate(16 17.1) scale(0.9) translate(-16 -17.1)" stroke-linecap="round" stroke-width="3.4">'
    + '<path d="M6 7l3.4 7.4" stroke="#7aa2f7"/><path d="M11 18l2.8 6.2" stroke="#f7768e"/>'
    + '<path d="M18.2 24.2 21 18" stroke="#9ece6a"/><path d="M22.6 14.4 26 7" stroke="#bb9af7"/></g>'
    + '<circle cx="25" cy="25" r="6" fill="#ffb547" stroke="#181c26" stroke-width="2"/></svg>',
)}`;

export function syncAttentionBadge(): () => void {
    let lastCount = -1;
    return useUi.subscribe((state) => {
        const count = attentionPanes(state.app).length;
        if (count === lastCount) {
            return;
        }
        lastCount = count;
        document.title = count > 0 ? `(${count}) Voltran` : 'Voltran';
        const link = document.getElementById('favicon') as HTMLLinkElement | null;
        if (link) {
            link.href = count > 0 ? ATTENTION_ICON : BASE_ICON;
        }
    });
}

export function notificationsSupported(): boolean {
    return typeof Notification !== 'undefined';
}

export async function enableNotifications(): Promise<NotificationPermission> {
    if (!notificationsSupported()) {
        return 'denied';
    }
    return Notification.requestPermission();
}

export function revealPane(sessionId: string, paneId: string): void {
    const ui = useUi.getState();
    ui.selectSession(sessionId);
    ui.focusPane(paneId);
    void api.seenPane(paneId).catch(() => undefined);
}

export function notifyAttention(event: AttentionEvent): void {
    const { focusedPaneId, selectedSessionId } = useUi.getState();
    const looking = document.visibilityState === 'visible' && document.hasFocus();
    if (looking && focusedPaneId === event.paneId && event.status === 'done') {
        void api.seenPane(event.paneId).catch(() => undefined);
        return;
    }
    if (looking && (focusedPaneId === event.paneId || (selectedSessionId === event.sessionId && event.status === 'done'))) {
        return;
    }
    if (!notificationsSupported() || Notification.permission !== 'granted') {
        return;
    }
    const prefix = event.status === 'needs-input' ? 'Needs input' : event.status === 'done' ? 'Finished' : 'Stopped';
    const notification = new Notification(`${prefix}: ${event.title}`, {
        body: event.body,
        tag: event.paneId,
        silent: event.status === 'done',
    });
    notification.onclick = () => {
        window.focus();
        revealPane(event.sessionId, event.paneId);
        notification.close();
    };
}
