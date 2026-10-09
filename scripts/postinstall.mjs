// node-pty's npm tarball ships the macOS prebuilt spawn-helper without the exec bit,
// which makes every spawn fail with "posix_spawnp failed".
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let root;
try {
    root = dirname(require.resolve('node-pty/package.json', { paths: ['packages/daemon'] }));
} catch {
    process.exit(0);
}

const prebuilds = join(root, 'prebuilds');
if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
        const helper = join(prebuilds, platform, 'spawn-helper');
        if (existsSync(helper)) {
            chmodSync(helper, 0o755);
        }
    }
}
