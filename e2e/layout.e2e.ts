import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paneIds, type Layout } from '@voltran/shared';
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

const layoutOf = async (sessionId: string): Promise<Layout | null> => (await voltran.session(sessionId)).layout;

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const rect = await locator.boundingBox();
    if (!rect) {
        throw new Error('not on screen');
    }
    return rect;
}

async function dragHeader(page: Page, from: Locator, to: Locator, at: { x: number; y: number }): Promise<void> {
    const target = await box(to);
    await from.locator('.pane__header .pane__summary').dragTo(to.locator('.pane__body'), {
        targetPosition: { x: target.width * at.x, y: (target.height - 40) * at.y },
    });
    await page.locator('.pane__drop').first().waitFor({ state: 'detached' });
}

describe('layout', () => {
    it('splits a pane from its header and keeps the new layout', async () => {
        const { session, panes } = await voltran.seed('split');
        const page = await voltran.open(context, session.id);
        const first = paneBox(page, 'split 1');
        await waitForText(first, 'e2e$');

        await first.getByTitle('Split down').click();
        await page.getByRole('menuitem', { name: 'Shell' }).click();
        await until(async () => (await page.locator('.pane').count()) === 2, 'a second pane');

        const layout = await layoutOf(session.id);
        expect(layout).toMatchObject({ type: 'split', direction: 'vertical' });
        const ids = paneIds(layout);
        expect(ids[0]).toBe(panes[0].id);
        const added = page.locator('.pane').nth(1);
        expect((await box(added)).y).toBeGreaterThan((await box(first)).y);
        await waitForText(added, 'e2e$');
        await typeInto(added, 'echo split-$((3 * 3))\n');
        await waitForText(added, 'split-9');

        await page.reload();
        await until(async () => (await page.locator('.pane').count()) === 2, 'both panes after a reload');
        await waitForText(page.locator('.pane').nth(1), 'split-9');
    });

    it('rearranges panes by dragging one by its header', async () => {
        const { session, panes } = await voltran.seed('drag', 3);
        const page = await voltran.open(context, session.id);
        const [a, b, c] = ['drag 1', 'drag 2', 'drag 3'].map((title) => paneBox(page, title));
        await waitForText(c, 'e2e$');
        expect(paneIds(await layoutOf(session.id))).toEqual(panes.map((pane) => pane.id));

        await dragHeader(page, c, a, { x: 0.5, y: 0.5 });
        await until(async () => paneIds(await layoutOf(session.id))[0] === panes[2].id, 'the swap to be saved');
        expect(paneIds(await layoutOf(session.id))).toEqual([panes[2].id, panes[1].id, panes[0].id]);
        await until(async () => {
            const [cBox, bBox] = [await c.boundingBox(), await b.boundingBox()];
            return cBox !== null && bBox !== null && cBox.x < bBox.x;
        }, 'the moved pane on the left');

        await dragHeader(page, a, b, { x: 0.5, y: 0.9 });
        await until(async () => {
            const layout = await layoutOf(session.id);
            return layout?.type === 'split' && layout.children.length === 2;
        }, 'the move to be saved');
        expect(await layoutOf(session.id)).toMatchObject({
            type: 'split',
            direction: 'horizontal',
            children: [
                { type: 'pane', paneId: panes[2].id },
                {
                    type: 'split',
                    direction: 'vertical',
                    children: [
                        { type: 'pane', paneId: panes[1].id },
                        { type: 'pane', paneId: panes[0].id },
                    ],
                },
            ],
        });
        await until(async () => {
            const [aBox, bBox] = [await a.boundingBox(), await b.boundingBox()];
            return aBox !== null && bBox !== null && aBox.y > bBox.y && Math.abs(aBox.x - bBox.x) < 2;
        }, 'the moved pane below its target');
        await typeInto(a, 'echo still-$((5 + 5))\n');
        await waitForText(a, 'still-10');
    });

    it('resizes panes with the separator and saves the sizes', async () => {
        const { session } = await voltran.seed('resize', 2);
        const page = await voltran.open(context, session.id);
        const left = paneBox(page, 'resize 1');
        await waitForText(left, 'e2e$');
        const before = await box(left);

        const separator = await box(page.locator('.separator').first());
        await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
        await page.mouse.down();
        await page.mouse.move(separator.x + 200, separator.y + separator.height / 2, { steps: 10 });
        await page.mouse.up();

        await until(async () => ((await left.boundingBox())?.width ?? 0) > before.width + 150, 'the left pane to widen');
        await until(async () => {
            const layout = await layoutOf(session.id);
            return layout?.type === 'split' && layout.sizes[0] > 55;
        }, 'the sizes to be saved');

        await page.reload();
        await waitForText(left, 'e2e$');
        expect((await box(left)).width).toBeGreaterThan(before.width + 150);
    });

    it('maximizes a pane and restores the split', async () => {
        const { session } = await voltran.seed('max', 2);
        const page = await voltran.open(context, session.id);
        const first = paneBox(page, 'max 1');
        await waitForText(first, 'e2e$');
        const split = await box(first);

        await first.getByTitle(/^Maximize/).click();
        await until(async () => (await page.locator('.pane').count()) === 1, 'one pane on screen');
        expect((await box(first)).width).toBeGreaterThan(split.width * 1.8);
        await typeInto(first, 'echo big-$((9 * 9))\n');
        await waitForText(first, 'big-81');

        await first.getByTitle(/^Restore/).click();
        await until(async () => (await page.locator('.pane').count()) === 2, 'both panes back');
        await waitForText(first, 'big-81');
    });

    it('asks before closing a running pane, then removes it from the layout', async () => {
        const { session, panes } = await voltran.seed('close', 2);
        const page = await voltran.open(context, session.id);
        const second = paneBox(page, 'close 2');
        await waitForText(second, 'e2e$');

        await second.getByTitle(/^Close pane/).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByText('Close close 2?').waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        expect(await page.locator('.pane').count()).toBe(2);

        await second.getByTitle(/^Close pane/).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Close pane' }).click();
        await until(async () => (await page.locator('.pane').count()) === 1, 'the pane to go');
        expect(await layoutOf(session.id)).toEqual({ type: 'pane', paneId: panes[0].id });
        expect((await voltran.state()).panes.some((pane) => pane.id === panes[1].id)).toBe(false);
    });
});
