# Voltran

A local control room for running many coding agents and terminals at once. Instead of a dozen
terminal windows, you get one window with your projects, a session per piece of work, and split
panes for the agents, shells and dev servers in it. Voltran tells you which agent is waiting on you.

It works with any folder and any agent CLI. Claude Code gets first-class status through its hooks,
including the subagents it runs; other agents (Codex, Gemini CLI, anything else) get status from
terminal activity.

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
window. Closing the window stops nothing; run `voltran up` again to reopen it. When a Voltran window
is already open, `voltran up` does not open another one.

| Command | What it does |
|---|---|
| `voltran up [--browser] [--no-open] [--new]` | Start the daemon if needed and open the UI, unless a Voltran window is already open (`--new` opens another anyway) |
| `voltran add [path] [--name <name>]` | Register a folder as a project (defaults to the current folder) |
| `voltran status` | Show the daemon and every pane that needs you |
| `voltran down` | Stop the daemon. Agents resume the next time you open them |

## How it is organized

- **Project**: a folder or repository you work in.
- **Session**: one piece of work inside a project, such as a ticket, a branch or an investigation.
  It can carry a link to its ticket or pull request.
- **Pane**: a terminal inside a session, which runs an agent (Claude Code, Codex, Gemini CLI), a
  shell, or a command such as `npm run dev`. Panes split right or down and resize freely.

### Arranging panes

Drag a pane by its title bar onto an edge of another pane to move it to that side, onto its middle
to swap the two, or onto another session of the same project in the sidebar to move it into that
session. Moving a pane only changes the layout: its process, scrollback and agent conversation carry
on. ⌃⌥↩ maximizes a pane, ⌃⌥B hides the sidebar, and zen mode (⌃⌥Z) shows the focused pane alone in
full screen.

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
and as desktop notifications once you turn alerts on. While any agent in a project is working, a
light sweeps along the line in the project's colour under the session's title bar.

### Subagents

The subagents a Claude Code pane is running, background ones included, are listed under its session
in the sidebar with how long they have been running. Click one to open it in a pane next to its
Claude pane: a read-only view laid out like Claude Code's own view of a subagent, with its prompt, its
tool calls and their results, and its final report. It follows the subagent live and marks when it
has finished.

### Shortcuts

Shortcuts use ⌃⌥ (Control + Option) so they never collide with the terminal. The exceptions are ⌘K
(⌃⌥K works too) and ⌘F, which mean nothing to a terminal.

| Keys | Action |
|---|---|
| ⌘K | Command palette: every action below, plus the theme and the terminal font family and size. Type a session or pane name to jump to it |
| ⌘F | Find in the focused terminal's scrollback. ↩ / ⇧↩ or ⌘G / ⇧⌘G step through the matches, Esc closes. A capital letter makes it case-sensitive |
| ⌃⌥J | Jump to the next pane that needs you |
| ⌃⌥B | Show or hide the sidebar |
| ⌃⌥Z | Zen mode: the focused pane alone, full screen. Esc still reaches the terminal; ⇧Esc or ⌃⌥Z leaves |
| ⌃⌥N | Start a new session |
| ⌃⌥↑ / ⌃⌥↓ | Previous / next session |
| ⌃⌥← / ⌃⌥→ | Previous / next pane in the session (moves the maximized view along when a pane is maximized) |
| ⌃⌥\ / ⌃⌥- | Split the focused pane right / down with a shell |
| ⌃⌥↩ | Maximize or restore the focused pane |
| ⌃⌥W | Close the focused pane |
| ⌃⌥/ | Show all shortcuts |

In terminals, Option types the characters of your keyboard layout (such as @ and { on Turkish Q), as
in iTerm's default. Line editing follows iTerm's Natural Text Editing: ⌘←/⌘→ jump to the start or end
of the line, ⌥←/⌥→ move by word, ⌘⌫/⌥⌫ delete the line or the word, and ⇧↩ or ⌥↩ adds a new line.

### Themes and fonts

⌘K → **Theme…** colours the whole app and every terminal. Voltran is the default; the others are
Tokyo Night, Catppuccin Mocha, Dracula, Nord, Gruvbox Dark, One Dark, Rosé Pine, and the light
Catppuccin Latte, Solarized Light and GitHub Light. ⌘K → **Font family…** lists the common monospace fonts
installed on your Mac or takes any installed font by name, and the font size commands make terminal
text bigger or smaller. Moving
through a list previews each choice, ↩ keeps it and Esc goes back. Status lamps take their colours
from the theme, so the hues above can differ, and the choices are remembered in the browser.

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
  `~/.voltran/`, and scrollback is saved there every 20 seconds and on shutdown, once each terminal
  has caught up with its last output.
- **Restarts.** Stopping the daemon ends the processes (there is no tmux underneath). On the next
  start, panes come back asleep with their scrollback and start when you open them. Claude Code
  panes come back with `claude --resume <session>`, so the conversation continues. Open windows
  reconnect on their own.
- **Updates.** A build records a hash of the UI's source and of the shared protocol code in
  `dist/version.json`. When the UI is rebuilt, open windows offer to reload. When the build and the
  running daemon come from different protocol code, they say whether to rebuild the UI or restart
  the daemon.
- **Terminal sizes.** A window never resizes a terminal by itself: it asks the daemon for the size
  that fits, and the daemon resizes the process and its own copy and marks the resize in the output
  stream. Every window applies it at that mark, so all copies of a terminal stay identical however
  fast panes are opened, closed or zoomed.
- **Several windows.** Every window shows the same panes. Only the focused one asks for sizes, and a
  window asks again when it regains focus, so a background window of a different size shows its
  terminals cut off or with empty space until you switch to it.
- **Claude Code status.** Voltran launches Claude with `--settings <file>` that adds hooks for
  `SessionStart`, `UserPromptSubmit`, `Pre/PostToolUse`, `Notification`, `Stop`, `SubagentStart`,
  `SubagentStop` and `SessionEnd`. The hooks `curl` the daemon with a secret that is unique to that
  pane's process. Your own and your repositories' Claude settings stay untouched, because settings
  passed this way add to them rather than replacing them.
- **Subagents.** The hooks give each subagent's id, and Claude writes its transcript next to the
  parent session's (`<session>/subagents/agent-<id>.jsonl`). A subagent pane runs a small viewer
  that follows that file; the daemon tells it when the subagent stops.
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
- accepts agent hooks only with the per-pane secret, never the main token;
- reads a subagent transcript only at the path derived from Claude's own hook data, never from a
  path a client sends, and refuses one reached through a symlink.

Child processes do not inherit the environment of a Claude session that launched the daemon
(`CLAUDECODE`, messaging sockets and tokens) or the identity variables of the terminal that launched
it.

## Development

```bash
npm run dev:daemon   # daemon with --watch, allows the Vite origin
npm run dev:web      # Vite on http://localhost:5173, proxies /api and /ws to the daemon
npm test             # vitest: shared layout, daemon (PTYs, hooks, subagents, server) and web helpers
npm run typecheck
npm run build        # rebuilds the UI the daemon serves
```

With both dev servers running, `VOLTRAN_DEV=1 voltran up` opens the Vite URL signed in.

Outside the dev servers, the daemon serves the built UI from `packages/web/dist`: after changing the
UI, run `npm run build` and reload the window. After changing the daemon, restart it with `voltran
down && voltran up`. If you are working from a pane inside Voltran, run the restart from another
terminal: `voltran down` stops the pane you are typing in.

`VOLTRAN_HOME` and `VOLTRAN_PORT` point a daemon at another data folder or port, which keeps
experiments away from your real sessions.

## Roadmap

- Session templates
- A git worktree per session, so parallel agents on one repository never touch each other's files
- Sending a prompt to one or many agents, and headless `claude -p` runs streamed into panes
- An agent-to-agent message bus exposed as an MCP server
- A native window (Tauri) with a dock badge and global shortcuts
- Project providers that discover work automatically, for example task folders in a repository
