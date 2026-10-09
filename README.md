# Voltran

A local control room for running many coding agents and terminals at once. Instead of a dozen
terminal windows, you get one window with your projects, a session per piece of work, and split
panes for the agents, shells and dev servers in it. Voltran tells you which agent is waiting on you.

It works with any folder and any agent CLI. Claude Code gets first-class status through its hooks;
other agents (Codex, Gemini CLI, anything else) get status from terminal activity.

## Requirements

- macOS (Linux should work; untested)
- Node.js 22.18 or newer (Voltran runs its TypeScript directly, with no build step for the daemon)
- Google Chrome is optional: when installed, `voltran up` opens Voltran in its own app window

## Getting started

```bash
npm install
npm link            # optional: puts `voltran` on your PATH
voltran up          # or: npm run up
```

`voltran up` builds the UI on first run, starts the daemon in the background, and opens a signed-in
window. Closing the window stops nothing; run `voltran up` again to reopen it.

| Command | What it does |
|---|---|
| `voltran up [--browser] [--no-open]` | Start the daemon if needed and open the UI |
| `voltran add [path] [--name <name>]` | Register a folder as a project (defaults to the current folder) |
| `voltran status` | Show the daemon and every pane that needs you |
| `voltran down` | Stop the daemon. Agents resume the next time you open them |

## How it is organized

- **Project**: a folder or repository you work in.
- **Session**: one piece of work inside a project, such as a ticket, a branch or an investigation.
  It can carry a link to its ticket or pull request.
- **Pane**: a terminal inside a session, which runs an agent (Claude Code, Codex, Gemini CLI), a
  shell, or a command such as `npm run dev`. Panes split right or down and resize freely.

### Status

| Lamp | Meaning |
|---|---|
| Pulsing amber | Needs input: a permission prompt, a question, or a startup prompt such as folder trust |
| Blue | Finished a turn you have not looked at yet |
| Spinning violet | Working |
| Green | A shell or command is running |
| Hollow | Idle |
| Dashed | Asleep: not started yet, or parked after a restart; it starts when you open it |
| Red | Exited with an error |

Panes that need you collect in the **Needs you** tray at the bottom of the sidebar, in the tab title,
and as desktop notifications once you turn alerts on.

### Shortcuts

All shortcuts use ⌃⌥ (Control + Option) so they never collide with the terminal.

| Keys | Action |
|---|---|
| ⌃⌥J | Jump to the next pane that needs you |
| ⌃⌥N | Start a new session |
| ⌃⌥↑ / ⌃⌥↓ | Previous / next session |
| ⌃⌥\ / ⌃⌥- | Split the focused pane right / down with a shell |
| ⌃⌥↩ | Maximize or restore the focused pane |
| ⌃⌥W | Close the focused pane |
| ⌃⌥/ | Show all shortcuts |

## How it works

```
packages/
  shared/   domain types, wire protocol, layout tree helpers
  daemon/   HTTP + WebSocket server, PTY manager, SQLite store, agent adapters, `voltran` CLI
  web/      React + xterm.js UI (Vite)
```

- **Daemon.** It owns every terminal through `node-pty` and mirrors each one into a headless xterm.
  A browser that attaches gets an exact snapshot of the screen and scrollback, then the live stream,
  so reloading or reopening the window loses nothing. Metadata lives in SQLite (`node:sqlite`) under
  `~/.voltran/`, and scrollback is saved there every 20 seconds and on shutdown.
- **Restarts.** Stopping the daemon ends the processes (there is no tmux underneath). On the next
  start, panes come back asleep with their scrollback and start when you open them. Claude Code
  panes come back with `claude --resume <session>`, so the conversation continues.
- **Claude Code status.** Voltran launches Claude with `--settings <file>` that adds hooks for
  `SessionStart`, `UserPromptSubmit`, `Pre/PostToolUse`, `Notification`, `Stop` and `SessionEnd`.
  The hooks `curl` the daemon with a secret that is unique to that pane's process. Your own and your
  repositories' Claude settings stay untouched, because settings passed this way add to them rather
  than replacing them.
- **Other agents.** Status comes from the terminal: streaming output means working, a quiet period
  after work means finished, and a terminal bell means the agent needs input.

### Security

A local server that can start processes is reachable from every web page you open, so the daemon:

- listens on `127.0.0.1` only;
- requires a token (`~/.voltran/token`, mode 0600) on every request, sent as a bearer header by the
  CLI and as an `HttpOnly`, `SameSite=Strict` cookie by the browser;
- signs browsers in through one-time login codes that expire after 60 seconds;
- rejects any `Host` header other than its own, which blocks DNS rebinding;
- rejects any `Origin` other than its own, on HTTP and WebSocket alike;
- accepts agent hooks only with the per-pane secret, never the main token.

Child processes do not inherit the environment of a Claude session that launched the daemon
(`CLAUDECODE`, messaging sockets and tokens) or the identity variables of the terminal that launched
it.

## Development

```bash
npm run dev:daemon   # daemon with --watch, allows the Vite origin
npm run dev:web      # Vite on http://localhost:5173, proxies /api and /ws to the daemon
npm test             # vitest: layout, status, security, PTY lifecycle, server integration
npm run typecheck
```

With both dev servers running, `VOLTRAN_DEV=1 voltran up` opens the Vite URL signed in.

`VOLTRAN_HOME` and `VOLTRAN_PORT` point a daemon at another data folder or port, which keeps
experiments away from your real sessions.

## Roadmap

- Session templates and a command palette
- A git worktree per session, so parallel agents on one repository never touch each other's files
- Sending a prompt to one or many agents, and headless `claude -p` runs streamed into panes
- An agent-to-agent message bus exposed as an MCP server
- A native window (Tauri) with a dock badge and global shortcuts
- Project providers that discover work automatically, for example task folders in a repository
