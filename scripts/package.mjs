// Node does not strip types from files under node_modules, so the published package carries the
// daemon and shared code compiled to JavaScript, in the same layout as the repository.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_SOURCES, sourceHash } from '../packages/daemon/src/source-hash.ts';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build', 'npm');
const daemonOut = join(out, 'packages', 'daemon', 'src');

function run(command, args) {
    execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function readJson(path) {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

rmSync(out, { recursive: true, force: true });
run('npm', ['run', 'build']);
run('npx', ['tsc', '-p', 'tsconfig.package.json']);

for (const name of readdirSync(daemonOut).filter((file) => file.endsWith('.js'))) {
    const file = join(daemonOut, name);
    const code = readFileSync(file, 'utf8').replaceAll(`from '@voltran/shared'`, `from '../../shared/src/index.js'`);
    if (code.includes('@voltran/shared')) {
        throw new Error(`${name} still imports @voltran/shared`);
    }
    writeFileSync(file, code);
}

for (const name of ['notes-hook.sh', 'statusline.sh']) {
    cpSync(join(root, 'packages/daemon/src', name), join(daemonOut, name));
}
mkdirSync(join(daemonOut, 'opencode-plugin'));
cpSync(join(root, 'packages/daemon/src/opencode-plugin/index.ts'), join(daemonOut, 'opencode-plugin/index.ts'));
cpSync(join(root, 'packages/web/dist'), join(out, 'packages/web/dist'), { recursive: true });
cpSync(join(root, 'scripts/postinstall.mjs'), join(out, 'scripts/postinstall.mjs'));
for (const name of ['README.md', 'LICENSE.md', 'SECURITY.md']) {
    cpSync(join(root, name), join(out, name));
}

mkdirSync(join(out, 'bin'));
const bin = join(out, 'bin/voltran.mjs');
writeFileSync(bin, readFileSync(join(root, 'bin/voltran.mjs'), 'utf8').replace('/cli.ts', '/cli.js'));
chmodSync(bin, 0o755);

const versionFile = join(out, 'packages/web/dist/version.json');
const version = JSON.parse(readFileSync(versionFile, 'utf8'));
writeFileSync(
    versionFile,
    JSON.stringify({ ...version, protocol: sourceHash(join(out, 'packages'), PROTOCOL_SOURCES) }),
);

const manifest = readJson('package.json');
const { '@voltran/shared': _, ...dependencies } = readJson('packages/daemon/package.json').dependencies;
writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(
        {
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            keywords: ['claude-code', 'codex', 'opencode', 'agents', 'terminal', 'orchestrator'],
            type: 'module',
            license: manifest.license,
            author: manifest.author,
            homepage: manifest.homepage,
            repository: manifest.repository,
            bugs: manifest.bugs,
            engines: manifest.engines,
            os: ['darwin', 'linux'],
            bin: manifest.bin,
            scripts: { postinstall: 'node scripts/postinstall.mjs' },
            dependencies,
        },
        null,
        2,
    )}\n`,
);

console.log(`Packaged ${manifest.name}@${manifest.version} in ${out}`);
