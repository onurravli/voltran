# Changelog

Voltran follows [Semantic Versioning](https://semver.org/). The README describes each feature in
full.

## 1.3.0 (2026-11-14)

- **Tasks** queue prompts for agent panes: Voltran types the next one once the agent has finished its
  turn and keeps its last reply as the result. **Queue a task…** in an agent pane's menu, **New
  task…** in ⌘K or a **Tasks** pane opens the composer, which sends a prompt to one agent, several at
  once or a new Claude Code, Codex or OpenCode pane. **Start after** makes a task wait for others and
  puts their results in front of its prompt, **Hand off context from** passes another pane's last
  reply and notes along, and **Subtask of** files it under another task. A turn that ends with a
  question keeps the task **Asking you** until you answer.
- A **Tasks** pane shows the project's tasks as a graph of what waits for what, or as one queue per
  agent that you can reorder, with **Retry**, **Mark done** and the rest on each task. The subagents
  Claude Code runs during a task show under it as live subtasks.
- Agents delegate to each other through `$VOLTRAN_TASK`: Claude Code, Codex and OpenCode can queue
  tasks for other agents, open new agent panes, wait for results and rewire the plan, only in their
  own project, while you follow it in the graph.
- The **agents view** shows agents delegating to each other on a canvas: who gave work to whom, whose
  results a task waits for and the subagents each one runs, beside the messages of the exchange, then
  a summary once every task has finished. Pan, zoom and drag the nodes, which keep their place until
  **Reset layout**; select a Claude Code agent for its thinking and tool calls. The robot button above
  the panes or ⌘K → **Show the agents talking** opens it, and `"autoAgenticViewEnabled": true` in the
  settings opens it by itself when an agent delegates.
- Search in files from the editor pane with ⇧⌘F, seeded with the selection, with match case, whole
  word and regular expression toggles; a result opens the file with the match selected.
- Every project has **notes** of its own, shared by all of its sessions and worktrees: the **Project**
  tab of the notes drawer, or **Show project notes** in a pane's menu. Claude Code and OpenCode get
  them like the pane's own notes, and every pane has their path in `$VOLTRAN_PROJECT_NOTES`.
- Drag the notes drawer's edge to resize it; Voltran keeps its width.
- ⌘-click (Ctrl-click off a Mac) or Shift-click sessions of a project to pick several, then archive,
  restore or delete them all at once from the right-click menu, or delete them with ⌫.
- `editor.paddingTop` and `editor.paddingLeft` in the settings add space above the first line and
  between the line numbers and the text.

## 1.2.0 (2026-10-31)

- An **Editor** pane browses the session's folder as a file tree and edits its files, with tabs,
  syntax highlighting and VS Code's editing keys: ⌘S saves, ⌘P opens a file by name, ⌘B hides the
  tree. Press ⌃⌥O to open one next to the focused pane, such as next to Claude Code. The tree shows
  each file's git state and creates, renames and moves files to the Trash. An agent's edit shows up
  in the open file as it lands, and a save never overwrites an edit it has not seen.
- The `editor` section of the settings file sets the editor's font, indentation, cursor, rulers,
  word wrap, minimap, trimming on save and auto save; ⌘K → **Open the settings file** now opens it in
  the editor.
- A Claude Code pane can show its conversation as messages instead of its terminal (⌃⌥C, or the
  button in its title bar), with replies as formatted text, tool calls with their results, and edits
  as diffs. Its composer takes pasted or dropped images, and `/` lists Claude Code's commands.
- A **Preview** pane shows a page served on this computer, such as `localhost:5173`, next to the
  terminals: type the address where a command goes, or use `voltran new --pane "preview
  localhost:5173"`.
- The changes view (⌃⌥G) shows each file in a side-by-side diff with syntax highlighting, and can stay
  open as a **Changes** pane next to an agent.
- Voltran says, in a line at the bottom of the sidebar, when a newer version is out. It asks npm once
  a day, sends nothing about you, and never installs anything; `"updates": { "check": false }` in the
  settings turns it off. `voltran doctor` reports it too.
- Updated markdown-it and DOMPurify for security advisories, and xterm.js to a newer build.

## 1.1.0 (2026-10-24)

- Click the Voltran logo, or ⌘K → **About Voltran**, for the version, the author and links to the
  repository, the changelog and the license.
- Click the number of changed files in a session's header, or press ⌃⌥G, to see the diff of every
  changed file without leaving Voltran.
- `voltran new` opens a session from the terminal, with the panes, title and worktree you give it,
  and shows it in the window: `voltran new . --pane "claude --model opus" --pane shell`.
- Option-drag selects text in a pane whose program takes the mouse, such as Claude Code in
  fullscreen mode.
- Switching to a session, workspace or pane puts the keyboard in its terminal, on the pane you
  used there last; closing the focused pane moves to the one next to it.
- After a daemon restart, a pane shows all of its earlier output again: the `restored` line no longer
  lands near the top of the screen and overwrites what was below it.

## 1.0.1 (2026-10-24)

- Install with `npm install -g voltran` or `brew install onurravli/tap/voltran`. The npm package
  carries the daemon compiled to JavaScript and the built UI.
- `voltran autostart on` keeps working after `brew upgrade`: it runs Homebrew's Node and Voltran
  through links that an upgrade leaves in place.
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
