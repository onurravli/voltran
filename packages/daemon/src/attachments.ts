import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PANE_ID = /^[A-Za-z0-9-]{1,64}$/;

export class AttachmentRefused extends Error {}

// What the bytes are decides the extension, never what the client says they are.
export function imageExtension(bytes: Buffer): string | null {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return 'jpg';
    }
    if (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a') {
        return 'gif';
    }
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
        return 'webp';
    }
    return null;
}

// Images pasted into a pane's composer, kept as files because an agent takes an image by its path.
// Each pane has a folder of its own that goes with the pane.
export class AttachmentStore {
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    load(paneIds: Iterable<string>): void {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const known = new Set(paneIds);
        for (const name of readdirSync(this.dir)) {
            if (!known.has(name) && PANE_ID.test(name)) {
                this.remove(name);
            }
        }
    }

    save(paneId: string, bytes: Buffer): string {
        const extension = imageExtension(bytes);
        if (!extension) {
            throw new AttachmentRefused('only PNG, JPEG, GIF and WebP images can be attached');
        }
        const folder = join(this.dir, paneId);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        if (!lstatSync(folder).isDirectory()) {
            throw new AttachmentRefused('the attachments folder is not a folder');
        }
        const path = join(folder, `${randomBytes(8).toString('hex')}.${extension}`);
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
        return path;
    }

    remove(paneId: string): void {
        if (PANE_ID.test(paneId)) {
            rmSync(join(this.dir, paneId), { recursive: true, force: true });
        }
    }
}
