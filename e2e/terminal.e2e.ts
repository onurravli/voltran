import type { Browser, BrowserContext, Locator } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Voltran, launchChrome, newContext, paneBox, screenText, typeInto, until, waitForText } from './harness.ts';

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

const rowsOf = (pane: Locator): Promise<number> => pane.locator('.xterm-rows > div').count();

async function processSize(pane: Locator, marker: string): Promise<{ rows: number; cols: number }> {
    await typeInto(pane, `printf '${marker}:'; stty size\n`);
    await waitForText(pane, new RegExp(`${marker}:\\d+ \\d+`));
    const [, rows, cols] = new RegExp(`${marker}:(\\d+) (\\d+)`).exec(await screenText(pane))!;
    return { rows: Number(rows), cols: Number(cols) };
}

describe('terminal', () => {
    it('sends keystrokes to the process and draws what it prints', async () => {
        const { session } = await voltran.seed('typing');
        const page = await voltran.open(context, session.id);
        const pane = paneBox(page, 'typing 1');

        await waitForText(pane, 'e2e$');
        await typeInto(pane, 'echo "sum=$((40 + 2))"\n');
        await waitForText(pane, 'sum=42');
    });

    it('gives the process the size the window fits, and follows the window when it shrinks', async () => {
        const { session } = await voltran.seed('sizing');
        const page = await voltran.open(context, session.id);
        const pane = paneBox(page, 'sizing 1');
        await waitForText(pane, 'e2e$');

        const before = await processSize(pane, 'big');
        expect(before.rows).toBe(await rowsOf(pane));

        await page.setViewportSize({ width: 900, height: 500 });
        await until(async () => (await rowsOf(pane)) < before.rows, 'the terminal to shrink');
        await typeInto(pane, 'clear\n');
        const after = await processSize(pane, 'small');
        expect(after.rows).toBe(await rowsOf(pane));
        expect(after.rows).toBeLessThan(before.rows);
        expect(after.cols).toBeLessThan(before.cols);
    });

    it('shows the same output in every window attached to a pane', async () => {
        const { session } = await voltran.seed('mirror');
        const first = await voltran.open(context, session.id);
        const second = await voltran.open(context, session.id);
        await waitForText(paneBox(first, 'mirror 1'), 'e2e$');
        await waitForText(paneBox(second, 'mirror 1'), 'e2e$');

        await typeInto(paneBox(first, 'mirror 1'), 'echo from-first-$((6 * 7))\n');
        await waitForText(paneBox(second, 'mirror 1'), 'from-first-42');
        await typeInto(paneBox(second, 'mirror 1'), 'echo from-second-$((6 * 8))\n');
        await waitForText(paneBox(first, 'mirror 1'), 'from-second-48');
    });

    it('keeps the scrollback when the window reloads', async () => {
        const { session } = await voltran.seed('reload');
        const page = await voltran.open(context, session.id);
        await waitForText(paneBox(page, 'reload 1'), 'e2e$');
        await typeInto(paneBox(page, 'reload 1'), 'echo before-$((1 + 1))-reload\n');
        await waitForText(paneBox(page, 'reload 1'), 'before-2-reload');

        await page.reload();
        await waitForText(paneBox(page, 'reload 1'), 'before-2-reload');
        await typeInto(paneBox(page, 'reload 1'), 'echo after-$((2 + 1))-reload\n');
        await waitForText(paneBox(page, 'reload 1'), 'after-3-reload');
    });
});
