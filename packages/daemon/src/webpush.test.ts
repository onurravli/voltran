import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    encryptPayload,
    generateVapidKeys,
    vapidAuthorization,
    validSubscription,
    verifyVapidAuthorization,
    type PushSubscription,
} from './webpush.ts';

// RFC 8291, section 5 and appendix A.
const RFC = {
    plaintext: 'When I grow up, I want to be a watermelon',
    receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const subscription: PushSubscription = {
    endpoint: 'https://web.push.apple.com/QGuQyavXutnMH8RfkA',
    keys: {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
};

function decrypt(body: Buffer, receiverPrivate: string, sub: PushSubscription): string {
    const salt = body.subarray(0, 16);
    const keyLength = body.readUInt8(20);
    const senderKey = body.subarray(21, 21 + keyLength);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(receiverPrivate, 'base64url'));
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(sub.keys.p256dh, 'base64url'), senderKey]);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(senderKey), Buffer.from(sub.keys.auth, 'base64url'), keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const record = body.subarray(21 + keyLength);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

describe('encryptPayload', () => {
    it('produces the RFC 8291 example byte for byte', () => {
        const body = encryptPayload(RFC.plaintext, subscription, {
            privateKey: Buffer.from(RFC.senderPrivate, 'base64url'),
            salt: Buffer.from(RFC.salt, 'base64url'),
        });
        expect(body.toString('base64url')).toBe(RFC.body);
    });

    it('uses a fresh key and salt for every message, which only the subscriber can read', () => {
        const first = encryptPayload('{"title":"Voltran"}', subscription);
        const second = encryptPayload('{"title":"Voltran"}', subscription);
        expect(first.equals(second)).toBe(false);
        expect(decrypt(first, RFC.receiverPrivate, subscription)).toBe('{"title":"Voltran"}');
    });

    it('refuses a payload that does not fit one record', () => {
        expect(() => encryptPayload('x'.repeat(5000), subscription)).toThrow(/too large/);
    });
});

describe('VAPID', () => {
    it('signs a token for the push service origin that verifies with the public key', () => {
        const keys = generateVapidKeys();
        const header = vapidAuthorization(subscription.endpoint, keys, 1_700_000_000_000);
        expect(header).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
        const claims = JSON.parse(Buffer.from(header.split('.')[1], 'base64url').toString('utf8'));
        expect(claims).toEqual({
            aud: 'https://web.push.apple.com',
            exp: 1_700_000_000 + 12 * 3600,
            sub: 'https://github.com/onurravli/voltran',
        });
        expect(verifyVapidAuthorization(header, keys)).toBe(true);
        expect(verifyVapidAuthorization(header, generateVapidKeys())).toBe(false);
    });
});

describe('validSubscription', () => {
    it('accepts the push services browsers use', () => {
        for (const endpoint of [
            'https://web.push.apple.com/x',
            'https://fcm.googleapis.com/fcm/send/x',
            'https://updates.push.services.mozilla.com/wpush/v2/x',
        ]) {
            expect(validSubscription({ ...subscription, endpoint })?.endpoint).toBe(endpoint);
        }
    });

    it('refuses endpoints that would send the daemon anywhere else', () => {
        for (const endpoint of [
            'https://127.0.0.1:4747/api/shutdown',
            'https://localhost/x',
            'https://192.168.1.1/x',
            'http://web.push.apple.com/x',
            'https://web.push.apple.com:8443/x',
            'https://user@web.push.apple.com/x',
            'https://web.push.apple.com.example.com/x',
            'not a url',
        ]) {
            expect(validSubscription({ ...subscription, endpoint })).toBeNull();
        }
    });

    it('refuses malformed keys', () => {
        expect(validSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: 'AAAA' } })).toBeNull();
        expect(validSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'AAAA' } })).toBeNull();
        expect(validSubscription({ endpoint: subscription.endpoint })).toBeNull();
        expect(validSubscription(null)).toBeNull();
    });
});
