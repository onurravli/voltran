import { createRenderState, renderEntries, renderNote } from './subagent-render.ts';
import { readTranscript } from './transcripts.ts';

// Runs inside a subagent pane: renders the transcript, follows it while the subagent runs, and on
// SIGUSR2 (sent by the daemon when the subagent stops) reads what is left and marks it finished.
const POLL_MS = 400;
const path = process.argv[2] ?? '';
const following = process.argv[3] === '--follow';

let next = 0;
let waiting = false;
let done = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const state = createRenderState();

const write = (text: string): void => {
    process.stdout.write(text);
};

function drain(): void {
    for (;;) {
        const chunk = readTranscript(path, next);
        if (!chunk) {
            if (!waiting) {
                write(renderNote('waiting for the transcript'));
                waiting = true;
            }
            return;
        }
        if (chunk.entries.length > 0) {
            write(renderEntries(chunk.entries, state));
        }
        if (chunk.skipped > 0) {
            write(renderNote(`${chunk.skipped === 1 ? '1 line' : `${chunk.skipped} lines`} not recognized`));
        }
        if (chunk.next === next) {
            return;
        }
        next = chunk.next;
    }
}

function finish(): void {
    if (done) {
        return;
    }
    done = true;
    if (timer) {
        clearTimeout(timer);
    }
    drain();
    write(renderNote(next > 0 ? 'subagent finished' : 'this subagent is no longer running'));
}

function poll(): void {
    drain();
    if (!done) {
        timer = setTimeout(poll, POLL_MS);
    }
}

process.on('SIGUSR2', finish);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
write('\x1b[2J\x1b[3J\x1b[H\x1b[?25l');
if (following) {
    poll();
} else {
    finish();
}
setInterval(() => undefined, 1 << 30);
