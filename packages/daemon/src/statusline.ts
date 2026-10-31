import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Usage, UsageWindow } from '@voltran/shared';

function windowOf(value: unknown): UsageWindow | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const { used_percentage: used, resets_at: resets } = value as Record<string, unknown>;
    if (typeof used !== 'number' || !Number.isFinite(used)) {
        return null;
    }
    return {
        usedPercent: Math.min(100, Math.max(0, used)),
        // Claude Code reports the reset in epoch seconds.
        resetsAt: typeof resets === 'number' && Number.isFinite(resets) && resets > 0 ? resets * 1000 : null,
    };
}

// Every pane reports the limits from its own last response, so a quiet pane can report an older view of
// a window than a busy one: within one window usage only grows, and a later reset is a newer window.
function newerWindow(current: UsageWindow | null, next: UsageWindow | null): UsageWindow | null {
    if (!next) {
        return current;
    }
    if (!current || current.resetsAt === null || next.resetsAt === null || next.resetsAt > current.resetsAt) {
        return next;
    }
    return next.resetsAt === current.resetsAt && next.usedPercent > current.usedPercent ? next : current;
}

const sameWindow = (a: UsageWindow | null, b: UsageWindow | null): boolean =>
    a === b || (a !== null && b !== null && a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt);

export function mergeUsage(current: Usage | null, payload: Record<string, unknown>): Usage | null {
    const limits = payload.rate_limits;
    if (!limits || typeof limits !== 'object') {
        return current;
    }
    const reported = limits as Record<string, unknown>;
    const fiveHour = newerWindow(current?.fiveHour ?? null, windowOf(reported.five_hour));
    const sevenDay = newerWindow(current?.sevenDay ?? null, windowOf(reported.seven_day));
    if (
        (!fiveHour && !sevenDay) ||
        (current && sameWindow(fiveHour, current.fiveHour) && sameWindow(sevenDay, current.sevenDay))
    ) {
        return current;
    }
    return { fiveHour, sevenDay };
}

function statusLineIn(file: string): string | null {
    try {
        const settings: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const statusLine =
            settings && typeof settings === 'object' ? (settings as Record<string, unknown>).statusLine : undefined;
        const command =
            statusLine && typeof statusLine === 'object' ? (statusLine as Record<string, unknown>).command : undefined;
        return typeof command === 'string' && command.trim() ? command : null;
    } catch {
        return null;
    }
}

function repositoryRoot(dir: string): string | null {
    for (let current = dir; ; current = dirname(current)) {
        if (existsSync(join(current, '.git'))) {
            return current;
        }
        if (dirname(current) === current) {
            return null;
        }
    }
}

// Voltran's --settings outranks the user's and the project's settings, so its status line runs the one
// Claude would have shown. Claude reads settings.local.json at the repository root as well as in the
// folder it starts in, and settings.json only in that folder.
// Claude runs no status line, wherever it comes from, until the folder is trusted, so a project's
// command still waits for that.
export function userStatusLine(cwd: string, configDir: string | null): string | null {
    const root = repositoryRoot(cwd);
    const files = [
        ...(root && root !== cwd ? [join(root, '.claude', 'settings.local.json')] : []),
        join(cwd, '.claude', 'settings.local.json'),
        join(cwd, '.claude', 'settings.json'),
        ...(configDir ? [join(configDir, 'settings.json')] : []),
    ];
    for (const file of files) {
        const command = statusLineIn(file);
        if (command) {
            return command;
        }
    }
    return null;
}
