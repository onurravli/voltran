import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateNotice } from '@voltran/shared';

export const LATEST_URL = 'https://registry.npmjs.org/voltran/latest';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WAKE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export type Fetch = (
    url: string,
    init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

interface Cache {
    checkedAt: number;
    latest: string | null;
}

// Whether `latest` is a newer release than `current`. A pre-release counts as older than its release,
// and an unreadable version is never newer, so a strange registry answer shows nothing.
export function isNewer(latest: string, current: string): boolean {
    const a = VERSION.exec(latest);
    const b = VERSION.exec(current);
    if (!a || !b) {
        return false;
    }
    for (let index = 1; index <= 3; index++) {
        const difference = Number(a[index]) - Number(b[index]);
        if (difference !== 0) {
            return difference > 0;
        }
    }
    if (a[4] === undefined || b[4] === undefined) {
        return a[4] === undefined && b[4] !== undefined;
    }
    return a[4].localeCompare(b[4], undefined, { numeric: true }) > 0;
}

// Why this copy does not check, or null when it does: a development daemon or a git checkout is
// updated by hand, and the user can turn the check off with a setting or the environment.
export function skipReason(options: {
    dev: boolean;
    repoRoot: string;
    env: NodeJS.ProcessEnv;
    setting: boolean;
}): string | null {
    if (options.env.VOLTRAN_NO_UPDATE_CHECK) {
        return 'turned off by VOLTRAN_NO_UPDATE_CHECK';
    }
    if (!options.setting) {
        return 'turned off in settings (updates.check)';
    }
    if (options.dev) {
        return 'not checked by a development daemon';
    }
    if (existsSync(join(options.repoRoot, '.git'))) {
        return 'not checked in a git checkout';
    }
    return null;
}

// One request, to the npm registry, for the version number of the latest release: no id and no
// headers of Voltran's own. Any failure reads as null and is not retried.
export async function fetchLatest(fetchImpl: Fetch = fetch as unknown as Fetch): Promise<string | null> {
    try {
        const response = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as { version?: unknown } | null;
        return typeof body?.version === 'string' && VERSION.test(body.version) ? body.version : null;
    } catch {
        return null;
    }
}

function readCache(file: string): Cache | null {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Cache>;
        return typeof raw.checkedAt === 'number'
            ? {
                  checkedAt: raw.checkedAt,
                  latest: typeof raw.latest === 'string' && VERSION.test(raw.latest) ? raw.latest : null,
              }
            : null;
    } catch {
        return null;
    }
}

export interface UpdateCheckerOptions {
    cacheFile: string;
    current: string;
    skip: () => string | null;
    onChange: () => void;
    fetch?: Fetch;
    now?: () => number;
}

// Asks the registry at start and then once a day, remembering the answer in the cache so a restart
// does not ask again. It only tells; installing is left to the user, since a restart ends the agents.
export class UpdateChecker {
    private readonly options: UpdateCheckerOptions;
    private cache: Cache | null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private checking = false;

    constructor(options: UpdateCheckerOptions) {
        this.options = options;
        this.cache = readCache(options.cacheFile);
    }

    start(): void {
        void this.checkIfDue();
        this.timer = setInterval(() => void this.checkIfDue(), WAKE_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = null;
    }

    // Settings changed: turning the check on asks now if the last answer is old, turning it off hides
    // the notice straight away.
    settingsChanged(): void {
        this.options.onChange();
        void this.checkIfDue();
    }

    notice(): UpdateNotice | null {
        const latest = this.cache?.latest;
        if (this.options.skip() !== null || !latest || !isNewer(latest, this.options.current)) {
            return null;
        }
        return { current: this.options.current, latest };
    }

    async checkIfDue(): Promise<void> {
        const now = (this.options.now ?? Date.now)();
        if (
            this.checking ||
            this.options.skip() !== null ||
            (this.cache && now - this.cache.checkedAt < CHECK_INTERVAL_MS)
        ) {
            return;
        }
        this.checking = true;
        try {
            const latest = await fetchLatest(this.options.fetch);
            const before = this.notice();
            this.cache = { checkedAt: now, latest: latest ?? this.cache?.latest ?? null };
            try {
                writeFileSync(this.options.cacheFile, `${JSON.stringify(this.cache)}\n`, { mode: 0o600 });
            } catch {
                // Only the next start asks again.
            }
            const after = this.notice();
            if (before?.latest !== after?.latest) {
                this.options.onChange();
            }
        } finally {
            this.checking = false;
        }
    }
}
