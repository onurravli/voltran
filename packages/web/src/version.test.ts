import { describe, expect, it } from 'vitest';
import { updateNotice } from './version.ts';

describe('updateNotice', () => {
    it('stays quiet when the window runs the current build', () => {
        expect(updateNotice('abc', { ui: 'abc', behind: null })).toBeNull();
    });

    it('asks for a reload once the build on disk changes', () => {
        expect(updateNotice('abc', { ui: 'def', behind: null })).toBe('reload');
    });

    it('says which side is behind when the build and the daemon disagree', () => {
        expect(updateNotice('abc', { ui: 'def', behind: 'daemon' })).toBe('restart-daemon');
        expect(updateNotice('abc', { ui: 'abc', behind: 'ui' })).toBe('rebuild');
        expect(updateNotice('abc', { ui: 'abc', behind: 'both' })).toBe('rebuild-and-restart');
    });

    it('never warns the Vite dev server, a daemon without a build, or before the daemon reports', () => {
        expect(updateNotice('dev', { ui: 'def', behind: 'daemon' })).toBeNull();
        expect(updateNotice('abc', { ui: null, behind: null })).toBeNull();
        expect(updateNotice('abc', null)).toBeNull();
    });
});
