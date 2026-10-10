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
