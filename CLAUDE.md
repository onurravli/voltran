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
npm run dev:web                  # Vite on :5173, proxies /api and /ws to the daemon
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
`security.ts` (`Guard`) checks token or cookie, `Host` and `Origin` on every request and upgrade.

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

**Agent status** comes from two places. Claude Code panes are launched with `--settings` pointing at a
generated file (`adapters.ts` → `claudeHookSettings`) whose hooks `curl` `/api/hooks/:pane/:event`
with a secret unique to that pane's process; `status.ts` maps hook events to statuses. Other agents
use `ActivityTracker` (output streaming / quiet / bell heuristics). Adapters (`claude`, `codex`,
`gemini`, `shell`, `command`, `subagent`) are defined in `adapters.ts`.

**Subagents.** `subagents.ts` tracks each Claude pane's running subagents from hooks: `SubagentStart`
has the id but no description, so starts are paired with the preceding `Agent` tool call, corrected by
`PostToolUse`, and background agents are reconciled against the `background_tasks` list on `Stop`.
`transcripts.ts` derives a subagent's transcript path from the parent transcript in the hook payload
(never from a client), validates it, and parses Claude's JSONL. An agent that a workflow starts writes
under `subagents/workflows/<run>/` instead, and no hook names the run, so reads look the file up there
by agent id; the derived path stays the subagent's identity. A `subagent` pane runs
`subagent-view.ts` as its process, which renders the transcript with `subagent-render.ts`; the daemon
sends it `SIGUSR2` when the subagent stops. Claude's transcript format is internal and may change.

**Layout** is a tree in `shared/src/layout.ts` (`insertPane`, `removePane`, `movePane`). The web app
edits it locally and sends the whole tree with `PATCH /api/sessions/:id`; the hub rejects a layout
whose set of panes differs from the session's. Moving a pane to another session is a separate
endpoint (`POST /api/panes/:id/move`).

**Web app** (`packages/web/src`): a zustand store (`store.ts`, UI preferences persisted in
`localStorage` under `voltran.ui`), `events.ts` for the state socket, `terminals.ts` (one
`TerminalSession` per pane, kept across unmounts), `shortcuts.ts` (⌃⌥ shortcuts and ⌘K) and
`keymap.ts` (iTerm-style line editing bytes). Themes (`themes.ts`) derive the UI's CSS variables from
each terminal palette; `index.html` applies a cached copy before first paint.

**Installed app.** Chrome can install Voltran as an app (`install.ts`, `public/manifest.webmanifest`).
Every file stays behind the session cookie, so `index.html` fetches the manifest with
`crossorigin="use-credentials"`; without it the manifest gets a 401 and Chrome refuses to install.
`daemon/src/macos.ts` finds the installed app through the bundle Chrome writes to
`~/Applications/Chrome Apps.localized` (its Info.plist names the app id, URL and profile), and the CLI
opens it with `--app-id` plus `--app-launch-url-for-shortcuts-menu-item=<login URL>`, which signs it in.

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
