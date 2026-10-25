import { describe, expect, it } from 'vitest';
import { previewUrl } from './preview.ts';

describe('previewUrl', () => {
    it('takes a loopback address with or without a scheme', () => {
        expect(previewUrl('localhost:5173')).toBe('http://localhost:5173/');
        expect(previewUrl('HTTPS://Localhost:8443/a?b=1#c')).toBe('https://localhost:8443/a?b=1#c');
        expect(previewUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
        expect(previewUrl('app.localhost:3000')).toBe('http://app.localhost:3000/');
    });

    it('refuses every other page and scheme', () => {
        for (const text of [
            'example.com',
            'localhost.example.com',
            '127.0.0.2:80',
            'http://[::1]:8080',
            '192.168.1.2:3000',
            'file:///etc/passwd',
            'javascript:alert(1)',
            'ftp://localhost',
            'http://user:pw@localhost',
            'npm run dev',
            '',
        ]) {
            expect(previewUrl(text), text).toBeNull();
        }
    });
});
