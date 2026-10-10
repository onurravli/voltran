import { describe, expect, it } from 'vitest';
import { linkLabel, shortPath } from './labels.ts';

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
