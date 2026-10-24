import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AttentionStatus, type Settings } from '@voltran/shared';
import { PushDevices, PushNotifier, pushMessage, type PushAttention } from './push.ts';
import type { PushSubscription } from './webpush.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-push-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'push');
}

const subscription = (id: string): PushSubscription => ({
    endpoint: `https://web.push.apple.com/${id}`,
    keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
});

const item = (paneId: string, status: AttentionStatus = 'needs-input', sessionTitle = 'Refactor billing', body = 'Claude: Bash wants to run `deploy --token abc`'): PushAttention =>
    ({ paneId, status, sessionTitle, body });

describe('PushDevices', () => {
    it('keeps devices and the VAPID key private and survives a restart', () => {
        const dir = tempDir();
        const devices = new PushDevices(dir);
        const keys = devices.vapid();
        const device = devices.add(subscription('a'), 'iPhone', 1000);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, 'devices.json')).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);

        const again = new PushDevices(dir);
        expect(again.vapid()).toEqual(keys);
        expect(again.list().map((entry) => entry.id)).toEqual([device.id]);
    });

    it('keeps the phones it can read when devices.json has an entry it cannot', () => {
        const dir = tempDir();
        const device = new PushDevices(dir).add(subscription('a'), 'iPhone', 1000);
        const file = join(dir, 'devices.json');
        writeFileSync(file, JSON.stringify([null, 'x', { id: 'b' }, JSON.parse(readFileSync(file, 'utf8'))[0]]));
        expect(new PushDevices(dir).list().map((entry) => entry.id)).toEqual([device.id]);
    });

    it('forgets the phones paired with a key it had to replace', () => {
        const dir = tempDir();
        const devices = new PushDevices(dir);
        devices.vapid();
        devices.add(subscription('a'), 'iPhone');
        rmSync(join(dir, 'vapid.json'));
        const again = new PushDevices(dir);
        expect(again.list()).toHaveLength(1);
        again.vapid();
        expect(again.list()).toHaveLength(0);
        expect(new PushDevices(dir).list()).toHaveLength(0);
    });

    it('never shows a window the endpoint or keys', () => {
        const devices = new PushDevices(tempDir());
        devices.add(subscription('a'), 'iPhone', 1000);
        const views = devices.views();
        expect(views).toEqual([{ id: expect.any(String), name: 'iPhone', pairedAt: 1000, lastSentAt: null, lastError: null }]);
        expect(JSON.stringify(views)).not.toContain('push.apple.com');
    });

    it('replaces a phone that pairs again instead of keeping both', () => {
        const devices = new PushDevices(tempDir());
        devices.add(subscription('a'), 'iPhone');
        devices.add(subscription('a'), 'iPhone');
        devices.add(subscription('b'), 'iPad');
        expect(devices.list().map((entry) => entry.name)).toEqual(['iPhone', 'iPad']);
    });
});

describe('pushMessage', () => {
    it('names no session, pane or command when content is minimal', () => {
        const message = pushMessage([item('a'), item('b'), item('c', 'done')], 'minimal');
        expect(message).toEqual({ title: 'Voltran', body: '2 panes need your input · An agent finished', tag: 'attention' });
    });

    it('names sessions only when content is titles', () => {
        const message = pushMessage([item('a')], 'titles');
        expect(message.body).toBe('Needs input: Refactor billing');
        expect(message.body).not.toContain('deploy');
    });

    it('adds what the pane reported when content is full, on one clipped line', () => {
        const message = pushMessage([item('a', 'needs-input', 'Refactor billing', `Claude:\x07 ${'x'.repeat(300)}`)], 'full');
        expect(message.body.startsWith('Needs input: Refactor billing — Claude: xxx')).toBe(true);
        expect(message.body).not.toContain('\x07');
        expect(message.body.length).toBeLessThanOrEqual(140);
    });

    it('lists at most four panes', () => {
        const message = pushMessage(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id)), 'titles');
        expect(message.body.split('\n')).toHaveLength(5);
        expect(message.body.endsWith('and 2 more')).toBe(true);
    });
});

describe('PushNotifier', () => {
    function setup(overrides: Partial<Settings['push']> = {}, status: (paneId: string) => AttentionStatus | 'idle' = () => 'needs-input') {
        vi.useFakeTimers();
        const devices = new PushDevices(tempDir());
        devices.vapid();
        devices.add(subscription('a'), 'iPhone');
        const sent: { endpoint: string; payload: unknown }[] = [];
        let answer = 201;
        const notifier = new PushNotifier({
            devices,
            settings: () => ({ ...DEFAULT_SETTINGS.push, ...overrides }),
            pending: (paneId, wanted) => status(paneId) === wanted,
            onChange: () => undefined,
            now: () => Date.now(),
            send: async (sub, payload) => {
                sent.push({ endpoint: sub.endpoint, payload });
                return { status: answer };
            },
        });
        cleanups.push(() => notifier.close());
        return { devices, notifier, sent, answer: (status: number) => { answer = status; } };
    }

    it('pushes once the delay passes and the pane still needs input', async () => {
        const { notifier, sent } = setup();
        notifier.attention(item('a'));
        await vi.advanceTimersByTimeAsync(29_000);
        expect(sent).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent).toEqual([{ endpoint: 'https://web.push.apple.com/a', payload: { title: 'Voltran', body: 'A pane needs your input', tag: 'attention' } }]);
    });

    it('stays quiet when the pane was answered or seen in the meantime', async () => {
        let current: AttentionStatus | 'idle' = 'needs-input';
        const { notifier, sent } = setup({}, () => current);
        notifier.attention(item('a'));
        current = 'idle';
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sent).toHaveLength(0);
    });

    it('stays quiet while the user is typing at the computer', async () => {
        const { notifier, sent } = setup();
        notifier.attention(item('a'));
        await vi.advanceTimersByTimeAsync(5000);
        notifier.userInput();
        await vi.advanceTimersByTimeAsync(25_000);
        expect(sent).toHaveLength(0);
    });

    it('sends one message for panes that need the user together, and waits a minute before the next', async () => {
        const { notifier, sent } = setup();
        notifier.attention(item('a'));
        notifier.attention(item('b'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sent.map((entry) => (entry.payload as { body: string }).body)).toEqual(['2 panes need your input']);

        notifier.attention(item('c'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sent).toHaveLength(2);
    });

    it('gives a pane that needs the user later its own delay', async () => {
        let current: AttentionStatus | 'idle' = 'needs-input';
        const { notifier, sent } = setup({}, (paneId) => (paneId === 'b' ? current : 'needs-input'));
        notifier.attention(item('a'));
        await vi.advanceTimersByTimeAsync(29_500);
        notifier.attention(item('b'));
        await vi.advanceTimersByTimeAsync(500);
        expect(sent.map((entry) => (entry.payload as { body: string }).body)).toEqual(['A pane needs your input']);
        current = 'idle';
        await vi.advanceTimersByTimeAsync(120_000);
        expect(sent).toHaveLength(1);
    });

    it('sends a pane that came up during the minute between pushes once that minute is over', async () => {
        const { notifier, sent } = setup();
        notifier.attention(item('a'));
        await vi.advanceTimersByTimeAsync(30_000);
        notifier.attention(item('b'));
        await vi.advanceTimersByTimeAsync(59_000);
        expect(sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent).toHaveLength(2);
    });

    it('does not hold a pane behind an older, longer wait', async () => {
        const settings: Partial<Settings['push']> = { delaySeconds: 3600 };
        const { notifier, sent } = setup(settings);
        notifier.attention(item('a'));
        settings.delaySeconds = 30;
        await vi.advanceTimersByTimeAsync(10_000);
        notifier.attention(item('b'));
        await vi.advanceTimersByTimeAsync(29_000);
        expect(sent).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent.map((entry) => (entry.payload as { body: string }).body)).toEqual(['2 panes need your input']);
    });

    it('drops what is waiting when notifications are turned off before the delay ends', async () => {
        const settings: Partial<Settings['push']> = { events: ['needs-input', 'done'] };
        const { notifier, sent } = setup(settings, (paneId) => (paneId === 'a' ? 'needs-input' : 'done'));
        notifier.attention(item('a'));
        notifier.attention(item('b', 'done'));
        await vi.advanceTimersByTimeAsync(10_000);
        settings.events = ['done'];
        await vi.advanceTimersByTimeAsync(20_000);
        expect(sent.map((entry) => (entry.payload as { body: string }).body)).toEqual(['An agent finished']);

        notifier.attention(item('c', 'done'));
        await vi.advanceTimersByTimeAsync(10_000);
        settings.enabled = false;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(sent).toHaveLength(1);
    });

    it('does not throw out of a timer when it cannot write down the result', async () => {
        const { devices, notifier, sent } = setup();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        cleanups.push(() => error.mockRestore());
        vi.spyOn(devices, 'record').mockImplementation(() => {
            throw new Error('ENOSPC');
        });
        notifier.attention(item('a'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sent).toHaveLength(1);
        expect(error).toHaveBeenCalledWith('[voltran] could not send a push notification:', expect.any(Error));
    });

    it('follows push.enabled and push.events', async () => {
        const off = setup({ enabled: false });
        off.notifier.attention(item('a'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(off.sent).toHaveLength(0);

        const needsInputOnly = setup({}, () => 'done');
        needsInputOnly.notifier.attention(item('a', 'done'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(needsInputOnly.sent).toHaveLength(0);
    });

    it('forgets a phone the push service no longer knows, and records other failures', async () => {
        const gone = setup();
        gone.answer(410);
        await gone.notifier.test();
        expect(gone.devices.list()).toHaveLength(0);

        const refused = setup();
        refused.answer(403);
        await refused.notifier.test();
        expect(refused.devices.views()[0].lastError).toBe('The push service answered 403');
        refused.answer(201);
        await refused.notifier.test();
        expect(refused.devices.views()[0]).toMatchObject({ lastError: null, lastSentAt: expect.any(Number) });
    });
});
