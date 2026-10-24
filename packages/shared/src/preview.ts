// A preview pane frames a page inside Voltran's window, which the daemon's Content-Security-Policy
// allows only for these loopback sources. CSP has no syntax for an IPv6 address, so [::1] is not one.
export const PREVIEW_FRAME_SOURCES = [
    'http://localhost:*',
    'https://localhost:*',
    'http://*.localhost:*',
    'https://*.localhost:*',
    'http://127.0.0.1:*',
    'https://127.0.0.1:*',
];

export const MAX_PREVIEW_URL = 2000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function previewUrl(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_PREVIEW_URL || /\s/.test(trimmed)) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        return null;
    }
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') ? url.href : null;
}
