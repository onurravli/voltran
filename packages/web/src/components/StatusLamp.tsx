import type { PaneStatus } from '@voltran/shared';
import { STATUS_LABEL } from '@voltran/shared';

interface StatusLampProps {
    status: PaneStatus | null;
    failed?: boolean;
    size?: 'sm' | 'md';
}

export function StatusLamp({ status, failed = false, size = 'md' }: StatusLampProps) {
    const variant = status ?? 'empty';
    const label = status ? (failed ? 'Exited with an error' : STATUS_LABEL[status]) : 'No panes';
    return (
        <span
            className={`lamp lamp--${variant} lamp--${size}${failed ? ' lamp--failed' : ''}`}
            role="img"
            aria-label={label}
            title={label}
        />
    );
}
