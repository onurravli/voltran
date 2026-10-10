import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionInfo } from '@voltran/shared';
import { PROTOCOL_SOURCES, sourceHash } from './source-hash.ts';

interface Built {
    ui: string;
    protocol: string;
}

function readBuilt(file: string): Built | null {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Built> | null;
        return parsed && typeof parsed.ui === 'string' && typeof parsed.protocol === 'string' ? { ui: parsed.ui, protocol: parsed.protocol } : null;
    } catch {
        return null;
    }
}

// The protocol hash is taken once, at start, because it must describe the code this process loaded.
export class VersionWatch {
    private readonly packagesDir: string;
    private readonly file: string;
    private readonly protocol: string;
    private stamp: number | null = null;
    private info: VersionInfo = { ui: null, behind: null };

    constructor(packagesDir: string, webDist: string) {
        this.packagesDir = packagesDir;
        this.file = join(webDist, 'version.json');
        this.protocol = sourceHash(packagesDir, PROTOCOL_SOURCES);
        this.refresh();
    }

    current(): VersionInfo {
        return this.info;
    }

    refresh(): boolean {
        let stamp: number;
        try {
            stamp = statSync(this.file).mtimeMs;
        } catch {
            stamp = 0;
        }
        if (stamp === this.stamp) {
            return false;
        }
        this.stamp = stamp;
        const built = readBuilt(this.file);
        let behind: VersionInfo['behind'] = null;
        if (built && built.protocol !== this.protocol) {
            const onDisk = sourceHash(this.packagesDir, PROTOCOL_SOURCES);
            behind = onDisk === built.protocol ? 'daemon' : onDisk === this.protocol ? 'ui' : 'both';
        }
        const next: VersionInfo = { ui: built?.ui ?? null, behind };
        const changed = next.ui !== this.info.ui || next.behind !== this.info.behind;
        this.info = next;
        return changed;
    }
}
