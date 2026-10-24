import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Voltran, launchChrome, newContext, paneBox, screenText, typeInto, waitForText } from './harness.ts';

let voltran: Voltran;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
    voltran = new Voltran();
    await voltran.start();
    browser = await launchChrome();
    context = await newContext(browser);
});

afterAll(async () => {
    await context?.close();
    await browser?.close();
    await voltran?.dispose();
});

afterEach(async () => {
    await voltran.start();
});

describe('reconnecting', () => {
    it('says the daemon is gone, then comes back with the scrollback and a live shell', async () => {
        const { session } = await voltran.seed('restart', 2);
        const page = await voltran.open(context, session.id);
        const first = paneBox(page, 'restart 1');
        await waitForText(first, 'e2e$');
        await typeInto(first, 'echo kept-$((20 + 1))\n');
        await waitForText(first, 'kept-21');

        await voltran.stop();
        await page.getByText('Reconnecting to the daemon…').waitFor();
        await first.getByText('Reconnecting…').waitFor();

        await voltran.start();
        await page.getByText('Reconnecting to the daemon…').waitFor({ state: 'detached', timeout: 15_000 });
        const second = paneBox(page, 'restart 2');
        for (const pane of [first, second]) {
            await pane.getByText('Reconnecting…').waitFor({ state: 'detached', timeout: 15_000 });
            await waitForText(pane, /── restored [^]*e2e\$/, 15_000);
        }
        await waitForText(first, 'kept-21');

        await typeInto(first, 'echo fresh-$((30 + 2))\n');
        await waitForText(first, 'fresh-32');
        await typeInto(second, 'echo second-$((4 * 4))\n');
        await waitForText(second, 'second-16');
        expect(await screenText(first)).toMatch(/\nkept-21\n[^]*── restored [^]*fresh-32/);
    });

    it('drops a pane another window closes and keeps the others working', async () => {
        const { session, panes } = await voltran.seed('removed', 2);
        const page = await voltran.open(context, session.id);
        await waitForText(paneBox(page, 'removed 2'), 'e2e$');

        await voltran.api('DELETE', `/api/panes/${panes[1].id}`);
        await paneBox(page, 'removed 2').waitFor({ state: 'detached' });
        expect(await page.locator('.pane').count()).toBe(1);
        await typeInto(paneBox(page, 'removed 1'), 'echo alone-$((7 + 7))\n');
        await waitForText(paneBox(page, 'removed 1'), 'alone-14');
    });
});
