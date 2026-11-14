import { execFileSync } from 'node:child_process';

// A git hook runs with GIT_DIR and its kin pointing at this repository, and every git command a test
// runs would inherit them and commit, configure and check out here instead of in its own temporary
// repository. These are the variables git itself clears before it enters a submodule.
export function clearRepositoryEnv(): void {
    for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n')) {
        if (name) {
            delete process.env[name];
        }
    }
}
