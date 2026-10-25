import { describe, expect, it } from 'vitest';
import type { GitStatus } from '@voltran/shared';
import { gitLabels, linkLabel, pullRequestLabel, shortPath } from './labels.ts';

describe('linkLabel', () => {
    it('names GitHub pull requests and issues by repository and number', () => {
        expect(linkLabel('https://github.com/acme/checkout-service/pull/482')).toBe('checkout-service#482');
        expect(linkLabel('https://github.com/acme/checkout-service/pull/482/files')).toBe('checkout-service#482');
        expect(linkLabel('https://github.com/acme/checkout-service/issues/17')).toBe('checkout-service#17');
    });

    it('names GitLab merge requests by project and number', () => {
        expect(linkLabel('https://gitlab.com/acme/group/web/-/merge_requests/31')).toBe('web!31');
        expect(linkLabel('https://gitlab.example.com/acme/web/merge_requests/7')).toBe('web!7');
    });

    it('names Jira and Linear issues by their key', () => {
        expect(linkLabel('https://acme.atlassian.net/browse/ABC-123')).toBe('ABC-123');
        expect(linkLabel('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-12')).toBe('ABC-12');
        expect(linkLabel('https://linear.app/acme/issue/ENG-42/fix-the-thing')).toBe('ENG-42');
    });

    it('falls back to the host name', () => {
        expect(linkLabel('https://www.notion.so/acme/Plan-1234')).toBe('notion.so');
        expect(linkLabel('https://github.com/acme/checkout-service')).toBe('github.com');
    });

    it('returns text that is not a URL unchanged', () => {
        expect(linkLabel('not a url')).toBe('not a url');
    });
});

describe('shortPath', () => {
    it('keeps the last two folders', () => {
        expect(shortPath('/Users/me/Developer/acme/voltran')).toBe('…/acme/voltran');
    });

    it('leaves short paths alone', () => {
        expect(shortPath('/tmp/x')).toBe('/tmp/x');
        expect(shortPath('/')).toBe('/');
    });
});

const clean: GitStatus = {
    branch: 'main',
    commit: 'abc1234',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    pullRequest: null,
};

describe('gitLabels', () => {
    it('shows only the branch of a clean, up-to-date checkout', () => {
        expect(gitLabels(clean)).toEqual({
            branch: 'main',
            sync: null,
            changes: null,
            detail: 'On main, tracking origin/main\nNo changes',
        });
    });

    it('counts commits to push and pull, and the changed files by kind', () => {
        const labels = gitLabels({ ...clean, ahead: 2, behind: 1, changed: 4, staged: 1, unstaged: 2, untracked: 1, conflicted: 1 });
        expect([labels.sync, labels.changes]).toEqual(['↑2 ↓1', '4']);
        expect(labels.detail).toBe(
            'On main, tracking origin/main\n2 commits to push, 1 commit to pull\n4 changed files: 1 staged, 2 unstaged, 1 untracked, 1 in conflict',
        );
    });

    it('names a detached head by its commit and a branch without upstream as such', () => {
        expect(gitLabels({ ...clean, branch: null }).branch).toBe('abc1234');
        expect(gitLabels({ ...clean, branch: null }).detail).toContain('Detached at abc1234');
        expect(gitLabels({ ...clean, upstream: null, ahead: 3 }).detail).toBe(
            'On main, with no upstream branch\n3 commits to push\nNo changes',
        );
        expect(gitLabels({ ...clean, branch: 'main', commit: null, upstream: null }).branch).toBe('main');
    });
});

describe('pullRequestLabel', () => {
    it('shows the number, the state and how the checks went', () => {
        expect(pullRequestLabel({ number: 42, url: 'https://x', state: 'open', checks: 'passing' })).toEqual({
            text: '#42 open',
            mark: '✓',
            title: 'Pull request #42 is open, checks passing. Click to open it.',
        });
        expect(pullRequestLabel({ number: 7, url: 'https://x', state: 'draft', checks: null })).toMatchObject({
            text: '#7 draft',
            mark: null,
        });
        expect(pullRequestLabel({ number: 9, url: 'https://x', state: 'open', checks: 'failing' }).mark).toBe('✗');
    });
});
