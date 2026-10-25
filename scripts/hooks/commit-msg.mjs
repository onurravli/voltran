import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkCommitMessage } from './commit-message.mjs';

const args = process.argv.slice(2);
const messages = [];

if (args[0] === '--range') {
    const log = execFileSync('git', ['log', '--no-merges', '--format=%H%n%B%x00', args[1]], { encoding: 'utf8' });
    for (const entry of log.split('\0')) {
        const text = entry.replace(/^\n/, '');
        if (text.trim() !== '') {
            const newline = text.indexOf('\n');
            messages.push({ label: `commit ${text.slice(0, 12)}`, text: text.slice(newline + 1) });
        }
    }
    if (args[2] === '--title') {
        messages.push({ label: 'pull request title', text: args[3] ?? '' });
    }
} else if (args.length === 1) {
    messages.push({ label: 'commit message', text: readFileSync(args[0], 'utf8') });
} else {
    console.error('usage: commit-msg.mjs <message file> | --range <from>..<to> [--title <text>]');
    process.exit(2);
}

let failed = false;
for (const { label, text } of messages) {
    const problems = checkCommitMessage(text);
    if (problems.length > 0) {
        failed = true;
        console.error(`${label}: ${text.trim().split('\n')[0]}`);
        for (const problem of problems) {
            console.error(`  - ${problem}`);
        }
    }
}
if (failed) {
    console.error('\nCommit messages follow Conventional Commits; see "Commits and pull requests" in CONTRIBUTING.md.');
    process.exit(1);
}
