import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@voltran/shared';
import { Voltran, launchChrome, newContext, paneBox, typeInto, until, waitForText } from './harness.ts';

let voltran: Voltran;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
    voltran = new Voltran();
    await voltran.start();
    browser = await launchChrome();
});

afterAll(async () => {
    await browser?.close();
    await voltran?.dispose();
});

beforeEach(async () => {
    context = await newContext(browser);
});

afterEach(async () => {
    await context.close();
});

const panesIn = async (sessionId: string): Promise<string[]> =>
    (await voltran.state()).panes.filter((pane) => pane.sessionId === sessionId).map((pane) => pane.id);

describe('sidebar menus', () => {
    it('adds a pane from the session context menu', async () => {
        const { session } = await voltran.seed('menu');
        const page = await voltran.open(context, session.id);
        await waitForText(paneBox(page, 'menu 1'), 'e2e$');

        await page.locator('.session-row', { hasText: 'menu session' }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Add pane' }).hover();
        await page.getByRole('menu', { name: 'Add pane' }).getByRole('menuitem', { name: 'Shell' }).click();
        await until(async () => (await panesIn(session.id)).length === 2, 'a second pane');
        await until(async () => (await page.locator('.pane').count()) === 2, 'two panes on screen');
        await waitForText(page.locator('.pane').nth(1), 'e2e$');
    });

    it('archives a session, stopping its processes, and restores it with its scrollback', async () => {
        const { session } = await voltran.seed('archive');
        const page = await voltran.open(context, session.id);
        const pane = paneBox(page, 'archive 1');
        await waitForText(pane, 'e2e$');
        await typeInto(pane, 'echo archived-$((8 * 8))\n');
        await waitForText(pane, 'archived-64');

        await page.locator('.session-row', { hasText: 'archive session' }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: /Archive session/ }).click();
        await page.getByText('This session is archived and its processes are stopped.').waitFor();
        await pane.getByText('Archived. Restore the session to resume this pane.').waitFor();
        await until(
            async () =>
                (await voltran.state()).panes.every((entry) => entry.sessionId !== session.id || entry.pid === null),
            'the process to stop',
        );

        await page.getByRole('button', { name: 'Restore session' }).click();
        await waitForText(pane, /archived-64[^]*── suspended ──[^]*e2e\$/);
        await typeInto(pane, 'echo back-$((8 + 8))\n');
        await waitForText(pane, 'back-16');
    });

    it('moves a pane to another session of the project by dropping it on the session', async () => {
        const { project, session } = await voltran.seed('move', 2);
        const other = await voltran.api<Session>('POST', '/api/sessions', {
            projectId: project.id,
            title: 'other session',
            panes: [{ adapter: 'shell', title: 'other 1' }],
        });
        const page = await voltran.open(context, session.id);
        const moving = paneBox(page, 'move 2');
        await waitForText(moving, 'e2e$');
        await typeInto(moving, 'echo moved-$((11 * 11))\n');
        await waitForText(moving, 'moved-121');
        const [, movingId] = await panesIn(session.id);

        await moving
            .locator('.pane__header .pane__summary')
            .dragTo(page.locator('.session-row', { hasText: 'other session' }));
        await until(async () => (await panesIn(other.id)).includes(movingId), 'the pane in the other session');
        expect(await panesIn(session.id)).toHaveLength(1);
        await page.getByText('Moved to other session').waitFor();
        await until(async () => (await page.locator('.pane').count()) === 1, 'one pane left here');

        await page.locator('.session-row', { hasText: 'other session' }).click();
        await waitForText(paneBox(page, 'move 2'), 'moved-121');
        await typeInto(paneBox(page, 'move 2'), 'echo still-here\n');
        await waitForText(paneBox(page, 'move 2'), /still-here\n/);
    });

    it('renames a session in place', async () => {
        const { session } = await voltran.seed('rename');
        const page = await voltran.open(context, session.id);

        await page.locator('.session-row', { hasText: 'rename session' }).dblclick();
        const input = page.getByRole('textbox', { name: 'Session name' });
        await input.fill('Renamed by e2e');
        await input.press('Enter');
        await until(
            async () => (await voltran.session(session.id)).title === 'Renamed by e2e',
            'the title to be saved',
        );
        await page.locator('.session-header__title', { hasText: 'Renamed by e2e' }).waitFor();
        expect((await voltran.session(session.id)).titleSource).toBe('user');
    });
});
