import { describe, expect, it } from 'vitest';
import { branchFromTitle } from './worktrees.ts';

describe('branchFromTitle', () => {
    it('turns a session title into a branch name', () => {
        expect(branchFromTitle('Fix login redirect (PROJ-123)')).toBe('fix-login-redirect-proj-123');
        expect(branchFromTitle('Ödeme sayfasını düzelt')).toBe('odeme-sayfasini-duzelt');
        expect(branchFromTitle('  --- ')).toBe('');
        expect(branchFromTitle('a'.repeat(80))).toHaveLength(60);
    });
});
