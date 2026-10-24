import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PushPairingView } from '@voltran/shared';
import type { PushDevice, PushDevices } from './push.ts';
import { validSubscription } from './webpush.ts';

export interface PairingNetwork {
    ip: string;
    dnsName: string | null;
}

export interface PairingOptions {
    devices: PushDevices;
    folder: string;
    iconFile?: string;
    onChange: () => void;
    onPaired: (device: PushDevice) => void;
    network?: () => PairingNetwork | null;
    reveal?: (folder: string) => void;
    windowMs?: number;
}

interface Certificates {
    key: Buffer;
    cert: Buffer;
    caDer: Buffer;
    fingerprint: string;
}

interface Active {
    server: Server;
    code: string;
    url: string;
    hosts: Set<string>;
    expiresAt: number;
    fingerprint: string;
    timer: ReturnType<typeof setTimeout>;
    failures: number;
    paired: boolean;
}

const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 10;
const BODY_LIMIT = 4096;
const CLOSE_AFTER_PAIRING_MS = 2000;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// VPN clients (WARP, Netskope, WireGuard) add tunnel interfaces with private addresses too; the phone
// can only reach Wi-Fi or Ethernet.
export function lanNetwork(): PairingNetwork | null {
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
        if (!/^(en|eth|wl)/.test(name)) {
            continue;
        }
        const address = addresses?.find((entry) => entry.family === 'IPv4' && !entry.internal && PRIVATE_IPV4.test(entry.address));
        if (address) {
            const host = hostname().replace(/\.local$/, '');
            return { ip: address.address, dnsName: /^[A-Za-z0-9-]{1,63}$/.test(host) ? `${host}.local` : null };
        }
    }
    return null;
}

export function revealFolder(folder: string): void {
    if (process.platform !== 'darwin') {
        return;
    }
    const child = spawn('open', [folder], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
}

// A CA for one pairing, name-constrained to this computer's LAN address, whose key is gone once it has
// signed the one server certificate: the profile a phone installs can never vouch for anything else,
// and nothing on disk can mint another certificate it trusts.
export function makeCertificates(network: PairingNetwork): Certificates {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-pairing-'));
    try {
        const file = (name: string): string => join(dir, name);
        const openssl = (...args: string[]): void => {
            execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
        };
        const names = [...(network.dnsName ? [`DNS:${network.dnsName}`] : []), `IP:${network.ip}`];
        writeFileSync(file('ca.cnf'), [
            '[req]', 'distinguished_name=dn', 'prompt=no',
            '[dn]', `CN=Voltran pairing ${new Date().toISOString().slice(0, 16)}`,
            '[ca]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign', 'subjectKeyIdentifier=hash',
            `nameConstraints=critical,${names.map((name) => `permitted;${name.startsWith('IP:') ? `${name}/255.255.255.255` : name}`).join(',')}`,
        ].join('\n'), { mode: 0o600 });
        writeFileSync(file('leaf.cnf'), [
            'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth',
            `subjectAltName=${names.join(',')}`, 'authorityKeyIdentifier=keyid',
        ].join('\n'), { mode: 0o600 });
        openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file('ca.key'));
        openssl('req', '-x509', '-new', '-key', file('ca.key'), '-sha256', '-days', '1', '-config', file('ca.cnf'), '-extensions', 'ca', '-out', file('ca.crt'));
        openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file('leaf.key'));
        openssl('req', '-new', '-key', file('leaf.key'), '-subj', '/CN=Voltran', '-out', file('leaf.csr'));
        openssl('x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-set_serial', `0x${randomBytes(16).toString('hex')}`,
            '-days', '1', '-sha256', '-extfile', file('leaf.cnf'), '-out', file('leaf.crt'));
        const ca = new X509Certificate(readFileSync(file('ca.crt')));
        return { key: readFileSync(file('leaf.key')), cert: readFileSync(file('leaf.crt')), caDer: ca.raw, fingerprint: ca.fingerprint256 };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export function pairingProfile(caDer: Buffer, expiresAt: number): string {
    const id = randomUUID();
    const expires = new Date(expiresAt).toISOString().slice(0, 10);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadCertificateFileName</key><string>voltran-pairing.cer</string>
<key>PayloadContent</key><data>${caDer.toString('base64')}</data>
<key>PayloadDisplayName</key><string>Voltran pairing</string>
<key>PayloadIdentifier</key><string>dev.voltran.pairing.${id}.ca</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDescription</key><string>Lets this phone open Voltran's pairing page on your computer, at that one address only. It expires ${expires}; delete it as soon as pairing is done.</string>
<key>PayloadDisplayName</key><string>Voltran pairing (expires ${expires})</string>
<key>PayloadIdentifier</key><string>dev.voltran.pairing.${id}</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${id}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>
`;
}

function weblocFile(url: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>${url}</string></dict></plist>
`;
}

export function deviceName(userAgent: string | undefined): string {
    if (/iPad/.test(userAgent ?? '')) {
        return 'iPad';
    }
    if (/iPhone/.test(userAgent ?? '')) {
        return 'iPhone';
    }
    return /Android/.test(userAgent ?? '') ? 'Android phone' : 'Phone';
}

const STYLE = 'body{font:17px -apple-system,system-ui,sans-serif;background:#16171a;color:#eaeaec;margin:0;padding:56px 24px}'
    + 'h1{font-size:28px}button{font:inherit;padding:14px 22px;border-radius:12px;border:0;background:#ebb862;color:#16171a}'
    + 'b{color:#ebb862}#log{color:#a0a0a8}';

const PAIR_SCRIPT = `
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const $ = (id) => document.getElementById(id);
const log = (text) => { $('log').textContent = text; };
$('browser').hidden = standalone;
$('app').hidden = !standalone;
$('go').onclick = async () => {
    $('go').disabled = true;
    try {
        const { code, key } = document.body.dataset;
        if (await Notification.requestPermission() !== 'granted') {
            throw new Error('Notifications were not allowed. Turn them on for Voltran in Settings, then try again.');
        }
        const registration = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        const applicationServerKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        const response = await fetch('/subscribe/' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) });
        if (!response.ok) {
            throw new Error(await response.text());
        }
        $('app').hidden = true;
        $('done').hidden = false;
    } catch (error) {
        log(error.message);
        $('go').disabled = false;
    }
};
`;

const PAIR_SCRIPT_HASH = `'sha256-${createHash('sha256').update(PAIR_SCRIPT).digest('base64')}'`;

const page = (body: string, extraHead = '', attributes = ''): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Voltran"><link rel="apple-touch-icon" href="/icon.png">${extraHead}
<title>Voltran</title><style>${STYLE}</style></head><body${attributes}>${body}</body></html>`;

function pairPage(code: string, key: string): string {
    return page(`<h1>Voltran</h1>
<div id="browser"><p>Tap <b>Share</b>, then <b>Add to Home Screen</b>, and open Voltran from your home screen.</p></div>
<div id="app" hidden><p>Allow notifications so your computer can tell you when an agent needs you.</p><button id="go" type="button">Enable notifications</button></div>
<div id="done" hidden><p>Paired. A test notification is on its way.</p><p>Now delete the pairing profile: <b>Settings → General → VPN &amp; Device Management</b>. Notifications keep working without it.</p></div>
<p id="log"></p><script>${PAIR_SCRIPT}</script>`, `<link rel="manifest" href="/manifest/${code}.webmanifest">`, ` data-code="${code}" data-key="${key}"`);
}

const DONE_PAGE = page('<h1>Voltran</h1><p>Go back to your computer: an agent is waiting for you.</p>');

const SERVICE_WORKER = `
self.addEventListener('install', (event) => {
    event.waitUntil(caches.open('voltran').then((cache) => cache.addAll(['/done', '/icon.png'])));
    self.skipWaiting();
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    const path = new URL(event.request.url).pathname;
    if (event.request.mode === 'navigate' || path === '/done' || path === '/icon.png') {
        event.respondWith(fetch(event.request, { signal: AbortSignal.timeout(3000) })
            .catch(() => caches.match(path === '/icon.png' ? '/icon.png' : '/done')));
    }
});
self.addEventListener('push', (event) => {
    let message = { title: 'Voltran', body: 'Something needs you.', tag: 'attention' };
    try {
        message = event.data.json();
    } catch {}
    event.waitUntil(self.registration.showNotification(message.title, { body: message.body, tag: message.tag, icon: '/icon.png' }));
});
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(self.clients.openWindow('/done'));
});
`;

const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    `script-src ${PAIR_SCRIPT_HASH}`,
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

// The one door into this computer from the LAN, open for minutes: it serves the pairing page and takes
// one subscription, behind a single-use code, and touches nothing else the daemon has.
export class Pairing {
    private readonly options: PairingOptions;
    private active: Active | null = null;
    private starting: Promise<PushPairingView> | null = null;

    constructor(options: PairingOptions) {
        this.options = options;
        rmSync(options.folder, { recursive: true, force: true });
    }

    view(): PushPairingView | null {
        return this.active ? { expiresAt: this.active.expiresAt, fingerprint: this.active.fingerprint } : null;
    }

    start(): Promise<PushPairingView> {
        if (this.active) {
            return Promise.resolve(this.view()!);
        }
        this.starting ??= this.open().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    private async open(): Promise<PushPairingView> {
        const network = (this.options.network ?? lanNetwork)();
        if (!network) {
            throw new Error('This computer has no Wi-Fi or Ethernet address on a private network. Connect it to the same network as your phone.');
        }
        const certificates = makeCertificates(network);
        const code = randomBytes(18).toString('base64url');
        const server = createServer({ key: certificates.key, cert: certificates.cert });
        await new Promise<void>((resolveListen, reject) => {
            server.once('error', reject);
            server.listen(0, network.ip, () => resolveListen());
        });
        const { port } = server.address() as { port: number };
        const expiresAt = Date.now() + (this.options.windowMs ?? WINDOW_MS);
        const url = `https://${network.ip}:${port}/p/${code}`;
        this.active = {
            server,
            code,
            url,
            hosts: new Set([`${network.ip}:${port}`, ...(network.dnsName ? [`${network.dnsName}:${port}`] : [])]),
            expiresAt,
            fingerprint: certificates.fingerprint,
            timer: setTimeout(() => this.stop(), expiresAt - Date.now()),
            failures: 0,
            paired: false,
        };
        server.on('request', (req, res) => this.handle(req, res));
        mkdirSync(this.options.folder, { recursive: true, mode: 0o700 });
        writeFileSync(join(this.options.folder, '1 Voltran pairing.mobileconfig'), pairingProfile(certificates.caDer, expiresAt), { mode: 0o600 });
        writeFileSync(join(this.options.folder, '2 Open Voltran pairing.webloc'), weblocFile(url), { mode: 0o600 });
        (this.options.reveal ?? revealFolder)(this.options.folder);
        this.options.onChange();
        return this.view()!;
    }

    pairingUrl(): string | null {
        return this.active?.url ?? null;
    }

    stop(): void {
        const active = this.active;
        if (!active) {
            return;
        }
        this.active = null;
        clearTimeout(active.timer);
        active.server.close();
        active.server.closeAllConnections();
        rmSync(this.options.folder, { recursive: true, force: true });
        this.options.onChange();
    }

    private accepts(active: Active, given: string): boolean {
        const ok = !active.paired && given.length === active.code.length && timingSafeEqual(Buffer.from(given), Buffer.from(active.code));
        if (!ok && ++active.failures >= MAX_FAILURES) {
            setImmediate(() => this.stop());
        }
        return ok;
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        const active = this.active;
        const reply = (status: number, type: string, body: string | Buffer): void => {
            res.writeHead(status, {
                'Content-Type': type,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': CONTENT_SECURITY_POLICY,
            });
            res.end(body);
        };
        if (!active || !active.hosts.has(req.headers.host ?? '')) {
            reply(421, 'text/plain; charset=utf-8', 'wrong host');
            return;
        }
        const path = (req.url ?? '/').split('?')[0];
        const match = (pattern: RegExp): string | null => pattern.exec(path)?.[1] ?? null;
        let code: string | null;
        if (req.method === 'GET' && (code = match(/^\/p\/([\w-]+)$/)) !== null && this.accepts(active, code)) {
            reply(200, 'text/html; charset=utf-8', pairPage(active.code, this.options.devices.vapid().publicKey));
        } else if (req.method === 'GET' && (code = match(/^\/manifest\/([\w-]+)\.webmanifest$/)) !== null && this.accepts(active, code)) {
            reply(200, 'application/manifest+json', JSON.stringify({
                name: 'Voltran',
                start_url: `/p/${active.code}`,
                scope: '/',
                display: 'standalone',
                background_color: '#16171a',
                theme_color: '#16171a',
                icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }],
            }));
        } else if (req.method === 'GET' && path === '/sw.js') {
            reply(200, 'text/javascript; charset=utf-8', SERVICE_WORKER);
        } else if (req.method === 'GET' && path === '/done') {
            reply(200, 'text/html; charset=utf-8', DONE_PAGE);
        } else if (req.method === 'GET' && path === '/icon.png' && this.options.iconFile && existsSync(this.options.iconFile)) {
            reply(200, 'image/png', readFileSync(this.options.iconFile));
        } else if (req.method === 'POST' && (code = match(/^\/subscribe\/([\w-]+)$/)) !== null && this.accepts(active, code)) {
            this.subscribe(active, req, (status, text) => reply(status, 'text/plain; charset=utf-8', text));
        } else {
            reply(404, 'text/plain; charset=utf-8', 'not found');
        }
    }

    private subscribe(active: Active, req: IncomingMessage, reply: (status: number, text: string) => void): void {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > BODY_LIMIT) {
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            let raw: unknown = null;
            try {
                raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                // answered below as an invalid subscription
            }
            const subscription = validSubscription(raw);
            if (!subscription || active.paired || this.active !== active) {
                reply(400, 'This is not a subscription Voltran can use.');
                return;
            }
            active.paired = true;
            const device = this.options.devices.add(subscription, deviceName(req.headers['user-agent']));
            reply(200, 'ok');
            this.options.onPaired(device);
            setTimeout(() => {
                if (this.active === active) {
                    this.stop();
                }
            }, CLOSE_AFTER_PAIRING_MS);
        });
    }
}
