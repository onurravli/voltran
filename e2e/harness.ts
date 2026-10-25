import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import type { AppState, PaneView, Project, Session } from '@voltran/shared';

// Panes run this instead of the user's login shell: no profile, and a prompt the tests can wait for.
const TEST_SHELL = `#!/bin/sh
[ "$1" = "-l" ] && shift
PS1='e2e$ ' BASH_SILENCE_DEPRECATION_WARNING=1 exec /bin/sh "$@"
`;

const CHROME_PATHS = [
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const freePort = (): Promise<number> =>
    new Promise((resolvePort) => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as AddressInfo;
            probe.close(() => resolvePort(port));
        });
    });

export async function until(condition: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const DAEMON = fileURLToPath(new URL('../packages/daemon/src/main.ts', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../packages/web/dist/index.html', import.meta.url));

// A daemon in its own process, as `voltran up` starts it, so stopping it closes every socket the way
// a real restart does.
export class Voltran {
    readonly root: string;
    readonly home: string;
    readonly work: string;
    private readonly fakeBin: string;
    private port = 0;
    private child: ChildProcess | null = null;
    private token = '';

    constructor() {
        this.root = mkdtempSync(join(tmpdir(), 'voltran-e2e-'));
        this.home = join(this.root, 'home');
        this.work = join(this.root, 'work');
        this.fakeBin = join(this.root, 'bin');
        mkdirSync(this.work);
        mkdirSync(this.fakeBin);
        writeFileSync(join(this.fakeBin, 'test-shell'), TEST_SHELL);
        chmodSync(join(this.fakeBin, 'test-shell'), 0o755);
    }

    get base(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    async start(): Promise<void> {
        if (this.child) {
            return;
        }
        if (!existsSync(WEB_DIST)) {
            throw new Error('the UI is not built: run `npm run build` first');
        }
        this.port ||= await freePort();
        const child = spawn(process.execPath, [DAEMON], {
            cwd: this.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                VOLTRAN_HOME: this.home,
                VOLTRAN_PORT: String(this.port),
                SHELL: join(this.fakeBin, 'test-shell'),
                PATH: `${this.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                HOME: this.root,
                LANG: 'en_US.UTF-8',
                TERM: 'xterm-256color',
            },
        });
        let output = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        this.child = child;
        await until(
            () => {
                if (child.exitCode !== null) {
                    throw new Error(`the daemon exited with ${child.exitCode}:\n${output}`);
                }
                return output.includes('daemon listening');
            },
            'the daemon to listen',
            20_000,
        );
        this.token = readFileSync(join(this.home, 'token'), 'utf8').trim();
    }

    async stop(): Promise<void> {
        const child = this.child;
        this.child = null;
        if (!child || child.exitCode !== null) {
            return;
        }
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
    }

    async dispose(): Promise<void> {
        await this.stop();
        rmSync(this.root, { recursive: true, force: true });
    }

    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
        const response = await fetch(`${this.base}${path}`, {
            method,
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
        }
        return (text ? JSON.parse(text) : null) as T;
    }

    state(): Promise<AppState> {
        return this.api<AppState>('GET', '/api/state');
    }

    async session(id: string): Promise<Session> {
        const session = (await this.state()).sessions.find((entry) => entry.id === id);
        if (!session) {
            throw new Error(`no session ${id}`);
        }
        return session;
    }

    // A project with one session of `panes` shell panes, made through the API so each test starts
    // from the screen it is about.
    async seed(name: string, panes = 1): Promise<{ project: Project; session: Session; panes: PaneView[] }> {
        const path = join(this.work, name);
        mkdirSync(path, { recursive: true });
        const project = await this.api<Project>('POST', '/api/projects', { path, name });
        const specs = Array.from({ length: panes }, (_, index) => ({ adapter: 'shell', title: `${name} ${index + 1}` }));
        const session = await this.api<Session>('POST', '/api/sessions', { projectId: project.id, title: `${name} session`, panes: specs });
        const created = (await this.state()).panes.filter((pane) => pane.sessionId === session.id);
        return { project, session: await this.session(session.id), panes: created };
    }

    async open(context: BrowserContext, sessionId?: string): Promise<Page> {
        const { code } = await this.api<{ code: string }>('POST', '/api/login-code');
        const page = await context.newPage();
        await page.goto(`${this.base}/auth?code=${code}${sessionId ? `&session=${sessionId}` : ''}`);
        await page.locator('.sidebar').waitFor();
        return page;
    }
}

// WebGL off, so xterm draws with its DOM renderer and a test can read what a terminal shows.
export function launchChrome(): Promise<Browser> {
    const executablePath = process.env.VOLTRAN_E2E_CHROME ?? CHROME_PATHS.find((path) => existsSync(path));
    return chromium.launch({
        executablePath,
        channel: executablePath ? undefined : 'chrome',
        args: ['--disable-webgl', '--disable-webgl2'],
    });
}

export function newContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
}

export const paneBox = (page: Page, title: string): Locator =>
    page.locator('.pane').filter({ has: page.locator('.pane__title', { hasText: title }) });

export async function screenText(pane: Locator): Promise<string> {
    return (await pane.locator('.xterm-rows').innerText()).replace(/ /g, ' ');
}

export async function waitForText(pane: Locator, text: string | RegExp, timeoutMs = 10_000): Promise<void> {
    await until(
        async () => {
            const screen = await screenText(pane);
            return typeof text === 'string' ? screen.includes(text) : text.test(screen);
        },
        `${String(text)} on screen`,
        timeoutMs,
    );
}

export async function typeInto(pane: Locator, text: string): Promise<void> {
    await pane.locator('.xterm-screen').click();
    await pane.page().keyboard.type(text);
}
