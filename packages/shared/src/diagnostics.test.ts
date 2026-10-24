import { describe, expect, it } from 'vitest';
import { bugReportUrl, formatDiagnostics, type Diagnostics } from './diagnostics.ts';

const REPORT: Diagnostics = {
    version: '1.0.0',
    platform: 'macOS 26.1 (arm64)',
    node: '22.18.0',
    checks: [
        { name: 'Voltran', status: 'ok', detail: '1.0.0' },
        { name: 'Terminals', status: 'fail', detail: 'posix_spawnp failed' },
        { name: 'Codex', status: 'off', detail: 'not installed' },
        { name: 'Daemon', status: 'warn', detail: 'not running' },
    ],
};

describe('formatDiagnostics', () => {
    it('lines up one check per line behind its mark', () => {
        expect(formatDiagnostics(REPORT)).toBe([
            '✓ Voltran    1.0.0',
            '✗ Terminals  posix_spawnp failed',
            '– Codex      not installed',
            '! Daemon     not running',
        ].join('\n'));
    });
});

describe('bugReportUrl', () => {
    it('fills in the bug report form by its field ids', () => {
        const url = new URL(bugReportUrl(REPORT));
        expect(`${url.origin}${url.pathname}`).toBe('https://github.com/onurravli/voltran/issues/new');
        expect(url.searchParams.get('template')).toBe('bug_report.yml');
        expect(url.searchParams.get('version')).toBe('1.0.0');
        expect(url.searchParams.get('platform-version')).toBe('macOS 26.1 (arm64), Node 22.18.0');
        expect(url.searchParams.get('diagnostics')).toBe(formatDiagnostics(REPORT));
    });
});
