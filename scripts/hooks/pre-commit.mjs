import { spawnSync } from 'node:child_process';

const TYPECHECKED = /(\.(ts|tsx|mts|mjs|js)|(^|\/)(tsconfig[^/]*|package)\.json)$/;

function git(args) {
    const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.error) {
        throw result.error;
    }
    return result;
}

let failed = false;

const check = git(['diff', '--cached', '--check', '--no-color']);
if (check.status !== 0) {
    failed = true;
    console.error('Trailing whitespace, blank lines at the end of a file or conflict markers:');
    console.error(check.stdout.trimEnd());
}

const diff = git([
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-U0',
]).stdout.split('\n');
const missingNewline = [];
let file = null;
let link = false;
for (let i = 0; i < diff.length; i++) {
    const line = diff[i];
    if (line.startsWith('diff --git ')) {
        link = false;
    } else if (/^(new file mode|new mode|index \S+) 120000$/.test(line)) {
        link = true;
    } else if (line.startsWith('+++ ')) {
        file = link || line === '+++ /dev/null' ? null : line.slice(6);
    } else if (line === '\\ No newline at end of file' && file && diff[i - 1]?.startsWith('+')) {
        missingNewline.push(file);
    }
}
if (missingNewline.length > 0) {
    failed = true;
    console.error('Every file ends with a newline; these do not:');
    for (const name of missingNewline) {
        console.error(`  ${name}`);
    }
}

const biome = spawnSync(
    'node_modules/.bin/biome',
    ['check', '--staged', '--error-on-warnings', '--no-errors-on-unmatched', '--files-ignore-unknown=true'],
    { stdio: 'inherit' },
);
if (biome.error) {
    failed = true;
    console.error('Biome is missing; run npm install.');
} else if (biome.status !== 0) {
    failed = true;
    console.error('Biome found formatting or lint problems; npm run format fixes most of them.');
}

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z']).stdout.split('\0').filter(Boolean);
if (!failed && staged.some((name) => TYPECHECKED.test(name))) {
    const typecheck = spawnSync('npm', ['run', '--silent', 'typecheck'], { stdio: 'inherit' });
    if (typecheck.status !== 0) {
        failed = true;
        console.error('npm run typecheck failed.');
    }
}

if (failed) {
    console.error('\nFix the above and stage it again, or commit with --no-verify to skip these checks.');
    process.exit(1);
}
