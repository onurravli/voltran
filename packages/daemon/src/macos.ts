import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const CHROME_APPS_DIR = join(homedir(), 'Applications', 'Chrome Apps.localized');
export const CHROME_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
export const LAUNCH_AGENT_LABEL = 'dev.voltran.daemon';
export const LAUNCH_AGENT_FILE = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

export interface ChromeApp {
    id: string;
    profileDirectory: string;
}

function readPlist(file: string): Record<string, unknown> | null {
    try {
        return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        return null;
    }
}

// Chrome writes every installed web app as a small app bundle whose Info.plist names the app id, the
// URL it opens and the profile folder that owns it (`<user data dir>/<profile>/Web Applications/…`).
export function installedChromeApp(url: string, appsDir = CHROME_APPS_DIR, userDataDir = CHROME_USER_DATA_DIR): ChromeApp | null {
    if (!existsSync(appsDir)) {
        return null;
    }
    for (const name of readdirSync(appsDir)) {
        if (!name.endsWith('.app')) {
            continue;
        }
        const plist = readPlist(join(appsDir, name, 'Contents', 'Info.plist'));
        const id = plist?.CrAppModeShortcutID;
        const appDataDir = plist?.CrAppModeUserDataDir;
        if (plist?.CrAppModeShortcutURL !== `${url}/` || typeof id !== 'string' || typeof appDataDir !== 'string') {
            continue;
        }
        const profile = dirname(dirname(appDataDir));
        if (dirname(profile) === userDataDir) {
            return { id, profileDirectory: basename(profile) };
        }
    }
    return null;
}

const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function launchAgentPlist(spec: { program: string[]; env: Record<string, string>; log: string }): string {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${LAUNCH_AGENT_LABEL}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...spec.program.map((arg) => `        <string>${xml(arg)}</string>`),
        '    </array>',
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        ...Object.entries(spec.env).flatMap(([key, value]) => [`        <key>${xml(key)}</key>`, `        <string>${xml(value)}</string>`]),
        '    </dict>',
        '    <key>RunAtLoad</key>',
        '    <true/>',
        '    <key>AbandonProcessGroup</key>',
        '    <true/>',
        '    <key>StandardOutPath</key>',
        `    <string>${xml(spec.log)}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${xml(spec.log)}</string>`,
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
}
