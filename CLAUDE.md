# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Voltran is a local orchestrator for agent CLIs and terminals: a Node daemon owns every terminal, and a
React web UI shows them as projects → sessions → split panes. See README.md for the user-facing
behaviour.

## Commands

```bash
npm install                      # postinstall makes node-pty's spawn-helper executable (else "posix_spawnp failed")
npm test                         # vitest, all packages
npx vitest run packages/daemon/src/panes.test.ts -t "persists scrollback"   # one file / one test
npm run typecheck                # tsc for daemon and web (each includes shared)
npm run build                    # builds packages/web/dist, which the daemon serves
npm run dev:daemon               # daemon with --watch, allows the Vite origin
npm run dev:web                  # Vite on :4774, proxies /api and /ws to the daemon
node bin/voltran.mjs up|down|status|add|autostart   # the CLI, same as `voltran` after npm link
```

There is no linter or formatter; match the surrounding code (4-space indent, single quotes, no
comments except for a constraint the code cannot show, every file ends with a newline).

## TypeScript without a build step

Node ≥ 22.18 runs the daemon's `.ts` files directly (type stripping), and `tsconfig.base.json` enforces
what that allows: `erasableSyntaxOnly` (no enums, namespaces or parameter properties),
`verbatimModuleSyntax` (use `import type` for type-only imports) and `.ts` extensions in every
relative import. `packages/shared` is consumed as source by both the daemon and the web app.

## Architecture

**The daemon is the source of truth.** `daemon/src/hub.ts` validates every change and broadcasts state;
`store.ts` persists projects, sessions and panes in SQLite (`node:sqlite`) under `~/.voltran`;
`panes.ts` (`PaneManager`) owns the running terminals; `server.ts` exposes HTTP routes and two
WebSockets: `/ws/events` (whole-app state, one per window) and `/ws/panes/:id` (one terminal).
`security.ts` (`Guard`) checks the token or a browser credential, `Host` and `Origin` on every
request and upgrade. A browser never gets the token and never a cookie (browsers send cookies to
every port of 127.0.0.1): `voltran up` opens `/auth?code=…`, `signInFromUrl` (`web/src/api.ts`) trades
the code at `POST /api/session` for a credential signed with the token, keeps it in `localStorage`
and sends it as `Authorization`, and on WebSockets as a subprotocol next to `voltran`. A credential
carries the time it was issued and lapses after `BROWSER_SESSION_MAX_AGE_MS` unless
`keepSessionFresh` renews it (`POST /api/session/renew`); a dev daemon signs with a key of its own,
so a credential from the Vite origin never works on the real daemon. `voltran signout`
(`POST /api/signout`) writes a new token, which ends every credential and closes every socket. The
UI's files need no credential; `index.html` gets a Content-Security-Policy with the hash of each
inline script it carries (`contentSecurityPolicy`), so a new inline script needs no change there. `ensureHome` keeps `~/.voltran` at 0700 and refuses a home another user
owns.

**Settings** live in `~/.voltran/settings.json` (JSONC, nested sections). `shared/src/settings.ts` is
the only place that decides whether a setting is valid, for the file and for `PATCH /api/settings`
alike. `daemon/src/settings.ts` (`SettingsFile`) watches the folder, keeps the last valid settings
while the file is broken, writes changes with `jsonc-parser` so comments survive, and the hub
broadcasts a `settings` event to every window. The web store applies it; its localStorage copy is
only a cache for the first paint. A new theme must be added to `DARK_THEME_IDS`/`LIGHT_THEME_IDS`
too (a test checks they match `THEMES`). Editing the file inside Voltran (`POST /api/settings/edit`)
opens a `command` pane whose command the daemon builds from `editor.command`; the hub deletes that
pane when it exits with code 0 (tracked in memory only, so not after a restart).

**A pane runtime** is a `node-pty` process mirrored into a headless xterm plus a serializer. Things that
are easy to get wrong here:
- A pane stays asleep until a client sends its first `resize`; that is what spawns the process.
- Headless `term.write()` is asynchronous. Anything that needs the terminal's current content must
  wait with `term.write('', callback)`: attaching takes its snapshot in that callback (so snapshot plus
  queued chunks neither lose nor repeat bytes), and shutdown waits for it before saving scrollback.
- The browser never resizes its terminal itself (`web/src/terminals.ts`). It asks the daemon for the
  size that fits; the daemon resizes the process and the mirror and sends a `resize` message in the
  output stream, and each client resizes at that point inside its own write queue. A local resize
  would parse output at a size the process never had, and Claude Code's diff rendering then leaves
  stray characters behind.
- Only the focused browser window asks for sizes; otherwise every attached window would push its
  own size and the last one would win.

**Agent status** comes from two places. Claude Code panes are launched with `--settings` set to a
JSON string built for that pane (`adapters.ts` → `claudeHookSettings`), whose hooks `curl`
`/api/hooks/:pane/:event` with a secret unique to that pane's process; curl reads the header from
`~/.voltran/hooks/<pane>` (0600) so the secret is never in `ps`, and `status.ts` maps hook events to
statuses. A hook's `session_id` is kept only when it is a UUID (`isClaudeSessionId`), because it is
launched as `--resume <id>` and Claude reads a dash-prefixed value as a flag. OpenCode V2
runs plugins in a background service shared by every client, so an OpenCode pane runs
`opencode --standalone` (a private server that inherits the pane's environment) with
`OPENCODE_CONFIG_CONTENT` adding `daemon/src/opencode-plugin/` (a folder plugin OpenCode loads with
Bun; keep it free of daemon imports). The plugin's `Reporter` turns OpenCode events into the
`OPENCODE_EVENTS` it posts to the same hook route, dropping child (subagent) sessions except for their
permission prompts and questions; `OpencodeStatus` maps them and counts the open prompts. Voltran picks
the `ses_…` id and always passes `--session`, which creates the session or continues it. Codex panes
pass the same hook command per event as `-c hooks.<Event>=…` (`codexHookArgs`): Codex runs it only
once the user trusts it, and keeps that trust by the command's hash, so the command must stay the
same for every pane. A Codex pane uses `ActivityTracker` until its first hook arrives and
`codexTransition` after that. Other agents use `ActivityTracker` (output streaming / quiet / bell
heuristics). Adapters (`claude`, `opencode`, `codex`, `antigravity`, `shell`, `command`, `subagent`)
are defined in `adapters.ts`.

**Session titles.** A session created without a title is `titleSource: 'pending'` and needs a pane
whose adapter reports hooks. `naming.ts` (`SessionNamer`) takes the first prompt any agent reports
(`'prompt'`), then for Claude reads the `ai-title` entry Claude Code writes near the top of its
transcript during the first turn (`readAiTitle`, `'agent'`): at most every 2 s and 30 times per
session, plus once more 4 s after a `Stop`. A title the user sets is `'user'` and is never replaced.

**Usage limits.** Claude Code passes the account's `rate_limits` (five-hour and seven-day windows,
`resets_at` in epoch seconds) only to its status line, so `claudeHookSettings` sets `statusLine` to
`statusline.sh`. A status line in `--settings` replaces the user's and the project's, so the script
posts input that carries `rate_limits` to `/api/hooks/:pane/StatusLine` and then runs
`$VOLTRAN_STATUSLINE`, the user's own command, which the Claude adapter looks up at spawn in Claude's
order (`userStatusLine` in `statusline.ts`). An idle pane reports the limits from its last response, so
`mergeUsage` keeps the newest view of each window. `AppState.usage` lives in memory only; the sidebar
footer draws it (`web/src/usage.ts`).

**Subagents.** `subagents.ts` tracks each Claude pane's running subagents from hooks: `SubagentStart`
has the id but no description, so starts are paired with the preceding `Agent` tool call, corrected by
`PostToolUse`, and background agents are reconciled against the `background_tasks` list on `Stop`.
`transcripts.ts` derives a subagent's transcript path from the parent transcript in the hook payload
(never from a client), validates it, and parses Claude's JSONL, dropping control characters from
every string it keeps (`clip`), because the viewer writes them to a terminal. An agent that a
workflow starts writes under `subagents/workflows/<run>/` instead, and no hook names the run, so
reads look the file up there by agent id; the derived path stays the subagent's identity. A
`subagent` pane runs `subagent-view.ts` as its process, which renders the transcript with
`subagent-render.ts`; the daemon sends it `SIGUSR2` when the subagent stops. Claude's transcript
format is internal and may change.

**Notes.** `daemon/src/notes.ts` (`NotesStore`) keeps each pane's notes in
`~/.voltran/notes/<pane>/notes.md`, one folder per pane so a lock can make the folder read-only as
well: a write through a temp file and a rename replaces a read-only file. The drawer
(`web/src/notes.ts`, `NotesEditor`) takes a lease (`POST …/notes/lock` with the version it shows) on
the first keystroke, renews it while typing, saves with `PUT …/notes` and gives it back three
seconds after the last keystroke; while it is held the folder is 0500 and the file 0400. The store
watches the folder and reports every write it did not make as the agent's, and Claude's
`PreToolUse`/`PostToolUse` on the notes file hold an agent lock that refuses the drawer's. Every
pane but subagent viewers gets `VOLTRAN_NOTES`. Claude's settings add `notes-hook.sh` (the notes, which it fetches from
`GET /api/hooks/:pane/notes` rather than reading the agent's folder, into context on `SessionStart`, again on `UserPromptSubmit` after a drawer save marks `<pane>.changed`, and
a `PreToolUse` deny while the folder is read-only) and Read/Edit permission for that pane's folder
only, which Claude's sandbox also takes as write access; OpenCode gets `GUIDE.md` and the notes as
`instructions`. Agents can write in these folders, so every write goes through `replaceFile` (a fresh
name opened with O_EXCL, then a rename), modes change only on real files and folders, and a linked,
hard-linked or non-regular notes file reads as empty and never has its mode changed (`openNote`). `NOTES_GUIDE` is the
one copy of what agents are told. A daemon start restores permissions and deletes the notes of panes
that no longer exist.

**Diagnostics.** `daemon/src/doctor.ts` (`diagnose`) runs the checks behind `voltran doctor` and
`GET /api/diagnostics`; `shared/src/diagnostics.ts` formats them and builds the pre-filled bug report
URL, whose query keys are the field ids in `.github/ISSUE_TEMPLATE/bug_report.yml`. The CLI runs
the checks itself so they work while the daemon is down, and never creates the home or the token.
The results go into a public issue: keep secrets, file contents and pane output out of them, and
write paths through `redactHome`.

**Layout** is a tree in `shared/src/layout.ts` (`insertPane`, `removePane`, `movePane`). The web app
edits it locally and sends the whole tree with `PATCH /api/sessions/:id`; the hub rejects a layout
whose set of panes differs from the session's. Moving a pane to another session is a separate
endpoint (`POST /api/panes/:id/move`).

**Sidebar order.** Projects and sessions have a `position` in `store.ts`; `PATCH` with `moveBefore`
(a sibling's id, or `null` for the end) renumbers the siblings, and `listSessions` returns sessions
grouped by project in that order, so `AppState` arrives in sidebar order. The web store tracks a
sidebar drag as `reordering`, apart from `draggingSessionId`, which means "can drop on a workspace"
and is set only for a session with panes.

**Workspaces** are named layouts that point at panes of any session or project without owning them
(`PATCH /api/workspaces/:id`); the hub only checks that every pane exists, appears once and that
there are at most `MAX_WORKSPACE_PANES`. Every path that deletes panes (a pane, a session, a project)
calls `pruneWorkspaces`, and the hub prunes again at start. In the web app `PaneBox`/`LayoutNode`
take a `PaneHost` (session or workspace); a pane's own session still decides whether it is archived.

**Git status.** `daemon/src/git.ts` (`GitWatcher`) runs `git status --porcelain=v2` for every
folder an open session works in, one command at a time with a timeout, every 10 s while a window is
open and a second after a Claude pane's `PostToolUse`/`Stop` or an OpenCode pane's
`ToolEnd`/`TurnEnd`; `AppState.git` is keyed by folder. Keep `core.fsmonitor=false`,
`--no-optional-locks` and `--ignore-submodules=dirty` in `STATUS_ARGS`: the first stops a repository
from running a command through `git status`, the second keeps polling off `index.lock`, the third
keeps git from running a status inside each submodule under that submodule's own config and filters. `git status` also runs clean filters, so
`repositoryFilterOverrides` blanks those the repository's own config defines before every poll and
before `Worktrees.changes`. Pull requests come from `gh pr view`,
cached per branch for two minutes and skipped when `git.pullRequests` is off or `gh` is missing.
Tests inject a `GitRunner` instead of the real `gh`.

**Worktrees.** A session created with `worktree: { branch, base? }` gets a `git worktree` under
`~/.voltran/worktrees/<project>/<branch>` (`daemon/src/worktrees.ts`); `Session.worktree` is its
root and `Session.cwd` the project's subfolder inside it, so panes and `GitWatcher` need nothing
special. Deleting the session removes the worktree only when `git status` shows nothing to lose,
otherwise the hub answers 409 until the client passes `?worktree=keep|remove`; deleting a project
removes only the clean ones. Branches are never deleted.

**Web app** (`packages/web/src`): a zustand store (`store.ts`; view state such as the selected session
and the sidebar width persisted in `localStorage` under `voltran.ui`, settings from the daemon),
`events.ts` for the state socket, `terminals.ts` (one
`TerminalSession` per pane, kept across unmounts), `shortcuts.ts` (⌃⌥ shortcuts and ⌘K) and
`keymap.ts` (iTerm-style line editing bytes). Menus are Base UI (`@base-ui/react`, unstyled, in our
`.menu` CSS): `menus.ts` builds each thing's items once and both the ⋯ buttons (`MoreMenu`) and
right-click (`ContextMenuArea`, a `display: contents` trigger) render them through `Controls.tsx`.
A portalled popup still bubbles React events through its owner, so popups swallow `contextmenu`.
Themes (`themes.ts`) derive the UI's CSS variables from each terminal palette; `index.html` applies
a cached copy before first paint.

**Installed app.** Chrome can install Voltran as an app (`install.ts`, `public/manifest.webmanifest`).
`daemon/src/macos.ts` finds the installed app through the bundle Chrome writes to
`~/Applications/Chrome Apps.localized` (its Info.plist names the app id, URL and profile), and the CLI
opens it with `--app-id` plus `--app-launch-url-for-shortcuts-menu-item=<login URL>`, which signs it in.

**Platforms.** macOS and Linux; Windows only through WSL2 (hooks are POSIX shell, viewers need
`SIGUSR2`, the notes lock needs real file modes). `daemon/src/linux.ts` holds the Linux side of the CLI:
finding Chrome for `--app=` and the systemd user unit for `autostart`, a oneshot with
`KillMode=process` because `up` exits once the daemon it started is listening. In the web app, keyboard
labels are written with Mac glyphs and go through `keys()` (`keyLabel` in `keymap.ts`); off a Mac, ⌘
shortcuts are Ctrl+Shift (`isPrimaryChord`) and find steps with F3. CI runs typecheck and tests on
Ubuntu and macOS (`.github/workflows/test.yml`).

## Testing

- Vitest runs `packages/*/src/**/*.test.ts` in a Node environment, so web logic that needs tests lives
  in DOM-free modules (`fonts.ts`, `palette.ts`, `keymap.ts`, `themes.ts`, `drag.ts`).
- Daemon tests spawn real PTYs; `server.test.ts` builds a whole daemon on a free port with a fake
  `claude` binary that runs the real hook command.
- There are no UI tests. Check UI changes in headless Chrome with `playwright-core` (a devDependency,
  launched with `executablePath` set to the installed Chrome) against a throwaway daemon:
  `VOLTRAN_HOME=/tmp/… VOLTRAN_PORT=49xx node bin/voltran.mjs up --no-open`, then
  `POST /api/login-code` with the token from `$VOLTRAN_HOME/token` and open `/auth?code=…`. Stop it
  with `down` and delete the folder afterwards. Never use port 4747 or `~/.voltran`: that is the
  user's real daemon.
- Headless Chrome at `deviceScaleFactor: 2` does not capture the WebGL terminal canvas in screenshots;
  use 1.
- The daemon builds its `PATH` from a login shell, so a fake agent binary must come first there. Point
  `SHELL` at a wrapper that runs `zsh -f` with your `PATH`, or the user's real `claude` starts instead.

## Applying changes to a running Voltran

The daemon serves the built UI from disk, so a UI change needs `npm run build` and a reload of the
window; a daemon change needs `voltran restart`. Claude Code often runs inside a Voltran pane: a
restart ends that session too (it resumes when the pane is opened again), so ask the user to run it
instead of running it yourself. Windows tell the user which one is missing: `vite.config.ts` writes `dist/version.json`
with hashes of `shared/src` and of the UI sources (`daemon/src/source-hash.ts`), and
`daemon/src/version.ts` compares it with the `shared/src` the daemon loaded at start.
