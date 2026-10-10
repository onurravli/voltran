import type { VersionInfo } from '@voltran/shared';

export type UpdateNotice = 'reload' | 'restart-daemon' | 'rebuild' | 'rebuild-and-restart';

export function updateNotice(page: string, info: VersionInfo | null): UpdateNotice | null {
    if (page === 'dev' || !info) {
        return null;
    }
    if (info.behind === 'daemon') {
        return 'restart-daemon';
    }
    if (info.behind === 'ui') {
        return 'rebuild';
    }
    if (info.behind === 'both') {
        return 'rebuild-and-restart';
    }
    return info.ui && info.ui !== page ? 'reload' : null;
}
