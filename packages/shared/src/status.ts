import type { PaneStatus } from './types.ts';

const PRIORITY: Record<PaneStatus, number> = {
    'needs-input': 7,
    done: 6,
    working: 5,
    starting: 4,
    running: 3,
    idle: 2,
    suspended: 1,
    exited: 0,
};

export const STATUS_LABEL: Record<PaneStatus, string> = {
    'needs-input': 'Needs input',
    done: 'Finished',
    working: 'Working',
    starting: 'Starting',
    running: 'Running',
    idle: 'Idle',
    suspended: 'Asleep',
    exited: 'Exited',
};

export function aggregateStatus(statuses: PaneStatus[]): PaneStatus | null {
    if (statuses.length === 0) {
        return null;
    }
    return statuses.reduce((best, status) => (PRIORITY[status] > PRIORITY[best] ? status : best));
}

export function needsAttention(status: PaneStatus): boolean {
    return status === 'needs-input' || status === 'done';
}
