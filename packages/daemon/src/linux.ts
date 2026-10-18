import { homedir } from 'node:os';
import { join } from 'node:path';
import { findOnPath } from './adapters.ts';

export const SYSTEMD_UNIT_NAME = 'voltran.service';
export const SYSTEMD_UNIT_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT_NAME);

const CHROME_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

export function findChrome(path = process.env.PATH ?? ''): string | null {
    for (const binary of CHROME_BINARIES) {
        const found = findOnPath(binary, path);
        if (found) {
            return found;
        }
    }
    return null;
}

const quote = (text: string): string => `"${text.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

// Only ExecStart expands $VARIABLES; Environment takes $ as it is.
const commandWord = (text: string): string => quote(text).replace(/\$/g, '$$$$');

// `up` starts the daemon detached and exits, so the unit is a oneshot that stays active, and
// KillMode=process leaves the daemon (and its panes) running when the unit stops, as launchd's
// AbandonProcessGroup does on macOS.
export function systemdUnit(spec: { program: string[]; env: Record<string, string>; log: string }): string {
    return [
        '[Unit]',
        'Description=Voltran daemon',
        '',
        '[Service]',
        'Type=oneshot',
        'RemainAfterExit=yes',
        'KillMode=process',
        `ExecStart=${spec.program.map(commandWord).join(' ')}`,
        ...Object.entries(spec.env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
        `StandardOutput=append:${spec.log.replace(/%/g, '%%')}`,
        `StandardError=append:${spec.log.replace(/%/g, '%%')}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}
