import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_LABEL, type AttentionStatus, type PushDeviceView, type Settings } from '@voltran/shared';
import { replaceFile } from './files.ts';
import { withoutControls } from './status.ts';
import { generateVapidKeys, sendPush, validSubscription, type PushSender, type PushSubscription, type VapidKeys } from './webpush.ts';

export interface PushDevice extends PushDeviceView {
    subscription: PushSubscription;
}

export interface PushAttention {
    paneId: string;
    status: AttentionStatus;
    sessionTitle: string;
    body: string;
}

export interface PushMessage {
    title: string;
    body: string;
    tag: string;
}

type PushSettings = Settings['push'];

const MIN_GAP_MS = 60_000;
const MAX_LINES = 4;
const MAX_LINE = 140;
const MAX_ERROR = 120;

export class PushDevices {
    private readonly dir: string;
    private devices: PushDevice[] = [];
    private keys: VapidKeys | null = null;

    constructor(dir: string) {
        this.dir = dir;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        this.devices = this.read();
    }

    private get devicesFile(): string {
        return join(this.dir, 'devices.json');
    }

    private read(): PushDevice[] {
        try {
            const raw = JSON.parse(readFileSync(this.devicesFile, 'utf8')) as unknown;
            if (!Array.isArray(raw)) {
                return [];
            }
            return raw.flatMap((value: unknown) => {
                if (!value || typeof value !== 'object') {
                    return [];
                }
                const entry = value as Partial<PushDevice>;
                const subscription = validSubscription(entry.subscription);
                return subscription && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.pairedAt === 'number'
                    ? [{ id: entry.id, name: entry.name, pairedAt: entry.pairedAt, lastSentAt: typeof entry.lastSentAt === 'number' ? entry.lastSentAt : null, lastError: typeof entry.lastError === 'string' ? entry.lastError : null, subscription }]
                    : [];
            });
        } catch {
            return [];
        }
    }

    private save(): void {
        replaceFile(this.dir, 'devices.json', `${JSON.stringify(this.devices, null, 4)}\n`, 0o600);
    }

    vapid(): VapidKeys {
        if (this.keys) {
            return this.keys;
        }
        const file = join(this.dir, 'vapid.json');
        if (existsSync(file)) {
            try {
                const keys = JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
                if (typeof keys.publicKey === 'string' && typeof keys.privateKey === 'string') {
                    chmodSync(file, 0o600);
                    this.keys = keys;
                    return keys;
                }
            } catch {
                // a broken key file is replaced; phones paired with it pair again
            }
        }
        this.keys = generateVapidKeys();
        replaceFile(this.dir, 'vapid.json', JSON.stringify(this.keys), 0o600);
        return this.keys;
    }

    list(): PushDevice[] {
        return this.devices;
    }

    views(): PushDeviceView[] {
        return this.devices.map(({ subscription: _subscription, ...view }) => view);
    }

    add(subscription: PushSubscription, name: string, now = Date.now()): PushDevice {
        const device: PushDevice = { id: randomUUID(), name, pairedAt: now, lastSentAt: null, lastError: null, subscription };
        this.devices = [...this.devices.filter((existing) => existing.subscription.endpoint !== subscription.endpoint), device];
        this.save();
        return device;
    }

    remove(id: string): boolean {
        const before = this.devices.length;
        this.devices = this.devices.filter((device) => device.id !== id);
        if (this.devices.length === before) {
            return false;
        }
        this.save();
        return true;
    }

    record(id: string, change: Pick<PushDevice, 'lastSentAt' | 'lastError'>): void {
        const device = this.devices.find((entry) => entry.id === id);
        if (device) {
            Object.assign(device, change);
            this.save();
        }
    }
}

const clip = (text: string): string => {
    const line = withoutControls(text.replace(/\s+/g, ' ')).trim();
    return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
};

const counted = (count: number, one: string, many: string): string => (count === 1 ? one : many.replace('#', String(count)));

// What leaves the computer depends on push.content: "minimal" names no session, pane or command.
export function pushMessage(items: PushAttention[], content: PushSettings['content']): PushMessage {
    if (content === 'minimal') {
        const count = (status: AttentionStatus): number => items.filter((item) => item.status === status).length;
        const parts = [
            count('needs-input') ? counted(count('needs-input'), 'A pane needs your input', '# panes need your input') : '',
            count('done') ? counted(count('done'), 'An agent finished', '# agents finished') : '',
            count('exited') ? counted(count('exited'), 'A pane exited', '# panes exited') : '',
        ].filter(Boolean);
        return { title: 'Voltran', body: parts.join(' · '), tag: 'attention' };
    }
    const lines = items.slice(0, MAX_LINES).map((item) => {
        const head = `${STATUS_LABEL[item.status]}: ${item.sessionTitle}`;
        return clip(content === 'full' && item.body ? `${head} — ${item.body}` : head);
    });
    if (items.length > MAX_LINES) {
        lines.push(`and ${items.length - MAX_LINES} more`);
    }
    return { title: 'Voltran', body: lines.join('\n'), tag: 'attention' };
}

export interface PushNotifierOptions {
    devices: PushDevices;
    settings: () => PushSettings;
    pending: (paneId: string, status: AttentionStatus) => boolean;
    onChange: () => void;
    send?: PushSender;
    now?: () => number;
}

interface Waiting extends PushAttention {
    at: number;
}

export class PushNotifier {
    private readonly options: PushNotifierOptions;
    private readonly send: PushSender;
    private readonly now: () => number;
    private waiting = new Map<string, Waiting>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timerAt = 0;
    private lastInputAt = 0;
    private lastPushAt = -Infinity;

    constructor(options: PushNotifierOptions) {
        this.options = options;
        this.send = options.send ?? sendPush;
        this.now = options.now ?? Date.now;
    }

    attention(item: PushAttention): void {
        const settings = this.options.settings();
        if (!settings.enabled || !settings.events.includes(item.status) || this.options.devices.list().length === 0) {
            return;
        }
        this.waiting.set(item.paneId, { ...item, at: this.now() });
        this.schedule(settings.delaySeconds * 1000);
    }

    userInput(): void {
        this.lastInputAt = this.now();
    }

    private schedule(delayMs: number): void {
        const at = this.now() + Math.max(0, delayMs);
        if (this.timer && this.timerAt <= at) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timerAt = at;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch((error: unknown) => console.error('[voltran] could not send a push notification:', error));
        }, at - this.now());
    }

    async flush(): Promise<void> {
        const settings = this.options.settings();
        const now = this.now();
        const delayMs = settings.delaySeconds * 1000;
        for (const item of this.waiting.values()) {
            const wanted = settings.enabled && settings.events.includes(item.status);
            if (!wanted || item.at <= this.lastInputAt || !this.options.pending(item.paneId, item.status)) {
                this.waiting.delete(item.paneId);
            }
        }
        const due = [...this.waiting.values()].filter((item) => item.at + delayMs <= now);
        const send = due.length > 0 && this.lastPushAt + MIN_GAP_MS <= now;
        if (send) {
            due.forEach((item) => this.waiting.delete(item.paneId));
            this.lastPushAt = now;
        }
        if (this.waiting.size > 0) {
            const next = Math.min(...[...this.waiting.values()].map((item) => item.at + delayMs));
            this.schedule(Math.max(next, this.lastPushAt + MIN_GAP_MS) - now);
        }
        if (send) {
            await this.deliver(this.options.devices.list(), pushMessage(due, settings.content));
        }
    }

    test(deviceId?: string, body = 'This is how Voltran tells you an agent needs you.'): Promise<void> {
        const devices = this.options.devices.list().filter((device) => deviceId === undefined || device.id === deviceId);
        return this.deliver(devices, { title: 'Voltran', body, tag: 'test' });
    }

    private async deliver(devices: PushDevice[], message: PushMessage): Promise<void> {
        try {
            const vapid = this.options.devices.vapid();
            await Promise.all(devices.map(async (device) => {
                let status: number;
                try {
                    ({ status } = await this.send(device.subscription, message, vapid));
                } catch (error) {
                    const reason = withoutControls(error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error));
                    this.options.devices.record(device.id, { lastSentAt: device.lastSentAt, lastError: `Could not reach the push service: ${reason.slice(0, MAX_ERROR)}` });
                    return;
                }
                if (status === 404 || status === 410) {
                    this.options.devices.remove(device.id);
                } else if (status >= 200 && status < 300) {
                    this.options.devices.record(device.id, { lastSentAt: this.now(), lastError: null });
                } else {
                    this.options.devices.record(device.id, { lastSentAt: device.lastSentAt, lastError: `The push service answered ${status}` });
                }
            }));
        } finally {
            this.options.onChange();
        }
    }

    close(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.waiting.clear();
    }
}
