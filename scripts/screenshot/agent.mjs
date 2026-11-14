import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const DEMO = process.env.VOLTRAN_DEMO;
const [kind, ...args] = process.argv.slice(2);
const argValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
};
const scene = argValue('--scene') ?? basename(process.cwd());
const cwd = process.cwd();
const home = process.env.VOLTRAN_DEMO_HOME || homedir();
const shownCwd = cwd.replace(join(DEMO, 'code'), join(home, 'code'));
const tilde = shownCwd.replace(home, '~');

const E = '\x1b[';
const rgb = (r, g, b) => (s) => `${E}38;2;${r};${g};${b}m${s}${E}39m`;
const bgc = (r, g, b) => (s) => `${E}48;2;${r};${g};${b}m${s}${E}49m`;
const bold = (s) => `${E}1m${s}${E}22m`;
const orange = rgb(215, 119, 87);
const green = rgb(78, 186, 101);
const red = rgb(255, 107, 128);
const grey = rgb(153, 153, 153);
const blue = rgb(122, 162, 247);
const purple = rgb(177, 156, 217);
const addBg = bgc(34, 92, 43);
const delBg = bgc(122, 41, 54);
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const cols = () => process.stdout.columns || 100;

const settingsFile = argValue('--settings');
let hookSettings = null;
try {
    hookSettings = settingsFile
        ? JSON.parse(settingsFile.startsWith('{') ? settingsFile : readFileSync(settingsFile, 'utf8'))
        : null;
} catch {}
function claudeHook(event, payload) {
    const command = hookSettings?.hooks?.[event]?.[0]?.hooks?.[0]?.command;
    if (command) spawnSync('sh', ['-c', command], { input: JSON.stringify(payload) });
}
function claudeStatusLine(payload) {
    const command = hookSettings?.statusLine?.command;
    if (command) spawnSync('sh', ['-c', command], { input: JSON.stringify(payload) });
}
function opencodeHook(event, payload) {
    const { VOLTRAN_URL, VOLTRAN_PANE_ID, VOLTRAN_HOOK_HEADER } = process.env;
    if (!VOLTRAN_URL) return;
    spawnSync('curl', [
        '-s',
        '-m',
        '2',
        '-o',
        '/dev/null',
        '-X',
        'POST',
        '-H',
        `@${VOLTRAN_HOOK_HEADER}`,
        '-H',
        'Content-Type: application/json',
        '--data-binary',
        JSON.stringify(payload),
        `${VOLTRAN_URL}/api/hooks/${VOLTRAN_PANE_ID}/${event}`,
    ]);
}

const fit = (s, width) => {
    let out = '';
    let n = 0;
    for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
        if (part.startsWith('\x1b[')) {
            out += part;
            continue;
        }
        for (const ch of part) {
            if (n >= width) return `${out}${E}0m`;
            out += ch;
            n++;
        }
    }
    return out;
};
const pad = (s, width) => s + ' '.repeat(Math.max(0, width - visible(s).length));

function wrap(text, width, indent = '') {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
        if (visible(line + word).length > width - indent.length && line) {
            lines.push(line.trimEnd());
            line = '';
        }
        line += `${word} `;
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines;
}

function claudeHeader(model) {
    return [
        ` ${orange('▐▛███▜▌')}   ${bold('Claude Code')} ${grey('v2.4.2')}`,
        `${orange('▝▜█████▛▘')}  ${grey(`${model} · Claude Max`)}`,
        `  ${orange('▘▘ ▝▝')}    ${grey(shownCwd)}`,
        '',
    ];
}
function userPrompt(text) {
    const w = cols();
    return wrap(text, w - 2)
        .map((line, i) => grey(i === 0 ? `> ${line}` : `  ${line}`))
        .concat('');
}
function said(text) {
    const w = cols();
    return wrap(text, w - 2)
        .map((line, i) => (i === 0 ? `${'⏺'} ${line}` : `  ${line}`))
        .concat('');
}
function tool(name, argText, results, dot = green) {
    const out = [`${dot('⏺')} ${bold(name)}(${argText})`];
    results.forEach((r, i) => out.push(i === 0 ? `  ${grey('⎿')}  ${r}` : `     ${r}`));
    out.push('');
    return out;
}
function diff(file, summary, rows) {
    const w = cols();
    const out = [`${green('⏺')} ${bold('Update')}(${file})`, `  ${grey('⎿')}  ${summary}`];
    for (const [n, sign, code] of rows) {
        const num = String(n).padStart(5);
        const body = `${num} ${sign === ' ' ? ' ' : sign}  ${code.replace(/\t/g, '    ')}`;
        const line = fit(pad(body, w - 8), w - 8);
        out.push(`      ${sign === '+' ? addBg(line) : sign === '-' ? delBg(line) : grey(line)}`);
    }
    out.push('');
    return out;
}
function inputBox(mode) {
    const w = cols();
    const rule = grey('─'.repeat(w));
    return [rule, `${grey('>')} `, rule, `  ${mode}`];
}

const SCENES = {};

const NOTES = `## Webhook retries · PAY-412

- Backoff: 2s base, doubles, capped at 10m, ±20% jitter
- Park after 8 attempts in webhook_dead_letters
- Unknown event types skip retries and park at once

- [x] Backoff + tests
- [x] Migration 0007
- [ ] Wire DeadLetterStore into NewHandler
- [ ] \`checkout replay-webhooks --since 24h\`

Ask Maya: Stripe retries for 3 days itself.
Is our 10m cap still worth it?
`;

SCENES['checkout-api'] = {
    model: 'Opus 5.5',
    lines() {
        return [
            ...claudeHeader(this.model),
            ...userPrompt(
                'Stripe webhooks that fail with a 5xx from our handler are dropped for good. Retry them with exponential backoff and park the ones that run out of attempts in a dead-letter table. Keep the handler idempotent.',
            ),
            ...said(
                "I'll start by looking at how webhook delivery works today, and map every place that could retry an event.",
            ),
            ...tool('Search', 'pattern: "Deliver\\(|Process\\(", path: "internal"', [`Found ${bold('7')} files`]),
            ...tool('Read', 'internal/webhooks/handler.go', [`Read ${bold('31')} lines`]),
            ...tool(
                `${purple('Explore')}`,
                'Map every webhook retry path',
                [grey('Running in the background (↓ to manage)')],
                purple,
            ),
            ...said(
                "Delivery returns the processor's error and nothing retries it, so a single 5xx loses the event. I'll add the backoff to the handler and park events after 8 attempts.",
            ),
            ...diff(
                'internal/webhooks/handler.go',
                `Updated ${bold('internal/webhooks/handler.go')} with ${bold('12')} additions and ${bold('3')} removals`,
                [
                    [27, ' ', 'func (h *Handler) Deliver(ctx context.Context, ev Event) error {'],
                    [28, '-', '\tif err := h.proc.Process(ctx, ev); err != nil {'],
                    [29, '-', '\t\th.log.Error("webhook failed", "event", ev.ID, "err", err)'],
                    [30, '-', '\t\treturn err'],
                    [28, '+', '\terr := h.proc.Process(ctx, ev)'],
                    [29, '+', '\tif err == nil {'],
                    [30, '+', '\t\treturn nil'],
                    [31, '+', '\t}'],
                    [32, '+', '\tif errors.Is(err, ErrUnknownEvent) || ev.Attempts+1 >= MaxAttempts {'],
                    [33, '+', '\t\treturn h.park(ctx, ev, err)'],
                    [34, ' ', '\t}'],
                ],
            ),
            ...tool('Write', 'migrations/0007_webhook_dead_letters.sql', [
                `Wrote ${bold('7')} lines to ${bold('migrations/0007_webhook_dead_letters.sql')}`,
            ]),
            ...tool('Bash', 'go test ./internal/webhooks/... -run Backoff', [
                'ok      github.com/lumenpay/api/internal/webhooks   0.412s',
            ]),
            `${orange('✽')} ${orange('Wiring the dead-letter store…')} ${grey(`(3m 41s · esc to interrupt)`)}`,
            `  ${grey('⎿')}  ${grey('Next: Add a replay command for parked events')}`,
            '',
            ...inputBox(`${purple('⏵⏵ accept edits on')} ${grey('(shift+tab to cycle)')}`),
        ];
    },
    transcript(file) {
        writeFileSync(
            file,
            `${CHECKOUT_TRANSCRIPT()
                .map((l) => JSON.stringify(l))
                .join('\n')}\n`,
        );
    },
    hooks(ctx) {
        claudeHook('SessionStart', ctx.base);
        claudeHook('UserPromptSubmit', {
            ...ctx.base,
            prompt: 'Stripe webhooks that fail with a 5xx from our handler are dropped for good. Retry them with exponential backoff and park the ones that run out of attempts in a dead-letter table.',
        });
        const agentId = 'a3f9c27e15b84d06';
        writeSubagent(ctx, agentId);
        claudeHook('PreToolUse', {
            ...ctx.base,
            tool_name: 'Agent',
            tool_use_id: 'toolu_01Explore',
            tool_input: {
                description: 'Map every webhook retry path',
                subagent_type: 'Explore',
                run_in_background: true,
                prompt: '…',
            },
        });
        claudeHook('SubagentStart', { ...ctx.base, agent_id: agentId, agent_type: 'Explore' });
        claudeHook('PostToolUse', {
            ...ctx.base,
            tool_name: 'Agent',
            tool_use_id: 'toolu_01Explore',
            tool_input: {
                description: 'Map every webhook retry path',
                subagent_type: 'Explore',
                run_in_background: true,
            },
            tool_response: { agentId, status: 'async_launched' },
        });
        claudeHook('PreToolUse', {
            ...ctx.base,
            tool_name: 'Edit',
            tool_input: { file_path: `${shownCwd}/internal/webhooks/handler.go` },
        });
        const inSeconds = (seconds) => Math.floor(Date.now() / 1000) + seconds;
        claudeStatusLine({
            ...ctx.base,
            rate_limits: {
                five_hour: { used_percentage: 64, resets_at: inSeconds(2 * 3600 + 14 * 60) },
                seven_day: { used_percentage: 31, resets_at: inSeconds(3 * 86400 + 5 * 3600) },
            },
        });
        if (process.env.VOLTRAN_NOTES) writeFileSync(process.env.VOLTRAN_NOTES, NOTES);
    },
};

SCENES['refunds-rate-limit'] = {
    model: 'Sonnet 5.5',
    lines() {
        return [
            ...claudeHeader(this.model),
            ...userPrompt(
                'Add a per-merchant rate limit to POST /v1/refunds: 20 requests a minute, 429 with Retry-After above it.',
            ),
            ...tool('Read', 'internal/refunds/refunds.go', [`Read ${bold('24')} lines`]),
            ...tool('Write', 'internal/refunds/ratelimit.go', [
                `Wrote ${bold('58')} lines to ${bold('internal/refunds/ratelimit.go')}`,
            ]),
            ...tool('Bash', 'go test ./internal/refunds/...', [
                'ok      github.com/lumenpay/api/internal/refunds   0.388s',
            ]),
            ...said(
                'Done. Refunds are now limited to 20 a minute per merchant with a token bucket keyed by merchant id; requests above it get 429 and a Retry-After header in seconds. Tests cover the burst, the refill and the header.',
            ),
            ...inputBox(grey('? for shortcuts')),
        ];
    },
    hooks(ctx) {
        claudeHook('SessionStart', ctx.base);
        claudeHook('UserPromptSubmit', { ...ctx.base, prompt: 'Add a per-merchant rate limit to POST /v1/refunds' });
        claudeHook('Stop', {
            ...ctx.base,
            last_assistant_message:
                'Done. Refunds are now limited to 20 a minute per merchant; requests above it get 429 and a Retry-After header.',
        });
    },
};

SCENES['flaky-invoices'] = {
    model: 'Opus 5.5',
    lines() {
        const w = cols();
        return [
            ...claudeHeader(this.model),
            ...userPrompt('invoice-table.test.tsx fails about one run in five on CI. Find out why and fix it.'),
            ...tool('Bash', 'pnpm vitest run components/InvoiceTable --repeat 20', [
                `${red('2 failed')} | ${green('18 passed')}`,
            ]),
            ...said(
                'The test sorts by "Due date" and reads the first row before the sort has re-rendered. I want to run the suite in CI mode to confirm.',
            ),
            grey('─'.repeat(w)),
            ` ${bold('Bash command')}`,
            '',
            `   CI=1 pnpm vitest run components/InvoiceTable --repeat 50`,
            `   ${grey('Run the invoice table tests 50 times with the CI config')}`,
            '',
            ' Do you want to proceed?',
            ` ${blue('❯')} ${blue('1. Yes')}`,
            `   2. Yes, and don't ask again for ${bold('pnpm vitest run')} commands in ${bold(shownCwd)}`,
            `   3. No, and tell Claude what to do differently ${grey('(esc)')}`,
        ];
    },
    hooks(ctx) {
        claudeHook('SessionStart', ctx.base);
        claudeHook('UserPromptSubmit', {
            ...ctx.base,
            prompt: 'invoice-table.test.tsx fails about one run in five on CI. Find out why and fix it.',
        });
        claudeHook('Notification', {
            ...ctx.base,
            notification_type: 'permission_prompt',
            message: 'Claude needs your permission to use Bash',
        });
    },
};

function CHECKOUT_TRANSCRIPT() {
    const model = 'claude-opus-5-5';
    const t0 = Date.now() - 221_000;
    const at = (sec) => new Date(t0 + sec * 1000).toISOString();
    const lines = [];
    let n = 0;
    const user = (content, sec) =>
        lines.push({ type: 'user', timestamp: at(sec), cwd: shownCwd, message: { role: 'user', content } });
    const asst = (content, sec) =>
        lines.push({ type: 'assistant', timestamp: at(sec), message: { role: 'assistant', model, content } });
    const say = (text, sec) => asst([{ type: 'text', text }], sec);
    const call = (name, input, result, sec, pending = false) => {
        const id = `toolu_01${String(++n).padStart(2, '0')}`;
        asst([{ type: 'tool_use', id, name, input }], sec);
        if (!pending) user([{ type: 'tool_result', tool_use_id: id, content: result }], sec + 2);
    };
    const f = (rel) => `${shownCwd}/${rel}`;
    user(
        'Stripe webhooks that fail with a 5xx from our handler are dropped for good. Retry them with exponential backoff and park the ones that run out of attempts in a dead-letter table. Keep the handler idempotent.',
        0,
    );
    say("I'll look at how delivery works today, and have a subagent map every place that could retry an event.", 4);
    call(
        'Grep',
        { pattern: 'Deliver\\(|Process\\(', path: 'internal' },
        'internal/webhooks/handler.go\ninternal/webhooks/handler_test.go\ninternal/store/store.go',
        6,
    );
    call('Read', { file_path: f('internal/webhooks/handler.go') }, '…', 10);
    call(
        'Agent',
        {
            description: 'Map every webhook retry path',
            subagent_type: 'Explore',
            run_in_background: true,
            prompt: 'Find every code path that delivers, retries or drops a Stripe webhook event.',
        },
        'Async agent launched successfully.',
        14,
    );
    say(
        "Nothing retries a failed delivery: `Deliver` returns the processor's error and the HTTP handler answers 500, so **one 5xx loses the event**. The plan:\n\n1. Retry with exponential backoff — 2s base, doubling, capped at 10m, ±20% jitter\n2. Park an event in `webhook_dead_letters` after 8 attempts\n3. Skip retries for unknown event types and park them at once",
        40,
    );
    call(
        'TodoWrite',
        {
            todos: [
                { content: 'Backoff with jitter, plus tests', status: 'completed' },
                { content: 'Migration 0007: webhook_dead_letters', status: 'completed' },
                { content: 'Wire DeadLetterStore into NewHandler', status: 'in_progress' },
                { content: 'checkout replay-webhooks --since 24h', status: 'pending' },
            ],
        },
        'Todos have been modified successfully.',
        46,
    );
    call(
        'Edit',
        {
            file_path: f('internal/webhooks/handler.go'),
            old_string: '    if err := h.process(ev); err != nil {\n        return err\n    }',
            new_string:
                '    err := h.process(ev)\n    if err == nil || errors.Is(err, ErrDup) {\n        return nil\n    }\n    if ev.Attempts+1 >= MaxAttempts {\n        return h.park(ctx, ev, err)\n    }\n    return h.retry(ctx, ev, err)',
        },
        '',
        70,
    );
    call(
        'Bash',
        { command: 'go test ./internal/webhooks/ -run Backoff', description: 'Run the backoff tests' },
        'ok  \tgithub.com/lumenpay/api/internal/webhooks\t0.260s',
        120,
    );
    say('Backoff tests pass. Wiring the dead-letter store into `NewHandler` so parked events survive a restart.', 150);
    call(
        'Edit',
        {
            file_path: f('cmd/api/main.go'),
            old_string: '    h := webhooks.NewHandler(proc, logger)',
            new_string: '    dead := store.NewDeadLetterStore(db)\n    h := webhooks.NewHandler(proc, dead, logger)',
        },
        '',
        210,
        true,
    );
    return lines;
}

function writeSubagent(ctx, agentId) {
    const dir = join(dirname(ctx.base.transcript_path), ctx.base.session_id, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `agent-${agentId}.meta.json`),
        JSON.stringify({ description: 'Map every webhook retry path', agentType: 'Explore' }),
    );
    const file = join(dir, `agent-${agentId}.jsonl`);
    const t0 = Date.now() - 95_000;
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    let n = 0;
    const id = () => `toolu_${String(++n).padStart(2, '0')}`;
    const lines = [];
    const user = (content, s) => lines.push({ type: 'user', timestamp: at(s), message: { role: 'user', content } });
    const asst = (content, s) =>
        lines.push({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content } });
    const call = (name, input, result, s) => {
        const t = id();
        asst([{ type: 'tool_use', id: t, name, input }], s);
        user([{ type: 'tool_result', tool_use_id: t, content: result }], s + 2);
    };
    user(
        'Find every code path that delivers, retries or drops a Stripe webhook event in this repository. For each one, give the file and line, what triggers it, and whether a failure there is retried today. Do not change any files.',
        0,
    );
    asst([{ type: 'text', text: "I'll trace delivery from the HTTP entry point down to the processor." }], 3);
    call(
        'Grep',
        { pattern: 'webhooks\\.|Deliver\\(' },
        'cmd/api/main.go\ninternal/webhooks/handler.go\ninternal/webhooks/handler_test.go',
        5,
    );
    call('Read', { file_path: `${shownCwd}/cmd/api/main.go` }, '…', 9);
    call('Read', { file_path: `${shownCwd}/internal/webhooks/handler.go` }, '…', 14);
    call('Grep', { pattern: 'Attempts' }, 'internal/webhooks/event.go:9\ninternal/webhooks/handler.go:33', 21);
    call('Glob', { pattern: 'internal/**/*queue*.go' }, 'No files found', 26);
    call(
        'Bash',
        { command: 'git log --oneline -- internal/webhooks | head -20' },
        '9c1e4a2 webhooks: park events that run out of attempts\n4b7d013 webhooks: add exponential backoff with jitter',
        31,
    );
    asst(
        [
            {
                type: 'text',
                text: 'There is no queue: events are delivered inline from the HTTP handler, so a retry has to come from Stripe itself or from a worker we add. Checking how the processor reports transient errors next.',
            },
        ],
        40,
    );
    call('Grep', { pattern: 'StatusServiceUnavailable|5\\d\\d' }, 'internal/store/store.go:6', 44);
    call('Read', { file_path: `${shownCwd}/internal/store/store.go` }, '…', 49);
    call('Read', { file_path: `${shownCwd}/internal/webhooks/event.go` }, '…', 53);
    asst([{ type: 'tool_use', id: id(), name: 'Grep', input: { pattern: 'idempotency' } }], 60);
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function opencodeLines() {
    const w = cols();
    const bar = rgb(250, 178, 131);
    const accent = rgb(157, 124, 216);
    const panel = bgc(30, 32, 40);
    const block = (s) => panel(pad(fit(` ${s}`, w - 4), w - 4));
    const userMsg = (s) => wrap(s, w - 6).map((l) => `  ${accent('┃')} ${l}`);
    return [
        '',
        ...userMsg(
            'Move app/settings/billing from the pages router to the App Router. Keep the session check, and delete the old page when the new one renders.',
        ),
        `  ${accent('┃')} ${grey('onur (10:52 AM)')}`,
        '',
        `  ${grey('→')} Read ${grey('pages/settings/billing.tsx')}`,
        `  ${grey('→')} Read ${grey('lib/session.ts')}`,
        `  ${grey('←')} Write ${grey('app/settings/billing/page.tsx')}`,
        `  ${grey('←')} Write ${grey('app/settings/layout.tsx')}`,
        `  ${grey('✗')} Delete ${grey('pages/settings/billing.tsx')}`,
        '',
        ...wrap(
            'The billing page now renders as a server component and reads the account with getAccount(), which replaces getServerSideProps. Running the settings tests before I remove the old route for good.',
            w - 4,
        ).map((l) => `  ${l}`),
        '',
        `  ${bar('△')} ${bold('Permission required')}`,
        `  ${block(`${grey('$')} pnpm vitest run app/settings --reporter=dot`)}`,
        `  ${block(grey('Run the settings tests'))}`,
        '',
        `  ${bgc(250, 178, 131)(rgb(20, 20, 20)(' Allow once '))}  ${grey('Allow always')}  ${grey('Reject')}`,
        '',
        `  ${grey('Build')}  ${accent('Claude Sonnet 5.5')} ${grey('Anthropic')}`,
    ];
}

let codexSeconds = 37;
function codexLines() {
    const w = Math.min(cols(), 72);
    const top = `╭${'─'.repeat(w - 2)}╮`;
    const row = (s) => `│ ${pad(s, w - 4)} │`;
    return [
        top,
        row(`${bold('>_ OpenAI Codex')} ${grey('(v0.58.0)')}`),
        row(''),
        row(`${grey('model:')}     gpt-5-codex high   ${blue('/model')} ${grey('to change')}`),
        row(`${grey('directory:')} ${tilde}`),
        `╰${'─'.repeat(w - 2)}╯`,
        '',
        `${bold('›')} Bump checkout's RDS instances to Postgres 16. Staging first; add a`,
        `  parameter group for pg16 and keep production on 15 until we sign off.`,
        '',
        `${bold('•')} ${bold('Explored')}`,
        `  ${grey('└')} ${blue('Read')} main.tf, variables.tf`,
        `    ${blue('Search')} engine_version in envs`,
        '',
        `${bold('•')} ${bold('Edited')} modules/rds/main.tf ${green('(+6')} ${red('-1)')}`,
        `    ${grey('4')}  ${red('-  engine_version          = "15.8"')}`,
        `    ${grey('4')}  ${green('+  engine_version          = var.engine_version')}`,
        `   ${grey('10')}  ${green('+resource "aws_db_parameter_group" "this" {')}`,
        `   ${grey('11')}  ${green('+  name   = "${var.name}-pg${split(".", var.engine_version)[0]}"')}`,
        '',
        `${bold('•')} ${bold('Ran')} terraform -chdir=envs/staging plan -no-color`,
        `  ${grey('└')} Plan: 1 to add, 1 to change, 0 to destroy.`,
        '',
    ];
}
function codexFooter() {
    const spin = ['◐', '◓', '◑', '◒'][codexSeconds % 4];
    const m = Math.floor(codexSeconds / 60);
    const s = codexSeconds % 60;
    const t = m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
    return `${spin} ${bold('Working')} ${grey(`(${t} • esc to interrupt)`)}`;
}

// The feature images: a lead Claude in the webhook-replay worktree delegates through task.sh, and the
// agents it opens there answer each prompt Voltran types in by its key.
const CREW_SCENE = 'webhook-replay';
const crew = scene === 'lead' || scene === CREW_SCENE;
const CREW_WORK = [
    {
        key: 'every code path',
        seconds: 3,
        tools: [
            ['Grep', 'park\\(|deadLetter', `Found ${bold('4')} files`],
            ['Read', 'internal/webhooks/retry.go', `Read ${bold('112')} lines`],
        ],
        reply: 'Events are parked in two places: retry.go after the 8th failed attempt, and handler.go for unknown event types. Both write the raw payload, the last status and the attempt count to webhook_dead_letters; nothing reads them back yet.',
    },
    {
        key: 'Add ListParked',
        seconds: 5,
        tools: [
            ['Edit', 'internal/store/deadletters.go', `${green('+48')} ${red('-2')}`],
            ['Write', 'migrations/0008_dead_letter_replayed_at.sql', `Wrote ${bold('5')} lines`],
            ['Bash', 'go test ./internal/store/...', 'ok  github.com/lumenpay/api/internal/store  0.291s'],
        ],
        reply: 'Added ListParked(since, limit) and MarkReplayed(id) to DeadLetterStore, with migration 0008 for a replayed_at column and an index on parked_at. go test ./internal/store/... passes.',
    },
    {
        key: 'replay-webhooks subcommand',
        tools: [
            ['Read', 'cmd/checkout/main.go', `Read ${bold('86')} lines`],
            ['Write', 'cmd/checkout/replay.go', `Wrote ${bold('71')} lines`],
        ],
        working: 'Wiring --since and --dry-run into the replay command',
    },
];
const crewTurns = [];
const crewWork = (prompt) => CREW_WORK.find((work) => asked(prompt).includes(work.key));
const asked = (prompt) =>
    prompt
        .split(/Your task:\s*/)
        .at(-1)
        .trim();
const shortId = (id) => `${id.slice(0, 8)}…`;

const codexHooks = {};
for (let i = 0; i < args.length - 1; i++) {
    const match = args[i] === '-c' && /^hooks\.(\w+)=.*command=("(?:[^"\\]|\\.)*")/.exec(args[i + 1]);
    if (match) codexHooks[match[1]] = JSON.parse(match[2]);
}
function codexHook(event, payload) {
    const command = codexHooks[event];
    if (command) spawnSync('sh', ['-c', command], { input: JSON.stringify(payload) });
}

let crewBase = null;
function crewHook(event, payload = {}) {
    if (kind === 'claude') {
        const names = { start: 'SessionStart', prompt: 'UserPromptSubmit', tool: 'PreToolUse', stop: 'Stop' };
        const extra =
            event === 'prompt'
                ? { prompt: payload.text }
                : event === 'tool'
                  ? { tool_name: payload.text }
                  : event === 'stop'
                    ? { last_assistant_message: payload.text }
                    : {};
        claudeHook(names[event], { ...crewBase, ...extra });
    } else if (kind === 'codex') {
        const names = { start: 'SessionStart', prompt: 'UserPromptSubmit', tool: 'PreToolUse', stop: 'Stop' };
        const extra =
            event === 'prompt'
                ? { prompt: payload.text }
                : event === 'tool'
                  ? { tool_name: payload.text }
                  : event === 'stop'
                    ? { last_assistant_message: payload.text }
                    : {};
        codexHook(names[event], { session_id: 'demo', cwd, ...extra });
    } else if (event === 'start') {
        opencodeHook('Ready', {});
    } else if (event === 'prompt') {
        opencodeHook('PromptSubmit', { prompt: payload.text });
    } else if (event === 'tool') {
        opencodeHook('ToolStart', { tool_name: payload.text });
    } else if (event === 'stop') {
        opencodeHook('TurnEnd', { outcome: 'completed', message: payload.text });
    }
}

function task(...words) {
    const result = spawnSync(process.env.VOLTRAN_TASK, words, { encoding: 'utf8' });
    return result.stdout.trim().split('\n')[0];
}

async function lead(turn) {
    const step = (name, argText, result) => {
        turn.tools.push([name, argText, result]);
        draw();
    };
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    crewHook('tool', { text: 'Bash' });
    step('Bash', '"$VOLTRAN_TASK" board', `pane ${shortId(task('board'))}`);
    const agents = {};
    for (const agent of ['claude', 'codex', 'opencode']) {
        crewHook('tool', { text: 'Bash' });
        agents[agent] = task('spawn', '--agent', agent);
        step('Bash', `"$VOLTRAN_TASK" spawn --agent ${agent}`, `pane ${shortId(agents[agent])}`);
        await pause(300);
    }
    const delegate = (to, title, prompt, after = []) => {
        const id = task(
            'delegate',
            '--to',
            agents[to],
            '--title',
            title,
            ...after.flatMap((dep) => ['--after', dep]),
            prompt,
        );
        const waits = after.length > 0 ? ` --after ${after.map(shortId).join(' --after ')}` : '';
        step('Bash', `"$VOLTRAN_TASK" delegate --to ${shortId(agents[to])}${waits} --title "${title}"`, id);
        return id;
    };
    const map = delegate(
        'claude',
        'Map where webhooks get parked',
        'Find every code path that parks a webhook in webhook_dead_letters and say what each one stores. Read only, change nothing.',
    );
    const store = delegate(
        'codex',
        'Dead-letter store: list and mark',
        'Add ListParked(since, limit) and MarkReplayed(id) to DeadLetterStore in internal/store, with a migration for a replayed_at column. Keep go test ./internal/store/... green.',
    );
    const command = delegate(
        'opencode',
        'replay-webhooks command',
        'Add the `checkout replay-webhooks` subcommand: --since (default 24h) and --dry-run, list parked events with ListParked, send each through webhooks.Handler and MarkReplayed the ones that return 2xx.',
        [map, store],
    );
    delegate(
        'codex',
        'Table tests for replay',
        'Write table tests for replay-webhooks: an event that replays, one that fails again, --dry-run, and --since filtering.',
        [command],
    );
    delegate(
        'claude',
        'Review the replay diff',
        'Review the replay-webhooks command for double replays, a missing idempotency check and anything that logs a payload.',
        [command],
    );
    turn.working = 'Waiting on the replay command and its tests';
    draw();
}

async function crewPrompt(text) {
    const prompt = asked(text);
    const turn = { prompt, tools: [], reply: null, working: 'Working' };
    crewTurns.push(turn);
    crewHook('prompt', { text: prompt });
    draw();
    if (scene === 'lead') {
        await lead(turn);
        return;
    }
    const work = crewWork(text);
    if (!work) return;
    turn.working = work.working ?? 'Working';
    for (const [name, argText, result] of work.tools) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        crewHook('tool', { text: name });
        turn.tools.push([name, argText, result]);
        draw();
    }
    if (work.seconds) {
        await new Promise((resolve) => setTimeout(resolve, work.seconds * 1000));
        turn.reply = work.reply;
        draw();
        crewHook('stop', { text: work.reply });
    }
}

let typed = '';
function crewInput(data) {
    const text = data.toString('utf8');
    if (text === '\r') {
        const prompt = typed.trim();
        typed = '';
        if (prompt) crewPrompt(prompt);
        return;
    }
    typed += text;
}

function crewLines() {
    const w = cols();
    const spinner = ['◐', '◓', '◑', '◒'][Math.floor(Date.now() / 250) % 4];
    if (kind === 'claude') {
        const out = [...claudeHeader(scene === 'lead' ? 'Opus 5.5' : 'Sonnet 5.5')];
        for (const turn of crewTurns) {
            out.push(...userPrompt(turn.prompt));
            for (const [name, argText, result] of turn.tools) out.push(...tool(name, argText, [result]));
            out.push(
                ...(turn.reply
                    ? said(turn.reply)
                    : [`${orange('✽')} ${orange(`${turn.working}…`)} ${grey('(esc to interrupt)')}`, '']),
            );
        }
        return [...out, ...inputBox(grey('? for shortcuts'))];
    }
    if (kind === 'codex') {
        const box = Math.min(w, 60);
        const out = [
            `╭${'─'.repeat(box - 2)}╮`,
            `│ ${pad(`${bold('>_ OpenAI Codex')} ${grey('(v0.58.0)')}`, box - 4)} │`,
            `│ ${pad(`${grey('directory:')} ${tilde}`, box - 4)} │`,
            `╰${'─'.repeat(box - 2)}╯`,
            '',
        ];
        for (const turn of crewTurns) {
            out.push(
                ...wrap(turn.prompt, w - 2).map((line, i) => (i === 0 ? `${bold('›')} ${line}` : `  ${line}`)),
                '',
            );
            for (const [name, argText, result] of turn.tools) {
                out.push(
                    `${bold('•')} ${bold(name === 'Bash' ? 'Ran' : name === 'Write' ? 'Added' : 'Edited')} ${argText}`,
                );
                out.push(`  ${grey('└')} ${result}`, '');
            }
            out.push(
                ...(turn.reply
                    ? [...wrap(turn.reply, w - 2).map((l) => `  ${l}`), '']
                    : [`${spinner} ${bold('Working')}`]),
            );
        }
        return [...out, '', `${grey('›')} ${grey('Ask Codex to do anything')}`];
    }
    const accent = rgb(157, 124, 216);
    const out = [''];
    for (const turn of crewTurns) {
        out.push(...wrap(turn.prompt, w - 6).map((l) => `  ${accent('┃')} ${l}`), '');
        for (const [name, argText] of turn.tools) {
            out.push(`  ${grey(name === 'Read' ? '→' : '←')} ${name} ${grey(argText)}`);
        }
        out.push(
            '',
            ...(turn.reply
                ? wrap(turn.reply, w - 4).map((l) => `  ${l}`)
                : [`  ${accent(spinner)} ${grey(`${turn.working}…`)}`]),
            '',
        );
    }
    return [...out, `  ${grey('Build')}  ${accent('Claude Sonnet 5.5')} ${grey('Anthropic')}`];
}

function draw() {
    let lines;
    if (crew) lines = crewLines();
    else if (kind === 'claude') lines = SCENES[scene]?.lines() ?? claudeHeader('Opus 5.5');
    else if (kind === 'opencode') lines = opencodeLines();
    else lines = codexLines();
    const w = cols();
    let out = `${E}?25l${E}H${E}2J${E}3J`;
    out += lines.map((l) => fit(l, w)).join('\r\n');
    if (kind === 'codex' && !crew) {
        out += `\r\n${codexFooter()}\r\n\r\n${grey('›')} ${grey('Ask Codex to do anything')}\r\n\r\n${grey('  ⏎ send   ⌃T transcript   59% context left')}`;
    }
    process.stdout.write(out);
}

process.title = kind;
process.stdout.write(`${E}?25l`);
process.on('SIGWINCH', draw);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', crew ? crewInput : () => {});

setTimeout(() => {
    draw();
    if (crew) {
        const sessionId = argValue('--session-id') ?? argValue('--resume') ?? randomUUID();
        const transcript = join(DEMO, 'claude-projects', scene, `${sessionId}.jsonl`);
        mkdirSync(dirname(transcript), { recursive: true });
        appendFileSync(transcript, '');
        crewBase = { session_id: sessionId, transcript_path: transcript, cwd };
        crewHook('start');
    } else if (kind === 'claude') {
        const sessionId = argValue('--session-id') ?? argValue('--resume') ?? randomUUID();
        const dir = join(DEMO, 'claude-projects', scene);
        mkdirSync(dir, { recursive: true });
        const transcript = join(dir, `${sessionId}.jsonl`);
        appendFileSync(transcript, '');
        SCENES[scene]?.transcript?.(transcript);
        SCENES[scene]?.hooks({ base: { session_id: sessionId, transcript_path: transcript, cwd } });
    } else if (kind === 'opencode') {
        opencodeHook('Ready', {});
        opencodeHook('PromptSubmit', { prompt: 'Move app/settings/billing from the pages router to the App Router' });
        opencodeHook('Permission', {
            request_id: 'per_7Kq2',
            action: 'bash',
            resources: ['pnpm vitest run app/settings --reporter=dot'],
        });
    } else if (kind === 'codex') {
        setTimeout(
            () =>
                setInterval(() => {
                    codexSeconds++;
                    draw();
                }, 1000),
            6500,
        );
    }
}, 400);
