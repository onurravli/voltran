import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pairing, deviceName, makeCertificates } from './pairing.ts';
import { PushDevices, type PushDevice } from './push.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

const SUBSCRIPTION = {
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
};
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

interface Reply {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

async function startPairing(): Promise<{ pairing: Pairing; devices: PushDevices; folder: string; paired: PushDevice[]; port: number; code: string; ca: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-pairing-test-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const devices = new PushDevices(join(dir, 'push'));
    const folder = join(dir, 'push', 'pairing');
    const paired: PushDevice[] = [];
    const pairing = new Pairing({
        devices,
        folder,
        onChange: () => undefined,
        onPaired: (device) => paired.push(device),
        network: () => ({ ip: '127.0.0.1', dnsName: null }),
        reveal: () => undefined,
    });
    cleanups.unshift(() => pairing.stop());
    await pairing.start();
    const url = new URL(pairing.pairingUrl()!);
    const profile = readFileSync(join(folder, '1 Voltran pairing.mobileconfig'), 'utf8');
    const der = Buffer.from(/<data>([^<]+)<\/data>/.exec(profile)![1], 'base64');
    return { pairing, devices, folder, paired, port: Number(url.port), code: url.pathname.split('/')[2], ca: new X509Certificate(der).toString() };
}

function fetchPairing(port: number, ca: string, path: string, options: { method?: string; body?: string; host?: string; userAgent?: string } = {}): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
        const req = request({
            host: '127.0.0.1',
            port,
            path,
            method: options.method ?? 'GET',
            ca,
            ...(options.host ? { checkServerIdentity: () => undefined } : {}),
            headers: { Host: options.host ?? `127.0.0.1:${port}`, 'User-Agent': options.userAgent ?? 'test', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end(options.body);
    });
}

describe('makeCertificates', () => {
    it('makes a CA constrained to the one address, and leaves no key behind', async () => {
        const before = readdirSync(tmpdir()).filter((name) => name.startsWith('voltran-pairing-') && !name.startsWith('voltran-pairing-test-'));
        const certificates = await makeCertificates({ ip: '192.168.1.20', dnsName: 'studio.local' });
        const after = readdirSync(tmpdir()).filter((name) => name.startsWith('voltran-pairing-') && !name.startsWith('voltran-pairing-test-'));
        expect(after).toEqual(before);

        const text = execFileSync('openssl', ['x509', '-inform', 'DER', '-noout', '-text'], { input: certificates.caDer }).toString();
        expect(text).toMatch(/Name Constraints: critical/);
        expect(text).toMatch(/DNS:studio\.local/);
        expect(text).toMatch(/IP:192\.168\.1\.20\/255\.255\.255\.255/);
        expect(text).toMatch(/CA:TRUE, pathlen:0/);

        const ca = new X509Certificate(certificates.caDer);
        const leaf = new X509Certificate(certificates.cert);
        expect(leaf.verify(ca.publicKey)).toBe(true);
        expect(leaf.subjectAltName).toBe('DNS:studio.local, IP Address:192.168.1.20');
        expect(new Date(ca.validTo).getTime() - Date.now()).toBeLessThanOrEqual(86_400_000 + 60_000);
    });
});

describe('Pairing', () => {
    it('writes the profile and the link for AirDrop, readable by the user alone', async () => {
        const { folder, pairing } = await startPairing();
        expect(statSync(folder).mode & 0o777).toBe(0o700);
        expect(statSync(join(folder, '1 Voltran pairing.mobileconfig')).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(folder, '2 Open Voltran pairing.webloc'), 'utf8')).toContain(pairing.pairingUrl()!);
        expect(pairing.view()?.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        pairing.stop();
        expect(existsSync(folder)).toBe(false);
        expect(pairing.view()).toBeNull();
    });

    it('serves the pairing page over TLS the profile vouches for, with the code only', async () => {
        const { port, code, ca } = await startPairing();
        const page = await fetchPairing(port, ca, `/p/${code}`);
        expect(page.status).toBe(200);
        expect(page.body).toContain('Add to Home Screen');
        expect(page.headers['content-security-policy']).toMatch(/default-src 'none'/);
        expect((await fetchPairing(port, ca, `/p/${'A'.repeat(code.length)}`)).status).toBe(404);
        expect((await fetchPairing(port, ca, `/p/${code}`, { host: 'evil.example:443' })).status).toBe(421);
        expect((await fetchPairing(port, ca, '/api/state')).status).toBe(404);
    });

    it('takes one subscription, names the device, and refuses the code afterwards', async () => {
        const { port, code, ca, devices, paired, pairing } = await startPairing();
        const forged = await fetchPairing(port, ca, `/subscribe/${code}`, { method: 'POST', body: JSON.stringify({ ...SUBSCRIPTION, endpoint: 'https://127.0.0.1:4747/api/shutdown' }) });
        expect(forged.status).toBe(400);
        expect(devices.list()).toHaveLength(0);

        const ok = await fetchPairing(port, ca, `/subscribe/${code}`, { method: 'POST', body: JSON.stringify(SUBSCRIPTION), userAgent: IPHONE });
        expect(ok.status).toBe(200);
        expect(paired.map((device) => device.name)).toEqual(['iPhone']);
        expect(devices.list()[0].subscription.endpoint).toBe(SUBSCRIPTION.endpoint);

        expect((await fetchPairing(port, ca, `/subscribe/${code}`, { method: 'POST', body: JSON.stringify(SUBSCRIPTION) })).status).toBe(404);
        expect((await fetchPairing(port, ca, `/p/${code}`)).status).toBe(404);
        await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
        expect(pairing.view()).toBeNull();
    });

    it('installs the phone\'s service worker without an icon to cache', async () => {
        const { port, ca } = await startPairing();
        const worker = await fetchPairing(port, ca, '/sw.js');
        expect(worker.status).toBe(200);
        const listeners = new Map<string, (event: unknown) => void>();
        let installed: Promise<unknown> | null = null;
        const add = async (path: string): Promise<void> => {
            const { status } = await fetchPairing(port, ca, path);
            if (status !== 200) {
                throw new TypeError(`${path} answered ${status}`);
            }
        };
        const cache = { add, addAll: (paths: string[]) => Promise.all(paths.map(add)) };
        runInNewContext(worker.body, {
            self: { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener), skipWaiting: () => undefined },
            caches: { open: async () => cache },
        });
        listeners.get('install')!({ waitUntil: (promise: Promise<unknown>) => { installed = promise; } });
        await expect(installed).resolves.toBeDefined();
    });

    it('opens nothing when it cannot get the push key or write the pairing files', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voltran-pairing-test-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const devices = new PushDevices(join(dir, 'push'));
        const options = { devices, onChange: () => undefined, onPaired: () => undefined, network: () => ({ ip: '127.0.0.1', dnsName: null }), reveal: () => undefined };

        const unwritable = new Pairing({ ...options, folder: join(dir, 'file', 'pairing') });
        writeFileSync(join(dir, 'file'), '');
        await expect(unwritable.start()).rejects.toThrow();
        expect(unwritable.view()).toBeNull();

        const noKey = new Pairing({ ...options, folder: join(dir, 'pairing') });
        cleanups.unshift(() => noKey.stop());
        vi.spyOn(devices, 'vapid').mockImplementation(() => {
            throw new Error('ENOSPC');
        });
        await expect(noKey.start()).rejects.toThrow('ENOSPC');
        expect(noKey.view()).toBeNull();
        expect(existsSync(join(dir, 'pairing'))).toBe(false);
    });

    it('answers a subscription it cannot save with an error and keeps the code', async () => {
        const { port, code, ca, devices, paired } = await startPairing();
        const add = vi.spyOn(devices, 'add').mockImplementationOnce(() => {
            throw new Error('ENOSPC');
        });
        const failed = await fetchPairing(port, ca, `/subscribe/${code}`, { method: 'POST', body: JSON.stringify(SUBSCRIPTION), userAgent: IPHONE });
        expect(failed.status).toBe(500);
        expect(paired).toHaveLength(0);
        add.mockRestore();
        expect((await fetchPairing(port, ca, `/subscribe/${code}`, { method: 'POST', body: JSON.stringify(SUBSCRIPTION), userAgent: IPHONE })).status).toBe(200);
        expect(paired).toHaveLength(1);
    });

    it('opens one listener when asked twice at once', async () => {
        const { pairing } = await startPairing();
        pairing.stop();
        const [first, second] = await Promise.all([pairing.start(), pairing.start()]);
        expect(second).toEqual(first);
        const url = new URL(pairing.pairingUrl()!);
        pairing.stop();
        await expect(new Promise((resolveConnect, reject) => {
            request({ host: '127.0.0.1', port: Number(url.port), path: '/', rejectUnauthorized: false }, resolveConnect).on('error', reject).end();
        })).rejects.toThrow(/ECONNREFUSED/);
    });

    it('opens nothing when stopped while it is still starting', async () => {
        const { pairing } = await startPairing();
        pairing.stop();
        const starting = pairing.start();
        pairing.stop();
        await expect(starting).rejects.toThrow('Pairing was stopped.');
        expect(pairing.view()).toBeNull();
    });

    it('closes after ten wrong codes', async () => {
        const { port, ca, pairing } = await startPairing();
        for (let attempt = 0; attempt < 10; attempt++) {
            await fetchPairing(port, ca, `/p/wrong${attempt}`);
        }
        await new Promise((resolveWait) => setImmediate(resolveWait));
        expect(pairing.view()).toBeNull();
    });
});

describe('deviceName', () => {
    it('reads the kind of phone from the user agent', () => {
        expect(deviceName(IPHONE)).toBe('iPhone');
        expect(deviceName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
        expect(deviceName('Mozilla/5.0 (Linux; Android 15)')).toBe('Android phone');
        expect(deviceName(undefined)).toBe('Phone');
    });
});
