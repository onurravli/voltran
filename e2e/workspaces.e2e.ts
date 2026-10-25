import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paneIds, type Workspace } from '@voltran/shared';
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
    for (const workspace of (await voltran.state()).workspaces) {
        await voltran.api('DELETE', `/api/workspaces/${workspace.id}`);
    }
});

const workspaceShows = async (): Promise<string[]> => {
    const [workspace] = (await voltran.state()).workspaces;
    return workspace ? paneIds(workspace.layout) : [];
};

async function newWorkspace(page: Page): Promise<void> {
    await page.locator('.sidebar__projects').click({ button: 'right', position: { x: 40, y: 400 } });
    await page.getByRole('menuitem', { name: 'New workspace' }).click();
    await page.getByText('Drag panes or whole sessions here from the sidebar.').waitFor();
}

describe('workspaces', () => {
    it('shows panes from two projects side by side, dragged in from the sidebar', async () => {
        const alpha = await voltran.seed('alpha');
        const beta = await voltran.seed('beta', 2);
        const page = await voltran.open(context, alpha.session.id);
        await waitForText(paneBox(page, 'alpha 1'), 'e2e$');
        await typeInto(paneBox(page, 'alpha 1'), 'echo alpha-$((1 + 1))\n');
        await waitForText(paneBox(page, 'alpha 1'), 'alpha-2');

        await newWorkspace(page);
        await page.getByRole('button', { name: 'Show the panes of alpha session' }).click();
        await page.locator('.pane-row', { hasText: 'alpha 1' }).dragTo(page.locator('.workspace__empty'));
        await until(async () => (await workspaceShows()).length === 1, 'the pane in the workspace');
        await waitForText(paneBox(page, 'alpha 1'), 'alpha-2');

        await page
            .locator('.session-row', { hasText: 'beta session' })
            .dragTo(paneBox(page, 'alpha 1').locator('.pane__body'), { targetPosition: { x: 20, y: 200 } });
        await until(async () => (await workspaceShows()).length === 3, 'the session in the workspace');
        expect(new Set(await workspaceShows())).toEqual(new Set([alpha.panes[0].id, ...beta.panes.map((pane) => pane.id)]));
        await until(async () => (await page.locator('.pane').count()) === 3, 'three panes on screen');
        await expect(page.locator('.pane__origin', { hasText: 'beta / beta session' }).count()).resolves.toBe(2);

        await typeInto(paneBox(page, 'beta 2'), 'echo beta-$((2 + 2))\n');
        await waitForText(paneBox(page, 'beta 2'), 'beta-4');
        await page.locator('.session-row', { hasText: 'beta session' }).click();
        await waitForText(paneBox(page, 'beta 2'), 'beta-4');
    });

    it('takes a pane out of a workspace without stopping it, and drops panes that are closed', async () => {
        const gamma = await voltran.seed('gamma', 2);
        const workspace = await voltran.api<Workspace>('POST', '/api/workspaces', { title: 'Mixed' });
        await voltran.api('PATCH', `/api/workspaces/${workspace.id}`, {
            layout: {
                type: 'split',
                direction: 'horizontal',
                sizes: [50, 50],
                children: gamma.panes.map((pane) => ({ type: 'pane', paneId: pane.id })),
            },
        });
        const page = await voltran.open(context);
        await page.locator('.session-row', { hasText: 'Mixed' }).click();
        await waitForText(paneBox(page, 'gamma 1'), 'e2e$');

        await paneBox(page, 'gamma 1')
            .getByTitle(/^Remove from this workspace/)
            .click();
        await until(async () => (await workspaceShows()).length === 1, 'the pane out of the workspace');
        expect((await voltran.state()).panes.find((pane) => pane.id === gamma.panes[0].id)?.pid).not.toBeNull();
        await page.locator('.session-row', { hasText: 'gamma session' }).click();
        expect(await page.locator('.pane').count()).toBe(2);

        await paneBox(page, 'gamma 2')
            .getByTitle(/^Close pane/)
            .click();
        await page.getByRole('dialog').getByRole('button', { name: 'Close pane' }).click();
        await until(async () => (await workspaceShows()).length === 0, 'the closed pane out of the workspace');
        await page.locator('.session-row', { hasText: 'Mixed' }).click();
        await page.getByText('Drag panes or whole sessions here from the sidebar.').waitFor();
    });
});
