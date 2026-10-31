import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LAUNCH_AGENT_LABEL, installedChromeApp, launchAgentPlist } from './macos.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()!();
    }
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voltran-macos-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function shim(appsDir: string, name: string, plist: Record<string, string> | string): void {
    const contents = join(appsDir, name, 'Contents');
    mkdirSync(contents, { recursive: true });
    const body =
        typeof plist === 'string'
            ? plist
            : `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(plist)
                  .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
                  .join('')}</dict></plist>\n`;
    writeFileSync(join(contents, 'Info.plist'), body);
}

const readPlist = (text: string): unknown => {
    const dir = tempDir();
    writeFileSync(join(dir, 'agent.plist'), text);
    execFileSync('plutil', ['-lint', join(dir, 'agent.plist')]);
    return JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', join(dir, 'agent.plist')], { encoding: 'utf8' }),
    );
};

describe.skipIf(process.platform !== 'darwin')('macOS integration', () => {
    it('finds the Chrome app installed for this daemon in the default Chrome profile folder', () => {
        const appsDir = tempDir();
        const userDataDir = '/Users/me/Library/Application Support/Google/Chrome';
        shim(appsDir, 'Other.app', {
            CrAppModeShortcutID: 'other',
            CrAppModeShortcutURL: 'https://example.com/',
            CrAppModeUserDataDir: `${userDataDir}/Default/Web Applications/_crx_other`,
        });
        shim(appsDir, 'Voltran (test profile).app', {
            CrAppModeShortcutID: 'temp',
            CrAppModeShortcutURL: 'http://127.0.0.1:4747/',
            CrAppModeUserDataDir: '/tmp/profile/Default/Web Applications/_crx_temp',
        });
        shim(appsDir, 'Broken.app', 'not a plist');
        shim(appsDir, 'Voltran.app', {
            CrAppModeShortcutID: 'abc',
            CrAppModeShortcutURL: 'http://127.0.0.1:4747/',
            CrAppModeUserDataDir: `${userDataDir}/Profile 2/Web Applications/_crx_abc`,
        });
        writeFileSync(join(appsDir, 'Icon\r'), '');

        expect(installedChromeApp('http://127.0.0.1:4747', appsDir, userDataDir)).toEqual({
            id: 'abc',
            profileDirectory: 'Profile 2',
        });
        expect(installedChromeApp('http://127.0.0.1:4848', appsDir, userDataDir)).toBeNull();
        expect(installedChromeApp('http://127.0.0.1:4747', join(appsDir, 'missing'), userDataDir)).toBeNull();
    });

    it("takes the profile from Chrome's Local State when several profiles share the app bundle", () => {
        const appsDir = tempDir();
        const userDataDir = tempDir();
        const localState = (appShims: unknown): void =>
            writeFileSync(join(userDataDir, 'Local State'), JSON.stringify({ app_shims: appShims }));
        shim(appsDir, 'Voltran.app', {
            CrAppModeShortcutID: 'abc',
            CrAppModeShortcutURL: 'http://127.0.0.1:4747/',
            CrAppModeUserDataDir: `${userDataDir}/-/Web Applications/_crx_abc`,
        });
        const find = (): unknown => installedChromeApp('http://127.0.0.1:4747', appsDir, userDataDir);

        expect(find()).toBeNull();

        localState({
            abc: { installed_profiles: ['Default', 'Profile 1'], last_active_profiles: ['Profile 3', 'Profile 1'] },
        });
        expect(find()).toEqual({ id: 'abc', profileDirectory: 'Profile 1' });

        localState({ abc: { installed_profiles: ['Default'], last_active_profiles: [] } });
        expect(find()).toEqual({ id: 'abc', profileDirectory: 'Default' });

        localState({
            abc: { installed_profiles: [7, '-', '', '../Default'] },
            other: { installed_profiles: ['Default'] },
        });
        expect(find()).toBeNull();

        writeFileSync(join(userDataDir, 'Local State'), '{');
        expect(find()).toBeNull();
    });

    it('writes a launch agent that runs the given program with its environment', () => {
        const text = launchAgentPlist({
            program: ['/Users/me/.nvm/node', '/Users/me/R&D <voltran>/bin/voltran.mjs', 'up', '--no-open'],
            env: { SHELL: '/bin/zsh', VOLTRAN_PORT: '4800' },
            log: '/Users/me/.voltran/daemon.log',
        });
        expect(readPlist(text)).toEqual({
            Label: LAUNCH_AGENT_LABEL,
            ProgramArguments: ['/Users/me/.nvm/node', '/Users/me/R&D <voltran>/bin/voltran.mjs', 'up', '--no-open'],
            EnvironmentVariables: { SHELL: '/bin/zsh', VOLTRAN_PORT: '4800' },
            RunAtLoad: true,
            AbandonProcessGroup: true,
            StandardOutPath: '/Users/me/.voltran/daemon.log',
            StandardErrorPath: '/Users/me/.voltran/daemon.log',
        });
    });
});
