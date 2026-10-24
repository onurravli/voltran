# Security

## Reporting a vulnerability

Voltran runs a local server that starts processes, so please do not report a vulnerability in a
public issue. Email onur@onurravli.com with the steps to reproduce it and what an attacker gains.
Fixes go to the latest `main`; there are no maintained older releases.

## What Voltran protects against

- **Web pages you visit.** The daemon listens on `127.0.0.1` only, rejects any `Host` or `Origin`
  but its own, and needs a credential on every API request and WebSocket. A browser gets a
  credential of its own when `voltran up` signs it in, keeps it in the page's own storage and sends
  it as a header. Voltran sets no cookie, because a browser sends cookies to every port of a host.
- **Other people on the machine, as far as files go.** `~/.voltran` is 0700 and its files 0600,
  and the secret each pane's hooks use is read from a file rather than passed on a command line.
- **A repository you open.** Polling `git status` runs neither a file system monitor nor a filter
  the repository's own config defines, and does not look inside submodules, whose own config could
  define one.
- **An agent kept in Claude Code's sandbox.** A Claude pane may edit its own notes and no other
  pane's, notes are never written or read through a link or a hard link, nothing an agent leaves in
  its notes folder can stop the daemon, and what an agent reports through its hooks cannot add flags
  to the next launch of that pane.

## What it does not protect against

- **Anything that runs as you, which includes every agent and command in every pane.** It can read
  `~/.voltran/token` and then do anything Voltran can: open panes, run commands, read every pane's
  output and notes. Panes are not walled off from each other. The only isolation is an agent's own
  sandbox, such as Claude Code's, when it keeps the agent away from that file and from the daemon.
- **Other people on the machine, beyond files.** Voltran assumes one person uses the computer.
  On macOS and Linux other users can read every process's command line: the one-time code that
  `voltran up` passes to the browser is visible there for up to a minute, and whoever redeems it
  first is signed in. `voltran up` and `voltran status` also talk to whatever listens on Voltran's
  port, so another user who takes the port while the daemon is down receives the token.
- **What agents do.** Voltran starts agents with the permissions you give them and does not review
  their actions.
- **Commands a repository runs by design.** A session in its own worktree runs `git worktree add`,
  which runs the repository's checkout hooks and filters, as it would in your shell.

The README's [Security](README.md#security) section describes the checks in more detail.
