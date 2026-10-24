# Changelog

Voltran follows [Semantic Versioning](https://semver.org/). The README describes each feature in
full.

## Unreleased

- `voltran doctor` checks the installation, and `voltran doctor --report`, ⌘K → **Report a
  problem…** and a button in the sidebar open a bug report with its results filled in.
- The daemon reports its real version to `voltran doctor` and the CLI instead of `0.1.0`.

## 1.0.0 (2026-10-24)

The first release.

### Sessions and panes

- Projects, sessions and split panes that run agents, shells and commands, owned by a local daemon,
  so reloading or reopening the window loses nothing. Panes come back asleep after a restart, with
  their scrollback, and agents resume their conversation when you open them.
- Drag panes to rearrange them, swap them or move them to another session; maximize a pane, hide
  the sidebar or show one pane alone in zen mode.
- Workspaces: named screens that show panes from any project side by side.
- A session can work in a git worktree of its own, removed with the session when nothing in it
  would be lost.
- A session started without a title is named from its first prompt, then from Claude's own title.
- Right-click menus for everything in the sidebar, and projects and sessions you can reorder.

### Agents

- Claude Code status through hooks, including the subagents it runs, each of which opens in a
  read-only pane that follows it live.
- OpenCode status through a plugin, and Codex status through hooks you trust once. Other agents,
  such as Antigravity, get their status from terminal activity.
- A **Needs you** tray, the tab title and desktop notifications say which agent is waiting on you.
- The Claude account's five-hour and weekly usage limits in the sidebar.
- Notes for every pane that you and its agent share, locked to you while you type.

### Git

- The branch, commits to push and pull, changed files and pull request of each session, refreshed
  as agents work.

### Look and settings

- Thirteen themes for the app and its terminals, one for dark mode and one for light mode, and
  terminal and UI fonts of your choice.
- Every choice is kept in `~/.voltran/settings.json`, which you can edit inside Voltran, with
  comments that survive.
- ⌃⌥ shortcuts that never collide with the terminal, a ⌘K command palette, ⌘F search in a
  terminal's scrollback and iTerm-style line editing.

### Platforms and CLI

- macOS and Linux, and Windows through WSL2. Chrome can install Voltran as an app with a Dock icon
  of its own.
- `voltran up`, `down`, `restart`, `status`, `add`, `autostart`, `signout` and `version`.

### Security

- The daemon listens on `127.0.0.1` only, checks the `Host` and `Origin` of every request and
  needs a credential on each one; browsers get a credential of their own that expires and that
  `voltran signout` revokes. [SECURITY.md](SECURITY.md) says what Voltran does and does not protect
  against.
