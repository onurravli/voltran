import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify } from 'node:crypto';

export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
    publicKey: string;
    privateKey: string;
}

export interface PushResult {
    status: number;
}

export type PushSender = (subscription: PushSubscription, payload: unknown, vapid: VapidKeys) => Promise<PushResult>;

const RECORD_SIZE = 4096;
const TTL_SECONDS = 3600;
const SEND_TIMEOUT_MS = 10_000;
// Apple refuses a VAPID subject it cannot reach, such as a mailto: at localhost.
export const VAPID_SUBJECT = 'https://github.com/onurravli/voltran';

// The push services browsers subscribe with. A subscription names the URL the daemon posts to, so any
// other host is refused: a forged one would otherwise send the daemon's requests into the LAN.
const PUSH_HOSTS = [
    /^web\.push\.apple\.com$/,
    /^[a-z0-9-]+\.push\.apple\.com$/,
    /^fcm\.googleapis\.com$/,
    /^updates\.push\.services\.mozilla\.com$/,
    /^[a-z0-9-]+\.notify\.windows\.com$/,
];

const fromBase64Url = (text: string): Buffer => Buffer.from(text, 'base64url');

export function validSubscription(raw: unknown): PushSubscription | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') {
        return null;
    }
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !PUSH_HOSTS.some((host) => host.test(url.hostname))) {
        return null;
    }
    const p256dh = fromBase64Url(keys.p256dh);
    const auth = fromBase64Url(keys.auth);
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) {
        return null;
    }
    return { endpoint: url.href, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

// RFC 8291: only the browser that made the subscription can read the payload; the push service
// carries ciphertext.
export function encryptPayload(plaintext: string, subscription: PushSubscription, fixed: { privateKey?: Buffer; salt?: Buffer } = {}): Buffer {
    const receiverKey = fromBase64Url(subscription.keys.p256dh);
    const authSecret = fromBase64Url(subscription.keys.auth);
    const ecdh = createECDH('prime256v1');
    if (fixed.privateKey) {
        ecdh.setPrivateKey(fixed.privateKey);
    } else {
        ecdh.generateKeys();
    }
    const senderKey = ecdh.getPublicKey();
    const salt = fixed.salt ?? randomBytes(16);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderKey]);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(receiverKey), authSecret, keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const record = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
    if (record.length + 16 > RECORD_SIZE) {
        throw new Error('push payload too large');
    }
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(senderKey.length, 20);
    return Buffer.concat([header, senderKey, body]);
}

export function generateVapidKeys(): VapidKeys {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

function vapidJwk(vapid: VapidKeys, withPrivate: boolean): Record<string, string> {
    const key = fromBase64Url(vapid.publicKey);
    const jwk = { kty: 'EC', crv: 'P-256', x: key.subarray(1, 33).toString('base64url'), y: key.subarray(33, 65).toString('base64url') };
    return withPrivate ? { ...jwk, d: vapid.privateKey } : jwk;
}

// RFC 8292: proves to the push service that this daemon is the one the browser subscribed for.
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): string {
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT })).toString('base64url');
    const key = createPrivateKey({ key: vapidJwk(vapid, true), format: 'jwk' });
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${signature.toString('base64url')}, k=${vapid.publicKey}`;
}

export function verifyVapidAuthorization(value: string, vapid: VapidKeys): boolean {
    const token = /^vapid t=([^,]+), k=/.exec(value)?.[1];
    const [header, claims, signature] = token?.split('.') ?? [];
    if (!header || !claims || !signature) {
        return false;
    }
    const key = createPublicKey({ key: vapidJwk(vapid, false), format: 'jwk' });
    return verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, fromBase64Url(signature));
}

export const sendPush: PushSender = async (subscription, payload, vapid) => {
    const response = await fetch(subscription.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
            Authorization: vapidAuthorization(subscription.endpoint, vapid),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(TTL_SECONDS),
            Urgency: 'high',
        },
        body: new Uint8Array(encryptPayload(JSON.stringify(payload), subscription)),
    });
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
};
