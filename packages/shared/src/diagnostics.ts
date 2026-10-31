export type CheckStatus = 'ok' | 'warn' | 'fail' | 'off';

export interface DiagnosticCheck {
    name: string;
    status: CheckStatus;
    detail: string;
}

export interface Diagnostics {
    version: string;
    platform: string;
    node: string;
    checks: DiagnosticCheck[];
}

const MARKS: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', off: '–' };

export const NEW_ISSUE_URL = 'https://github.com/onurravli/voltran/issues/new';

export function formatDiagnostics(report: Diagnostics): string {
    const width = Math.max(0, ...report.checks.map((check) => check.name.length));
    return report.checks
        .map((check) => `${MARKS[check.status]} ${check.name.padEnd(width)}  ${check.detail}`)
        .join('\n');
}

// The keys are the ids of the fields in .github/ISSUE_TEMPLATE/bug_report.yml, which GitHub fills in
// from the query string.
export function bugReportUrl(report: Diagnostics): string {
    const params = new URLSearchParams({
        template: 'bug_report.yml',
        version: report.version,
        'platform-version': `${report.platform}, Node ${report.node}`,
        diagnostics: formatDiagnostics(report),
    });
    return `${NEW_ISSUE_URL}?${params}`;
}
