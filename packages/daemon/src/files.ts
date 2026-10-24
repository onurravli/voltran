import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A fresh name opened with O_EXCL, then a rename: nothing already in the folder, such as a link an
// agent planted, is ever written through.
export function replaceFile(dir: string, name: string, content: string, mode: number): void {
    const temporary = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    try {
        writeFileSync(temporary, content, { mode, flag: 'wx' });
        renameSync(temporary, join(dir, name));
    } finally {
        rmSync(temporary, { force: true });
    }
}
