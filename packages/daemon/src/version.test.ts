import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_SOURCES, sourceHash } from './source-hash.ts';
import { VersionWatch } from './version.ts';

const dirs: string[] = [];

afterEach(() => {
    while (dirs.length > 0) {
        rmSync(dirs.pop()!, { recursive: true, force: true });
    }
});

function packages(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-version-'));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
}

let tick = 1_700_000_000;

function writeBuild(dir: string, ui: string, protocol: string): void {
    const file = join(dir, 'web/dist/version.json');
    mkdirSync(join(dir, 'web/dist'), { recursive: true });
    writeFileSync(file, JSON.stringify({ ui, protocol }));
    tick += 10;
    utimesSync(file, tick, tick);
}

describe('sourceHash', () => {
    it('depends on file names and contents but not on tests', () => {
        const a = packages({ 'shared/src/types.ts': 'export type A = 1;', 'shared/src/types.test.ts': 'one' });
        const b = packages({ 'shared/src/types.ts': 'export type A = 1;', 'shared/src/types.test.ts': 'two' });
        const c = packages({ 'shared/src/types.ts': 'export type A = 2;' });
        const d = packages({ 'shared/src/other.ts': 'export type A = 1;' });
        expect(sourceHash(a, PROTOCOL_SOURCES)).toBe(sourceHash(b, PROTOCOL_SOURCES));
        expect(sourceHash(a, PROTOCOL_SOURCES)).not.toBe(sourceHash(c, PROTOCOL_SOURCES));
        expect(sourceHash(a, PROTOCOL_SOURCES)).not.toBe(sourceHash(d, PROTOCOL_SOURCES));
    });

    it('skips paths that do not exist', () => {
        const dir = packages({ 'shared/src/types.ts': 'x' });
        expect(sourceHash(dir, ['shared/src', 'web/index.html'])).toBe(sourceHash(dir, ['shared/src']));
    });
});

describe('VersionWatch', () => {
    it('reports the build and nothing behind when the build matches the running code', () => {
        const dir = packages({ 'shared/src/types.ts': 'v1' });
        writeBuild(dir, 'ui-1', sourceHash(dir, PROTOCOL_SOURCES));
        expect(new VersionWatch(dir, join(dir, 'web/dist')).current()).toEqual({ ui: 'ui-1', behind: null });
    });

    it('reports nothing without a build', () => {
        const dir = packages({ 'shared/src/types.ts': 'v1' });
        expect(new VersionWatch(dir, join(dir, 'web/dist')).current()).toEqual({ ui: null, behind: null });
    });

    it('blames the daemon when the build is newer than the code it loaded', () => {
        const dir = packages({ 'shared/src/types.ts': 'v1' });
        const watch = new VersionWatch(dir, join(dir, 'web/dist'));
        writeFileSync(join(dir, 'shared/src/types.ts'), 'v2');
        writeBuild(dir, 'ui-2', sourceHash(dir, PROTOCOL_SOURCES));
        expect(watch.refresh()).toBe(true);
        expect(watch.current()).toEqual({ ui: 'ui-2', behind: 'daemon' });
        expect(watch.refresh()).toBe(false);
    });

    it('blames the build when the daemon runs newer code than it', () => {
        const dir = packages({ 'shared/src/types.ts': 'v1' });
        const old = sourceHash(dir, PROTOCOL_SOURCES);
        writeFileSync(join(dir, 'shared/src/types.ts'), 'v2');
        writeBuild(dir, 'ui-1', old);
        expect(new VersionWatch(dir, join(dir, 'web/dist')).current()).toEqual({ ui: 'ui-1', behind: 'ui' });
    });

    it('blames both when the code changed after the build and after the daemon started', () => {
        const dir = packages({ 'shared/src/types.ts': 'v1' });
        writeBuild(dir, 'ui-0', 'some-older-protocol');
        const watch = new VersionWatch(dir, join(dir, 'web/dist'));
        writeFileSync(join(dir, 'shared/src/types.ts'), 'v2');
        writeBuild(dir, 'ui-0', 'some-older-protocol');
        watch.refresh();
        expect(watch.current()).toEqual({ ui: 'ui-0', behind: 'both' });
    });
});
