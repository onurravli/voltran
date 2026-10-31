export const TYPES = [
    'build',
    'chore',
    'ci',
    'docs',
    'feat',
    'fix',
    'perf',
    'refactor',
    'release',
    'revert',
    'style',
    'test',
];
export const MAX_HEADER_LENGTH = 100;

const HEADER = /^(?<type>[^\s():!]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?: (?<subject>.*)$/;
const SCOPE = /^[a-z0-9][a-z0-9-]*$/;
const EXEMPT = /^(Merge |Revert "|(fixup|squash|amend)! )/;
const SCISSORS = /^# -+ >8 -+$/;

export function cleanMessage(text) {
    const lines = [];
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        if (SCISSORS.test(line)) {
            break;
        }
        if (!line.startsWith('#')) {
            lines.push(line.trimEnd());
        }
    }
    while (lines.length > 0 && lines[0] === '') {
        lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function checkCommitMessage(text) {
    const lines = cleanMessage(text);
    if (lines.length === 0) {
        return ['the message is empty'];
    }
    const header = lines[0];
    if (EXEMPT.test(header)) {
        return [];
    }
    const match = HEADER.exec(header);
    if (!match) {
        return [`"${header}" is not "type(scope): subject", for example "fix(web): keep the sidebar open"`];
    }
    const { type, scope, subject } = match.groups;
    const problems = [];
    if (!TYPES.includes(type)) {
        problems.push(`"${type}" is not a type; use one of ${TYPES.join(', ')}`);
    }
    if (scope !== undefined && !SCOPE.test(scope)) {
        problems.push(`the scope "${scope}" must be lowercase letters, digits and dashes, such as "web" or "daemon"`);
    }
    if (subject.trim() === '' || subject !== subject.trimStart()) {
        problems.push('the subject must follow ": " directly and say what changes');
    } else if (subject.endsWith('.')) {
        problems.push('the subject must not end with a period');
    }
    if (header.length > MAX_HEADER_LENGTH) {
        problems.push(`the first line is ${header.length} characters; keep it to ${MAX_HEADER_LENGTH}`);
    }
    if (lines.length > 1 && lines[1] !== '') {
        problems.push('leave a blank line between the subject and the body');
    }
    return problems;
}
