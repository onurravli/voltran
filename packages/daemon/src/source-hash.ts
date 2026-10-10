import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PROTOCOL_SOURCES = ['shared/src'] as const;
export const UI_SOURCES = ['shared/src', 'web/src', 'web/index.html'] as const;

function sourceFiles(path: string): string[] {
    if (!existsSync(path)) {
        return [];
    }
    if (statSync(path).isFile()) {
        return [path];
    }
    return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || !entry.name.endsWith('.test.ts'))
        .flatMap((entry) => sourceFiles(join(path, entry.name)));
}

export function sourceHash(packagesDir: string, paths: readonly string[]): string {
    const hash = createHash('sha256');
    const files = paths.flatMap((path) => sourceFiles(join(packagesDir, path))).sort();
    for (const file of files) {
        hash.update(relative(packagesDir, file)).update('\0').update(readFileSync(file)).update('\0');
    }
    return hash.digest('hex').slice(0, 16);
}
