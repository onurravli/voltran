import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentRefused, AttachmentStore, imageExtension } from './attachments.ts';

const cleanups: (() => void)[] = [];

afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
});

function store(): { dir: string; attachments: AttachmentStore } {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-attachments-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, attachments: new AttachmentStore(join(dir, 'attachments')) };
}

describe('imageExtension', () => {
    it('names an image by its bytes and refuses anything else', () => {
        expect(imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
        expect(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
        expect(imageExtension(Buffer.from('GIF89a...'))).toBe('gif');
        expect(imageExtension(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
        expect(imageExtension(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
        expect(imageExtension(Buffer.alloc(0))).toBeNull();
    });
});

describe('AttachmentStore', () => {
    it('deletes the folders of panes that no longer exist when it loads', () => {
        const { dir, attachments } = store();
        attachments.load([]);
        attachments.save('kept', Buffer.from('GIF89a'));
        attachments.save('gone', Buffer.from('GIF89a'));
        attachments.load(['kept']);
        expect(readdirSync(join(dir, 'attachments'))).toEqual(['kept']);
    });

    it('refuses to write through a link planted as a pane folder', () => {
        const { dir, attachments } = store();
        attachments.load(['pane']);
        mkdirSync(join(dir, 'elsewhere'));
        symlinkSync(join(dir, 'elsewhere'), join(dir, 'attachments', 'pane'));
        expect(() => attachments.save('pane', Buffer.from('GIF89a'))).toThrow(AttachmentRefused);
        expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
    });
});
