import { useState } from 'react';
import { useUi } from '../store.ts';
import { updateNotice, type UpdateNotice } from '../version.ts';
import { CloseIcon } from './Icons.tsx';

declare const __VOLTRAN_UI__: string;

const MESSAGES: Record<UpdateNotice, React.ReactNode> = {
    reload: 'Voltran’s UI was updated.',
    'restart-daemon': <>The daemon is running older code. Restart it: <code>voltran restart</code></>,
    rebuild: <>This UI build is older than the daemon. Run <code>npm run build</code>, then reload.</>,
    'rebuild-and-restart': <>Voltran’s code changed. Run <code>npm run build</code>, then <code>voltran restart</code>.</>,
};

export function UpdateBanner() {
    const version = useUi((state) => state.version);
    const notice = updateNotice(__VOLTRAN_UI__, version);
    const key = `${notice}:${version?.ui}`;
    const [dismissed, setDismissed] = useState<string | null>(null);

    if (!notice || dismissed === key) {
        return null;
    }
    return (
        <div className={`update update--${notice}`} role="status">
            {notice === 'reload' ? null : <span className="lamp lamp--sm update__lamp" />}
            <span>{MESSAGES[notice]}</span>
            {notice === 'reload' ? (
                <button type="button" className="button button--small button--primary" onClick={() => window.location.reload()}>Reload</button>
            ) : null}
            <button type="button" className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(key)}>
                <CloseIcon size={13} />
            </button>
        </div>
    );
}
