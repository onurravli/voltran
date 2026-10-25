import { spawnSync } from 'node:child_process';

const HOOKS = '.githooks';

function git(args) {
    return spawnSync('git', args, { encoding: 'utf8' });
}

const inside = git(['rev-parse', '--is-inside-work-tree']);
if (inside.error || inside.stdout.trim() !== 'true') {
    process.exit(0);
}
const current = git(['config', '--local', '--get', 'core.hooksPath']).stdout.trim();
if (current === HOOKS) {
    process.exit(0);
}
if (current !== '') {
    console.warn(`core.hooksPath is already ${current}; leaving it. Run "git config core.hooksPath ${HOOKS}" to use Voltran's hooks.`);
    process.exit(0);
}
git(['config', '--local', 'core.hooksPath', HOOKS]);
