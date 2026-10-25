import { describe, expect, it } from 'vitest';
import { checkCommitMessage } from './commit-message.mjs';

describe('checkCommitMessage', () => {
    it('accepts the forms the history uses', () => {
        for (const message of [
            "feat: show the account's usage limits in the sidebar",
            'fix(web): move the keyboard into the pane you switch to',
            'chore(deps-dev): bump vitest from 4.1.11 to 5.0.5 (#7)',
            'release: 1.1.0',
            'feat!: drop Node 20\n\nNode 22.18 strips types itself.',
        ]) {
            expect(checkCommitMessage(message)).toEqual([]);
        }
    });

    it("lets git's own messages through", () => {
        for (const message of ["Merge branch 'main' into feature", 'Revert "feat: x"', 'fixup! fix: y', 'squash! feat: z']) {
            expect(checkCommitMessage(message)).toEqual([]);
        }
    });

    it('ignores comments, the scissors line and what follows it', () => {
        const message =
            'fix: keep the token private\n\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n';
        expect(checkCommitMessage(message)).toEqual([]);
    });

    it('rejects a header without a type', () => {
        expect(checkCommitMessage('Show git changes in Monaco')).toHaveLength(1);
        expect(checkCommitMessage('# only a comment\n')).toEqual(['the message is empty']);
    });

    it('names each problem', () => {
        expect(checkCommitMessage('feature(Web): add a thing.\nbody')).toEqual([
            expect.stringContaining('"feature" is not a type'),
            expect.stringContaining('the scope "Web"'),
            'the subject must not end with a period',
            'leave a blank line between the subject and the body',
        ]);
        expect(checkCommitMessage('fix:  two spaces')).toEqual([expect.stringContaining('subject')]);
        expect(checkCommitMessage(`fix: ${'x'.repeat(100)}`)).toEqual([expect.stringContaining('keep it to 100')]);
    });
});
