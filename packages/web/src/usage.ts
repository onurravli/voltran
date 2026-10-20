import type { Usage, UsageWindow } from '@voltran/shared';

export type UsageLevel = 'low' | 'warn' | 'high';

export interface UsageRow {
    label: string;
    name: string;
    window: UsageWindow;
}

export function usageRows(usage: Usage | null): UsageRow[] {
    const rows: UsageRow[] = [];
    if (usage?.fiveHour) {
        rows.push({ label: '5h', name: 'Five-hour limit', window: usage.fiveHour });
    }
    if (usage?.sevenDay) {
        rows.push({ label: '7d', name: 'Weekly limit', window: usage.sevenDay });
    }
    return rows;
}

export function usageLevel(usedPercent: number): UsageLevel {
    if (usedPercent > 80) {
        return 'high';
    }
    return usedPercent > 50 ? 'warn' : 'low';
}

export function isReset(window: UsageWindow, now: number): boolean {
    return window.resetsAt !== null && window.resetsAt <= now;
}

export function resetCountdown(resetsAt: number, now: number): string {
    const minutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) {
        return `${days}d${hours}h`;
    }
    return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}
