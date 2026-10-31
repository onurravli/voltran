import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, '..', '..');
const OUT = process.argv[2] ?? join(ROOT, 'docs');
const CHROME_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
];

const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
    }
};
const which = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const freePort = () =>
    new Promise((resolve) => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executable = (path, text) => {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
};

for (const tool of ['zsh', 'go', 'git', 'curl']) {
    if (!which(tool)) {
        throw new Error(`the demo needs ${tool} on PATH`);
    }
}
const chrome = process.env.VOLTRAN_CHROME ?? CHROME_PATHS.find((path) => existsSync(path));
if (!chrome) {
    throw new Error('Chrome not found; set VOLTRAN_CHROME');
}

const D = realpathSync(mkdtempSync(join(tmpdir(), 'voltran-shot-')));
const home = join(D, 'home');
const bin = join(D, 'bin');
const port = await freePort();
const env = { ...process.env, VOLTRAN_HOME: home, VOLTRAN_PORT: String(port), SHELL: join(bin, 'zsh-demo') };
const voltran = (...args) => run(process.execPath, [join(ROOT, 'bin', 'voltran.mjs'), ...args], { env, cwd: ROOT });

function setup() {
    run('bash', [join(HERE, 'repos.sh'), D], { stdio: ['ignore', 'ignore', 'inherit'] });
    for (const dir of [bin, join(D, 'zdot'), join(D, 'libexec'), home]) {
        mkdirSync(dir, { recursive: true });
    }
    for (const kind of ['claude', 'opencode', 'codex']) {
        executable(
            join(bin, kind),
            `#!/bin/sh\nVOLTRAN_DEMO='${D}' VOLTRAN_DEMO_HOME='${process.env.VOLTRAN_DEMO_HOME ?? ''}' exec '${process.execPath}' '${join(HERE, 'agent.mjs')}' ${kind} "$@"\n`,
        );
    }
    copyFileSync(realpathSync(process.execPath), join(D, 'libexec', 'stripe'));
    executable(
        join(bin, 'stripe'),
        `#!/bin/sh\nexec '${join(D, 'libexec', 'stripe')}' '${join(HERE, 'stripe.mjs')}' "$@"\n`,
    );
    executable(
        join(bin, 'gh'),
        `#!/bin/sh
case "$(basename "$PWD")" in
checkout-api) echo '{"number":482,"url":"https://github.com/lumenpay/checkout-api/pull/482","state":"OPEN","isDraft":false,"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}';;
web-dashboard) echo '{"number":1316,"url":"https://github.com/lumenpay/web-dashboard/pull/1316","state":"OPEN","isDraft":true,"statusCheckRollup":[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}]}';;
*) echo 'no pull requests found for branch' >&2; exit 1;;
esac
`,
    );
    executable(join(bin, 'zsh-demo'), `#!/bin/sh\nexport ZDOTDIR='${join(D, 'zdot')}'\nexec '${which('zsh')}' "$@"\n`);
    const path = [
        bin,
        dirname(which('go')),
        dirname(process.execPath),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
    ];
    writeFileSync(
        join(D, 'zdot', '.zshrc'),
        `export PATH='${[...new Set(path)].join(':')}'
export GOFLAGS=-mod=mod GIT_PAGER=cat PAGER=cat
autoload -Uz vcs_info colors && colors
zstyle ':vcs_info:git:*' formats '%b'
precmd() { vcs_info }
setopt PROMPT_SUBST
PROMPT=$'\\n%F{cyan}%1~%f %F{8}on%f %F{magenta}\${vcs_info_msg_0_}%f\\n%F{green}❯%f '
`,
    );
    writeFileSync(join(D, 'zdot', '.zprofile'), `source '${join(D, 'zdot', '.zshrc')}'\n`);
    writeFileSync(
        join(home, 'settings.json'),
        '{\n  "appearance": "dark",\n  "terminal": { "fontFamily": "JetBrains Mono", "fontSize": 13 }\n}\n',
    );
}

const base = `http://127.0.0.1:${port}`;
async function api(method, path, body) {
    const token = readFileSync(join(home, 'token'), 'utf8').trim();
    const res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${method} ${path} ${res.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
}
const leaf = (paneId) => ({ type: 'pane', paneId });
const split = (direction, children, sizes) => ({ type: 'split', direction, children, sizes });

async function populate() {
    const code = (name) => join(D, 'code', name);
    const checkout = await api('POST', '/api/projects', {
        name: 'checkout-api',
        path: code('checkout-api'),
        color: '#7aa2f7',
    });
    const web = await api('POST', '/api/projects', {
        name: 'web-dashboard',
        path: code('web-dashboard'),
        color: '#bb9af7',
    });
    const infra = await api('POST', '/api/projects', { name: 'infra', path: code('infra'), color: '#73daca' });
    const sessions = {};
    sessions.goUpgrade = await api('POST', '/api/sessions', {
        projectId: checkout.id,
        title: 'Upgrade to Go 1.23',
        panes: [{ adapter: 'shell' }],
    });
    await api('PATCH', `/api/sessions/${sessions.goUpgrade.id}`, { archived: true });
    sessions.refunds = await api('POST', '/api/sessions', {
        projectId: checkout.id,
        title: 'Rate limit POST /v1/refunds',
        panes: [{ adapter: 'claude', command: '--scene refunds-rate-limit' }],
    });
    sessions.webhooks = await api('POST', '/api/sessions', {
        projectId: checkout.id,
        title: 'Retry failed Stripe webhooks',
        link: 'https://linear.app/lumenpay/issue/PAY-412',
        panes: [
            { adapter: 'claude', command: '--scene checkout-api' },
            { adapter: 'shell' },
            {
                adapter: 'command',
                title: 'stripe listen',
                command: 'stripe listen --forward-to localhost:8080/webhooks/stripe',
            },
            { adapter: 'editor' },
        ],
    });
    sessions.appRouter = await api('POST', '/api/sessions', {
        projectId: web.id,
        title: 'Move settings to the App Router',
        panes: [{ adapter: 'opencode' }],
    });
    sessions.flaky = await api('POST', '/api/sessions', {
        projectId: web.id,
        title: 'Flaky invoice table test',
        panes: [{ adapter: 'claude', command: '--scene flaky-invoices' }],
    });
    sessions.pg16 = await api('POST', '/api/sessions', {
        projectId: infra.id,
        title: 'Postgres 16 on staging',
        panes: [{ adapter: 'codex' }],
    });
    const state = await api('GET', '/api/state');
    const panes = Object.fromEntries(
        Object.entries(sessions).map(([key, session]) => [
            key,
            state.panes.filter((pane) => pane.sessionId === session.id).map((pane) => pane.id),
        ]),
    );
    const webhooks = state.panes.filter((pane) => pane.sessionId === sessions.webhooks.id);
    const byAdapter = (adapter) => webhooks.find((pane) => pane.adapter === adapter).id;
    panes.webhooks = [byAdapter('claude'), byAdapter('shell'), byAdapter('command'), byAdapter('editor')];
    return { sessions: Object.fromEntries(Object.entries(sessions).map(([key, session]) => [key, session.id])), panes };
}

async function stage(ids) {
    const [claude, shell, stripe, editor] = ids.panes.webhooks;
    await api('PATCH', `/api/sessions/${ids.sessions.webhooks}`, {
        layout: split(
            'horizontal',
            [leaf(claude), split('vertical', [leaf(editor), leaf(shell), leaf(stripe)], [50, 30, 20])],
            [50, 50],
        ),
    });
    const workspace = await api('POST', '/api/workspaces', { title: 'Release 2.4' });
    await api('PATCH', `/api/workspaces/${workspace.id}`, {
        layout: split(
            'horizontal',
            [leaf(claude), split('vertical', [leaf(ids.panes.appRouter[0]), leaf(ids.panes.pg16[0])], [50, 50])],
            [50, 50],
        ),
    });
    // Restarted after the browser has looked at it, so the sidebar shows it finished and unseen.
    await api('POST', `/api/panes/${ids.panes.refunds[0]}/restart`);
}

// Dark above the line from the top-right corner to the bottom-left one, light below it.
async function composite({ dark, light }) {
    const load = (data) =>
        new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = `data:image/png;base64,${data}`;
        });
    const [darkImage, lightImage] = await Promise.all([load(dark), load(light)]);
    const { width, height } = darkImage;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(lightImage, 0, 0);
    context.save();
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(width, 0);
    context.lineTo(0, height);
    context.closePath();
    context.clip();
    context.drawImage(darkImage, 0, 0);
    context.restore();
    return canvas.toDataURL('image/png').split(',')[1];
}

async function shoot(ids) {
    const { code } = await (
        await fetch(`${base}/api/login-code`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${readFileSync(join(home, 'token'), 'utf8').trim()}` },
        })
    ).json();
    // Chrome does not capture the WebGL terminal canvas at a device scale of 2.
    const browser = await chromium.launch({ executablePath: chrome, args: ['--disable-webgl', '--disable-webgl2'] });
    try {
        const context = await browser.newContext({
            viewport: { width: 1600, height: 1000 },
            deviceScaleFactor: 2,
            colorScheme: 'dark',
        });
        // Keyboard labels follow the platform, and the README shows the Mac ones.
        await context.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
        await context.addInitScript(
            ({ session, editor }) => {
                if (!localStorage.getItem('voltran.ui')) {
                    localStorage.setItem('voltran.ui', JSON.stringify({ selectedSessionId: session }));
                    localStorage.setItem(
                        `voltran.editor.${editor}`,
                        JSON.stringify({
                            tabs: ['internal/webhooks/handler.go', 'internal/webhooks/retry.go'],
                            active: 'internal/webhooks/handler.go',
                            expanded: ['internal', 'internal/webhooks'],
                            treeWidth: 190,
                        }),
                    );
                }
            },
            { session: ids.sessions.webhooks, editor: ids.panes.webhooks[3] },
        );
        const page = await context.newPage();
        await page.goto(`${base}/auth?code=${code}`);
        await page.waitForTimeout(1500);
        const open = async (title) => {
            await page.getByText(title, { exact: true }).first().click();
            await page.waitForTimeout(3000);
        };
        for (const title of [
            'Rate limit POST /v1/refunds',
            'Move settings to the App Router',
            'Flaky invoice table test',
            'Postgres 16 on staging',
            'Retry failed Stripe webhooks',
        ]) {
            await open(title);
        }
        await stage(ids);
        await sleep(4000);
        await page.reload();
        await page.waitForTimeout(3000);
        await page.locator('.pane').filter({ hasText: 'Shell' }).locator('.xterm').first().click();
        await page.keyboard.type('go test -count=1 -run Backoff -v ./internal/webhooks/', { delay: 30 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(8000);
        await page.reload();
        await page.waitForTimeout(3000);
        const editorBox = await page
            .locator('.pane')
            .filter({ hasText: 'Editor' })
            .locator('.monaco-editor')
            .boundingBox();
        await page.mouse.click(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2);
        await page.keyboard.press('Control+G');
        await page.keyboard.type('40');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        const claude = page.locator('.pane').first();
        await claude.locator('.pane__view-toggle').click();
        await page.waitForTimeout(3000);
        await claude
            .locator('details.tool summary')
            .filter({ hasText: 'Edit' })
            .filter({ hasText: 'webhooks/handler.go' })
            .click();
        await page.waitForTimeout(500);
        await page.mouse.click(5, 5);
        const dark = await page.screenshot();
        await api('PATCH', '/api/settings', { appearance: 'light' });
        await page.waitForTimeout(2000);
        const light = await page.screenshot();
        const composer = await context.newPage();
        const png = await composer.evaluate(composite, {
            dark: dark.toString('base64'),
            light: light.toString('base64'),
        });
        writeFileSync(join(OUT, 'screenshot.png'), Buffer.from(png, 'base64'));
    } finally {
        await browser.close();
    }
}

try {
    setup();
    run('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    voltran('up', '--no-open');
    await shoot(await populate());
    console.log(`wrote ${join(OUT, 'screenshot.png')}`);
} finally {
    if (existsSync(join(home, 'token'))) {
        voltran('down');
    }
    rmSync(D, { recursive: true, force: true });
}
