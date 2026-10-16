<p align="center">
  <img src="packages/web/public/favicon.svg" alt="Voltran" width="96" height="96">
</p>

## Voltran

A local control room for running many coding agents and terminals at once. Instead of a dozen
terminal windows, you get one window with your projects, a session per piece of work, and split
panes for the agents, shells and dev servers in it. Voltran tells you which agent is waiting on you.

It works with any folder and any agent CLI. Claude Code gets first-class status through its hooks,
including the subagents it runs, and OpenCode through a plugin Voltran gives it; other agents (Codex,
Antigravity, anything else) get status from terminal activity.

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
| `voltran restart` | Restart the daemon so it loads new code, then reconnect the open windows. Takes the same options as `up` |
| `voltran autostart [on\|off]` | Start the daemon when you log in to macOS (a LaunchAgent); with no argument, say whether it does |

### In the Dock

In Chrome, ⌘K → **Install Voltran as an app** installs Voltran as an app of its own: it gets its own
window, Dock icon and ⌘Tab entry, and `voltran up` opens it from then on. Right-click its Dock icon →
Options → Keep in Dock to pin it. The app cannot start the daemon, so run `voltran autostart on` once
to have it running whenever you are logged in. The agent runs the Node that ran that command; run it
again after switching Node versions.

## How it is organized

- **Project**: a folder or repository you work in.
- **Session**: one piece of work inside a project, such as a ticket, a branch or an investigation.
  It can carry a link to its ticket or pull request.
- **Pane**: a terminal inside a session, which runs an agent (Claude Code, OpenCode, Codex,
  Antigravity), a shell, or a command such as `npm run dev`. Panes split right or down and resize freely. A
  command that starts with `claude`, such as `claude --plugin-dir ./my-plugin`, opens a Claude Code
  pane with those arguments, so it keeps its status, subagents and resume. Quotes work as in a shell
  but nothing is expanded (`~`, `$VAR`), and Voltran sets `--settings`, `--session-id`, `--resume`
  and `--continue` itself. A command that starts with `opencode`, such as `opencode --auto` or
  `opencode mini --model anthropic/claude-sonnet-4-5`, does the same for OpenCode; Voltran sets
  `--standalone`, `--server`, `--session`, `--continue` and `--fork` there.
- **Workspace**: a named screen that shows panes from any projects side by side, such as two agents
  from one repository next to the dev server of another. It only points at the panes: they keep
  running in their own sessions and show there too.

### Arranging panes

Drag a pane by its title bar onto an edge of another pane to move it to that side, onto its middle
to swap the two, or onto another session of the same project in the sidebar to move it into that
session. Moving a pane only changes the layout: its process, scrollback and agent conversation carry
on. ⌃⌥↩ maximizes a pane, ⌃⌥B hides the sidebar, and zen mode (⌃⌥Z) shows the focused pane alone in
full screen. Drag the sidebar's right edge to make it between 200 and 480 pixels wide, or all the way
to the left to close it; double-click the edge to go back to the default width.

### Workspaces

The **+** next to **Workspaces** at the top of the sidebar starts one; double-click it to rename it.
Drag a session from the sidebar onto it to add every pane that session has, in the session's own
arrangement, or open a session's pane list with the arrow at the end of its row and drag a single
pane. Drop onto the empty workspace, onto an edge of a pane already in it, or onto the workspace's
row in the sidebar; a pane title bar can be dragged onto that row too. Inside a workspace, panes
rearrange the same way as in a session, each title bar names the project and session the pane
belongs to (click it to open that session), and ⌃⌥\ / ⌃⌥- add the new shell to the focused pane's
session and to the workspace. ⌃⌥W or the × takes a pane out of the workspace without stopping it. A
workspace shows at most 16 panes. A pane whose session is archived keeps its place but stays asleep
until the session is restored, and a pane that is closed leaves every workspace it was in. Deleting
a workspace stops nothing.

### Git

A session in a git repository shows its branch in the header, with the commits to push (↑) and pull
(↓) and the number of changed files (●); hover it for staged, unstaged, untracked and conflicting
files. A detached head shows its commit. When the GitHub CLI (`gh`) is installed and signed in, the
branch's pull request appears next to it with its state and checks, and opens on click; set
`git.pullRequests` to `false` to stop asking GitHub. The project's row in the sidebar shows the
branch too. Voltran reads the status every 10 seconds while a window is open, and a second after a
Claude Code or OpenCode pane uses a tool, so an agent's edits show up straight away. It runs
`git status` with `core.fsmonitor` off and without optional locks, so it neither runs a command a
repository configures nor holds `index.lock` while an agent commits.

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
| ⌘K | Command palette: every action below, plus the appearance, the themes and the terminal font family and size. Type a workspace, session or pane name to jump to it |
| ⌘F | Find in the focused terminal's scrollback. ↩ / ⇧↩ or ⌘G / ⇧⌘G step through the matches, Esc closes. A capital letter makes it case-sensitive |
| ⌃⌥J | Jump to the next pane that needs you |
| ⌃⌥B | Show or hide the sidebar |
| ⌃⌥Z | Zen mode: the focused pane alone, full screen. Esc still reaches the terminal; ⇧Esc or ⌃⌥Z leaves |
| ⌃⌥N | Start a new session |
| ⌃⌥↑ / ⌃⌥↓ | Previous / next workspace or session |
| ⌃⌥← / ⌃⌥→ | Previous / next pane on screen (moves the maximized view along when a pane is maximized) |
| ⌃⌥\ / ⌃⌥- | Split the focused pane right / down with a shell |
| ⌃⌥↩ | Maximize or restore the focused pane |
| ⌃⌥W | Close the focused pane; in a workspace, take it out of the workspace |
| ⌃⌥/ | Show all shortcuts |

In terminals, Option types the characters of your keyboard layout (such as @ and { on Turkish Q), as
in iTerm's default. Line editing follows iTerm's Natural Text Editing: ⌘←/⌘→ jump to the start or end
of the line, ⌥←/⌥→ move by word, ⌘⌫/⌥⌫ delete the line or the word, and ⇧↩ or ⌥↩ adds a new line.

### Themes and fonts

⌘K → **Appearance…** follows the system's dark or light mode, or keeps one of them. Dark and light
each have their own theme, which colours the whole app and every terminal: ⌘K → **Dark theme…** picks
from Voltran (the default), Tokyo Night, Catppuccin Mocha, Dracula, Nord, Gruvbox Dark, One Dark and
Rosé Pine, and ⌘K → **Light theme…** from GitHub Light (the default), Catppuccin Latte and Solarized
Light. ⌘K → **Terminal font family…** lists the common monospace fonts
installed on your Mac or takes any installed font by name, and the terminal font size commands make
terminal text bigger or smaller. ⌘K → **UI font family…** and the UI font size commands do the same
for the rest of the window (sidebar, bars, dialogs), from 11 to 18 pixels; the UI uses the system font
until you pick another. Moving
through a list previews each choice, ↩ keeps it and Esc goes back. Status lamps take their colours
from the theme, so the hues above can differ. ⌘K → **Move the sidebar to the right** (or left) puts the
project list on the other side.

### Settings file

Every choice above is saved in `~/.voltran/settings.json`, and you can edit that file instead of
using ⌘K: ⌘K → **Open the settings file** opens it in a terminal editor in a pane next to the focused
one, creating it with every setting and the values each accepts. The editor is `editor.command`, or
`$VISUAL`, then `$EDITOR`, then `vim`; the pane closes when the editor exits cleanly. With no session
open, or with **Open the settings file in the default app**, it opens in your system's editor
instead. The file takes comments and trailing commas, like VS Code's:

```jsonc
{
    "appearance": "system",          // "system", "dark" or "light"
    "theme": { "dark": "voltran", "light": "github-light" },
    "terminal": { "fontFamily": "JetBrains Mono", "fontSize": 13 },
    "ui": { "fontFamily": "", "fontSize": 13 }, // "" is the system font
    "sidebar": { "position": "left" }, // "left" or "right"
    "editor": { "command": "" },       // such as "nvim"
    "git": { "pullRequests": true }    // look up each branch's pull request with gh
}
```

Saving the file changes every open window at once, and a choice made in ⌘K is written back into it
without touching your comments. A value Voltran does not accept keeps its default, and the window
says which one and why; while the file is not valid JSON, the last valid settings stay in effect.
The first window to connect after an update moves the choices it had in the browser into the file.

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
  panes come back with `claude --resume <session>` and OpenCode panes with
  `opencode --session <session>`, so the conversation continues. Open windows reconnect on their
  own.
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
- **OpenCode status.** Each OpenCode pane runs its own OpenCode server (`--standalone`), and Voltran
  adds a small plugin to it through `OPENCODE_CONFIG_CONTENT`, which adds to your configuration
  files instead of replacing them. The plugin follows OpenCode's events (prompts, tools, permission
  prompts and questions, including a subagent's, and the end of each turn) and reports them to the
  daemon with the pane's secret. Voltran picks the session id, so the pane resumes the same
  conversation, or the one you switched to inside it.
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
UI, run `npm run build` and reload the window. After changing the daemon, run `voltran restart`. It
works from a pane inside Voltran too: that pane stops with the others and resumes when you open it.
The restarted daemon keeps the environment of the one before it, so after changing an environment
variable the daemon should see, use `voltran down && voltran up` from a terminal that has it.

`VOLTRAN_HOME` and `VOLTRAN_PORT` point a daemon at another data folder or port, which keeps
experiments away from your real sessions.

## Roadmap

- Session templates
- A git worktree per session, so parallel agents on one repository never touch each other's files
- Sending a prompt to one or many agents, and headless `claude -p` runs streamed into panes
- An agent-to-agent message bus exposed as an MCP server
- A native window (Tauri) with a dock badge and global shortcuts
- Project providers that discover work automatically, for example task folders in a repository
