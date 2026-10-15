import type { GitStatus, PullRequest } from '@voltran/shared';

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export function linkLabel(link: string): string {
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return link;
    }
    const host = url.hostname.replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);

    if (host === 'github.com' && parts.length >= 4 && (parts[2] === 'pull' || parts[2] === 'issues') && /^\d+$/.test(parts[3])) {
        return `${parts[1]}#${parts[3]}`;
    }
    const mergeRequest = parts.indexOf('merge_requests');
    const project = parts[mergeRequest - 1] === '-' ? parts[mergeRequest - 2] : parts[mergeRequest - 1];
    if (host.includes('gitlab') && project && /^\d+$/.test(parts[mergeRequest + 1] ?? '')) {
        return `${project}!${parts[mergeRequest + 1]}`;
    }
    const selected = url.searchParams.get('selectedIssue');
    if (selected && ISSUE_KEY.test(selected)) {
        return selected;
    }
    const key = parts.find((part) => ISSUE_KEY.test(part));
    if (key && (parts.includes('browse') || parts.includes('issue') || parts.includes('issues'))) {
        return key;
    }
    return host || link;
}

export function shortPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 2) {
        return path;
    }
    return `…/${parts.slice(-2).join('/')}`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export interface GitLabels {
    branch: string;
    sync: string | null;
    changes: string | null;
    detail: string;
}

export function gitLabels(status: GitStatus): GitLabels {
    const branch = status.branch ?? status.commit ?? 'no commits yet';
    const sync = [status.ahead > 0 ? `↑${status.ahead}` : '', status.behind > 0 ? `↓${status.behind}` : ''].filter(Boolean).join(' ') || null;
    const where = status.branch
        ? status.upstream ? `On ${status.branch}, tracking ${status.upstream}` : `On ${status.branch}, with no upstream branch`
        : status.commit ? `Detached at ${status.commit}` : 'No commits yet';
    const lines = [where];
    if (sync) {
        lines.push([status.ahead > 0 ? `${plural(status.ahead, 'commit')} to push` : '', status.behind > 0 ? `${plural(status.behind, 'commit')} to pull` : ''].filter(Boolean).join(', '));
    }
    const parts = [
        status.staged > 0 ? `${status.staged} staged` : '',
        status.unstaged > 0 ? `${status.unstaged} unstaged` : '',
        status.untracked > 0 ? `${status.untracked} untracked` : '',
        status.conflicted > 0 ? `${status.conflicted} in conflict` : '',
    ].filter(Boolean);
    lines.push(status.changed > 0 ? `${plural(status.changed, 'changed file')}: ${parts.join(', ')}` : 'No changes');
    return { branch, sync, changes: status.changed > 0 ? String(status.changed) : null, detail: lines.join('\n') };
}

const CHECK_MARKS: Record<NonNullable<PullRequest['checks']>, string> = { passing: '✓', failing: '✗', pending: '…' };

export function pullRequestLabel(pr: PullRequest): { text: string; mark: string | null; title: string } {
    const title = `Pull request #${pr.number} is ${pr.state}${pr.checks ? `, checks ${pr.checks}` : ''}. Click to open it.`;
    return { text: `#${pr.number} ${pr.state}`, mark: pr.checks ? CHECK_MARKS[pr.checks] : null, title };
}
